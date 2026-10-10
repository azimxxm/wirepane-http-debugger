import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as net from 'net';
import * as http from 'http';
import type * as stream from 'stream';
import type { AddressInfo } from 'net';
import type { Application } from 'express';
import { expect } from 'chai';
import { WebSocketServer } from 'ws';
import * as mockttp from 'mockttp';

import { HttpClient } from '../../src/client/http-client';
import { HttpToolkitServerApi } from '../../src/api/api-server';
import {
    getHandshakeHeaders,
    WebSocketClient,
    WebSocketEvent
} from '../../src/client/ws-client';
import { streamToArray } from '../../src/util/stream';

const ORIGIN = 'http://localhost:8080';
const AUTH_TOKEN = 'ws-client-test-token';

// An echo server, which also remembers the handshake requests it saw
async function startEchoServer(options: ConstructorParameters<typeof WebSocketServer>[0] = {}) {
    const handshakes: http.IncomingMessage[] = [];
    const closes: Array<{ code: number, reason: string }> = [];

    const server = new WebSocketServer({ port: 0, host: '127.0.0.1', ...options });
    server.on('connection', (socket, request) => {
        handshakes.push(request);
        socket.on('message', (data, isBinary) => socket.send(data, { binary: isBinary }));
        socket.on('close', (code, reason) => closes.push({ code, reason: reason.toString() }));
    });
    await new Promise((resolve) => server.once('listening', resolve));

    const { port } = server.address() as AddressInfo;
    return { server, port, handshakes, closes };
}

async function getClosedPort() {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise((resolve) => server.close(resolve));
    return port;
}

async function nextEvent(iterator: AsyncIterator<WebSocketEvent>): Promise<WebSocketEvent> {
    const result = await iterator.next();
    if (result.done) throw new Error('The event stream ended early');
    return result.value;
}

const eventsOf = (events: stream.Readable) => events[Symbol.asyncIterator]() as AsyncIterator<WebSocketEvent>;

// The message a promise is rejected with
async function rejectionOf(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error: any) {
        return error.message;
    }
    throw new Error('Expected the promise to be rejected');
}

