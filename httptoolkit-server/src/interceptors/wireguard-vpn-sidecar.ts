import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';

// A running wirepane-tunnel process, and its JSON-lines protocol: one JSON command per
// line on stdin, one JSON event per line on stdout (logs go to stderr).
//
// Commands have no ids in the protocol, so they run one at a time: each waits for its own
// reply event (or an error event) before the next is sent.

export interface TunnelPeer {
    peer: string;
    name: string;
    tunnelIp: string;
    endpoint: string | null; // where the phone's packets last came from
    lastHandshake: number | null; // ms since epoch
}

export interface AddedPeer {
    peer: string;
    name: string;
    tunnelIp: string;
    config: string; // The wg-quick text the phone scans as a QR code
}

export interface SidecarOptions {
    binaryPath: string;
    listenPort: number;
    statePath: string;
    socksAddr: string; // host:port of the proxy
    endpointHost?: string; // the address phones dial, written into their configs
    // The Wirepane CA, for the helper's HTTP/3 leaf certificates
    caCertPath?: string;
    caKeyPath?: string;
    // Where the IKEv2 front-end listens (ip:port), when it's on
    ikev2?: string;
    // Every event the network tools show (dns, udp-*, quic, tls-hello, stats)
    onToolEvent?: (event: TunnelEvent) => void;
}

// What this build of the helper can do, from its ready event
export interface TunnelCapabilities {
    quicDecrypt: boolean;
    ikev2: boolean;
}

export const NO_CAPABILITIES: TunnelCapabilities = { quicDecrypt: false, ikev2: false };

// The events the UI's network tools read (docs/plans/2026-10-13-rust-network-tools.md)
export const TOOL_EVENTS: ReadonlySet<string> = new Set([
    'dns', 'udp-open', 'udp-update', 'udp-close', 'quic', 'tls-hello', 'stats'
]);

export interface CaptureSummary {
    path: string;
    packets: number;
    bytes: number;
}

const READY_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 5_000;
// After stdin closes the helper should leave straight away. These are the grace periods
// before we get firmer. The server only gives shutdown handlers about 3s in all.
const STDIN_CLOSE_GRACE_MS = 1_200;
const SIGTERM_GRACE_MS = 800;
const STDERR_LINES_KEPT = 20;
// The helper's error events don't say which command they belong to (or whether they belong
// to one at all). An error that arrives while a command waits fails it only if the command's
// real reply doesn't follow within this time.
const ERROR_GRACE_MS = 150;

export type TunnelEvent = { event: string, [key: string]: unknown };

interface PendingCommand {
    replyEvent: string;
    isReply: (event: TunnelEvent) => boolean;
    resolve: (event: TunnelEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
    // Set when an error event arrived while this command waited
    failure?: { message: string, timer: NodeJS.Timeout };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms).unref());

function toPeer(raw: unknown): TunnelPeer | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const { peer, name, tunnelIp, endpoint, lastHandshake } = raw as Record<string, unknown>;
    if (typeof peer !== 'string' || !peer) return undefined;

    return {
        peer,
        name: typeof name === 'string' ? name : peer,
        tunnelIp: typeof tunnelIp === 'string' ? tunnelIp : '',
        endpoint: typeof endpoint === 'string' && endpoint ? endpoint : null,
        lastHandshake: typeof lastHandshake === 'number' && lastHandshake > 0 ? lastHandshake : null
    };
}

export class TunnelSidecar {

    /**
     * Starts the helper and waits until it says it's listening. Rejects with the helper's
     * own error output if it can't start.
     */
    static async start(options: SidecarOptions): Promise<TunnelSidecar> {
        let sidecar: TunnelSidecar;
        try {
            sidecar = new TunnelSidecar(options);
        } catch (e: any) {
            // spawn throws straight away for a file that can't be executed at all
            throw new Error(`The VPN helper couldn't start: ${e?.message}`);
        }

        try {
            await sidecar.waitUntilReady();

            // The helper loads its saved peers from the state file, so ask who they are. Not
            // knowing them yet is no reason to give up on a helper that's running.
            await sidecar.refreshPeers().catch((e) => {
                if (!sidecar.isRunning) throw e;
                console.warn(`wireguard-vpn: couldn't list the saved peers (${e?.message})`);
            });
        } catch (e) {
            await sidecar.stop();
            throw e;
        }
        return sidecar;
    }

