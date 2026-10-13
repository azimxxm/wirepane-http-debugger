import * as fs from 'fs/promises';
import * as path from 'path';

import type { TunnelEvent } from './wireguard-vpn-sidecar';

// The VPN's network tools (docs/plans/2026-10-13-rust-network-tools.md): the settings the UI
// changes (network conditions per phone, DNS rules, the QUIC mode), saved next to the VPN's
// state and sent to the helper again after every restart, and the events the UI polls for.

export interface VpnConditions {
    latencyMs: number;
    jitterMs: number;
    downKbps: number; // 0 = no limit
    upKbps: number; // 0 = no limit
    lossPct: number; // 0-100
}

export type VpnDnsRule =
    | { pattern: string, action: 'block' }
    | { pattern: string, action: 'answer', ipv4: string };

export type VpnQuicMode = 'block' | 'relay' | 'decrypt';

export interface VpnSettings {
    conditions: { [peer: string]: VpnConditions | null };
    dnsRules: VpnDnsRule[];
    quic: VpnQuicMode;
}

export type VpnSettingsPatch = Partial<VpnSettings>;

export const DEFAULT_VPN_SETTINGS: VpnSettings = Object.freeze({
    conditions: {},
    dnsRules: [],
    quic: 'block'
}) as VpnSettings;

export const SETTINGS_FILE_NAME = 'wirepane-vpn-settings.json';
export const MAX_TOOL_EVENTS = 5000;

const MAX_DELAY_MS = 60_000;
const MAX_KBPS = 10_000_000;
const MAX_DNS_RULES = 10_000;
const MAX_PATTERN_LENGTH = 253;
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
// A name like api.example.com, or a wildcard like *.example.com
const DNS_PATTERN = /^(\*\.)?[a-z0-9_*-]+(\.[a-z0-9_*-]+)*\.?$/;
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const QUIC_MODES: ReadonlyArray<VpnQuicMode> = ['block', 'relay', 'decrypt'];

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function wholeNumber(raw: Record<string, unknown>, key: string, max: number): number {
    const value = raw[key] ?? 0;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
        throw new Error(`${key} must be a whole number from 0 to ${max}`);
    }
    return value;
}

export function parseConditions(raw: unknown): VpnConditions | null {
    if (raw === null || raw === undefined) return null;
    if (!isRecord(raw)) throw new Error('Network conditions must be an object or null');

    const lossPct = raw.lossPct ?? 0;
    if (typeof lossPct !== 'number' || !Number.isFinite(lossPct) || lossPct < 0 || lossPct > 100) {
        throw new Error('lossPct must be from 0 to 100');
    }
    return {
        latencyMs: wholeNumber(raw, 'latencyMs', MAX_DELAY_MS),
        jitterMs: wholeNumber(raw, 'jitterMs', MAX_DELAY_MS),
        downKbps: wholeNumber(raw, 'downKbps', MAX_KBPS),
        upKbps: wholeNumber(raw, 'upKbps', MAX_KBPS),
        lossPct
    };
}

export function parseDnsRule(raw: unknown, index: number): VpnDnsRule {
    if (!isRecord(raw)) throw new Error(`DNS rule ${index + 1} must be an object`);

    const pattern = typeof raw.pattern === 'string' ? raw.pattern.trim().toLowerCase() : '';
    if (!pattern || pattern.length > MAX_PATTERN_LENGTH || !DNS_PATTERN.test(pattern)) {
        throw new Error(`DNS rule ${index + 1} needs a name like api.example.com or *.example.com`);
    }

    if (raw.action === 'block') return { pattern, action: 'block' };
    if (raw.action === 'answer') {
        if (typeof raw.ipv4 !== 'string' || !IPV4_PATTERN.test(raw.ipv4)) {
            throw new Error(`DNS rule ${index + 1} needs an IPv4 address to answer with`);
        }
        return { pattern, action: 'answer', ipv4: raw.ipv4 };
    }
    throw new Error(`DNS rule ${index + 1}: the action must be block or answer`);
}