async function waitFor(condition: () => boolean, timeoutMs = 2000) {
    const start = Date.now();
    while (!condition()) {
        if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for condition');
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

describe("The WebSocket client", function () {
    this.timeout(10000);

    let echo: Awaited<ReturnType<typeof startEchoServer>>;
    afterEach(() => echo?.server.close());

    it("opens, echoes text and binary messages, and closes", async () => {
        echo = await startEchoServer({
            handleProtocols: (protocols) => protocols.has('echo-v1') ? 'echo-v1' : false
        });
        const client = new WebSocketClient(new HttpClient({}));

        const { id, events } = await client.open({
            url: `ws://localhost:${echo.port}/socket?room=1`,
            headers: [
                ['X-Custom', 'custom-value'],
                ['Cookie', 'a=1'],
                ['cookie', 'b=2'],
                ['Sec-WebSocket-Protocol', 'echo-v1, other'],
                // Copies of what the handshake sets itself, e.g. from resending a captured
                // WebSocket. These must not be sent twice:
                ['Connection', 'keep-alive'],
                ['Sec-WebSocket-Key', 'c3RhbGUta2V5LXZhbHVlIQ=='],
                ['Content-Length', '12']
            ]
        }, {});
        const iterator = eventsOf(events);

        const open = await nextEvent(iterator);
        expect(open).to.include({
            type: 'ws-open',
            id,
            protocol: 'echo-v1',
            statusCode: 101
        });
        expect(open.type === 'ws-open' && open.headers.some(([name]) => name.toLowerCase() === 'sec-websocket-accept'))
            .to.equal(true);

        const handshake = echo.handshakes[0];
        expect(handshake.url).to.equal('/socket?room=1');
        expect(handshake.headers['x-custom']).to.equal('custom-value');
        expect(handshake.headers['cookie']).to.equal('a=1; b=2');
        expect(handshake.headers['connection']).to.equal('Upgrade');
        expect(handshake.headers['sec-websocket-key']).to.not.equal('c3RhbGUta2V5LXZhbHVlIQ==');
        expect(handshake.headers['sec-websocket-protocol']).to.equal('echo-v1,other');
        expect(handshake.headers['content-length']).to.equal(undefined);

        await client.send(id, Buffer.from('hello'), false);
        const textEcho = await nextEvent(iterator);
        expect(textEcho.type).to.equal('ws-message');
        if (textEcho.type !== 'ws-message') throw new Error('Unreachable');
        expect(textEcho.isBinary).to.equal(false);
        expect(textEcho.data.toString()).to.equal('hello');

        await client.send(id, Buffer.from([0, 1, 2, 255]), true);
        const binaryEcho = await nextEvent(iterator);
        if (binaryEcho.type !== 'ws-message') throw new Error(`Unexpected ${binaryEcho.type}`);
        expect(binaryEcho.isBinary).to.equal(true);
        expect([...binaryEcho.data]).to.deep.equal([0, 1, 2, 255]);

        client.close(id, 4000, 'all done');
        const close = await nextEvent(iterator);
        expect(close).to.include({ type: 'ws-close', code: 4000, reason: 'all done' });

        expect((await iterator.next()).done).to.equal(true);
        await waitFor(() => echo.closes.length === 1);
        expect(echo.closes[0]).to.deep.equal({ code: 4000, reason: 'all done' });
        expect(client.openCount).to.equal(0);
    });

    it("reports a failed upgrade with its status, headers and body", async () => {
        echo = await startEchoServer({
            verifyClient: (_info, callback) => callback(false, 401, 'Missing token', { 'X-Reason': 'no-auth' })
        });
        const client = new WebSocketClient(new HttpClient({}));

        const { events } = await client.open({ url: `ws://127.0.0.1:${echo.port}`, headers: [] }, {});
        const allEvents = await streamToArray<WebSocketEvent>(events);

        expect(allEvents.length).to.equal(1);
        const [failure] = allEvents;
        if (failure.type !== 'error') throw new Error(`Unexpected ${failure.type}`);

        expect(failure.error.code).to.equal('unexpected-response');
        expect(failure.error.message).to.include('401');
        expect(failure.response!.statusCode).to.equal(401);
        expect(failure.response!.statusMessage).to.equal('Unauthorized');
        expect(failure.response!.headers).to.deep.include(['X-Reason', 'no-auth']);
        expect(failure.response!.body.toString()).to.equal('Missing token');
        expect(client.openCount).to.equal(0);
    });

    it("reports connection errors without a close", async () => {
        const client = new WebSocketClient(new HttpClient({}));
        const port = await getClosedPort();

        const { events } = await client.open({ url: `ws://127.0.0.1:${port}`, headers: [] }, {});
        const allEvents = await streamToArray<WebSocketEvent>(events);

        expect(allEvents.length).to.equal(1);
        expect(allEvents[0].type).to.equal('error');
        if (allEvents[0].type !== 'error') throw new Error('Unreachable');
        expect(allEvents[0].error.code).to.equal('ECONNREFUSED');
        expect(allEvents[0].response).to.equal(undefined);
    });

    it("refuses URLs that aren't WebSockets, and bad close codes", async () => {
        echo = await startEchoServer();
        const client = new WebSocketClient(new HttpClient({}));

        expect(await rejectionOf(client.open({ url: 'ftp://example.com', headers: [] }, {})))
            .to.include('ws:// or wss://');

        const { id, events } = await client.open({ url: `http://127.0.0.1:${echo.port}`, headers: [] }, {});
        const iterator = eventsOf(events);
        expect((await nextEvent(iterator)).type).to.equal('ws-open'); // http:// connects as ws://

        expect(() => client.close(id, 1006)).to.throw("isn't a close code a client can send");
        expect(() => client.close(id, 1000, 'x'.repeat(124))).to.throw('at most 123 bytes');
        expect(await rejectionOf(client.send('no-such-id', Buffer.from('hi'), false))).to.include("There's no WebSocket");

        client.close(id);
        expect(await nextEvent(iterator)).to.include({ type: 'ws-close', code: 1000 });
    });

    it("closes every socket when the server stops", async () => {
        echo = await startEchoServer();
        const client = new WebSocketClient(new HttpClient({}));

        const { events } = await client.open({ url: `ws://127.0.0.1:${echo.port}`, headers: [] }, {});
        const iterator = eventsOf(events);
        expect((await nextEvent(iterator)).type).to.equal('ws-open');

        await client.closeAll();
        await waitFor(() => echo.closes.length === 1);
        expect(echo.closes[0].code).to.equal(1001);
        expect(client.openCount).to.equal(0);
    });

    describe("through Send's proxy", () => {

        let proxy: mockttp.Mockttp;
        let ca: { key: string, cert: string };
        // A plain HTTP proxy, which can still intercept TLS inside its tunnels
        let proxyConfig: { proxyUrl: string };

        beforeEach(async () => {
            ca = await mockttp.generateCACertificate();
            proxy = mockttp.getLocal({ https: ca });
            await proxy.start();
            await proxy.forAnyWebSocket().thenEcho();
            proxyConfig = { proxyUrl: `http://localhost:${proxy.port}` };
        });

        afterEach(() => proxy.stop());

        it("connects to ws:// URLs", async () => {
            const client = new WebSocketClient(new HttpClient({}));

            // The host doesn't exist: only the proxy can answer
            const { id, events } = await client.open({ url: 'ws://wirepane-test.invalid/socket', headers: [] }, {
                proxyConfig
            });
            const iterator = eventsOf(events);
            expect((await nextEvent(iterator)).type).to.equal('ws-open');

            await client.send(id, Buffer.from('through the proxy'), false);
            const echoed = await nextEvent(iterator);
            if (echoed.type !== 'ws-message') throw new Error(`Unexpected ${echoed.type}`);
            expect(echoed.data.toString()).to.equal('through the proxy');

            client.close(id);
        });

        it("connects to wss:// URLs, with the upstream CAs and ignored HTTPS errors", async () => {
            const client = new WebSocketClient(new HttpClient({}));
            const url = 'wss://wirepane-test.invalid/socket';

            // The proxy's certificate isn't trusted by default...
            const untrusted = await streamToArray<WebSocketEvent>(
                (await client.open({ url, headers: [] }, { proxyConfig })).events
            );
            expect(untrusted.length).to.equal(1);
            expect(untrusted[0].type).to.equal('error');

            // ...but works once its CA is trusted...
            const trusted = await client.open({ url, headers: [] }, {
                proxyConfig,
                additionalTrustedCAs: [{ cert: ca.cert }]
            });
            expect((await nextEvent(eventsOf(trusted.events))).type).to.equal('ws-open');
            client.close(trusted.id);

            // ...or when HTTPS errors are ignored for the host
            const ignored = await client.open({ url, headers: [] }, {
                proxyConfig,
                ignoreHostHttpsErrors: ['wirepane-test.invalid']
            });
            expect((await nextEvent(eventsOf(ignored.events))).type).to.equal('ws-open');
            client.close(ignored.id);
        });

    });

    it("builds handshake headers from the tab's headers", () => {
        expect(getHandshakeHeaders([
            ['Host', 'example.com'],
            ['Upgrade', 'websocket'],
            ['Sec-WebSocket-Version', '13'],
            ['Sec-WebSocket-Extensions', 'permessage-deflate'],
            ['Sec-WebSocket-Protocol', 'graphql-ws'],
            ['sec-websocket-protocol', ' chat ,,superchat'],
            ['Accept', 'a'],
            ['accept', 'b'],
            ['Origin', 'https://example.com']
        ], undefined)).to.deep.equal({
            headers: {
                'Host': 'example.com',
                'Accept': 'a, b',
                'Origin': 'https://example.com'
            },
            protocols: ['graphql-ws', 'chat', 'superchat']
        });

        // Explicit subprotocols win over the header:
        expect(getHandshakeHeaders([['Sec-WebSocket-Protocol', 'chat']], []).protocols).to.deep.equal([]);
    });

});

describe("The WebSocket client REST API", function () {
    this.timeout(10000);

    let configPath: string;
    let apiServer: http.Server;
    let baseUrl: string;
    let echo: Awaited<ReturnType<typeof startEchoServer>>;

    const headers = {
        origin: ORIGIN,
        authorization: `Bearer ${AUTH_TOKEN}`,
        'content-type': 'application/json'
    };

    const post = async (urlPath: string, body: unknown) => {
        const response = await fetch(`${baseUrl}${urlPath}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
    };

    // Reads an NDJSON response as a queue of events
    const openStream = async (body: unknown, signal?: AbortSignal) => {
        const response = await fetch(`${baseUrl}/client/ws/open`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
            signal
        });
        expect(response.status).to.equal(200);
        expect(response.headers.get('content-type')).to.equal('application/x-ndjson');

        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffered = '';

        return {
            async next(): Promise<any | undefined> {
                while (!buffered.includes('\n')) {
                    const { done, value } = await reader.read();
                    if (done) return undefined;
                    buffered += decoder.decode(value, { stream: true });
                }
                const newline = buffered.indexOf('\n');
                const line = buffered.slice(0, newline);
                buffered = buffered.slice(newline + 1);
                return JSON.parse(line);
            }
        };
    };

    before(async () => {
        configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wirepane-ws-api-test-'));
        const certPath = path.join(configPath, 'ca.pem');
        fs.writeFileSync(certPath, 'unused'); // Read (but not parsed) when interceptors are created

        // The real API server's middleware and routes, on a random local port (as in the
        // collections API tests: start() would also open the UI bridge socket).
        const api = new HttpToolkitServerApi(
            {
                configPath,
                authToken: AUTH_TOKEN,
                https: { keyPath: '', certPath, certContent: '', keyLength: 2048, certificateTransparency: true }
            },
            new HttpClient({}),
            () => []
        );
        const app = (api as unknown as { server: Application }).server;

        apiServer = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => apiServer.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
    });

    beforeEach(async () => {
        echo = await startEchoServer();
    });

    afterEach(() => echo.server.close());

    after(() => {
        apiServer.close();
        fs.rmSync(configPath, { recursive: true, force: true });
    });

    it("opens a socket, sends a message and closes it", async () => {
        const events = await openStream({
            request: { url: `ws://127.0.0.1:${echo.port}/chat`, headers: [['X-Test', '1']] },
            options: {}
        });

        const open = await events.next();
        expect(open.type).to.equal('ws-open');
        expect(open.id).to.be.a('string');
        expect(echo.handshakes[0].headers['x-test']).to.equal('1');

        const sent = await post(`/client/ws/${open.id}/send`, {
            data: Buffer.from('{"hello":"world"}').toString('base64'),
            isBinary: false
        });
        expect(sent).to.deep.equal({ status: 200, body: { success: true } });

        const message = await events.next();
        expect(message.type).to.equal('ws-message');
        expect(message.isBinary).to.equal(false);
        expect(Buffer.from(message.data, 'base64').toString()).to.equal('{"hello":"world"}');

        const closed = await post(`/client/ws/${open.id}/close`, { code: 1000, reason: 'bye' });
        expect(closed).to.deep.equal({ status: 200, body: { success: true } });

        const close = await events.next();
        expect(close).to.include({ type: 'ws-close', code: 1000, reason: 'bye' });
        expect(await events.next()).to.equal(undefined); // The stream ends
    });

    it("sends big binary messages", async () => {
        const events = await openStream({ request: { url: `ws://127.0.0.1:${echo.port}` } });
        const open = await events.next();

        const bigMessage = Buffer.alloc(2 * 1024 * 1024, 7); // Bigger than the default JSON body limit
        const sent = await post(`/client/ws/${open.id}/send`, {
            data: bigMessage.toString('base64'),
            isBinary: true
        });
        expect(sent.status).to.equal(200);

        const message = await events.next();
        expect(message.isBinary).to.equal(true);
        expect(Buffer.from(message.data, 'base64').equals(bigMessage)).to.equal(true);
    });

    it("closes the socket when the event stream is closed", async () => {
        const abortController = new AbortController();
        const events = await openStream({ request: { url: `ws://127.0.0.1:${echo.port}` } }, abortController.signal);
        expect((await events.next()).type).to.equal('ws-open');

        abortController.abort();
        await waitFor(() => echo.closes.length === 1);
        expect(echo.closes[0].code).to.equal(1001);
    });

    it("answers while connecting, and stops connecting when the stream is closed", async () => {
        // A server that never answers the handshake
        const handshakeSockets: net.Socket[] = [];
        const silentServer = http.createServer();
        silentServer.on('upgrade', (_request, socket: net.Socket) => {
            handshakeSockets.push(socket);
            // Upgraded sockets are half-open: the client closing shows up as 'end'
            socket.on('end', () => { (socket as any).endedByClient = true; });
        });
        await new Promise<void>((resolve) => silentServer.listen(0, '127.0.0.1', resolve));
        const silentPort = (silentServer.address() as AddressInfo).port;

        try {
            const abortController = new AbortController();
            // The response starts straight away, before the socket has opened:
            await openStream({ request: { url: `ws://127.0.0.1:${silentPort}` } }, abortController.signal);
            await waitFor(() => handshakeSockets.length === 1);

            abortController.abort();
            await waitFor(() => (handshakeSockets[0] as any).endedByClient === true);
        } finally {
            handshakeSockets.forEach((socket) => socket.destroy());
            silentServer.close();
        }
    });

    it("rejects invalid requests", async () => {
        expect((await post('/client/ws/open', { request: { url: 'mailto:someone' } })).status).to.equal(400);
        expect((await post('/client/ws/open', { request: { url: 'ws://localhost', headers: 'nope' } })).status).to.equal(400);

        const unnamedHeader = await post('/client/ws/open', {
            request: { url: `ws://127.0.0.1:${echo.port}`, headers: [['', 'chat']] }
        });
        expect(unnamedHeader.status).to.equal(400);
        expect(unnamedHeader.body.error.message).to.include('has no name');
        expect((await post('/client/ws/unknown/send', { data: '' })).status).to.equal(404);
        expect((await post('/client/ws/unknown/close', {})).status).to.equal(404);

        const noOrigin = await fetch(`${baseUrl}/client/ws/open`, {
            method: 'POST',
            headers: { authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/json' },
            body: JSON.stringify({ request: { url: `ws://127.0.0.1:${echo.port}` } })
        });
        expect(noOrigin.status).to.equal(403);
        expect(echo.handshakes.length).to.equal(0);
    });

});