    readonly endpointHost: string | undefined;
    readonly listenPort: number;

    listen: string;
    socksAddr: string;
    // The latest problem the helper reported while running, cleared when it's fixed
    lastError: string | undefined;
    capabilities: TunnelCapabilities = NO_CAPABILITIES;

    private onToolEvent: ((event: TunnelEvent) => void) | undefined;

    private child: ChildProcess;
    private peers = new Map<string, TunnelPeer>();
    private pending: PendingCommand | undefined;
    private commandQueue: Promise<unknown> = Promise.resolve();
    private stderrTail: string[] = [];
    private refreshQueued = false;

    private readyEvent!: Promise<void>;
    private markReady!: () => void;
    private markFailedToStart!: (error: Error) => void;

    private exitedFlag = false;
    private stopping = false;
    private exitMessage: string | undefined;

    // Resolves (never rejects) when the process is gone
    readonly exited: Promise<{ unexpected: boolean, message: string }>;

    private constructor(options: SidecarOptions) {
        this.endpointHost = options.endpointHost;
        this.listenPort = options.listenPort;
        this.listen = `0.0.0.0:${options.listenPort}`;
        this.socksAddr = options.socksAddr;
        this.onToolEvent = options.onToolEvent;

        this.readyEvent = new Promise<void>((resolve, reject) => {
            this.markReady = resolve;
            this.markFailedToStart = reject;
        });
        // Whoever awaits readyEvent handles the rejection, but make sure a failure that
        // happens before anyone awaits isn't reported as unhandled
        this.readyEvent.catch(() => {});

        const args = [
            '--wireguard', this.listen,
            '--state', options.statePath,
            '--socks', options.socksAddr,
            ...(options.endpointHost ? ['--endpoint-host', options.endpointHost] : []),
            ...(options.caCertPath && options.caKeyPath
                ? ['--ca-cert', options.caCertPath, '--ca-key', options.caKeyPath]
                : []),
            ...(options.ikev2 ? ['--ikev2', options.ikev2] : [])
        ];

        // stdin stays an open pipe for as long as this server lives. When the server dies,
        // however it dies, the OS closes the pipe, the helper reads EOF and exits. So it
        // can never be left behind holding the VPN port.
        this.child = spawn(options.binaryPath, args, {
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true
        });

        this.exited = new Promise((resolve) => {
            const finish = (message: string) => {
                if (this.exitedFlag) return;
                this.exitedFlag = true;
                this.exitMessage = message;
                this.failPending(new Error(message));
                this.markFailedToStart(new Error(message));
                resolve({ unexpected: !this.stopping, message });
            };

            // Spawn errors (missing file, no permission) come here and 'exit' never fires
            this.child.once('error', (error) => finish(
                `The VPN helper couldn't start: ${error.message}`
            ));
            this.child.once('close', (code, signal) => finish(this.describeExit(code, signal)));
        });

        // A pipe error on a helper that just died (EPIPE when writing to it, say) would
        // otherwise be an unhandled error event. The exit handler reports what matters.
        this.child.stdin!.on('error', () => {});
        this.child.stdout!.on('error', () => {});
        this.child.stderr!.on('error', () => {});

        readline.createInterface({ input: this.child.stdout! })
            .on('line', (line) => this.handleLine(line));
        readline.createInterface({ input: this.child.stderr! })
            .on('line', (line) => this.handleStderrLine(line));
    }

    get isRunning() {
        return !this.exitedFlag;
    }

    listPeers(): TunnelPeer[] {
        return Array.from(this.peers.values(), (peer) => ({ ...peer }));
    }

    // --- Commands ---

    async addPeer(name: string): Promise<AddedPeer> {
        const reply = await this.sendCommand(
            { cmd: 'add-peer', name, kind: 'wireguard' },
            'peer-added'
        );

        const peer = toPeer(reply);
        if (!peer || typeof reply.config !== 'string' || !reply.config) {
            throw new Error('The VPN helper added the device but gave no configuration for it');
        }
        return { peer: peer.peer, name: peer.name, tunnelIp: peer.tunnelIp, config: reply.config };
    }

    async removePeer(peerId: string): Promise<void> {
        await this.sendCommand(
            { cmd: 'remove-peer', peer: peerId },
            'peer-removed',
            (event) => event.peer === peerId
        );
    }

    async refreshPeers(): Promise<void> {
        await this.sendCommand({ cmd: 'list-peers' }, 'peers');
    }

