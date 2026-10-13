import { action, computed, observable, runInAction } from 'mobx';

import { getReadableSize } from '../../util/buffer';
import type { VpnNetworkStore, VpnQuicMode, VpnUdpFlow } from './vpn-network';

/*
 * The logic behind the Network page's UDP tab: how the flows are sorted, counted and described,
 * and how the QUIC mode is chosen and saved. The tab itself (components/network/udp-tab.tsx)
 * only draws what this file works out. Contract: docs/plans/2026-10-13-rust-network-tools.md.
 */

const describeError = (error: unknown) =>
    error instanceof Error && error.message
        ? error.message
        : 'Something went wrong. Try again.';

// --- The flow table ---

export type UdpSortKey = 'newest' | 'bytes';

export const UDP_SORT_OPTIONS: ReadonlyArray<{ key: UdpSortKey, label: string }> = [
    { key: 'newest', label: 'Newest first' },
    { key: 'bytes', label: 'Most data first' }
];

// A busy phone can open thousands of UDP flows. Drawing all of them every second would make
// the page slow, so the table shows the first rows of the sorted list.
export const MAX_UDP_ROWS = 500;

export const totalBytes = (flow: Pick<VpnUdpFlow, 'bytesUp' | 'bytesDown'>) =>
    flow.bytesUp + flow.bytesDown;

export const totalPackets = (flow: Pick<VpnUdpFlow, 'packetsUp' | 'packetsDown'>) =>
    flow.packetsUp + flow.packetsDown;

// A flow the tunnel doesn't track has no counts: it only says it refused a QUIC connection, and the
// table shows a dash there instead of "0 bytes"
export const hasUdpCounts = (flow: Pick<VpnUdpFlow, 'bytesUp' | 'bytesDown' | 'packetsUp' | 'packetsDown'>) =>
    totalBytes(flow) > 0 || totalPackets(flow) > 0;

// The tunnel reports blocked QUIC once and never follows it, and decrypted QUIC the same until
// it has counters. Such a flow is neither open nor closed, and has no duration to show.
export type UdpFlowState = 'open' | 'closed' | 'untracked';

export function getUdpFlowState(
    flow: Pick<VpnUdpFlow, 'closedAt' | 'quic' | 'bytesUp' | 'bytesDown' | 'packetsUp' | 'packetsDown'>
): UdpFlowState {
    if (flow.quic === 'blocked') return 'untracked';
    if (flow.quic === 'decrypted' && flow.closedAt === undefined && !hasUdpCounts(flow)) return 'untracked';
    return flow.closedAt === undefined ? 'open' : 'closed';
}

/** How long the flow lasted, or has lasted so far when it is still open. */
export function getUdpFlowDurationMs(flow: Pick<VpnUdpFlow, 'openedAt' | 'closedAt'>, now: number): number {
    return Math.max(0, (flow.closedAt ?? now) - flow.openedAt);
}

/** "850 ms", "12 s", "3 min 20 s", "1 h 5 min". */
export function formatUdpDuration(durationMs: number): string {
    if (!Number.isFinite(durationMs) || durationMs < 0) return '0 ms';

    // Round first, so 999.6 ms reads "1 s" and not "1000 ms"
    const rounded = Math.round(durationMs);
    if (rounded < 1000) return `${rounded} ms`;

    const totalSeconds = Math.floor(rounded / 1000);
    if (totalSeconds < 60) return `${totalSeconds} s`;

    const totalMinutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (totalMinutes < 60) return seconds ? `${totalMinutes} min ${seconds} s` : `${totalMinutes} min`;

    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes ? `${hours} h ${minutes} min` : `${hours} h`;
}

const countFormat = new Intl.NumberFormat('en-US');

/** "1,234" */
export const formatUdpCount = (count: number) => countFormat.format(count);

/** "1.4 kB", the same sizes the rest of the app shows. */
export const formatUdpBytes = (bytes: number) => getReadableSize(bytes);

/**
 * The flows in the order the table shows them, as a new list. `newest` puts the flow that opened
 * last first; `bytes` puts the one that moved the most data (both ways) first. Ties go to the
 * flow the store got later, so the order doesn't jump around between refreshes.
 */
export function sortUdpFlows(flows: ReadonlyArray<VpnUdpFlow>, key: UdpSortKey): VpnUdpFlow[] {
    const primary = (flow: VpnUdpFlow) => key === 'bytes' ? totalBytes(flow) : flow.openedAt;

    return flows
        .map((flow, index) => ({ flow, index }))
        .sort((a, b) => (primary(b.flow) - primary(a.flow)) || (b.index - a.index))
        .map((entry) => entry.flow);
}

export interface UdpSummary {
    flows: number;
    open: number;
    bytes: number;
    quicBlocked: number;
}

