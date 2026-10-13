import * as dgram from 'dgram';
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { expect } from 'chai';
import { generateCACertificate } from 'mockttp';

import type { HtkConfig } from '../../src/config';
import type { Ikev2ProfileAnswer } from '../../src/interceptors/wireguard-vpn-ikev2';
import {
    WireGuardVpnInterceptor,
    WireGuardVpnMetadata,
    AddPeerResult
} from '../../src/interceptors/wireguard-vpn';
import {
    choosePort,
    findTunnelBinary,
    getLanIPv4,
    isUdpPortFree,
    readSavedPort,
    WIREGUARD_FIRST_PORT,
    WIREGUARD_LAST_PORT
} from '../../src/interceptors/wireguard-vpn-env';
import {
    applySettingsPatch,
    capturePath,
    DEFAULT_VPN_SETTINGS,
    loadSettings,
    parseSettingsPatch,
    ToolEventLog
} from '../../src/interceptors/wireguard-vpn-tools';

// A stand-in for the wirepane-tunnel binary that speaks its JSON-lines protocol
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const STUB = path.join(FIXTURES, 'wirepane-tunnel-stub.cjs');
const HARNESS = path.join(FIXTURES, 'wireguard-vpn-harness.ts');

const PROXY_PORT = 9474;

// The plist package comes with usbmux-client (a server dependency); it reads the profiles back
// eslint-disable-next-line @typescript-eslint/no-var-requires
const plist: { parse(xml: string): any } = require('plist');

// A fresh connection each time, so a closed link shows as refused
function httpGet(url: string): Promise<{ status: number, body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(url, { agent: false }, (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk: Buffer) => chunks.push(chunk));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
        });
        req.on('error', reject);
    });
}

type Falsy = false | 0 | '' | null | undefined;

// Polls until the check returns something truthy, and returns that
async function waitFor<T>(check: () => T | Promise<T>, timeoutMs = 3000): Promise<Exclude<Awaited<T>, Falsy>> {
    const start = Date.now();
    for (;;) {
        const result = await check();
        if (result) return result as Exclude<Awaited<T>, Falsy>;
        if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
}

const isAlive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
};

async function rejectionOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error: any) {
        return error.message;
    }
    throw new Error('Expected the promise to be rejected');
}

