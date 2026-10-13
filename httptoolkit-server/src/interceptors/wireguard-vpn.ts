import * as fs from 'fs';
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
import {
    CaptureSummary,
    Ikev2Status,
    NO_CAPABILITIES,
    TunnelCapabilities,
    TunnelEvent,
    TunnelPeer,
    TunnelSidecar
} from './wireguard-vpn-sidecar';
import {
    createIkev2ProfileAnswer,
    Ikev2ProfileAnswer,
    parseIkev2PeerAdded,
    ProfileLink
} from './wireguard-vpn-ikev2';
import {
    applySettingsPatch,
    capturePath,
    loadSettings,
    parseSettingsPatch,
    saveSettings,
    ToolEventLog,
    VpnSettings,
    VpnSettingsPatch
} from './wireguard-vpn-tools';

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
    // The network tools (docs/plans/2026-10-13-rust-network-tools.md)
    settings: VpnSettings;
    capture: VpnCaptureState;
    capabilities: TunnelCapabilities;
    // IKEv2 for iPhones without the WireGuard app (wirepane-tunnel/docs/ikev2.md): listening
    // or not, and why not when this build has it but UDP 500 or 4500 couldn't be bound
    ikev2: Ikev2Status;
}

export interface VpnCaptureState {
    running: boolean;
    path?: string;
    packets?: number;
    bytes?: number;
}

export interface AddPeerResult {
    peer: string;
    name: string;
    tunnelIp: string;
    config: string;
}

// What tests replace: this machine's LAN address, and how often the helper's counters are read
export interface VpnEnvironment {
    lanAddress?: () => string | undefined;
    statsIntervalMs?: number;
}

type WireGuardVpnOptions =
    | { action: 'start' }
    | { action: 'add-peer', name: string }
    | { action: 'remove-peer', peer: string }
    // The UI's Stop button: the REST API has no deactivate route, so it comes through activate
    | { action: 'stop' }
    // The network tools: a settings patch, and pcap captures of the tunnel
    | { action: 'configure', settings: VpnSettingsPatch }
    | { action: 'capture-start' }
    | { action: 'capture-stop' }
    // A new IKEv2 device and the .mobileconfig profile that sets it up
    | { action: 'ikev2-profile', name: string };

const EVENTS_SUB_ID = /^events-(\d{1,15})$/;

const DEFAULT_PEER_NAME = 'iPhone';
const MAX_PEER_NAME_LENGTH = 64;
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

