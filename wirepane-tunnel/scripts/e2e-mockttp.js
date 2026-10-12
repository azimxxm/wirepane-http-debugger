#!/usr/bin/env node
// End-to-end check against a real Mockttp (the one httptoolkit-server ships):
//   WireGuard test client -> wirepane-tunnel -> SOCKS5 (custom-metadata) -> Mockttp -> origin
// It shows that the request reaches Mockttp carrying the wirepane-vpn tags.
//
//   node scripts/e2e-mockttp.js [path to the wirepane-tunnel binary] [path to the wg_client example]
//
// Build first: cargo build --release --examples (or --examples for debug).

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const readline = require('readline');

const repoRoot = path.resolve(__dirname, '..', '..');
const mockttp = require(path.join(repoRoot, 'httptoolkit-server', 'node_modules', 'mockttp'));

const crateRoot = path.resolve(__dirname, '..');
const binary = process.argv[2] || path.join(crateRoot, 'target', 'release', 'wirepane-tunnel');
const client = process.argv[3] || path.join(crateRoot, 'target', 'release', 'examples', 'wg_client');

const log = (...parts) => console.log('[e2e]', ...parts);
const fail = (message) => {
    console.error('[e2e] FAILED:', message);
    process.exitCode = 1;
};

async function main() {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wirepane-e2e-'));

    // The origin the passthrough rule forwards to.
    const origin = http.createServer((req, res) => {
        res.setHeader('content-type', 'text/plain');
        res.end(`origin saw ${req.method} ${req.url}`);
    });
    await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve));
    const originPort = origin.address().port;

    // The real Mockttp, with the SOCKS options the Wirepane UI will use.
    const proxy = mockttp.getLocal({ socks: { authMethods: ['no-auth', 'custom-metadata'] } });
    const randomPort = await new Promise((resolve) => {
        const probe = net.createServer().listen(0, '127.0.0.1', () => {
            const { port } = probe.address();
            probe.close(() => resolve(port));
        });
    });
    await proxy.start(randomPort);
    await proxy.forAnyRequest().thenPassThrough();
    const seen = [];
    await proxy.on('request', (request) => seen.push(request));
    log(`Mockttp on 127.0.0.1:${proxy.port}, origin on 127.0.0.1:${originPort}`);

    const sidecar = spawn(binary, [
        '--wireguard', '127.0.0.1:0',
        '--state', path.join(tmp, 'state.json'),
        '--socks', `127.0.0.1:${proxy.port}`,
        '--endpoint-host', '127.0.0.1',
        '--unsafe-allow-loopback', // test only: the origin is on loopback
    ], { stdio: ['pipe', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => sidecar.on('exit', (code) => resolve(code)));

    const waiters = [];
    const events = [];
    readline.createInterface({ input: sidecar.stdout }).on('line', (line) => {
        const event = JSON.parse(line);
        events.push(event);
        log('sidecar event:', line.length > 200 ? line.slice(0, 200) + '...' : line);
        for (const waiter of waiters.splice(0)) waiter(event);
    });
    const nextEvent = (name) => new Promise((resolve, reject) => {
        const existing = events.find((e) => e.event === name);
        if (existing) return resolve(existing);
        const timer = setTimeout(() => reject(new Error(`no ${name} event`)), 10000);
        const check = (event) => {
            if (event.event === name) { clearTimeout(timer); resolve(event); }
            else waiters.push(check);
        };
        waiters.push(check);
    });

    try {
        await nextEvent('ready');
        sidecar.stdin.write(JSON.stringify({ cmd: 'add-peer', name: 'e2e phone', kind: 'wireguard' }) + '\n');
        const added = await nextEvent('peer-added');
        const configFile = path.join(tmp, 'phone.conf');
        fs.writeFileSync(configFile, added.config);

        // Async on purpose: Mockttp runs in this process, a blocking spawn would freeze it.
        const result = await new Promise((resolve) => {
            const child = spawn(client, [
                '--config', configFile,
                '--dns', 'localhost',
                '--get', `127.0.0.1:${originPort}`,
                '--host', `localhost:${originPort}`,
                '--path', '/e2e-through-wireguard',
            ]);
            let stdout = '';
            let stderr = '';
            child.stdout.on('data', (chunk) => { stdout += chunk; });
            child.stderr.on('data', (chunk) => { stderr += chunk; });
            const timer = setTimeout(() => child.kill(), 30000);
            child.on('exit', (status) => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
        });
        for (const line of result.stdout.split('\n').filter(Boolean)) log('client:', line);
        if (result.status !== 0) throw new Error(`client exited with ${result.status}: ${result.stderr}`);

        // Give Mockttp a moment to emit the completed request event.
        for (let i = 0; i < 50 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
        if (seen.length === 0) throw new Error('Mockttp saw no request');

        const request = seen[0];
        log('Mockttp saw:', JSON.stringify({
            method: request.method,
            url: request.url,
            host: request.headers.host,
            tags: request.tags,
        }));
        const expected = [
            'socket-metadata:wirepane-vpn',
            'socket-metadata:wirepane-vpn-peer:p1',
            'socket-metadata:wirepane-vpn-endpoint:127.0.0.1',
            'socket-metadata:wirepane-vpn-name:localhost',
        ];
        for (const tag of expected) {
            if (!request.tags.includes(tag)) throw new Error(`missing tag ${tag}`);
        }
        const body = result.stdout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((l) => l.step === 'get');
        if (!body || !body.ok || !body.response.includes('origin saw GET /e2e-through-wireguard')) {
            throw new Error('the client did not get the origin response through the tunnel');
        }
        log('PASS: the request arrived at Mockttp with the wirepane-vpn tags and was passed through to the origin');
    } catch (error) {
        fail(error.message);
    } finally {
        sidecar.stdin.end(); // stdin EOF stops the sidecar
        const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 5000))]);
        log('sidecar exit code after stdin EOF:', code);
        if (code !== 0) fail('the sidecar did not exit cleanly after stdin EOF');
        await proxy.stop();
        origin.close();
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

main().catch((error) => { fail(error.stack || error.message); });
