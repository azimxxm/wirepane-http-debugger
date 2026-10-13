import { action, observable, runInAction } from 'mobx';

import { activateInterceptor, getDetailedInterceptorMetadata } from '../../services/server-api';

/*
 * The VPN's network tools: what the tunnel saw (DNS, UDP, TLS hellos), its settings (network
 * conditions, DNS rules, QUIC mode) and pcap captures. Contract: docs/plans/2026-10-13-rust-network-tools.md.
 *
 * The tools only read the lists and call the actions; the Network page passes the store to each
 * tab as a prop, and keeps it polling while it's open (startPolling).
 */

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
    // Per WireGuard peer id; null or missing = no conditions
    conditions: { [peer: string]: VpnConditions | null };
    dnsRules: VpnDnsRule[];
    quic: VpnQuicMode;
}

export const DEFAULT_VPN_SETTINGS: VpnSettings = {
    conditions: {},
    dnsRules: [],
    quic: 'block'
};

export interface VpnCaptureState {
    running: boolean;
    path?: string;
    packets?: number;
    bytes?: number;
}

export interface VpnDnsQuery {
    peer: string;
    name: string;
    qtype: string;
    rcode: string;
    answers: string[];
    ms: number;
    // Set when a DNS rule changed the answer
    rule?: 'blocked' | 'answered';
    at: number; // ms since the epoch, when the UI got it
}

export interface VpnUdpFlow {
    flow: string;
    peer: string;
    src: string;
    dst: string;
    name?: string;
    bytesUp: number;
    bytesDown: number;
    packetsUp: number;
    packetsDown: number;
    openedAt: number;
    closedAt?: number;
    quic?: 'blocked' | 'relayed' | 'decrypted';
}

export interface VpnTlsHello {
    peer: string;
    dst: string;
    sni?: string;
    alpn: string[];
    ja4: string;
    at: number;
}

export type VpnStats = { [key: string]: unknown };

// What this build of the VPN helper can do (from its ready event)
export interface VpnCapabilities {
    quicDecrypt: boolean;
    ikev2: boolean;
}

const VPN_INTERCEPTOR_ID = 'wireguard-vpn';

export const POLL_INTERVAL_MS = 1000;
// The lists keep the newest entries only, so a busy phone can't grow them without end
export const MAX_DNS_QUERIES = 5000;
export const MAX_UDP_FLOWS = 2000;
export const MAX_TLS_HELLOS = 2000;
// While the VPN runs, its metadata (settings, capture) is read again every this many polls
const METADATA_EVERY_POLLS = 5;

// The server calls the store needs, so tests can fake the server
export interface VpnNetworkApi {
    activate(options: { action: string, [key: string]: unknown }): Promise<unknown>;
    getMetadata(): Promise<unknown>;
    // The interceptor's `events-<since>` sub-metadata: { seq, events }
    getEvents(since: number): Promise<unknown>;
}

export const createServerVpnNetworkApi = (getProxyPort: () => number): VpnNetworkApi => ({
    activate: (options) => activateInterceptor(VPN_INTERCEPTOR_ID, getProxyPort(), options),
    getMetadata: () => getDetailedInterceptorMetadata(VPN_INTERCEPTOR_ID),
    getEvents: (since) => getDetailedInterceptorMetadata(VPN_INTERCEPTOR_ID, `events-${since}`)
});

// --- Parsing what the server sends ---

type Raw = Record<string, unknown>;

const isRecord = (value: unknown): value is Raw =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown) => typeof value === 'string' ? value : undefined;
const count = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const strings = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];

function parseConditions(raw: unknown): VpnConditions | null {
    if (!isRecord(raw)) return null;
    return {
        latencyMs: count(raw.latencyMs),
        jitterMs: count(raw.jitterMs),
        downKbps: count(raw.downKbps),
        upKbps: count(raw.upKbps),
        lossPct: count(raw.lossPct)
    };
}

export function parseVpnSettings(raw: unknown): VpnSettings {
    if (!isRecord(raw)) return DEFAULT_VPN_SETTINGS;

    const conditions: VpnSettings['conditions'] = {};
    if (isRecord(raw.conditions)) {
        for (const [peer, value] of Object.entries(raw.conditions)) {
            const parsed = parseConditions(value);
            if (parsed) conditions[peer] = parsed;
        }
    }

    // A loop, not flatMap: the UI's TypeScript lib predates it
    const dnsRules: VpnDnsRule[] = [];
    for (const rule of Array.isArray(raw.dnsRules) ? raw.dnsRules as unknown[] : []) {
        if (!isRecord(rule) || typeof rule.pattern !== 'string') continue;
        if (rule.action === 'block') {
            dnsRules.push({ pattern: rule.pattern, action: 'block' });
        } else if (rule.action === 'answer' && typeof rule.ipv4 === 'string') {
            dnsRules.push({ pattern: rule.pattern, action: 'answer', ipv4: rule.ipv4 });
        }
    }

    const quic = raw.quic === 'relay' || raw.quic === 'decrypt' ? raw.quic : 'block';
    return { conditions, dnsRules, quic };
}