    async setSocks(addr: string): Promise<void> {
        await this.sendCommand({ cmd: 'set-socks', addr }, 'socks-set');
    }

    // --- The network tools' commands ---

    async setConditions(peer: string, conditions: object | null): Promise<void> {
        await this.sendCommand(
            { cmd: 'set-conditions', peer, conditions },
            'conditions-set',
            (event) => event.peer === peer
        );
    }

    async setDnsRules(rules: object[]): Promise<void> {
        await this.sendCommand({ cmd: 'set-dns-rules', rules }, 'dns-rules-set');
    }

    async setQuic(mode: string): Promise<void> {
        await this.sendCommand({ cmd: 'set-quic', mode }, 'quic-mode');
    }

    async captureStart(path: string): Promise<void> {
        await this.sendCommand({ cmd: 'capture-start', path }, 'capture-started');
    }

    async captureStop(): Promise<CaptureSummary> {
        const reply = await this.sendCommand({ cmd: 'capture-stop' }, 'capture-stopped');
        return {
            path: typeof reply.path === 'string' ? reply.path : '',
            packets: typeof reply.packets === 'number' ? reply.packets : 0,
            bytes: typeof reply.bytes === 'number' ? reply.bytes : 0
        };
    }

    private sendCommand(
        command: { cmd: string, [key: string]: unknown },
        replyEvent: string,
        isReply: (event: TunnelEvent) => boolean = () => true
    ): Promise<TunnelEvent> {
        const run = () => new Promise<TunnelEvent>((resolve, reject) => {
            if (this.exitedFlag) {
                return reject(new Error(this.exitMessage ?? 'The VPN helper is not running'));
            }

            const timer = setTimeout(() => {
                const timedOut = new Error(`The VPN helper didn't answer "${command.cmd}" in time`);
                if (this.pending?.timer === timer) this.failPending(timedOut);
                else reject(timedOut);
            }, COMMAND_TIMEOUT_MS);

            this.pending = { replyEvent, isReply, resolve, reject, timer };
            this.child.stdin!.write(JSON.stringify(command) + '\n', (error) => {
                if (error) this.failPending(new Error(`Couldn't send "${command.cmd}" to the VPN helper: ${error.message}`));
            });
        });

        // A failed command mustn't block the commands queued behind it
        const result = this.commandQueue.then(run);
        this.commandQueue = result.catch(() => {});
        return result;
    }

    private failPending(error: Error) {
        const pending = this.pending;
        if (!pending) return;
        this.pending = undefined;
        clearTimeout(pending.timer);
        if (pending.failure) clearTimeout(pending.failure.timer);
        pending.reject(error);
    }

    // --- Events from the helper ---

    private handleLine(line: string) {
        if (!line.trim()) return;

        let event: TunnelEvent;
        try {
            const parsed = JSON.parse(line);
            if (!parsed || typeof parsed.event !== 'string') return;
            event = parsed;
        } catch (e) {
            return; // Not protocol output, so it's only noise
        }

        this.handleEvent(event);
    }

    private handleEvent(event: TunnelEvent) {
        switch (event.event) {
            case 'ready': {
                if (typeof event.listen === 'string' && event.listen) this.listen = event.listen;
                const capabilities = event.capabilities as Record<string, unknown> | undefined;
                this.capabilities = {
                    quicDecrypt: capabilities?.quicDecrypt === true,
                    ikev2: capabilities?.ikev2 === true
                };
                this.markReady();
                break;
            }

            case 'peer-added': {
                const peer = toPeer(event);
                if (peer) this.peers.set(peer.peer, peer);
                break;
            }

            case 'peer-removed':
                if (typeof event.peer === 'string') this.peers.delete(event.peer);
                break;

            case 'peers': {
                const peers = Array.isArray(event.peers) ? event.peers : [];
                this.peers = new Map(
                    peers.flatMap((raw) => {
                        const peer = toPeer(raw);
                        return peer ? [[peer.peer, peer] as const] : [];
                    })
                );
                break;
            }

            case 'socks-set':
                if (typeof event.addr === 'string' && event.addr) this.socksAddr = event.addr;
                this.lastError = undefined;
                break;

            case 'peer':
                this.handlePeerActivity(event);
                break;

            case 'error':
                this.handleErrorEvent(event);
                return; // An error event isn't a reply, see handleErrorEvent

            default:
                // dns, udp-*, quic, tls-hello, stats go to the network tools; replies like
                // conditions-set and capture-stopped only answer their command
                if (TOOL_EVENTS.has(event.event)) this.relayToolEvent(event);
                break;
        }

        this.resolvePending(event);
    }

