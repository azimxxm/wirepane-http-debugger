import { observable } from 'mobx';

/*
 * The VPN's network tools: what the tunnel saw (DNS, UDP, TLS hellos), its settings (network
 * conditions, DNS rules, QUIC mode) and pcap captures. Contract: docs/plans/2026-10-13-rust-network-tools.md.
 *
 * This file is the lead's stub. T0 implements the polling and the actions; the tools only read
 * the lists and call the actions. The Network page passes the store to each tab as a prop.
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

export class VpnNetworkStore {

    @observable.shallow dnsQueries: VpnDnsQuery[] = [];
    @observable.shallow udpFlows: VpnUdpFlow[] = [];
    @observable.shallow tlsHellos: VpnTlsHello[] = [];
    @observable.ref stats: VpnStats | undefined = undefined;

    @observable.ref settings: VpnSettings = DEFAULT_VPN_SETTINGS;
    @observable.ref capture: VpnCaptureState = { running: false };

    // T0: send the patch to the server (activate 'configure'), then take the saved settings
    async configure(_patch: Partial<VpnSettings>): Promise<void> {
        throw new Error('VPN network settings are not wired up yet');
    }

    // T0: activate 'capture-start' / 'capture-stop'
    async startCapture(): Promise<VpnCaptureState> {
        throw new Error('VPN captures are not wired up yet');
    }

    async stopCapture(): Promise<VpnCaptureState> {
        throw new Error('VPN captures are not wired up yet');
    }
}
