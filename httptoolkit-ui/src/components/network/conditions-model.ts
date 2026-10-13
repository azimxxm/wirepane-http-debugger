import { VpnConditions } from '../../model/interception/vpn-network';

/*
 * The logic behind the Network conditions tab: the presets, turning the text fields into
 * conditions (with the reason when they don't fit), and describing what is active. No React
 * and no MobX here, so it is easy to test. The limits match the sidecar's
 * (wirepane-tunnel/src/features/conditions.rs): it pulls values back inside them anyway.
 */

export const MAX_LATENCY_MS = 60_000;
export const MAX_JITTER_MS = 60_000;
// 10 Gbit/s, far above any link a phone has; keeps a typo like 1e12 out
export const MAX_KBPS = 10_000_000;
export const MAX_LOSS_PCT = 100;

export type ConditionsPresetId = 'off' | '3g' | 'edge' | 'lte' | 'lossy-wifi' | 'offline';

export interface ConditionsPreset {
    id: ConditionsPresetId;
    label: string;
    // null = no conditions at all: the device goes back to the normal network
    conditions: VpnConditions | null;
}

export const CONDITIONS_PRESETS: ReadonlyArray<ConditionsPreset> = [
    { id: 'off', label: 'Off', conditions: null },
    {
        id: '3g',
        label: '3G',
        conditions: { latencyMs: 200, jitterMs: 0, downKbps: 750, upKbps: 250, lossPct: 0 }
    },
    {
        id: 'edge',
        label: 'Edge',
        conditions: { latencyMs: 400, jitterMs: 0, downKbps: 240, upKbps: 200, lossPct: 0 }
    },
    {
        id: 'lte',
        label: 'LTE',
        conditions: { latencyMs: 50, jitterMs: 0, downKbps: 12_000, upKbps: 5_000, lossPct: 0 }
    },
    {
        id: 'lossy-wifi',
        label: 'Lossy Wi-Fi',
        conditions: { latencyMs: 40, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 5 }
    },
    {
        id: 'offline',
        label: 'Offline',
        conditions: { latencyMs: 0, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 100 }
    }
];

export const NO_CONDITIONS: VpnConditions = {
    latencyMs: 0,
    jitterMs: 0,
    downKbps: 0,
    upKbps: 0,
    lossPct: 0
};

/** True when the conditions change nothing (none set, or every value is 0). */
export function isOff(conditions: VpnConditions | null | undefined): boolean {
    if (!conditions) return true;
    return conditions.latencyMs === 0
        && conditions.jitterMs === 0
        && conditions.downKbps === 0
        && conditions.upKbps === 0
        && !(conditions.lossPct > 0);
}

/** Whether two settings do the same thing: no conditions and all zeros are the same. */
export function sameConditions(
    a: VpnConditions | null | undefined,
    b: VpnConditions | null | undefined
): boolean {
    if (isOff(a) || isOff(b)) return isOff(a) && isOff(b);

    return a!.latencyMs === b!.latencyMs
        && a!.jitterMs === b!.jitterMs
        && a!.downKbps === b!.downKbps
        && a!.upKbps === b!.upKbps
        && a!.lossPct === b!.lossPct;
}

/** The preset that does exactly what these conditions do, if there is one. */
export function findPreset(conditions: VpnConditions | null | undefined): ConditionsPreset | undefined {
    return CONDITIONS_PRESETS.find((preset) => sameConditions(preset.conditions, conditions));
}

// --- Describing conditions ---

const trimNumber = (value: number, digits: number) =>
    String(Number(value.toFixed(digits)));

/** "750 kbps", "12 Mbps", "1.5 Mbps"; 0 means no limit. */
export function formatBandwidth(kbps: number): string {
    if (!(kbps > 0)) return 'no limit';
    if (kbps < 1000) return `${trimNumber(kbps, 0)} kbps`;
    return `${trimNumber(kbps / 1000, 2)} Mbps`;
}

/** "5%", "0.5%" */
export function formatLoss(lossPct: number): string {
    return `${trimNumber(lossPct, 2)}%`;
}

/**
 * What the conditions do, in a short line: "750 kbps down, 250 kbps up, 200 ms latency".
 * Parts that are off are left out.
 */
export function describeConditions(conditions: VpnConditions | null | undefined): string {
    if (isOff(conditions)) return 'No limits';
    const { latencyMs, jitterMs, downKbps, upKbps, lossPct } = conditions!;

    if (lossPct >= MAX_LOSS_PCT) return 'All packets are dropped';

    const parts: string[] = [];
    if (downKbps > 0) parts.push(`${formatBandwidth(downKbps)} down`);
    if (upKbps > 0) parts.push(`${formatBandwidth(upKbps)} up`);
    if (latencyMs > 0 || jitterMs > 0) {
        parts.push(jitterMs > 0
            ? `${latencyMs} ms latency ± ${jitterMs} ms jitter`
            : `${latencyMs} ms latency`);
    }
    if (lossPct > 0) parts.push(`${formatLoss(lossPct)} packet loss`);
    return parts.join(', ');
}

/** The line shown under a preset's name. */
export const describePreset = (preset: ConditionsPreset): string =>
    preset.id === 'off' ? 'Normal network' : describeConditions(preset.conditions);