    private relayToolEvent(event: TunnelEvent) {
        try {
            this.onToolEvent?.(event);
        } catch (e: any) {
            console.warn(`wireguard-vpn: a network tools listener failed (${e?.message})`);
        }
    }

    private resolvePending(event: TunnelEvent) {
        const pending = this.pending;
        if (!pending || pending.replyEvent !== event.event || !pending.isReply(event)) return;

        this.pending = undefined;
        clearTimeout(pending.timer);
        pending.resolve(event);

        // The reply came after all, so that error was about something else
        if (pending.failure) {
            clearTimeout(pending.failure.timer);
            this.recordError(pending.failure.message);
        }
    }

    // A phone's packets arrived from a new address, or it did a new handshake
    private handlePeerActivity(event: TunnelEvent) {
        const known = typeof event.peer === 'string' ? this.peers.get(event.peer) : undefined;
        if (!known) {
            // A peer we haven't heard of (added by an earlier run, say): ask for the full list
            this.queuePeerRefresh();
            return;
        }

        if (typeof event.endpoint === 'string' && event.endpoint) known.endpoint = event.endpoint;
        if (typeof event.lastHandshake === 'number' && event.lastHandshake > 0) {
            known.lastHandshake = event.lastHandshake;
        }
    }

    private queuePeerRefresh() {
        if (this.refreshQueued || this.exitedFlag) return;
        this.refreshQueued = true;
        this.refreshPeers()
            .catch(() => {}) // It will be asked again at the next unknown peer
            .finally(() => { this.refreshQueued = false; });
    }

    private handleErrorEvent(event: TunnelEvent) {
        const message = typeof event.message === 'string' && event.message
            ? event.message
            : 'The VPN helper reported an error';

        // With a command in flight, an error is most likely the answer to it
        const pending = this.pending;
        if (pending) {
            if (!pending.failure) {
                const timer = setTimeout(() => {
                    if (this.pending === pending) this.failPending(new Error(message));
                }, ERROR_GRACE_MS);
                pending.failure = { message, timer };
            }
            return;
        }

        this.recordError(message);
    }

    private recordError(message: string) {
        if (message !== this.lastError) console.warn(`wireguard-vpn: ${message}`);
        this.lastError = message;
    }

    private handleStderrLine(line: string) {
        if (!line.trim()) return;
        this.stderrTail.push(line);
        if (this.stderrTail.length > STDERR_LINES_KEPT) this.stderrTail.shift();

        // The helper logs a lot (every flow), so its log only reaches ours when asked for
        if (process.env.WIREPANE_TUNNEL_DEBUG) console.log(`wirepane-tunnel: ${line}`);
    }

    // --- Starting and stopping ---

    private waitUntilReady(): Promise<void> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(
                () => reject(new Error(this.withStderr("The VPN helper didn't report ready in time"))),
                READY_TIMEOUT_MS
            );
            this.readyEvent.then(resolve, reject).finally(() => clearTimeout(timer));
        });
    }

    private describeExit(code: number | null, signal: NodeJS.Signals | null) {
        const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
        return this.withStderr(`The VPN helper ${how}`);
    }

    // The helper's own words about why it's failing are the most useful part of our message
    private withStderr(message: string) {
        const detail = this.lastError ?? this.stderrTail[this.stderrTail.length - 1];
        return detail ? `${message}: ${detail}` : message;
    }

    /**
     * Stops the helper: closing its stdin is the polite way, signals only if it ignores that.
     * Resolves once the process is gone, so its UDP port is free again.
     */
    async stop(): Promise<void> {
        if (this.exitedFlag) return;
        this.stopping = true;

        this.child.stdin!.end();
        if (await this.exitedWithin(STDIN_CLOSE_GRACE_MS)) return;

        this.child.kill('SIGTERM');
        if (await this.exitedWithin(SIGTERM_GRACE_MS)) return;

        this.child.kill('SIGKILL');
        await this.exitedWithin(SIGTERM_GRACE_MS);
    }

    private async exitedWithin(ms: number): Promise<boolean> {
        return Promise.race([this.exited.then(() => true), sleep(ms).then(() => false)]);
    }
}