export function parseCaptureState(raw: unknown): VpnCaptureState {
    if (!isRecord(raw)) return { running: false };
    return {
        running: raw.running === true,
        ...(text(raw.path) ? { path: text(raw.path) } : {}),
        ...(typeof raw.packets === 'number' ? { packets: raw.packets } : {}),
        ...(typeof raw.bytes === 'number' ? { bytes: raw.bytes } : {})
    };
}

const quicMark = (action: unknown): VpnUdpFlow['quic'] =>
    action === 'blocked' || action === 'relayed' || action === 'decrypted' ? action : undefined;

// Keeps the newest `max` entries
function trimmed<T>(list: T[], max: number) {
    if (list.length > max) list.splice(0, list.length - max);
}

export class VpnNetworkStore {

    @observable.shallow dnsQueries: VpnDnsQuery[] = [];
    @observable.shallow udpFlows: VpnUdpFlow[] = [];
    @observable.shallow tlsHellos: VpnTlsHello[] = [];
    @observable.ref stats: VpnStats | undefined = undefined;

    @observable.ref settings: VpnSettings = DEFAULT_VPN_SETTINGS;
    @observable.ref capture: VpnCaptureState = { running: false };

    @observable running = false;
    @observable.ref capabilities: VpnCapabilities = { quicDecrypt: false, ikev2: false };
    // Why the last poll failed, cleared by the next good one
    @observable error: string | undefined = undefined;

    // index.tsx waits for every store's `initialized`; this one needs nothing at startup
    readonly initialized = Promise.resolve();

    // The last event number seen, for the next `events-<seq>` poll
    private seq = 0;
    private polls = 0;
    private pollers = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private pollInFlight = false;
    // A QUIC flow the helper relays shows up as a quic event, then a udp-open for it
    private relayedQuic = new Set<string>();

    constructor(
        private readonly api: VpnNetworkApi = createServerVpnNetworkApi(() => 0),
        private readonly now: () => number = Date.now,
        private readonly pollIntervalMs = POLL_INTERVAL_MS
    ) {}

    // --- Polling ---

    /** Polls every second until every caller has called the returned stop function. */
    startPolling(): () => void {
        this.pollers += 1;
        // A poll that's still running schedules the next one itself
        if (this.pollers === 1 && !this.pollInFlight && this.timer === undefined) this.schedule(0);

        let stopped = false;
        return () => {
            if (stopped) return;
            stopped = true;
            this.pollers -= 1;
            if (this.pollers === 0 && this.timer !== undefined) {
                clearTimeout(this.timer);
                this.timer = undefined;
            }
        };
    }

    private schedule(delay: number) {
        this.timer = setTimeout(async () => {
            this.timer = undefined;
            this.pollInFlight = true;
            try {
                await this.poll();
            } finally {
                this.pollInFlight = false;
            }
            if (this.pollers > 0) this.schedule(this.pollIntervalMs);
        }, delay);
    }

    /** One poll: the metadata when it's due (always while the VPN is off), then the new events. */
    async poll(): Promise<void> {
        try {
            if (!this.running || this.polls % METADATA_EVERY_POLLS === 0) await this.refreshMetadata();
            this.polls += 1;
            if (this.running) await this.refreshEvents();
            runInAction(() => { this.error = undefined; });
        } catch (e: any) {
            runInAction(() => { this.error = e?.message ?? String(e); });
        }
    }

    async refreshMetadata(): Promise<void> {
        const raw = await this.api.getMetadata();
        if (!isRecord(raw)) return;
        const capabilities = isRecord(raw.capabilities) ? raw.capabilities : {};

        runInAction(() => {
            this.running = raw.running === true;
            this.settings = parseVpnSettings(raw.settings);
            this.capture = parseCaptureState(raw.capture);
            this.capabilities = {
                quicDecrypt: capabilities.quicDecrypt === true,
                ikev2: capabilities.ikev2 === true
            };
        });
    }

    async refreshEvents(): Promise<void> {
        const raw = await this.api.getEvents(this.seq);
        if (!isRecord(raw) || typeof raw.seq !== 'number') return;
        const events = Array.isArray(raw.events) ? raw.events.filter(isRecord) : [];
        this.addEvents(events, raw.seq);
    }

    // --- Events from the tunnel ---