describe("The WireGuard VPN helpers", () => {

    describe("finding the tunnel binary", () => {

        let repoRoot: string;
        beforeEach(() => {
            repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'htk-tunnel-repo-'));
        });
        afterEach(() => {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        });

        const addDevBuild = (profile: string) => {
            const dir = path.join(repoRoot, 'wirepane-tunnel', 'target', profile);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, process.platform === 'win32' ? 'wirepane-tunnel.exe' : 'wirepane-tunnel');
            fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
            return file;
        };

        it("uses WIREPANE_TUNNEL_BINPATH first", () => {
            addDevBuild('release');
            expect(findTunnelBinary({ WIREPANE_TUNNEL_BINPATH: STUB }, repoRoot).path).to.equal(STUB);
        });

        it("falls back to the release build, then the debug build", () => {
            const debugBuild = addDevBuild('debug');
            expect(findTunnelBinary({}, repoRoot).path).to.equal(debugBuild);

            const releaseBuild = addDevBuild('release');
            expect(findTunnelBinary({}, repoRoot).path).to.equal(releaseBuild);
        });

        it("reports a missing binary instead of throwing", () => {
            const result = findTunnelBinary({}, repoRoot);
            expect(result.path).to.equal(undefined);
            expect(result.error).to.include('not built');
        });

        it("names the configured path when that is what's missing", () => {
            const result = findTunnelBinary({ WIREPANE_TUNNEL_BINPATH: '/nowhere/wirepane-tunnel' }, repoRoot);
            expect(result.path).to.equal(undefined);
            expect(result.error).to.include('/nowhere/wirepane-tunnel');
        });

    });

    describe("finding this machine's network address", () => {

        const iface = (address: string, extra: Partial<os.NetworkInterfaceInfo> = {}) => ({
            address,
            netmask: '255.255.255.0',
            family: 'IPv4',
            mac: '00:00:00:00:00:00',
            internal: false,
            cidr: `${address}/24`,
            ...extra
        } as os.NetworkInterfaceInfo);

        it("picks the private address on Wi-Fi over virtual interfaces", () => {
            expect(getLanIPv4({
                lo0: [iface('127.0.0.1', { internal: true })],
                utun3: [iface('100.64.0.9')],
                docker0: [iface('172.17.0.1')],
                'br-1a2b3c': [iface('172.18.0.1')],
                en0: [iface('192.168.0.199')],
                bridge100: [iface('192.168.64.1')]
            })).to.equal('192.168.0.199');
        });

        it("ignores IPv6 and link-local addresses", () => {
            expect(getLanIPv4({
                en0: [
                    iface('fe80::1', { family: 'IPv6' }),
                    iface('169.254.12.7')
                ]
            })).to.equal(undefined);
        });

        it("takes a public address when that is all there is", () => {
            expect(getLanIPv4({ eth0: [iface('203.0.113.8')] })).to.equal('203.0.113.8');
        });

        it("keeps the system's order between equally good addresses", () => {
            expect(getLanIPv4({
                en0: [iface('10.0.0.5')],
                en1: [iface('10.0.1.5')]
            })).to.equal('10.0.0.5');
        });

        it("returns undefined without a network", () => {
            expect(getLanIPv4({ lo0: [iface('127.0.0.1', { internal: true })] })).to.equal(undefined);
        });

    });

    describe("choosing the UDP port", () => {

        it("prefers the saved port when it's free", async () => {
            expect(await choosePort(51880, async () => true)).to.equal(51880);
        });

        it("starts from 51873 without a saved port", async () => {
            expect(await choosePort(undefined, async () => true)).to.equal(WIREGUARD_FIRST_PORT);
        });

        it("falls back to the next free port in the range", async () => {
            const taken = new Set([51880, 51873, 51874]);
            expect(await choosePort(51880, async (port) => !taken.has(port))).to.equal(51875);
        });

        it("ignores a saved port outside the range", async () => {
            const asked: number[] = [];
            await choosePort(51820, async (port) => { asked.push(port); return true; });
            expect(asked).to.deep.equal([WIREGUARD_FIRST_PORT]);
        });

        it("fails when the whole range is taken", async () => {
            const message = await rejectionOf(choosePort(undefined, async () => false));
            expect(message).to.include(`${WIREGUARD_FIRST_PORT} and ${WIREGUARD_LAST_PORT}`);
        });

        it("sees a UDP port that's in use", async () => {
            const socket = dgram.createSocket('udp4');
            await new Promise<void>((resolve) => socket.bind(0, '0.0.0.0', () => resolve()));
            const { port } = socket.address();

            expect(await isUdpPortFree(port)).to.equal(false);

            await new Promise<void>((resolve) => socket.close(() => resolve()));
            expect(await isUdpPortFree(port)).to.equal(true);
        });

    });

    describe("the wireguard-vpn interceptor", () => {

        let configPath: string;
        let stubLog: string;
        let interceptor: WireGuardVpnInterceptor;

        const makeInterceptor = () => new WireGuardVpnInterceptor({ configPath } as HtkConfig);

        const logEntries = (): any[] => fs.existsSync(stubLog)
            ? fs.readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
            : [];
        const startsOf = () => logEntries().filter((entry) => entry.type === 'start');
        const commandsOf = (name: string) => logEntries().filter((entry) => entry.cmd?.cmd === name);
        const argValue = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

        const metadata = () => interceptor.getMetadata();
        const start = (port = PROXY_PORT) => interceptor.activate(port, { action: 'start' }) as Promise<WireGuardVpnMetadata>;
        const addPeer = (name?: string) =>
            interceptor.activate(PROXY_PORT, { action: 'add-peer', name }) as Promise<AddPeerResult>;

        const stubEnvKeys = [
            'WIREPANE_TUNNEL_BINPATH', 'STUB_LOG', 'STUB_HANDSHAKE_MS', 'STUB_NO_SET_SOCKS',
            'STUB_FAIL_START', 'STUB_IGNORE_STDIN_EOF', 'STUB_NOISY_ERROR', 'STUB_LIST_PEERS_ERROR',
            'STUB_LATE_PEER', 'STUB_CAPABILITIES', 'STUB_NO_IKEV2_OPTION', 'STUB_IKEV2_BIND_ERROR',
            'STUB_IKEV2_BAD_IDENTITY', 'STUB_REFUSE_DNS_PATTERN'
        ];

        beforeEach(() => {
            configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'htk-vpn-config-'));
            stubLog = path.join(configPath, 'stub-log.jsonl');
            process.env.WIREPANE_TUNNEL_BINPATH = STUB;
            process.env.STUB_LOG = stubLog;
            interceptor = makeInterceptor();
        });

        afterEach(async () => {
            await interceptor.deactivateAll();
            const pids = startsOf().map((entry) => entry.pid as number);
            for (const key of stubEnvKeys) delete process.env[key];
            fs.rmSync(configPath, { recursive: true, force: true });

            // Nothing may be left running after a test
            for (const pid of pids) expect(isAlive(pid), `stub ${pid} still running`).to.equal(false);
        });

        it("is not available when the binary is missing, and doesn't crash", async () => {
            const noBinary = new WireGuardVpnInterceptor({ configPath } as HtkConfig, () => ({
                error: 'The VPN helper (wirepane-tunnel) is not built.'
            }));

            expect(await noBinary.isActivable()).to.equal(false);
            expect(noBinary.isActive(PROXY_PORT)).to.equal(false);

            const result = await noBinary.getMetadata();
            expect(result.available).to.equal(false);
            expect(result.running).to.equal(false);
            expect(result.peers).to.deep.equal([]);
            expect(result.error).to.include('not built');

            expect(await rejectionOf(noBinary.activate(PROXY_PORT, { action: 'start' }))).to.include('not built');
            await noBinary.deactivate(PROXY_PORT);
            await noBinary.deactivateAll();
        });

        it("is available but stopped before anything starts it", async () => {
            expect(await interceptor.isActivable()).to.equal(true);
            expect(interceptor.isActive(PROXY_PORT)).to.equal(false);

            const result = await metadata();
            expect(result).to.deep.equal({
                available: true,
                running: false,
                listen: '',
                endpointHost: getLanIPv4() ?? '',
                peers: [],
                settings: DEFAULT_VPN_SETTINGS,
                capture: { running: false },
                capabilities: { quicDecrypt: false, ikev2: false },
                ikev2: { running: false }
            });
            expect(startsOf()).to.have.length(0);
        });

        it("starts the helper with the right arguments and returns the metadata", async () => {
            const result = await start();

            expect(result.available).to.equal(true);
            expect(result.running).to.equal(true);
            expect(result.peers).to.deep.equal([]);
            expect(result.error).to.equal(undefined);
            expect(result.endpointHost).to.equal(getLanIPv4() ?? '');
            expect(result.listen).to.match(/^0\.0\.0\.0:518\d\d$/);
            expect(interceptor.isActive(PROXY_PORT)).to.equal(true);
            expect(interceptor.isActive(PROXY_PORT + 1)).to.equal(false);

            const [started] = startsOf();
            expect(startsOf()).to.have.length(1);
            expect(argValue(started.args, '--wireguard')).to.equal(result.listen);
            expect(argValue(started.args, '--state')).to.equal(path.join(configPath, 'wirepane-vpn.json'));
            expect(argValue(started.args, '--socks')).to.equal(`127.0.0.1:${PROXY_PORT}`);
            if (getLanIPv4()) {
                expect(argValue(started.args, '--endpoint-host')).to.equal(getLanIPv4());
            } else {
                expect(started.args).not.to.include('--endpoint-host');
            }
            // IKEv2 is always asked for; this build of the stand-in doesn't have it
            expect(argValue(started.args, '--ikev2')).to.equal('0.0.0.0:500');
            expect(result.ikev2).to.deep.equal({ running: false });
        });

        // --- The network tools (docs/plans/2026-10-13-rust-network-tools.md) ---

        const configure = (settings: unknown) =>
            interceptor.activate(PROXY_PORT, { action: 'configure', settings }) as Promise<any>;
        const settingsFile = () => path.join(configPath, 'wirepane-vpn-settings.json');
        const lastCommand = (name: string) => commandsOf(name).slice(-1)[0]?.cmd;

        const patch = {
            dnsRules: [
                { pattern: '*.Example.com', action: 'block' },
                { pattern: 'api.test', action: 'answer', ipv4: '192.168.0.10' }
            ],
            quic: 'relay',
            conditions: { p1: { latencyMs: 100, jitterMs: 10, downKbps: 750, upKbps: 250, lossPct: 1.5 } }
        };

        it("saves the network tools' settings and sends them to the helper now and after a restart", async () => {
            await start();
            const saved = await configure(patch);

            expect(saved.dnsRules[0]).to.deep.equal({ pattern: '*.example.com', action: 'block' });
            expect(saved.quic).to.equal('relay');
            expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).to.deep.equal(saved);
            expect(lastCommand('set-dns-rules').rules).to.deep.equal(saved.dnsRules);
            expect(lastCommand('set-quic').mode).to.equal('relay');
            expect(lastCommand('set-conditions')).to.deep.include({ peer: 'p1', conditions: patch.conditions.p1 });
            expect((await metadata()).settings).to.deep.equal(saved);

            // A new helper gets everything again
            const before = commandsOf('set-dns-rules').length;
            await interceptor.deactivate(PROXY_PORT);
            await start();
            expect(startsOf()).to.have.length(2);
            expect(commandsOf('set-dns-rules')).to.have.length(before + 1);
            expect(lastCommand('set-quic').mode).to.equal('relay');
            expect(lastCommand('set-conditions').peer).to.equal('p1');

            // A fresh server reads them back from the file
            const reloaded = makeInterceptor();
            expect((await reloaded.getMetadata()).settings).to.deep.equal(saved);

            // null takes a phone's conditions off
            const cleared = await configure({ conditions: { p1: null } });
            expect(cleared.conditions).to.deep.equal({});
            expect(cleared.dnsRules).to.deep.equal(saved.dnsRules);
            expect(lastCommand('set-conditions')).to.deep.include({ peer: 'p1', conditions: null });
        });

        it("drops a removed device's network conditions", async () => {
            const added = await addPeer('iPhone');
            await configure({ conditions: { [added.peer]: { latencyMs: 300 } } });
            await interceptor.activate(PROXY_PORT, { action: 'remove-peer', peer: added.peer });
            expect((await metadata()).settings.conditions).to.deep.equal({});
        });

        it("only saves the settings while the VPN is stopped", async () => {
            const saved = await configure({ quic: 'decrypt' });
            expect(saved.quic).to.equal('decrypt');
            expect(startsOf()).to.have.length(0);
            expect((await metadata()).settings.quic).to.equal('decrypt');

            await start();
            expect(lastCommand('set-quic').mode).to.equal('decrypt');
        });

        it("rejects bad settings and saves nothing", async () => {
            for (const bad of [
                { dnsRules: [{ pattern: '', action: 'block' }] },
                { dnsRules: [{ pattern: 'a.test', action: 'answer', ipv4: '300.1.1.1' }] },
                { dnsRules: [{ pattern: 'a b', action: 'block' }] },
                { dnsRules: 'all' },
                { quic: 'fast' },
                { conditions: { p1: { latencyMs: -1 } } },
                { conditions: { p1: { lossPct: 101 } } },
                { conditions: { '../p1': null } },
                // What the helper's parse_pattern refuses (wirepane-tunnel/src/features/dns_rules.rs)
                { dnsRules: [{ pattern: '*', action: 'block' }] },
                { dnsRules: [{ pattern: '*.', action: 'block' }] },
                { dnsRules: [{ pattern: 'a*.example.com', action: 'block' }] },
                { dnsRules: [{ pattern: '*.*.example.com', action: 'block' }] },
                { dnsRules: [{ pattern: 'api.*', action: 'block' }] },
                { dnsRules: [{ pattern: `${'a'.repeat(64)}.com`, action: 'block' }] },
                { dnsRules: [{ pattern: `${'a.'.repeat(126)}com`, action: 'block' }] },
                { dnsRules: [{ pattern: 'a..b', action: 'block' }] },
                { dnsRules: [{ pattern: '.a.b', action: 'block' }] },
                { dnsRules: [{ pattern: 'exämple.com', action: 'block' }] },
                'nothing'
            ]) {
                const message = await rejectionOf(configure(bad));
                expect(message, JSON.stringify(bad)).to.be.a('string');
            }
            expect(fs.existsSync(settingsFile())).to.equal(false);
        });

        it("keeps nothing the helper refuses, so a restart gets the last good rules", async () => {
            process.env.STUB_REFUSE_DNS_PATTERN = 'refused.test';
            await start();
            const good = await configure({ dnsRules: [{ pattern: 'good.test', action: 'block' }] });

            const message = await rejectionOf(configure({
                quic: 'relay',
                dnsRules: [{ pattern: 'good.test', action: 'block' }, { pattern: 'refused.test', action: 'block' }]
            }));
            expect(message).to.include('rule 2: the helper refuses this name');

            // Neither saved nor remembered, and the helper is back on what is saved
            expect((await metadata()).settings).to.deep.equal(good);
            expect(JSON.parse(fs.readFileSync(settingsFile(), 'utf8'))).to.deep.equal(good);
            expect(lastCommand('set-dns-rules').rules).to.deep.equal(good.dnsRules);
            expect(lastCommand('set-quic').mode).to.equal('block');

            // A new helper gets the rules that worked
            await interceptor.deactivate(PROXY_PORT);
            await start();
            expect(lastCommand('set-dns-rules').rules).to.deep.equal(good.dnsRules);
            expect(startsOf()).to.have.length(2);
        });

        it("asks a running helper for its counters and relays them to the UI's log", async () => {
            interceptor = new WireGuardVpnInterceptor({ configPath } as HtkConfig, findTunnelBinary, {
                statsIntervalMs: 40
            });
            await addPeer('iPhone');

            const stats = await waitFor(async () => (await interceptor.getSubMetadata('events-0')).events
                .find((event) => event.event === 'stats'));
            expect((stats.peers as Array<{ peer: string }>).map((peer) => peer.peer)).to.deep.equal(['p1']);
            expect(stats.seq).to.be.a('number');
            expect(commandsOf('stats')[0].cmd).to.deep.equal({ cmd: 'stats' });

            // Nothing is asked once it's stopped
            await interceptor.deactivate(PROXY_PORT);
            const asked = commandsOf('stats').length;
            await new Promise((resolve) => setTimeout(resolve, 150));
            expect(commandsOf('stats')).to.have.length(asked);
        });

        it("asks for the counters every 2 seconds by default", async function () {
            this.timeout(6000);
            await start();
            await new Promise((resolve) => setTimeout(resolve, 1500));
            expect(commandsOf('stats')).to.have.length(0);
            await waitFor(() => commandsOf('stats').length === 1, 1500);
        });

        it("captures to a pcapng file in the captures folder", async () => {
            expect(await rejectionOf(interceptor.activate(PROXY_PORT, { action: 'capture-start' })))
                .to.include('Start the VPN');

            await start();
            const started = await interceptor.activate(PROXY_PORT, { action: 'capture-start' }) as any;
            expect(started.running).to.equal(true);
            expect(path.dirname(started.path)).to.equal(path.join(configPath, 'captures'));
            expect(path.basename(started.path)).to.match(/^wirepane-\d{4}-\d\d-\d\d_\d\d-\d\d-\d\d\.pcapng$/);
            expect(fs.existsSync(started.path)).to.equal(true);
            expect((await metadata()).capture).to.deep.equal({ running: true, path: started.path });

            // A second start while one runs changes nothing
            const again = await interceptor.activate(PROXY_PORT, { action: 'capture-start' }) as any;
            expect(again.path).to.equal(started.path);
            expect(commandsOf('capture-start')).to.have.length(1);

            const stopped = await interceptor.activate(PROXY_PORT, { action: 'capture-stop' }) as any;
            expect(stopped).to.deep.equal({ running: false, path: started.path, packets: 12, bytes: 3456 });
            expect((await metadata()).capture.running).to.equal(false);
        });

        it("ends the capture state when the helper stops", async () => {
            await start();
            await interceptor.activate(PROXY_PORT, { action: 'capture-start' });
            await interceptor.deactivate(PROXY_PORT);
            expect((await metadata()).capture.running).to.equal(false);
        });

        it("relays the helper's events to a numbered log for the UI", async () => {
            await start();
            // The stub sends a dns and a quic event right after ready
            const all = await interceptor.getSubMetadata('events-0');
            expect(all.seq).to.equal(2);
            expect(all.events.map((event) => event.event)).to.deep.equal(['dns', 'quic']);
            expect(all.events[0]).to.deep.include({ name: 'example.com', seq: 1 });
            expect(all.events[0].at).to.be.a('number').within(Date.now() - 60_000, Date.now());

            expect((await interceptor.getSubMetadata('events-2')).events).to.deep.equal([]);
            expect((await interceptor.getSubMetadata('events-1')).events.map((e) => e.event)).to.deep.equal(['quic']);
            // A number from before a server restart gets everything there is
            expect((await interceptor.getSubMetadata('events-999')).events).to.have.length(2);
            expect(await rejectionOf(interceptor.getSubMetadata('events-x'))).to.include('Unknown');
            expect(await rejectionOf(interceptor.getSubMetadata('peers'))).to.include('Unknown');
        });

        it("reports the helper's capabilities", async () => {
            process.env.STUB_CAPABILITIES = JSON.stringify({ quicDecrypt: true, ikev2: false });
            expect((await metadata()).capabilities).to.deep.equal({ quicDecrypt: false, ikev2: false });
            await start();
            expect((await metadata()).capabilities).to.deep.equal({ quicDecrypt: true, ikev2: false });
        });

        it("hands the Wirepane CA to the helper only when it decrypts HTTP/3", async () => {
            const caCert = path.join(configPath, 'wirepane-ca.pem');
            const caKey = path.join(configPath, 'wirepane-ca.key');

            // Without the files there's nothing to hand over, even for decrypt
            await configure({ quic: 'decrypt' });
            await start();
            expect(startsOf()[0].args).not.to.include('--ca-cert');
            await interceptor.deactivate(PROXY_PORT);
            await configure({ quic: 'block' });

            fs.writeFileSync(caCert, 'cert');
            fs.writeFileSync(caKey, 'key');

            // block (the default) and relay never use the private key
            await addPeer('iPhone');
            expect(startsOf()[1].args).not.to.include('--ca-key');
            const rules = [{ pattern: 'a.test', action: 'block' }];
            await configure({ quic: 'relay', dnsRules: rules });
            expect(startsOf()).to.have.length(2);

            // Switching to decrypt starts the helper again with the CA, its peers and settings
            await configure({ quic: 'decrypt' });
            expect(startsOf()).to.have.length(3);
            const [, old, decrypting] = startsOf();
            expect(isAlive(old.pid)).to.equal(false);
            expect(argValue(decrypting.args, '--ca-cert')).to.equal(caCert);
            expect(argValue(decrypting.args, '--ca-key')).to.equal(caKey);
            expect(argValue(decrypting.args, '--socks')).to.equal(`127.0.0.1:${PROXY_PORT}`);
            const restarted = await metadata();
            expect(restarted.running).to.equal(true);
            expect(restarted.peers.map((peer) => peer.name)).to.deep.equal(['iPhone']);
            const sentToNew = (name: string) => commandsOf(name).filter((entry) => entry.pid === decrypting.pid);
            expect(sentToNew('set-dns-rules').slice(-1)[0].cmd.rules).to.deep.equal(rules);
            expect(sentToNew('set-quic').slice(-1)[0].cmd.mode).to.equal('decrypt');

            // ...and switching away takes the key away again
            await configure({ quic: 'block' });
            expect(startsOf()).to.have.length(4);
            expect(startsOf()[3].args).not.to.include('--ca-cert');
            expect(startsOf()[3].args).not.to.include('--ca-key');

            // A stopped VPN only saves the mode, and the next start brings the CA
            await interceptor.deactivate(PROXY_PORT);
            await configure({ quic: 'decrypt' });
            expect(startsOf()).to.have.length(4);
            await start();
            expect(argValue(startsOf()[4].args, '--ca-key')).to.equal(caKey);
        });

        it("keeps the same port the next time it starts", async () => {
            const first = await start();
            const savedPort = await readSavedPort(configPath);
            expect(first.listen).to.equal(`0.0.0.0:${savedPort}`);

            await interceptor.deactivate(PROXY_PORT);
            const second = await start();
            expect(second.listen).to.equal(first.listen);
        });

        it("moves to the next free port when the saved one is taken", async () => {
            const first = await start();
            const savedPort = await readSavedPort(configPath);
            await interceptor.deactivate(PROXY_PORT);

            // Another program takes the port in between
            const squatter = dgram.createSocket('udp4');
            await new Promise<void>((resolve) => squatter.bind(savedPort, '0.0.0.0', () => resolve()));
            try {
                const second = await start();
                expect(second.listen).not.to.equal(first.listen);
                expect(second.listen).to.equal(`0.0.0.0:${await readSavedPort(configPath)}`);
            } finally {
                await new Promise<void>((resolve) => squatter.close(() => resolve()));
            }
        });

        it("adds a peer and returns its config", async () => {
            const added = await addPeer('Azim iPhone');

            expect(added.peer).to.equal('p1');
            expect(added.name).to.equal('Azim iPhone');
            expect(added.tunnelIp).to.equal('10.73.0.2');
            expect(added.config).to.include('[Interface]');
            expect(added.config).to.include(`Endpoint = ${getLanIPv4()}:`);
            expect(Object.keys(added).sort()).to.deep.equal(['config', 'name', 'peer', 'tunnelIp']);

            // Adding a peer starts the helper when it wasn't running
            expect(startsOf()).to.have.length(1);
            expect(commandsOf('add-peer')[0].cmd).to.deep.equal({ cmd: 'add-peer', name: 'Azim iPhone', kind: 'wireguard' });

            expect((await metadata()).peers).to.deep.equal([{
                peer: 'p1',
                name: 'Azim iPhone',
                tunnelIp: '10.73.0.2',
                endpoint: null,
                lastHandshake: null
            }]);
        });

        it("names a peer iPhone by default, and keeps names to one plain line", async () => {
            expect((await addPeer()).name).to.equal('iPhone');
            expect((await addPeer('  \n\t ')).name).to.equal('iPhone');
            expect((await addPeer('Evil\n[Peer]\nAllowedIPs = 0.0.0.0/0')).name).to.equal('Evil [Peer] AllowedIPs = 0.0.0.0/0');
            expect((await addPeer('x'.repeat(200))).name).to.have.length(64);
        });

        it("shows a phone's handshake and address in the metadata", async () => {
            process.env.STUB_HANDSHAKE_MS = '30';
            const before = Date.now();
            await addPeer('iPhone');

            const [peer] = (await waitFor(async () => {
                const { peers } = await metadata();
                return peers[0]?.lastHandshake ? peers : undefined;
            }));

            expect(peer.endpoint).to.equal('192.168.0.199:61234');
            expect(peer.lastHandshake).to.be.at.least(before);
        });

        it("removes a peer", async () => {
            const { peer } = await addPeer('iPhone');
            await addPeer('iPad');

            const result = await interceptor.activate(PROXY_PORT, { action: 'remove-peer', peer });
            expect(result).to.deep.equal({ removed: true });
            expect((await metadata()).peers.map((p) => p.name)).to.deep.equal(['iPad']);
        });

        it("fails clearly when the peer to remove doesn't exist", async () => {
            await start();
            const message = await rejectionOf(
                interceptor.activate(PROXY_PORT, { action: 'remove-peer', peer: 'p42' })
            );
            expect(message).to.equal('no such peer: p42');

            // ...and carries on working afterwards
            expect((await addPeer('iPhone')).peer).to.equal('p1');
        });

        it("doesn't fail a command because of an unrelated error from the helper", async () => {
            process.env.STUB_NOISY_ERROR = '1';

            const added = await addPeer('iPhone');
            expect(added.peer).to.equal('p1');

            // The error isn't lost: it shows up as the helper's problem
            expect((await metadata()).error).to.equal('upstream connection failed');
        });

        it("learns about a phone that it didn't add itself", async () => {
            process.env.STUB_LATE_PEER = '1';
            await start();

            const peers = await waitFor(async () => {
                const { peers } = await metadata();
                return peers.length ? peers : undefined;
            });
            expect(peers).to.deep.equal([{
                peer: 'p9',
                name: 'late phone',
                tunnelIp: '10.73.0.9',
                endpoint: '192.168.0.50:5555',
                lastHandshake: peers[0].lastHandshake
            }]);
            expect(peers[0].lastHandshake).to.be.a('number');
        });

        it("still starts when the helper can't list its saved peers", async () => {
            process.env.STUB_LIST_PEERS_ERROR = '1';

            const result = await start();
            expect(result.running).to.equal(true);
            expect(result.peers).to.deep.equal([]);
        });

        it("keeps peers when the helper is stopped and started again", async () => {
            await addPeer('iPhone');
            await interceptor.deactivate(PROXY_PORT);

            const stopped = await metadata();
            expect(stopped.running).to.equal(false);
            expect(stopped.listen).to.equal('');
            expect(stopped.peers).to.deep.equal([]);

            const restarted = await start();
            expect(restarted.peers.map((peer) => peer.name)).to.deep.equal(['iPhone']);
            expect(startsOf()).to.have.length(2);
        });

        it("switches the proxy port without restarting the helper", async () => {
            await start(9474);
            const [{ pid }] = startsOf();

            const moved = await start(9500);
            expect(moved.running).to.equal(true);
            expect(startsOf()).to.have.length(1);
            expect(commandsOf('set-socks')[0].cmd).to.deep.equal({ cmd: 'set-socks', addr: '127.0.0.1:9500' });
            expect(commandsOf('set-socks')[0].pid).to.equal(pid);

            expect(interceptor.isActive(9500)).to.equal(true);
            expect(interceptor.isActive(9474)).to.equal(false);
        });

        it("restarts the helper when it can't switch the proxy port", async () => {
            process.env.STUB_NO_SET_SOCKS = '1';
            await addPeer('iPhone');
            const [first] = startsOf();

            const moved = await start(9500);
            expect(moved.running).to.equal(true);
            expect(moved.peers.map((peer) => peer.name)).to.deep.equal(['iPhone']);

            const starts = startsOf();
            expect(starts).to.have.length(2);
            expect(isAlive(first.pid)).to.equal(false);
            expect(argValue(starts[1].args, '--socks')).to.equal('127.0.0.1:9500');
            expect(argValue(starts[1].args, '--wireguard')).to.equal(argValue(first.args, '--wireguard'));
        });

        it("starts only one helper for activations that arrive together", async () => {
            const results = await Promise.all([start(), start(), addPeer('iPhone'), start()]);

            expect(results).to.have.length(4);
            expect(startsOf()).to.have.length(1);
        });

        it("stops the helper and keeps its state on deactivate", async () => {
            await addPeer('iPhone');
            const [{ pid }] = startsOf();

            await interceptor.deactivate(PROXY_PORT);

            expect(isAlive(pid)).to.equal(false);
            expect(interceptor.isActive(PROXY_PORT)).to.equal(false);
            expect((await metadata()).running).to.equal(false);
            expect(fs.existsSync(path.join(configPath, 'wirepane-vpn.json'))).to.equal(true);
            expect(logEntries().some((entry) => entry.type === 'stdin-eof' && entry.pid === pid)).to.equal(true);
        });

        it("stops the helper when asked through activate, as the UI's Stop button does", async () => {
            await addPeer('iPhone');
            const [{ pid }] = startsOf();
            expect(interceptor.isActive(PROXY_PORT)).to.equal(true);

            const result = await interceptor.activate(PROXY_PORT, { action: 'stop' }) as WireGuardVpnMetadata;

            // The answer is the metadata of a stopped helper, ready for the UI to show
            expect(result).to.deep.equal({
                available: true,
                running: false,
                listen: '',
                endpointHost: getLanIPv4() ?? '',
                peers: [],
                settings: DEFAULT_VPN_SETTINGS,
                capture: { running: false },
                capabilities: { quicDecrypt: false, ikev2: false },
                ikev2: { running: false }
            });
            expect(result).to.deep.equal(await metadata());
            expect(isAlive(pid)).to.equal(false);
            expect(interceptor.isActive(PROXY_PORT)).to.equal(false);
            expect(logEntries().some((entry) => entry.type === 'stdin-eof' && entry.pid === pid)).to.equal(true);

            // Stopping isn't forgetting: the phone's peer is still saved for the next start
            expect(fs.existsSync(path.join(configPath, 'wirepane-vpn.json'))).to.equal(true);
            const restarted = await start();
            expect(restarted.peers.map((peer) => peer.name)).to.deep.equal(['iPhone']);
            expect(startsOf()).to.have.length(2);
        });

        it("starts nothing when asked to stop and no helper is running", async () => {
            const result = await interceptor.activate(PROXY_PORT, { action: 'stop' }) as WireGuardVpnMetadata;

            expect(result.available).to.equal(true);
            expect(result.running).to.equal(false);
            expect(result.peers).to.deep.equal([]);
            expect(result.error).to.equal(undefined);
            expect(interceptor.isActive(PROXY_PORT)).to.equal(false);

            // The stand-in logs every start, and writes the state file when it starts
            expect(logEntries()).to.deep.equal([]);
            expect(fs.existsSync(path.join(configPath, 'wirepane-vpn.json'))).to.equal(false);
            expect(await readSavedPort(configPath)).to.equal(undefined);

            // Asking again is fine too
            const again = await interceptor.activate(PROXY_PORT, { action: 'stop' }) as WireGuardVpnMetadata;
            expect(again.running).to.equal(false);
            expect(startsOf()).to.have.length(0);
        });

        it("stops the helper for a stop that comes from another proxy port, like a reloaded UI", async () => {
            await start(9474);
            const [{ pid }] = startsOf();

            const result = await interceptor.activate(9500, { action: 'stop' }) as WireGuardVpnMetadata;

            expect(result.running).to.equal(false);
            expect(isAlive(pid)).to.equal(false);
            expect(interceptor.isActive(9474)).to.equal(false);
        });

        it("runs a stop that arrives during a start after it, and leaves nothing running", async () => {
            const [started, stopped] = await Promise.all([
                start(),
                interceptor.activate(PROXY_PORT, { action: 'stop' }) as Promise<WireGuardVpnMetadata>
            ]);

            expect(started.running).to.equal(true);
            expect(stopped.running).to.equal(false);
            expect(startsOf()).to.have.length(1);
            expect(isAlive(startsOf()[0].pid)).to.equal(false);
            expect((await metadata()).running).to.equal(false);
        });

        it("answers a stop with the reason when the helper isn't built", async () => {
            const noBinary = new WireGuardVpnInterceptor({ configPath } as HtkConfig, () => ({
                error: 'The VPN helper (wirepane-tunnel) is not built.'
            }));

            const result = await noBinary.activate(PROXY_PORT, { action: 'stop' }) as WireGuardVpnMetadata;
            expect(result.available).to.equal(false);
            expect(result.running).to.equal(false);
            expect(result.error).to.include('not built');
        });

        it("stops the helper on deactivateAll, when the server shuts down", async () => {
            await start();
            const [{ pid }] = startsOf();

            await interceptor.deactivateAll();

            expect(isAlive(pid)).to.equal(false);
            expect((await metadata()).running).to.equal(false);
            await interceptor.deactivateAll(); // Stopping a stopped helper is fine
        });

        it("stops a helper that ignores its stdin closing", async function () {
            this.timeout(10000);
            process.env.STUB_IGNORE_STDIN_EOF = '1';
            await start();
            const [{ pid }] = startsOf();

            await interceptor.deactivate(PROXY_PORT);

            expect(isAlive(pid)).to.equal(false);
        });

        it("reports a helper that stops by itself, and recovers on the next start", async () => {
            await start();
            const [{ pid }] = startsOf();

            await addPeer('crash-me');

            const crashed = await waitFor(async () => {
                const result = await metadata();
                return result.running ? undefined : result;
            });
            expect(crashed.error).to.include('exited with code 3');
            expect(interceptor.isActive(PROXY_PORT)).to.equal(false);
            expect(isAlive(pid)).to.equal(false);

            const recovered = await start();
            expect(recovered.running).to.equal(true);
            expect(recovered.error).to.equal(undefined);
            expect(startsOf()).to.have.length(2);
        });

        it("explains why the helper couldn't start", async () => {
            process.env.STUB_FAIL_START = '1';

            const message = await rejectionOf(start());
            expect(message).to.include('exited with code 1');
            expect(message).to.include('failed to bind UDP');

            const result = await metadata();
            expect(result.running).to.equal(false);
            expect(interceptor.isActive(PROXY_PORT)).to.equal(false);
        });

        it("explains a helper that can't be run at all", async () => {
            const notRunnable = path.join(configPath, 'not-a-binary');
            fs.writeFileSync(notRunnable, 'this is not a program', { mode: 0o755 });
            const broken = new WireGuardVpnInterceptor({ configPath } as HtkConfig, () => ({ path: notRunnable }));

            const message = await rejectionOf(broken.activate(PROXY_PORT, { action: 'start' }));
            expect(message).to.match(/VPN helper/);
            expect((await broken.getMetadata()).running).to.equal(false);
        });

        it("rejects options it doesn't understand", async () => {
            expect(await rejectionOf(interceptor.activate(PROXY_PORT, { action: 'explode' })))
                .to.include('Unknown wireguard-vpn action');
            expect(await rejectionOf(interceptor.activate(PROXY_PORT, { action: 'remove-peer' })))
                .to.include('remove-peer needs');
            expect(await rejectionOf(interceptor.activate(PROXY_PORT, { action: 'remove-peer', peer: '../etc' })))
                .to.include('remove-peer needs');
            expect(await rejectionOf(interceptor.activate(0, { action: 'start' })))
                .to.include('Invalid proxy port');
            expect(await rejectionOf(interceptor.activate(PROXY_PORT, 'start')))
                .to.include('Invalid wireguard-vpn options');

            // None of that started anything
            expect(startsOf()).to.have.length(0);
        });

        it("starts the helper when activated without options, or with an empty body", async () => {
            const result = await interceptor.activate(PROXY_PORT) as WireGuardVpnMetadata;
            expect(result.running).to.equal(true);

            // The REST API passes an empty request body as {}
            const again = await interceptor.activate(PROXY_PORT, {}) as WireGuardVpnMetadata;
            expect(again.running).to.equal(true);
            expect(startsOf()).to.have.length(1);
        });

        // --- IKEv2 for iPhones without the WireGuard app (wirepane-tunnel/docs/ikev2.md) ---

        const IKEV2_CAPABLE = JSON.stringify({ quicDecrypt: false, ikev2: true });
        let testCaPem: string | undefined;

        // The profile's address and its one-time link stay on this machine
        const onLoopback = () => new WireGuardVpnInterceptor({ configPath } as HtkConfig, findTunnelBinary, {
            lanAddress: () => '127.0.0.1'
        });
        const writeCa = async () => {
            testCaPem ??= (await generateCACertificate({ subject: { commonName: 'Wirepane CA (test)' } })).cert;
            fs.writeFileSync(path.join(configPath, 'wirepane-ca.pem'), testCaPem);
            return testCaPem;
        };
        const requestProfile = (name?: string) =>
            interceptor.activate(PROXY_PORT, { action: 'ikev2-profile', name }) as Promise<Ikev2ProfileAnswer>;

        it("starts the helper with IKEv2 on UDP 500 and says where it listens", async () => {
            process.env.STUB_CAPABILITIES = IKEV2_CAPABLE;
            const result = await start();

            expect(argValue(startsOf()[0].args, '--ikev2')).to.equal('0.0.0.0:500');
            expect(result.capabilities.ikev2).to.equal(true);
            expect(result.ikev2).to.deep.equal({ running: true, ike: '0.0.0.0:500', natT: '0.0.0.0:4500' });
            expect(result.error).to.equal(undefined);
        });

        it("creates an IKEv2 profile with the CA and a one-time link, and adds the device", async function () {
            this.timeout(10000);
            process.env.STUB_CAPABILITIES = IKEV2_CAPABLE;
            interceptor = onLoopback();
            const caPem = await writeCa();

            const answer = await requestProfile('Azim iPhone');

            // Exactly what vpn-ikev2-setup.tsx reads (parseIkev2ProfileAnswer)
            expect(Object.keys(answer).sort()).to.deep.equal(['link', 'name', 'peer', 'profile']);
            expect(answer.peer).to.equal('p1');
            expect(answer.name).to.equal('Azim iPhone');
            expect(answer.link).to.match(/^http:\/\/\d{1,3}(\.\d{1,3}){3}:\d{1,5}\/[0-9a-f]{32}\.mobileconfig$/);
            expect(answer.link).to.match(/^http:\/\/127\.0\.0\.1:/);
            expect(commandsOf('add-peer')[0].cmd).to.deep.equal({ cmd: 'add-peer', name: 'Azim iPhone', kind: 'ikev2' });

            const [ca, vpn] = plist.parse(answer.profile).PayloadContent;
            expect(vpn.IKEv2).to.deep.include({
                RemoteAddress: '127.0.0.1',
                RemoteIdentifier: 'vpn.wirepane',
                LocalIdentifier: 'p1.wirepane',
                AuthenticationMethod: 'SharedSecret'
            });
            expect(vpn.IKEv2.SharedSecret).to.match(/^[A-Za-z0-9+/]{43}=$/);
            const der = Buffer.from(caPem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
            expect(Buffer.from(ca.PayloadContent).equals(der)).to.equal(true);

            // The device is listed like a WireGuard one
            expect((await metadata()).peers.map((peer) => peer.name)).to.deep.equal(['Azim iPhone']);

            // Safari on the iPhone gets the same profile from the link
            const download = await httpGet(answer.link!);
            expect(download.status).to.equal(200);
            expect(download.body).to.equal(answer.profile);

            // A second device gets its own profile
            const second = await requestProfile('iPad');
            expect(second.peer).to.equal('p2');
            expect(plist.parse(second.profile).PayloadContent[1].IKEv2.LocalIdentifier).to.equal('p2.wirepane');
        });

        it("never logs or saves the device's secret", async function () {
            this.timeout(10000);
            process.env.STUB_CAPABILITIES = IKEV2_CAPABLE;
            interceptor = onLoopback();
            await writeCa();

            const logged: string[] = [];
            const levels = ['log', 'info', 'warn', 'error', 'debug'] as const;
            const originals = levels.map((level) => console[level]);
            levels.forEach((level) => {
                console[level] = (...args: unknown[]) => { logged.push(args.map(String).join(' ')); };
            });
            let answer: Ikev2ProfileAnswer;
            try {
                answer = await requestProfile();
                await httpGet(answer.link!);
            } finally {
                levels.forEach((level, i) => { console[level] = originals[i]; });
            }

            const secret: string = plist.parse(answer.profile).PayloadContent[1].IKEv2.SharedSecret;
            expect(logged.join('\n')).not.to.include(secret);
            expect(JSON.stringify(await metadata())).not.to.include(secret);
            expect(JSON.stringify(await interceptor.getSubMetadata('events-0'))).not.to.include(secret);

            // Nothing in the config folder holds it or the profile
            const files = (fs.readdirSync(configPath, { recursive: true }) as string[])
                .map((file) => path.join(configPath, file))
                .filter((file) => fs.statSync(file).isFile());
            expect(files.length).to.be.at.least(2);
            for (const file of files) {
                const content = fs.readFileSync(file, 'utf8');
                expect(content, file).not.to.include(secret);
                expect(content, file).not.to.include('<plist');
            }
        });

        it("keeps WireGuard working when UDP 500 or 4500 can't be bound", async () => {
            process.env.STUB_CAPABILITIES = IKEV2_CAPABLE;
            process.env.STUB_IKEV2_BIND_ERROR = '1';
            interceptor = onLoopback();
            await writeCa();

            const result = await start();
            expect(result.running).to.equal(true);
            // Not the VPN's problem: the UI only shows IKEv2 as off
            expect(result.error).to.equal(undefined);
            expect(result.ikev2.running).to.equal(false);
            expect(result.ikev2.error).to.include('cannot bind UDP 0.0.0.0:500');

            expect((await addPeer('Android')).config).to.include('[Interface]');

            const message = await rejectionOf(requestProfile());
            expect(message).to.include("IKEv2 couldn't listen on UDP ports 500 and 4500");
            expect(message).to.include('Address already in use');
            expect(message).to.include('stop VPN mode and start it again');
            // Not what the UI takes for "this build can't do IKEv2" (isIkev2Unsupported)
            expect(message).not.to.match(/ikev2 is not (available|supported|running)/i);
            expect(commandsOf('add-peer').map((entry) => entry.cmd.kind)).to.deep.equal(['wireguard']);
            expect((await metadata()).error).to.equal(undefined);
        });

        it("starts a helper built before IKEv2 without the option, and says it can't make profiles", async () => {
            process.env.STUB_NO_IKEV2_OPTION = '1';
            interceptor = onLoopback();
            await writeCa();

            const result = await start();
            expect(result.running).to.equal(true);
            expect(result.error).to.equal(undefined);
            expect(result.ikev2).to.deep.equal({ running: false });
            const [refused, started] = startsOf();
            expect(startsOf()).to.have.length(2);
            expect(refused.args).to.include('--ikev2');
            expect(started.args).not.to.include('--ikev2');
            expect(isAlive(refused.pid)).to.equal(false);

            // The UI shows "this build can't run the IKEv2 VPN yet" for this message
            expect(await rejectionOf(requestProfile())).to.match(/ikev2 is not (available|supported|running)/i);
            expect(commandsOf('add-peer')).to.have.length(0);
        });

        it("adds no device when there's no address to dial or no CA to put in the profile", async () => {
            process.env.STUB_CAPABILITIES = IKEV2_CAPABLE;
            interceptor = new WireGuardVpnInterceptor({ configPath } as HtkConfig, findTunnelBinary, {
                lanAddress: () => undefined
            });
            await writeCa();
            expect(await rejectionOf(requestProfile())).to.include('no network address');
            await interceptor.deactivateAll();

            fs.rmSync(path.join(configPath, 'wirepane-ca.pem'));
            interceptor = onLoopback();
            expect(await rejectionOf(requestProfile())).to.include('Wirepane CA certificate');
            expect(commandsOf('add-peer')).to.have.length(0);
        });

        it("takes the device out again when the helper's answer can't make a profile", async () => {
            process.env.STUB_CAPABILITIES = IKEV2_CAPABLE;
            process.env.STUB_IKEV2_BAD_IDENTITY = '1';
            interceptor = onLoopback();
            await writeCa();

            expect(await rejectionOf(requestProfile())).to.include('no usable IKEv2 setup');
            expect(commandsOf('remove-peer').map((entry) => entry.cmd.peer)).to.deep.equal(['p1']);
            expect((await metadata()).peers).to.deep.equal([]);
        });

        it("closes open profile links when the helper stops, on purpose or not", async function () {
            this.timeout(10000);
            process.env.STUB_CAPABILITIES = IKEV2_CAPABLE;
            interceptor = onLoopback();
            await writeCa();

            const first = await requestProfile();
            await interceptor.deactivate(PROXY_PORT);
            expect(await rejectionOf(httpGet(first.link!))).to.include('ECONNREFUSED');

            const second = await requestProfile();
            await addPeer('crash-me');
            await waitFor(async () => !(await metadata()).running);
            expect(await rejectionOf(httpGet(second.link!))).to.include('ECONNREFUSED');
        });

        it("doesn't let the helper outlive the server", async function () {
            this.timeout(20000);

            // Run the interceptor in a separate process, standing in for the server
            const server = spawn(
                process.execPath,
                ['--import', 'tsx', HARNESS, configPath, String(PROXY_PORT)],
                { stdio: ['ignore', 'pipe', 'inherit'], env: process.env }
            );

            try {
                await new Promise<void>((resolve, reject) => {
                    server.once('exit', () => reject(new Error('The stand-in server exited early')));
                    server.stdout.on('data', (data) => {
                        if (data.toString().includes('started')) resolve();
                    });
                });

                const [{ pid }] = startsOf();
                expect(isAlive(pid)).to.equal(true);

                // SIGKILL gives the server no chance to clean up
                server.kill('SIGKILL');

                await waitFor(() => !isAlive(pid), 5000);
            } finally {
                server.kill('SIGKILL');
            }
        });

    });

});

