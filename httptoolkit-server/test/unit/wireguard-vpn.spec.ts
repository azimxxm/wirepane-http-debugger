import * as dgram from 'dgram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { expect } from 'chai';

import type { HtkConfig } from '../../src/config';
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

// A stand-in for the wirepane-tunnel binary that speaks its JSON-lines protocol
const FIXTURES = path.join(__dirname, '..', 'fixtures');
const STUB = path.join(FIXTURES, 'wirepane-tunnel-stub.cjs');
const HARNESS = path.join(FIXTURES, 'wireguard-vpn-harness.ts');

const PROXY_PORT = 9474;

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
            'STUB_LATE_PEER'
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
                peers: []
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
                peers: []
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
