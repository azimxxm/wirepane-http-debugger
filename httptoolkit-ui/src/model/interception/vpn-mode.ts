import { action, computed, observable, runInAction } from 'mobx';

import { activateInterceptor, getDetailedInterceptorMetadata } from '../../services/server-api';

// The server interceptor that runs the WireGuard tunnel (see docs/plans/2026-10-12-iphone-fixes-and-vpn.md)
export const VPN_INTERCEPTOR_ID = 'wireguard-vpn';

const DEFAULT_PEER_NAME = 'iPhone';
const POLL_INTERVAL_MS = 2000;
// WireGuard repeats its handshake about every 2 minutes while traffic flows, so a newer
// handshake than this means the phone's tunnel is up.
export const FRESH_HANDSHAKE_MS = 3 * 60 * 1000;

// --- What the server tells us ---

export interface VpnPeer {
    peer: string;
    name: string;
    tunnelIp?: string;
    // The phone's address on the network, once it has reached us
    endpoint?: string;
    // Milliseconds since the epoch
    lastHandshake?: number;
}

export interface VpnMetadata {
    available: boolean;
    running: boolean;
    listen?: string;
    endpointHost?: string;
    peers: VpnPeer[];
    error?: string;
}

// What adding a device returns: `config` is the wg-quick text the WireGuard app imports
export interface VpnPeerConfig {
    peer: string;
    name: string;
    tunnelIp?: string;
    config: string;
}

export type VpnActivateOptions =
    | { action: 'start' }
    | { action: 'stop' }
    | { action: 'add-peer', name: string }
    | { action: 'remove-peer', peer: string };

// The two server calls this store needs, so tests can fake the server
export interface VpnServerApi {
    activate(options: VpnActivateOptions): Promise<unknown>;
    getMetadata(): Promise<unknown>;
}