// iOS dials IKEv2 on UDP 500 and its profile has no port setting; NAT-T then uses 4500
const IKEV2_LISTEN = '0.0.0.0:500';

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

    const { action, name, peer, settings } = options as Record<string, unknown>;

    switch (action) {
        case undefined:
        case 'start':
            return { action: 'start' };
        case 'add-peer':
        case 'ikev2-profile':
            return { action, name: cleanPeerName(name) };
        case 'stop':
        case 'capture-start':
        case 'capture-stop':
            return { action };
        case 'configure':
            return { action, settings: parseSettingsPatch(settings) };
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
        // Only tests pass these, to run without the real binary or this machine's network
        private locateBinary: () => TunnelBinary = findTunnelBinary,
        private environment: VpnEnvironment = {}
    ) {}

    private lanAddress(): string | undefined {
        return this.environment.lanAddress ? this.environment.lanAddress() : getLanIPv4();
    }

    private sidecar: TunnelSidecar | undefined;
    // Why the helper last stopped by itself, shown until it's started again
    private stoppedError: string | undefined;

    // The network tools' settings (loaded once from the config folder), the running capture
    // and the helper's events for the UI
    private settings: VpnSettings | undefined;
    private capture: VpnCaptureState = { running: false };
    private readonly toolEvents = new ToolEventLog();
    // The IKEv2 profiles' one-time download links that are still open
    private readonly profileLinks = new Set<ProfileLink>();

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

    private async getSettings(): Promise<VpnSettings> {
        return this.settings ??= await loadSettings(this.config.configPath);
    }

    // The Wirepane CA that generateHTTPSConfig (src/index.ts) keeps next to the VPN state
    private get caCertPath() {
        return path.join(this.config.configPath, 'wirepane-ca.pem');
    }

    private caFiles(): { caCertPath: string, caKeyPath: string } | {} {
        const caCertPath = this.caCertPath;
        const caKeyPath = path.join(this.config.configPath, 'wirepane-ca.key');
        return fs.existsSync(caCertPath) && fs.existsSync(caKeyPath) ? { caCertPath, caKeyPath } : {};
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
            endpointHost: sidecar?.endpointHost ?? this.lanAddress() ?? '',
            peers: sidecar?.listPeers() ?? [],
            ...(error ? { error } : {}),
            settings: await this.getSettings(),
            capture: { ...this.capture },
            capabilities: sidecar?.capabilities ?? NO_CAPABILITIES,
            ikev2: sidecar ? { ...sidecar.ikev2 } : { running: false }
        };
    }

    // `events-<seq>`: what the helper reported after event number <seq>
    async getSubMetadata(subId: string): Promise<{ seq: number, events: TunnelEvent[] }> {
        const match = EVENTS_SUB_ID.exec(subId);
        if (!match) throw new Error(`Unknown wireguard-vpn metadata: ${subId}`);
        return this.toolEvents.since(Number(match[1]));
    }

    async activate(
        proxyPort: number,
        rawOptions?: unknown
    ): Promise<
        WireGuardVpnMetadata | AddPeerResult | { removed: true } | VpnSettings | VpnCaptureState | Ikev2ProfileAnswer
    > {
        if (!Number.isInteger(proxyPort) || proxyPort < 1 || proxyPort > 65535) {
            throw new Error(`Invalid proxy port: ${proxyPort}`);
        }
        const options = parseOptions(rawOptions);

        if (options.action === 'stop') {
            await this.deactivate(proxyPort);
            return this.getMetadata();
        }

        // These never start the VPN: settings are saved for the next start, and a capture
        // needs a running tunnel
        if (options.action === 'configure') {
            return this.serialize(() => this.configure(options.settings));
        }
        if (options.action === 'capture-start') {
            return this.serialize(() => this.startCapture());
        }
        if (options.action === 'capture-stop') {
            return this.serialize(() => this.stopCapture());
        }

        return this.serialize(async () => {
            const sidecar = await this.ensureRunning(proxyPort);

            switch (options.action) {
                case 'start':
                    return this.getMetadata();

                case 'add-peer':
                    return sidecar.addPeer(options.name);

                case 'ikev2-profile':
                    return this.createIkev2Profile(sidecar, options.name);

                case 'remove-peer':
                    await sidecar.removePeer(options.peer);
                    // A removed phone's network conditions go with it
                    if ((await this.getSettings()).conditions[options.peer]) {
                        await this.configure({ conditions: { [options.peer]: null } }).catch((e) => {
                            console.warn(`wireguard-vpn: couldn't drop the removed device's conditions (${e?.message})`);
                        });
                    }
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

    // --- The network tools ---

    // A running helper checks a patch before it's kept: what it refuses is neither saved nor
    // remembered, so one bad rule can't break the DNS rules again after every restart. Without
    // a helper, parseSettingsPatch (the same checks as the helper's) is the check.
    private async configure(patch: VpnSettingsPatch): Promise<VpnSettings> {
        const current = await this.getSettings();
        const settings = applySettingsPatch(current, patch);

        const sidecar = this.sidecar;
        if (sidecar) {
            try {
                await sendSettings(sidecar, patch);
            } catch (e) {
                // What the helper took before the refusal goes back to the saved settings
                await sendSettings(sidecar, undoPatch(current, patch)).catch(() => {});
                throw e;
            }
        }

        await saveSettings(this.config.configPath, settings);
        this.settings = settings;

        // Only a helper that decrypts HTTP/3 gets the CA's private key, so switching to or from
        // decrypt starts it again. Its peers are in its state file, and the new helper gets every
        // setting when it starts.
        if (sidecar && this.sidecar === sidecar && isDecrypting(current) !== isDecrypting(settings)) {
            await this.restartSidecar(sidecar);
        }
        return settings;
    }

    private async startCapture(): Promise<VpnCaptureState> {
        const sidecar = this.sidecar;
        if (!sidecar) throw new Error('Start the VPN before capturing its packets');
        if (this.capture.running) return { ...this.capture };

        const file = capturePath(this.config.configPath, new Date());
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await sidecar.captureStart(file);
        this.capture = { running: true, path: file };
        return { ...this.capture };
    }

    private async stopCapture(): Promise<VpnCaptureState> {
        const sidecar = this.sidecar;
        if (!sidecar || !this.capture.running) {
            this.capture = { ...this.capture, running: false };
            return { ...this.capture };
        }

        const summary: CaptureSummary = await sidecar.captureStop();
        this.capture = { running: false, ...summary, path: summary.path || this.capture.path };
        return { ...this.capture };
    }

    // --- IKEv2 for iPhones without the WireGuard app (wirepane-tunnel/docs/ikev2.md) ---

    // A new IKEv2 device and the profile that sets it up. The answer holds the device's secret:
    // it goes to the UI and into one short-lived download link, and is never logged or saved.
    private async createIkev2Profile(sidecar: TunnelSidecar, name: string): Promise<Ikev2ProfileAnswer> {
        // All checked before the device is added, so a profile that can't work leaves nothing behind
        if (!sidecar.capabilities.ikev2) {
            throw new Error('IKEv2 is not available in this build of the VPN helper');
        }
        if (!sidecar.ikev2.running) throw new Error(describeIkev2Off(sidecar.ikev2.error));
        const serverAddress = sidecar.endpointHost;
        if (!serverAddress) {
            throw new Error("This computer has no network address the iPhone can reach. Join the iPhone's Wi-Fi, then try again.");
        }
        const caCertificatePem = await this.readCaCertificate();

        const reply = await sidecar.addPeer(name, 'ikev2');
        try {
            const added = parseIkev2PeerAdded(reply);
            if (!added) throw new Error('The VPN helper added the device but gave no usable IKEv2 setup for it');
            return await createIkev2ProfileAnswer(added, {
                caCertificatePem,
                serverAddress,
                links: this.profileLinks
            });
        } catch (e) {
            // A device without a profile is no use to anyone, so it doesn't stay in the list
            if (typeof reply.peer === 'string' && PEER_ID_PATTERN.test(reply.peer)) {
                await sidecar.removePeer(reply.peer).catch((removeError) => {
                    console.warn(`wireguard-vpn: couldn't remove the unusable IKEv2 device (${removeError?.message})`);
                });
            }
            throw e;
        }
    }

    private async readCaCertificate(): Promise<string> {
        try {
            return await fs.promises.readFile(this.caCertPath, 'utf8');
        } catch (e: any) {
            throw new Error(`The Wirepane CA certificate couldn't be read (${e?.code ?? e?.message}), so the profile can't include it`);
        }
    }

    // The links go with the helper: after a restart (on a new network, say) a profile in one
    // could name an address that isn't this computer's any more
    private closeProfileLinks() {
        for (const link of this.profileLinks) link.close();
        this.profileLinks.clear();
    }

    // --- The helper process ---

    private async ensureRunning(proxyPort: number): Promise<TunnelSidecar> {
        const binary = this.locateBinary();
        if (!binary.path) throw new Error(binary.error);

        const socksAddr = socksAddress(proxyPort);
        const endpointHost = this.lanAddress();

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

        return this.startSidecar(binary.path, socksAddr, endpointHost);
    }

    private async startSidecar(
        binaryPath: string,
        socksAddr: string,
        endpointHost: string | undefined
    ): Promise<TunnelSidecar> {
        // Read first: the QUIC mode decides whether the helper gets the CA files
        const settings = await this.getSettings();
        const listenPort = await choosePort(await readSavedPort(this.config.configPath));
        const sidecar = await TunnelSidecar.start({
            binaryPath,
            listenPort,
            statePath: this.statePath,
            socksAddr,
            endpointHost,
            // The CA's private key only goes where it's used: the HTTP/3 gateway signs its leaf
            // certificates with it, and the other QUIC modes never touch it
            ...(isDecrypting(settings) ? this.caFiles() : {}),
            // The helper reports in its ready event whether IKEv2 runs; when UDP 500 or 4500
            // can't be bound, only IKEv2 is off and WireGuard works as before
            ikev2: IKEV2_LISTEN,
            statsIntervalMs: this.environment.statsIntervalMs,
            onToolEvent: (event) => this.toolEvents.push(event)
        });

        // A new helper knows none of the network tools' settings yet
        await sendSettings(sidecar, settings).catch((e) => {
            console.warn(`wireguard-vpn: couldn't apply the network tools' settings (${e?.message})`);
        });

        // Remember the port only once it works, so a scanned QR code keeps its port later
        await savePort(this.config.configPath, listenPort).catch((e) => {
            console.warn(`wireguard-vpn: could not save the VPN port (${e?.message})`);
        });

        this.sidecar = sidecar;
        this.stoppedError = undefined;

        sidecar.exited.then(({ unexpected, message }) => {
            // A capture ends with the helper that wrote it
            if (this.capture.running && this.sidecar === sidecar) {
                this.capture = { ...this.capture, running: false };
            }
            if (this.sidecar !== sidecar) return; // Already replaced or stopped on purpose
            this.sidecar = undefined;
            this.closeProfileLinks();
            if (unexpected) this.stoppedError = message;
        });

        return sidecar;
    }

    private async stopSidecar() {
        const sidecar = this.sidecar;
        this.sidecar = undefined;
        this.stoppedError = undefined;
        // Stopping the helper closes its capture file as it exits
        if (this.capture.running) this.capture = { ...this.capture, running: false };
        this.closeProfileLinks();
        await sidecar?.stop();
    }

    // The same proxy and network as before, for a change only a new helper picks up
    private async restartSidecar(running: TunnelSidecar) {
        const binary = this.locateBinary();
        if (!binary.path) throw new Error(binary.error);
        const { socksAddr } = running;
        await this.stopSidecar();
        await this.startSidecar(binary.path, socksAddr, this.lanAddress());
    }

}

const socksAddress = (proxyPort: number) => `127.0.0.1:${proxyPort}`;

// IKEv2 was asked for but isn't listening. iOS only dials UDP 500 (then 4500), so the way out
// is freeing those ports, not picking others.
function describeIkev2Off(reason: string | undefined): string {
    const detail = reason?.replace(/^IKEv2 is off:\s*/, '').trim();
    const hint = /permission denied|os error 13/i.test(detail ?? '')
        ? 'This system keeps ports below 1024 for privileged programs.'
        : 'Quit any other VPN or IPsec program that uses them, then stop VPN mode and start it again.';
    return `IKEv2 couldn't listen on UDP ports 500 and 4500${detail ? ` (${detail})` : ''}. ${hint}`;
}

const isDecrypting = (settings: VpnSettings) => settings.quic === 'decrypt';

// The patch that puts back `settings` for everything `patch` changes
function undoPatch(settings: VpnSettings, patch: VpnSettingsPatch): VpnSettingsPatch {
    const undo: VpnSettingsPatch = {};
    if (patch.dnsRules) undo.dnsRules = settings.dnsRules;
    if (patch.quic) undo.quic = settings.quic;
    if (patch.conditions) {
        undo.conditions = {};
        for (const peer of Object.keys(patch.conditions)) undo.conditions[peer] = settings.conditions[peer] ?? null;
    }
    return undo;
}

// Sends the parts of the settings that a patch (or a full settings object) has
async function sendSettings(sidecar: TunnelSidecar, settings: VpnSettingsPatch) {
    if (settings.dnsRules) await sidecar.setDnsRules(settings.dnsRules);
    if (settings.quic) await sidecar.setQuic(settings.quic);
    for (const [peer, conditions] of Object.entries(settings.conditions ?? {})) {
        await sidecar.setConditions(peer, conditions);
    }
}