/** Checks a settings patch from the UI. Throws on anything the helper couldn't use. */
export function parseSettingsPatch(raw: unknown): VpnSettingsPatch {
    if (!isRecord(raw)) throw new Error('configure needs a settings object');
    const patch: VpnSettingsPatch = {};

    if (raw.conditions !== undefined) {
        if (!isRecord(raw.conditions)) throw new Error('conditions must map device ids to conditions');
        const conditions: VpnSettings['conditions'] = {};
        for (const [peer, value] of Object.entries(raw.conditions)) {
            if (!PEER_ID_PATTERN.test(peer)) throw new Error(`Unknown device id: ${peer}`);
            conditions[peer] = parseConditions(value);
        }
        patch.conditions = conditions;
    }

    if (raw.dnsRules !== undefined) {
        if (!Array.isArray(raw.dnsRules)) throw new Error('dnsRules must be a list');
        if (raw.dnsRules.length > MAX_DNS_RULES) throw new Error(`At most ${MAX_DNS_RULES} DNS rules`);
        patch.dnsRules = raw.dnsRules.map(parseDnsRule);
    }

    if (raw.quic !== undefined) {
        if (!QUIC_MODES.includes(raw.quic as VpnQuicMode)) {
            throw new Error('quic must be block, relay or decrypt');
        }
        patch.quic = raw.quic as VpnQuicMode;
    }

    return patch;
}

/** The settings after a patch. A device whose conditions are set to null loses them. */
export function applySettingsPatch(settings: VpnSettings, patch: VpnSettingsPatch): VpnSettings {
    const conditions = { ...settings.conditions };
    for (const [peer, value] of Object.entries(patch.conditions ?? {})) {
        if (value) conditions[peer] = value;
        else delete conditions[peer];
    }
    return {
        conditions,
        dnsRules: patch.dnsRules ?? settings.dnsRules,
        quic: patch.quic ?? settings.quic
    };
}

/** The saved settings; the defaults when there are none or the file is broken. */
export async function loadSettings(configPath: string): Promise<VpnSettings> {
    let raw: unknown;
    try {
        raw = JSON.parse(await fs.readFile(path.join(configPath, SETTINGS_FILE_NAME), 'utf8'));
    } catch (e: any) {
        if (e?.code !== 'ENOENT') console.warn(`wireguard-vpn: ignoring unreadable settings (${e?.message})`);
        return DEFAULT_VPN_SETTINGS;
    }

    try {
        return applySettingsPatch(DEFAULT_VPN_SETTINGS, parseSettingsPatch(raw));
    } catch (e: any) {
        console.warn(`wireguard-vpn: ignoring broken settings (${e?.message})`);
        return DEFAULT_VPN_SETTINGS;
    }
}

// Written to a temporary file first, so a crash can't leave half a file behind
export async function saveSettings(configPath: string, settings: VpnSettings): Promise<void> {
    const file = path.join(configPath, SETTINGS_FILE_NAME);
    const temporary = `${file}.${process.pid}.tmp`;
    await fs.mkdir(configPath, { recursive: true });
    await fs.writeFile(temporary, JSON.stringify(settings, null, 2), { mode: 0o600 });
    await fs.rename(temporary, file);
}

/** Where a new capture goes: <configPath>/captures/wirepane-<local time>.pcapng */
export function capturePath(configPath: string, now: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}` +
        `_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    return path.join(configPath, 'captures', `wirepane-${stamp}.pcapng`);
}

/**
 * The last helper events for the UI, numbered. The UI asks for everything after the last
 * number it saw; when that number is from before a server restart it gets all there is.
 */
export class ToolEventLog {
    private events: Array<TunnelEvent & { seq: number, at: number }> = [];
    private lastSeq = 0;

    constructor(private readonly limit = MAX_TOOL_EVENTS) {}

    get seq() {
        return this.lastSeq;
    }

    // `at` (ms since the epoch) is when the helper reported it, so a list the UI loads later
    // still shows when each query happened
    push(event: TunnelEvent, at = Date.now()) {
        this.lastSeq += 1;
        this.events.push({ ...event, seq: this.lastSeq, at });
        // Trimmed in batches, so a busy phone doesn't shift the array on every event
        if (this.events.length > this.limit * 1.2) {
            this.events = this.events.slice(-this.limit);
        }
    }

    since(seq: number): { seq: number, events: TunnelEvent[] } {
        const from = Number.isInteger(seq) && seq >= 0 && seq <= this.lastSeq ? seq : 0;
        const kept = this.events.length > this.limit ? this.events.slice(-this.limit) : this.events;
        return {
            seq: this.lastSeq,
            events: kept.filter((event) => event.seq > from)
        };
    }
}