export const createServerVpnApi = (getProxyPort: () => number): VpnServerApi => ({
    activate: (options) => activateInterceptor(VPN_INTERCEPTOR_ID, getProxyPort(), options),
    getMetadata: () => getDetailedInterceptorMetadata(VPN_INTERCEPTOR_ID)
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const optionalString = (value: unknown) =>
    typeof value === 'string' && value ? value : undefined;

function parsePeer(raw: unknown): VpnPeer | undefined {
    if (!isRecord(raw)) return undefined;

    const peer = optionalString(raw.peer);
    if (!peer) return undefined;

    const { lastHandshake } = raw;
    return {
        peer,
        name: optionalString(raw.name) ?? peer,
        tunnelIp: optionalString(raw.tunnelIp),
        endpoint: optionalString(raw.endpoint),
        lastHandshake: typeof lastHandshake === 'number' && lastHandshake > 0
            ? lastHandshake
            : undefined
    };
}

/**
 * The server's detailed metadata, or undefined if it isn't the shape of a VPN interceptor's
 * (an old server, or a build without VPN mode).
 */
export function parseVpnMetadata(raw: unknown): VpnMetadata | undefined {
    if (!isRecord(raw)) return undefined;

    const peers = Array.isArray(raw.peers)
        ? raw.peers.map(parsePeer).filter((peer): peer is VpnPeer => !!peer)
        : [];

    return {
        available: raw.available === true,
        running: raw.running === true,
        listen: optionalString(raw.listen),
        endpointHost: optionalString(raw.endpointHost),
        peers,
        error: optionalString(raw.error)
    };
}

export function parsePeerConfig(raw: unknown): VpnPeerConfig | undefined {
    if (!isRecord(raw)) return undefined;

    const peer = optionalString(raw.peer);
    const config = optionalString(raw.config);
    if (!peer || !config) return undefined;

    return {
        peer,
        config,
        name: optionalString(raw.name) ?? DEFAULT_PEER_NAME,
        tunnelIp: optionalString(raw.tunnelIp)
    };
}

// "iPhone", then "iPhone 2" and so on, so a second phone doesn't clash with the first one
export function nextPeerName(existing: ReadonlyArray<Pick<VpnPeer, 'name'>>): string {
    const taken = new Set(existing.map((peer) => peer.name));
    if (!taken.has(DEFAULT_PEER_NAME)) return DEFAULT_PEER_NAME;

    let number = 2;
    while (taken.has(`${DEFAULT_PEER_NAME} ${number}`)) number += 1;
    return `${DEFAULT_PEER_NAME} ${number}`;
}

export function formatHandshakeAge(ageMs: number): string {
    const seconds = Math.max(0, Math.round(ageMs / 1000));
    if (seconds < 60) return `${seconds} s ago`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;

    return `${Math.floor(minutes / 60)} h ago`;
}

const describeError = (error: unknown) =>
    error instanceof Error && error.message
        ? error.message
        : 'Something went wrong. Try again.';

// --- The store ---

export type VpnAvailability = 'checking' | 'available' | 'unavailable';
export type VpnBusy = 'starting' | 'adding-device' | 'stopping';
export type PhoneVpnState = 'waiting' | 'connected' | 'quiet';

/**
 * The state of VPN mode for the iPhone page: whether this build has it, whether the tunnel
 * runs, the QR code for the phone, and whether the phone has connected yet.
 */
export class VpnModeStore {

    @observable availability: VpnAvailability = 'checking';
    @observable.ref metadata: VpnMetadata | undefined = undefined;
    // Only known right after adding a device: the server doesn't keep showing it
    @observable.ref peerConfig: VpnPeerConfig | undefined = undefined;
    @observable busy: VpnBusy | undefined = undefined;
    @observable errorMessage: string | undefined = undefined;
    // When the metadata was read, so "last handshake 3 s ago" is measured from then
    @observable observedAt: number;

    private refreshing: Promise<void> | undefined;

    constructor(
        private readonly api: VpnServerApi,
        private readonly now: () => number = Date.now,
        private readonly pollIntervalMs: number = POLL_INTERVAL_MS
    ) {
        this.observedAt = now();
    }

    @computed get running() {
        return this.metadata?.running === true;
    }

    @computed get peers(): ReadonlyArray<VpnPeer> {
        return this.metadata?.peers ?? [];
    }

    // The phone this page is about: the one just added, else the most recently seen one
    @computed get trackedPeer(): VpnPeer | undefined {
        const justAdded = this.peerConfig
            ? this.peers.find((peer) => peer.peer === this.peerConfig!.peer)
            : undefined;
        if (justAdded) return justAdded;

        return [...this.peers].sort((a, b) => (b.lastHandshake ?? 0) - (a.lastHandshake ?? 0))[0];
    }

    @computed get handshakeAgeMs(): number | undefined {
        const handshake = this.trackedPeer?.lastHandshake;
        return handshake === undefined ? undefined : Math.max(0, this.observedAt - handshake);
    }

    @computed get phoneState(): PhoneVpnState {
        const age = this.handshakeAgeMs;
        if (age === undefined) return 'waiting';
        return age <= FRESH_HANDSHAKE_MS ? 'connected' : 'quiet';
    }

    // The server found the tunnel can't run, e.g. its UDP port is taken
    @computed get serverProblem() {
        return this.metadata?.error;
    }

    refresh(): Promise<void> {
        // Polls never pile up behind a slow server
        if (this.refreshing) return this.refreshing;

        const refreshing = this.readMetadata().finally(() => {
            this.refreshing = undefined;
        });
        this.refreshing = refreshing;
        return refreshing;
    }

    private async readMetadata() {
        let metadata: VpnMetadata | undefined;
        let failed = false;
        try {
            metadata = parseVpnMetadata(await this.api.getMetadata());
        } catch (e) {
            failed = true;
        }

        runInAction(() => {
            this.observedAt = this.now();

            // A server without this interceptor answers with an error or nothing at all
            if (!metadata || !metadata.available) {
                // Once the tunnel is known to work, one failed poll doesn't take it away
                if (failed && this.availability === 'available') return;
                this.availability = 'unavailable';
                this.metadata = undefined;
                return;
            }

            this.availability = 'available';
            this.metadata = metadata;
        });
    }

    /**
     * Polls the server until the returned function is called, e.g. while the page is open.
     */
    startPolling(): () => void {
        let stopped = false;
        let timer: ReturnType<typeof setTimeout> | undefined;

        const poll = async () => {
            await this.refresh();
            if (!stopped) timer = setTimeout(poll, this.pollIntervalMs);
        };
        poll();

        return () => {
            stopped = true;
            if (timer) clearTimeout(timer);
        };
    }

    /**
     * Starts the tunnel, and if no device is set up yet, adds the iPhone. A device that was
     * set up before keeps working: its WireGuard config is still valid.
     */
    @action.bound
    async start() {
        await this.runBusy('starting', async () => {
            await this.api.activate({ action: 'start' });
            await this.refreshAfterChange();
            if (this.availability !== 'available') return;

            if (this.peers.length === 0) await this.addPeer();
        });
    }

    /** Sets up another device and keeps its config so the page can show the QR code. */
    @action.bound
    async addDevice() {
        await this.runBusy('adding-device', () => this.addPeer());
    }

    @action.bound
    async stop() {
        await this.runBusy('stopping', async () => {
            await this.api.activate({ action: 'stop' });
            runInAction(() => { this.peerConfig = undefined; });
            await this.refreshAfterChange();
        });
    }

    private async addPeer() {
        const result = await this.api.activate({
            action: 'add-peer',
            name: nextPeerName(this.peers)
        });
        const peerConfig = parsePeerConfig(result);
        if (!peerConfig) throw new Error("The server didn't send a WireGuard configuration.");

        runInAction(() => { this.peerConfig = peerConfig; });
        await this.refreshAfterChange();
    }

    // A poll that began before an action finished could still show the old state, so wait it out
    private async refreshAfterChange() {
        await this.refreshing; // Never rejects: reading the metadata catches its own errors
        await this.refresh();
    }

    private async runBusy(busy: VpnBusy, task: () => Promise<void>) {
        if (this.busy) return;

        runInAction(() => {
            this.busy = busy;
            this.errorMessage = undefined;
        });

        try {
            await task();
        } catch (e) {
            runInAction(() => { this.errorMessage = describeError(e); });
        } finally {
            runInAction(() => { this.busy = undefined; });
        }
    }
}

// One store for the whole app, so the QR code and the tunnel's state survive leaving the page
let sharedStore: VpnModeStore | undefined;

export function getVpnModeStore(getProxyPort: () => number): VpnModeStore {
    return sharedStore ??= new VpnModeStore(createServerVpnApi(getProxyPort));
}