    @action
    addEvents(events: Raw[], seq: number) {
        // A lower number means the server started again: its events are all new to us
        if (seq < this.seq) this.relayedQuic.clear();
        this.seq = seq;
        const now = this.now();

        for (const event of events) {
            // The server stamps each event when the helper reported it
            const at = typeof event.at === 'number' && event.at > 0 ? event.at : now;
            switch (event.event) {
                case 'dns':
                    this.dnsQueries.push({
                        peer: text(event.peer) ?? '',
                        name: text(event.name) ?? '',
                        qtype: text(event.qtype) ?? '',
                        rcode: text(event.rcode) ?? '',
                        answers: strings(event.answers),
                        ms: count(event.ms),
                        ...(event.rule === 'blocked' || event.rule === 'answered' ? { rule: event.rule } : {}),
                        at
                    });
                    break;

                case 'udp-open': {
                    const peer = text(event.peer) ?? '';
                    const dst = text(event.dst) ?? '';
                    const relayKey = `${peer} ${dst}`;
                    const relayed = this.relayedQuic.delete(relayKey);
                    this.udpFlows.push({
                        flow: String(event.flow ?? ''),
                        peer,
                        src: text(event.src) ?? '',
                        dst,
                        ...(text(event.name) ? { name: text(event.name) } : {}),
                        bytesUp: 0,
                        bytesDown: 0,
                        packetsUp: 0,
                        packetsDown: 0,
                        openedAt: at,
                        ...(relayed ? { quic: 'relayed' as const } : {})
                    });
                    break;
                }

                case 'udp-update':
                case 'udp-close':
                    this.updateFlow(event, at);
                    break;

                case 'quic': {
                    const mark = quicMark(event.action);
                    const peer = text(event.peer) ?? '';
                    const dst = text(event.dst) ?? '';
                    if (mark === 'relayed') {
                        // Its udp-open follows and carries the counters
                        this.relayedQuic.add(`${peer} ${dst}`);
                    } else if (mark) {
                        // Blocked and decrypted QUIC never becomes a relayed UDP flow, so it
                        // gets a row of its own
                        this.udpFlows.push({
                            flow: `quic-${seq}-${this.udpFlows.length}`,
                            peer,
                            src: '',
                            dst,
                            bytesUp: 0,
                            bytesDown: 0,
                            packetsUp: 0,
                            packetsDown: 0,
                            openedAt: at,
                            quic: mark
                        });
                    }
                    break;
                }

                case 'tls-hello':
                    this.tlsHellos.push({
                        peer: text(event.peer) ?? '',
                        dst: text(event.dst) ?? '',
                        ...(text(event.sni) ? { sni: text(event.sni) } : {}),
                        alpn: strings(event.alpn),
                        ja4: text(event.ja4) ?? '',
                        at
                    });
                    break;

                case 'stats': {
                    const stats: VpnStats = { ...event };
                    delete stats.event;
                    delete stats.seq;
                    delete stats.at;
                    this.stats = stats;
                    break;
                }
            }
        }

        trimmed(this.dnsQueries, MAX_DNS_QUERIES);
        trimmed(this.udpFlows, MAX_UDP_FLOWS);
        trimmed(this.tlsHellos, MAX_TLS_HELLOS);
    }

    private updateFlow(event: Raw, at: number) {
        const flow = String(event.flow ?? '');
        const peer = text(event.peer) ?? '';
        // The newest flow with that id: ids start again when the helper restarts
        for (let index = this.udpFlows.length - 1; index >= 0; index--) {
            const known = this.udpFlows[index];
            if (known.flow !== flow || known.peer !== peer || known.closedAt !== undefined) continue;

            this.udpFlows[index] = {
                ...known,
                bytesUp: count(event.bytesUp),
                bytesDown: count(event.bytesDown),
                packetsUp: count(event.packetsUp),
                packetsDown: count(event.packetsDown),
                ...(event.event === 'udp-close' ? { closedAt: at } : {})
            };
            return;
        }
    }

    // --- Actions ---

    /** Sends a settings patch; the store then holds what the server saved. */
    async configure(patch: Partial<VpnSettings>): Promise<void> {
        const saved = await this.api.activate({ action: 'configure', settings: patch });
        runInAction(() => {
            this.settings = parseVpnSettings(saved);
        });
    }

    async startCapture(): Promise<VpnCaptureState> {
        const state = parseCaptureState(await this.api.activate({ action: 'capture-start' }));
        runInAction(() => { this.capture = state; });
        return state;
    }

    async stopCapture(): Promise<VpnCaptureState> {
        const state = parseCaptureState(await this.api.activate({ action: 'capture-stop' }));
        runInAction(() => { this.capture = state; });
        return state;
    }

    @action
    clear() {
        this.dnsQueries = [];
        this.udpFlows = [];
        this.tlsHellos = [];
    }
}

let sharedStore: VpnNetworkStore | undefined;

/** The one store the app uses (index.tsx creates it with the proxy port it should talk to). */
export function getVpnNetworkStore(getProxyPort: () => number): VpnNetworkStore {
    return sharedStore ??= new VpnNetworkStore(createServerVpnNetworkApi(getProxyPort));
}
