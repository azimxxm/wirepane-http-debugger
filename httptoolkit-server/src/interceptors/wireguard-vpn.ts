import * as path from 'path';

import type { Interceptor } from '.';
import type { HtkConfig } from '../config';

import {
    choosePort,
    findTunnelBinary,
    getLanIPv4,
    readSavedPort,
    savePort,
    TunnelBinary
} from './wireguard-vpn-env';
import { TunnelPeer, TunnelSidecar } from './wireguard-vpn-sidecar';

// Phone traffic comes into the wirepane-tunnel helper as a WireGuard VPN. The helper
// turns every TCP flow into a SOCKS connection to the proxy, so the proxy sees (and can
// rewrite) it like any other traffic. This interceptor starts and stops the helper, and
// tells the UI who is connected.

export interface WireGuardVpnMetadata {
    available: boolean; // false when the wirepane-tunnel binary can't be found
    running: boolean;
    listen: string; // e.g. "0.0.0.0:51873", empty while the helper isn't running
    endpointHost: string; // the address phones dial, empty when this machine has none
    peers: TunnelPeer[];
    error?: string;
}

export interface AddPeerResult {
    peer: string;
    name: string;
    tunnelIp: string;
    config: string;
}

type WireGuardVpnOptions =
    | { action: 'start' }
    | { action: 'add-peer', name: string }
    | { action: 'remove-peer', peer: string };

const DEFAULT_PEER_NAME = 'iPhone';
const MAX_PEER_NAME_LENGTH = 64;
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// Peer names end up in a text config, so keep them to one plain line
function cleanPeerName(name: unknown): string {
    if (typeof name !== 'string') return DEFAULT_PEER_NAME;
    const cleaned = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_PEER_NAME_LENGTH);
    return cleaned || DEFAULT_PEER_NAME;
}

function parseOptions(options: unknown): WireGuardVpnOptions {
    // Activating with no options (an empty body over REST, say) is the same as starting the VPN
    if (options === undefined || options === null) return { action: 'start' };
    if (typeof options !== 'object') throw new Error('Invalid wireguard-vpn options');

    const { action, name, peer } = options as Record<string, unknown>;

    switch (action) {
        case undefined:
        case 'start':
            return { action: 'start' };
        case 'add-peer':
            return { action, name: cleanPeerName(name) };
        case 'remove-peer':
            if (typeof peer !== 'string' || !PEER_ID_PATTERN.test(peer)) {
                throw new Error('remove-peer needs the id of the peer to remove');
            }
            return { action, peer };
        default:
            throw new Error(`Unknown wireguard-vpn action: ${String(action)}`);
    }
}

export class WireGuardVpnInterceptor implements Interceptor {

    id = 'wireguard-vpn';
    version = '1.0.0';

    constructor(
        private config: HtkConfig,
        // Only tests pass this, to run without the real binary
        private locateBinary: () => TunnelBinary = findTunnelBinary
    ) {}

    private sidecar: TunnelSidecar | undefined;
    // Why the helper last stopped by itself, shown until it's started again
    private stoppedError: string | undefined;

    // Start, stop and restart steps run one after another, so two UI calls arriving
    // together can't start two helpers.
    private lifecycle: Promise<unknown> = Promise.resolve();
    private serialize<T>(step: () => Promise<T>): Promise<T> {
        const result = this.lifecycle.then(step);
        this.lifecycle = result.catch(() => {});
        return result;
    }

    private get statePath() {
        return path.join(this.config.configPath, 'wirepane-vpn.json');
    }

    async isActivable(): Promise<boolean> {
        return !!this.locateBinary().path;
    }

    isActive(proxyPort: number): boolean {
        return !!this.sidecar && this.sidecar.socksAddr === socksAddress(proxyPort);
    }

    async getMetadata(): Promise<WireGuardVpnMetadata> {
        const binary = this.locateBinary();
        const sidecar = this.sidecar;

        const error = !binary.path
            ? binary.error
            : sidecar?.lastError ?? this.stoppedError;

        return {
            available: !!binary.path,
            running: !!sidecar,
            listen: sidecar?.listen ?? '',
            endpointHost: sidecar?.endpointHost ?? getLanIPv4() ?? '',
            peers: sidecar?.listPeers() ?? [],
            ...(error ? { error } : {})
        };
    }

    async activate(proxyPort: number, rawOptions?: unknown): Promise<WireGuardVpnMetadata | AddPeerResult | { removed: true }> {
        if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
            throw new Error(`Invalid proxy port: ${proxyPort}`);
        }
        const options = parseOptions(rawOptions);

        return this.serialize(async () => {
            const sidecar = await this.ensureRunning(proxyPort);

            switch (options.action) {
                case 'start':
                    return this.getMetadata();

                case 'add-peer':
                    return sidecar.addPeer(options.name);

                case 'remove-peer':
                    await sidecar.removePeer(options.peer);
                    return { removed: true as const };
            }
        });
    }

    async deactivate(_proxyPort?: number): Promise<void> {
        await this.serialize(() => this.stopSidecar());
    }

    async deactivateAll(): Promise<void> {
        await this.serialize(() => this.stopSidecar());
    }

    // --- The helper process ---

    private async ensureRunning(proxyPort: number): Promise<TunnelSidecar> {
        const binary = this.locateBinary();
        if (!binary.path) throw new Error(binary.error);

        const socksAddr = socksAddress(proxyPort);
        const endpointHost = getLanIPv4();

        const running = this.sidecar;
        if (running) {
            // The network changed under a running helper: its configs would hand out an old
            // address, so it starts again. Its saved peers keep working.
            if (running.endpointHost !== endpointHost) {
                await this.stopSidecar();
            } else if (running.socksAddr === socksAddr) {
                return running;
            } else {
                // The proxy moved to another port (the UI reloaded, say). The helper can
                // switch over without dropping the phones.
                try {
                    await running.setSocks(socksAddr);
                    return running;
                } catch (e: any) {
                    console.warn(`wireguard-vpn: switching the proxy port failed (${e?.message}), restarting the helper`);
                    await this.stopSidecar();
                }
            }
        }

        const listenPort = await choosePort(await readSavedPort(this.config.configPath));
        const sidecar = await TunnelSidecar.start({
            binaryPath: binary.path,
            listenPort,
            statePath: this.statePath,
            socksAddr,
            endpointHost
        });

        // Remember the port only once it works, so a scanned QR code keeps its port later
        await savePort(this.config.configPath, listenPort).catch((e) => {
            console.warn(`wireguard-vpn: could not save the VPN port (${e?.message})`);
        });

        this.sidecar = sidecar;
        this.stoppedError = undefined;

        sidecar.exited.then(({ unexpected, message }) => {
            if (this.sidecar !== sidecar) return; // Already replaced or stopped on purpose
            this.sidecar = undefined;
            if (unexpected) this.stoppedError = message;
        });

        return sidecar;
    }

    private async stopSidecar() {
        const sidecar = this.sidecar;
        this.sidecar = undefined;
        this.stoppedError = undefined;
        await sidecar?.stop();
    }

}

const socksAddress = (proxyPort: number) => `127.0.0.1:${proxyPort}`;