export function summariseUdpFlows(flows: ReadonlyArray<VpnUdpFlow>): UdpSummary {
    const summary: UdpSummary = { flows: flows.length, open: 0, bytes: 0, quicBlocked: 0 };

    flows.forEach((flow) => {
        if (getUdpFlowState(flow) === 'open') summary.open += 1;
        if (flow.quic === 'blocked') summary.quicBlocked += 1;
        summary.bytes += totalBytes(flow);
    });
    return summary;
}

export type QuicMarkKind = NonNullable<VpnUdpFlow['quic']>;

export interface QuicMark {
    kind: QuicMarkKind;
    label: string;
    description: string;
}

const QUIC_MARKS: { [kind in QuicMarkKind]: QuicMark } = {
    blocked: {
        kind: 'blocked',
        label: 'Blocked',
        description: 'Wirepane refused this QUIC (HTTP/3) connection, so the app falls back to HTTPS, which Wirepane can read.'
    },
    relayed: {
        kind: 'relayed',
        label: 'Let through',
        description: 'Wirepane let this QUIC (HTTP/3) connection through untouched, so its requests are not shown in View.'
    },
    decrypted: {
        kind: 'decrypted',
        label: 'Decrypted',
        description: 'Wirepane decrypted this QUIC (HTTP/3) connection: its requests show up in View.'
    }
};

/** The QUIC mark for a flow, or undefined for UDP that isn't QUIC. */
export function describeQuicMark(flow: Pick<VpnUdpFlow, 'quic'>): QuicMark | undefined {
    return flow.quic ? QUIC_MARKS[flow.quic] : undefined;
}

// --- What this build of the VPN helper can do ---

// What the helper says about itself when it starts, as the store keeps it. A helper that isn't
// running says nothing, so "can't decrypt" then only means "not known".
export interface QuicSupport {
    canDecrypt: boolean;
    helperRunning: boolean;
}

export const getQuicSupport = (store: Pick<VpnNetworkStore, 'capabilities' | 'running'>): QuicSupport => ({
    canDecrypt: store.capabilities.quicDecrypt,
    helperRunning: store.running
});

// --- The QUIC mode ---

export interface QuicModeOption {
    mode: VpnQuicMode;
    label: string;
    // Said right after the label, in brackets
    note?: string;
    description: string;
}

export const QUIC_MODE_OPTIONS: ReadonlyArray<QuicModeOption> = [
    {
        mode: 'block',
        label: 'Block',
        note: '(recommended: apps fall back to HTTPS Wirepane can read)',
        description: 'QUIC is refused at once, so apps switch to HTTPS and their requests show up in View.'
    },
    {
        mode: 'relay',
        label: 'Let through',
        description: 'QUIC passes untouched. You see its UDP flow here, but not the requests inside it.'
    },
    {
        mode: 'decrypt',
        label: 'Decrypt (beta)',
        description: 'Wirepane reads HTTP/3 itself and shows its requests in View. Apps that pin their certificate can still fail.'
    }
];

/**
 * Why a QUIC mode can't be picked, or undefined when it can. Only Decrypt needs the helper's
 * support (`capabilities.quicDecrypt` in the server's metadata).
 */
export function quicModeUnavailableReason(mode: VpnQuicMode, support: QuicSupport): string | undefined {
    if (mode !== 'decrypt' || support.canDecrypt) return undefined;

    return support.helperRunning
        ? "This build's VPN helper can't decrypt HTTP/3 yet."
        : 'Start the VPN to check: its helper says whether this build can decrypt HTTP/3.';
}

/**
 * Choosing the QUIC mode: the choice shows at once, and goes back if the server refuses to save
 * it. Saving goes through the store, which sends it to the helper and keeps it for the next start.
 */
export class QuicModeController {

    // The mode being saved
    @observable.ref pending: VpnQuicMode | undefined = undefined;
    @observable.ref error: string | undefined = undefined;

    constructor(private readonly store: Pick<VpnNetworkStore, 'settings' | 'configure'>) {}

    @computed get selected(): VpnQuicMode {
        return this.pending ?? this.store.settings.quic;
    }

    @computed get saving(): boolean {
        return this.pending !== undefined;
    }

    /** Resolves true if the mode was saved. */
    @action.bound
    async choose(mode: VpnQuicMode, support: QuicSupport): Promise<boolean> {
        if (this.saving || mode === this.selected) return false;
        if (quicModeUnavailableReason(mode, support)) return false;

        this.pending = mode;
        this.error = undefined;

        try {
            await this.store.configure({ quic: mode });
            return true;
        } catch (e) {
            runInAction(() => { this.error = describeError(e); });
            return false;
        } finally {
            runInAction(() => { this.pending = undefined; });
        }
    }
}