describe("the VPN network tools' settings", () => {

    it("merges patches and drops conditions set to null", () => {
        const one = applySettingsPatch(DEFAULT_VPN_SETTINGS, parseSettingsPatch({
            conditions: { p1: { latencyMs: 50 }, p2: { downKbps: 100 } }
        }));
        expect(one.conditions.p1).to.deep.equal({ latencyMs: 50, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 0 });
        const two = applySettingsPatch(one, parseSettingsPatch({ conditions: { p1: null }, quic: 'block' }));
        expect(Object.keys(two.conditions)).to.deep.equal(['p2']);
        expect(two.dnsRules).to.deep.equal([]);
        expect(DEFAULT_VPN_SETTINGS.conditions).to.deep.equal({});
    });

    it("accepts the DNS names the helper accepts, compared like it does", () => {
        const longest = `${'a'.repeat(63)}.${'a'.repeat(63)}.${'a'.repeat(63)}.${'b'.repeat(61)}`;
        expect(longest).to.have.length(253);
        const { dnsRules } = parseSettingsPatch({
            dnsRules: [
                { pattern: ' *.Example.COM. ', action: 'block' },
                { pattern: '_dmarc.my-site.test', action: 'block' },
                { pattern: `${'x'.repeat(63)}.test`, action: 'block' },
                { pattern: longest, action: 'answer', ipv4: '10.0.0.5' }
            ]
        });
        expect(dnsRules!.map((rule) => rule.pattern)).to.deep.equal([
            '*.example.com', '_dmarc.my-site.test', `${'x'.repeat(63)}.test`, longest
        ]);
    });

    it("drops only the saved DNS rules the helper would refuse", async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'htk-vpn-settings-'));
        try {
            fs.writeFileSync(path.join(dir, 'wirepane-vpn-settings.json'), JSON.stringify({
                dnsRules: [{ pattern: '*', action: 'block' }, { pattern: 'ok.test', action: 'block' }],
                quic: 'relay',
                conditions: { p1: { latencyMs: 80 } }
            }));
            const settings = await loadSettings(dir);
            expect(settings.dnsRules).to.deep.equal([{ pattern: 'ok.test', action: 'block' }]);
            expect(settings.quic).to.equal('relay');
            expect(settings.conditions.p1?.latencyMs).to.equal(80);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });

    it("names captures by the local time", () => {
        const file = capturePath('/config', new Date(2026, 9, 13, 9, 5, 7));
        expect(file).to.equal(path.join('/config', 'captures', 'wirepane-2026-10-13_09-05-07.pcapng'));
    });

    it("keeps only the newest events", () => {
        const log = new ToolEventLog(3);
        for (let i = 1; i <= 10; i++) log.push({ event: 'dns', n: i });
        const { seq, events } = log.since(0);
        expect(seq).to.equal(10);
        expect(events.map((event) => event.n)).to.deep.equal([8, 9, 10]);
        expect(log.since(9).events.map((event) => event.n)).to.deep.equal([10]);
    });

});