/** "3G" when a preset matches, else "Custom" (and "Off" when nothing is set). */
export function nameConditions(conditions: VpnConditions | null | undefined): string {
    if (isOff(conditions)) return 'Off';
    return findPreset(conditions)?.label ?? 'Custom';
}

// --- The text fields ---

export type ConditionsField = 'latencyMs' | 'jitterMs' | 'downKbps' | 'upKbps' | 'lossPct';

// What the user typed, as text, so half-typed numbers and mistakes can be shown as they are
export type ConditionsFormFields = { [field in ConditionsField]: string };

export interface ConditionsFieldSpec {
    field: ConditionsField;
    label: string;
    unit: string;
    max: number;
    // Whole numbers only (the sidecar counts in whole milliseconds and kbit/s)
    wholeNumber: boolean;
    hint: string;
}

export const CONDITIONS_FIELDS: ReadonlyArray<ConditionsFieldSpec> = [
    {
        field: 'latencyMs',
        label: 'Latency',
        unit: 'ms',
        max: MAX_LATENCY_MS,
        wholeNumber: true,
        hint: 'Added to every packet, each way'
    },
    {
        field: 'jitterMs',
        label: 'Jitter',
        unit: 'ms',
        max: MAX_JITTER_MS,
        wholeNumber: true,
        hint: 'Latency varies by up to this much'
    },
    {
        field: 'downKbps',
        label: 'Download',
        unit: 'kbps',
        max: MAX_KBPS,
        wholeNumber: true,
        hint: '0 means no limit'
    },
    {
        field: 'upKbps',
        label: 'Upload',
        unit: 'kbps',
        max: MAX_KBPS,
        wholeNumber: true,
        hint: '0 means no limit'
    },
    {
        field: 'lossPct',
        label: 'Packet loss',
        unit: '%',
        max: MAX_LOSS_PCT,
        wholeNumber: false,
        hint: 'Chance that a packet is lost'
    }
];

export function toFormFields(conditions: VpnConditions | null | undefined): ConditionsFormFields {
    const values = conditions ?? NO_CONDITIONS;
    return {
        latencyMs: String(values.latencyMs),
        jitterMs: String(values.jitterMs),
        downKbps: String(values.downKbps),
        upKbps: String(values.upKbps),
        lossPct: String(values.lossPct)
    };
}

export type ConditionsFieldErrors = { [field in ConditionsField]?: string };

export type ParsedConditions =
    | { ok: true, conditions: VpnConditions }
    | { ok: false, errors: ConditionsFieldErrors };

const NUMBER_PATTERN = /^[+-]?(\d+\.?\d*|\.\d+)$/;

function parseField(spec: ConditionsFieldSpec, text: string): { value: number } | { error: string } {
    const trimmed = text.trim();
    // An empty field means "none", like the 0 the form starts with
    if (trimmed === '') return { value: 0 };

    // Number() would also take '0x10', '1e3' and 'Infinity'
    if (!NUMBER_PATTERN.test(trimmed)) return { error: 'Enter a number' };

    const value = Number(trimmed);
    if (value < 0) return { error: 'Can\'t be negative' };
    if (spec.wholeNumber && !Number.isInteger(value)) return { error: 'Use a whole number' };
    if (value > spec.max) return { error: `At most ${spec.max}` };

    return { value };
}

/** Turns what the user typed into conditions, or says what is wrong with each field. */
export function parseConditionsFields(fields: ConditionsFormFields): ParsedConditions {
    const values: { [field in ConditionsField]?: number } = {};
    const errors: ConditionsFieldErrors = {};

    CONDITIONS_FIELDS.forEach((spec) => {
        const result = parseField(spec, fields[spec.field]);
        if ('error' in result) {
            errors[spec.field] = result.error;
        } else {
            values[spec.field] = result.value;
        }
    });

    if (Object.keys(errors).length > 0) return { ok: false, errors };

    return {
        ok: true,
        conditions: {
            latencyMs: values.latencyMs!,
            jitterMs: values.jitterMs!,
            downKbps: values.downKbps!,
            upKbps: values.upKbps!,
            // Two decimals are plenty, and keep 0.1 + 0.2 style noise out of the saved settings
            lossPct: Number(values.lossPct!.toFixed(2))
        }
    };
}

// --- Devices ---

// What the picker needs to know about a VPN device
export interface ConditionsDevice {
    peer: string;
    name: string;
    tunnelIp?: string;
    // ms since the epoch
    lastHandshake?: number;
}

/**
 * The device to start on: one that already has conditions, else the one that connected most
 * recently, else the first.
 */
export function pickDefaultDevice(
    devices: ReadonlyArray<ConditionsDevice>,
    conditionsByPeer: { [peer: string]: VpnConditions | null | undefined }
): ConditionsDevice | undefined {
    const withConditions = devices.find((device) => !isOff(conditionsByPeer[device.peer]));
    if (withConditions) return withConditions;

    return [...devices].sort((a, b) => (b.lastHandshake ?? 0) - (a.lastHandshake ?? 0))[0];
}

/** How many devices have conditions on, for the tab's summary. */
export function countActive(
    devices: ReadonlyArray<ConditionsDevice>,
    conditionsByPeer: { [peer: string]: VpnConditions | null | undefined }
): number {
    return devices.filter((device) => !isOff(conditionsByPeer[device.peer])).length;
}
