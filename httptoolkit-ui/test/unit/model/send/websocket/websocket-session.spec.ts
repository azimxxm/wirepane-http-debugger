import { observable, runInAction } from 'mobx';

import { expect } from '../../../../test-setup';

import { RequestInput, SendRequest } from '../../../../../src/model/send/send-request-model';
import { SendExtras } from '../../../../../src/model/send/send-extras';
import {
    MAX_LOG_ITEMS,
    WebSocketClientApi,
    WebSocketLogEntry,
    WebSocketSession
} from '../../../../../src/model/send/websocket/websocket-session';
import { WebSocketSessions } from '../../../../../src/model/send/websocket/websocket-sessions';
import { connectTab, sendComposedMessage, WebSocketSendHooks } from '../../../../../src/model/send/websocket/websocket-actions';
import type { WebSocketStreamEvent } from '../../../../../src/services/websocket-client-api';

// A stand-in for the server: tests push events into the latest stream themselves
function fakeServer() {
    let controller: ReadableStreamDefaultController<WebSocketStreamEvent> | undefined;

    const calls = {
        opened: [] as Array<{ url: string, headers: unknown, protocols?: string[], options: unknown, signal: AbortSignal }>,
        sent: [] as Array<{ id: string, data: string, isBinary: boolean }>,
        closed: [] as Array<{ id: string, code?: number, reason?: string }>
    };

    let failSend: Error | undefined;

    const api: WebSocketClientApi = {
        async open(request, options, signal) {
            calls.opened.push({ ...request, options, signal });

            let streamController!: ReadableStreamDefaultController<WebSocketStreamEvent>;
            const stream = new ReadableStream<WebSocketStreamEvent>({
                start(newController) { streamController = newController; }
            });
            controller = streamController;

            // Like fetch: aborting fails the response stream
            signal.addEventListener('abort', () => {
                streamController.error(new DOMException('The operation was aborted.', 'AbortError'));
            });
            return stream;
        },
        async send(id, data, isBinary) {
            if (failSend) throw failSend;
            calls.sent.push({ id, data: data.toString(), isBinary });
        },
        async close(id, code, reason) {
            calls.closed.push({ id, code, reason });
        }
    };

    return {
        api,
        calls,
        emit: (event: WebSocketStreamEvent) => controller!.enqueue(event),
        end: () => controller!.close(),
        failSendsWith: (error: Error) => { failSend = error; }
    };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

async function waitFor(condition: () => boolean) {
    for (let i = 0; i < 100; i++) {
        if (condition()) return;
        await tick();
    }
    throw new Error('Timed out waiting for condition');
}

const openEvent = (id = 'socket-1'): WebSocketStreamEvent => ({
    type: 'ws-open',
    id,
    protocol: 'chat',
    extensions: '',
    statusCode: 101,
    statusMessage: 'Switching Protocols',
    headers: [['upgrade', 'websocket']],
    timestamp: 1000
});

const textEntries = (session: WebSocketSession) =>
    session.messages.map((entry: WebSocketLogEntry) => `${entry.direction}:${entry.text}`);

describe("WebSocket sessions", () => {

    it("connects, logs messages both ways and closes", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);

        const finished = session.connect({ url: 'wss://example.com/chat', headers: [] }, {});
        expect(session.state.status).to.equal('connecting');
        expect(session.isActive).to.equal(true);

        await waitFor(() => server.calls.opened.length === 1);
        server.emit(openEvent());
        await waitFor(() => session.isOpen);

        if (session.state.status !== 'open') throw new Error('Not open');
        expect(session.state.handshake.protocol).to.equal('chat');

        await session.send(Buffer.from('hello'), false);
        expect(server.calls.sent).to.deep.equal([{ id: 'socket-1', data: 'hello', isBinary: false }]);

        server.emit({ type: 'ws-message', data: Buffer.from('hello back'), isBinary: false, timestamp: 1100 });
        await waitFor(() => session.receivedCount === 1);

        expect(textEntries(session)).to.deep.equal(['sent:hello', 'received:hello back']);
        expect(session.sentCount).to.equal(1);
        expect(session.messages[0].sendState).to.equal('sent');

        await session.disconnect(1000, 'bye');
        expect(session.state.status).to.equal('closing');
        expect(server.calls.closed).to.deep.equal([{ id: 'socket-1', code: 1000, reason: 'bye' }]);

        server.emit({ type: 'ws-close', code: 1000, reason: 'bye', timestamp: 1200 });
        server.end();
        await finished;

        expect(session.state).to.include({ status: 'closed', code: 1000, reason: 'bye' });
        expect(session.isActive).to.equal(false);
        // Notes in the log mark the connection opening and closing
        expect(session.log.map((item) => item.direction)).to.deep.equal(['note', 'sent', 'received', 'note']);
    });

    it("shows a refused handshake's response", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);

        const finished = session.connect({ url: 'wss://example.com/private', headers: [] }, {});
        await waitFor(() => server.calls.opened.length === 1);

        server.emit({
            type: 'error',
            error: { code: 'unexpected-response', message: 'The server answered the handshake with 401 Unauthorized' },
            response: {
                statusCode: 401,
                statusMessage: 'Unauthorized',
                headers: [['www-authenticate', 'Bearer']],
                body: Buffer.from('Token required')
            },
            timestamp: 1000
        });
        server.end();
        await finished;

        if (session.state.status !== 'failed') throw new Error(`Unexpected ${session.state.status}`);
        expect(session.state.response!.statusCode).to.equal(401);
        expect(session.state.response!.body.toString()).to.equal('Token required');
    });

    it("fails with the server's error when the connection can't be opened", async () => {
        const session = new WebSocketSession({
            ...fakeServer().api,
            open: async () => { throw new Error('Invalid WebSocket URL: wss://'); }
        });

        await session.connect({ url: 'wss://', headers: [] }, {});

        expect(session.state).to.deep.include({
            status: 'failed',
            error: { message: 'Invalid WebSocket URL: wss://', code: undefined }
        });
    });

    it("can be cancelled while connecting", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);

        const finished = session.connect({ url: 'wss://slow.example.com', headers: [] }, {});
        await waitFor(() => server.calls.opened.length === 1);

        session.cancel();
        await finished;

        expect(server.calls.opened[0].signal.aborted).to.equal(true);
        expect(session.state).to.include({ status: 'closed', cancelled: true });
    });

    it("reports a lost connection when the event stream just ends", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);

        const finished = session.connect({ url: 'wss://example.com', headers: [] }, {});
        await waitFor(() => server.calls.opened.length === 1);
        server.emit(openEvent());
        server.end();
        await finished;

        if (session.state.status !== 'closed') throw new Error(`Unexpected ${session.state.status}`);
        expect(session.state.error!.message).to.include('was lost');
    });

    it("marks messages the server didn't take", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);

        session.connect({ url: 'wss://example.com', headers: [] }, {});
        await waitFor(() => server.calls.opened.length === 1);
        server.emit(openEvent());
        await waitFor(() => session.isOpen);

        server.failSendsWith(new Error('This WebSocket isn\'t open'));
        await session.send(Buffer.from('lost'), false);

        expect(session.messages[0].sendState).to.equal('failed');
        expect(session.messages[0].sendError).to.equal('This WebSocket isn\'t open');
    });

    it("filters, clears and caps its log", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);

        session.connect({ url: 'wss://example.com', headers: [] }, {});
        await waitFor(() => server.calls.opened.length === 1);
        server.emit(openEvent());
        for (let i = 0; i < MAX_LOG_ITEMS + 9; i++) {
            server.emit({ type: 'ws-message', data: Buffer.from(`message ${i}`), isBinary: false, timestamp: 2000 + i });
        }
        await waitFor(() => session.receivedCount === MAX_LOG_ITEMS + 9);

        expect(session.log.length).to.equal(MAX_LOG_ITEMS);
        expect(session.droppedCount).to.equal(10); // The open note, and the first 9 messages

        session.setFilter('MESSAGE 4999');
        expect(session.visibleLog.map((item) => (item as WebSocketLogEntry).text)).to.deep.equal(['message 4999']);

        session.clear();
        expect(session.log.length).to.equal(0);
        expect(session.receivedCount).to.equal(0);
    });

});

describe("The WebSocket sessions of Send tabs", () => {

    const tab = (id: string, requestType: 'http' | 'websocket'): SendRequest => observable({
        id,
        request: new RequestInput({
            method: 'GET',
            url: requestType === 'websocket' ? 'wss://example.com' : 'https://example.com',
            headers: [],
            requestContentType: 'text',
            rawBody: Buffer.from([]),
            extras: new SendExtras({ requestType })
        }),
        sentExchange: undefined
    });

    it("closes a tab's socket when it's closed or switched to HTTP", async () => {
        const server = fakeServer();
        const first = tab('first', 'websocket');
        const second = tab('second', 'websocket');
        const sendTabs = observable({ sendRequests: [first, second] });
        const sessions = new WebSocketSessions(sendTabs, server.api);

        const firstConnection = sessions.sessionFor(first).connect({ url: 'wss://example.com', headers: [] }, {});
        sessions.sessionFor(second).connect({ url: 'wss://example.com', headers: [] }, {});
        await waitFor(() => server.calls.opened.length === 2);

        runInAction(() => { first.request.extras.requestType = 'http'; });
        expect(sessions.has('first')).to.equal(false);
        expect(server.calls.opened[0].signal.aborted).to.equal(true);
        await firstConnection;

        runInAction(() => { sendTabs.sendRequests.splice(1, 1); });
        expect(sessions.has('second')).to.equal(false);
        expect(server.calls.opened[1].signal.aborted).to.equal(true);
    });

});

describe("Connecting and sending from a WebSocket tab", () => {

    const hooks = (overrides: Partial<WebSocketSendHooks> = {}): WebSocketSendHooks => ({
        prepareRequestInput: async (sendRequest) => sendRequest.request,
        getRequestOptions: () => ({ ignoreHostHttpsErrors: ['example.com'] }),
        resolveTemplates: (_sendRequest, text) => text.replace('{{name}}', 'Wirepane'),
        ...overrides
    });

    const wsTab = (url: string, headers: Array<[string, string]> = []): SendRequest => ({
        id: 'tab',
        request: new RequestInput({
            method: 'GET',
            url,
            headers,
            requestContentType: 'text',
            rawBody: Buffer.from([]),
            extras: { requestType: 'websocket' }
        }),
        sentExchange: undefined
    });

    it("connects with the tab's headers, subprotocols and Send's options", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);
        const sendRequest = wsTab('wss://example.com/chat', [['Sec-WebSocket-Protocol', 'chat, superchat'], ['X-Token', 'abc']]);

        await connectTab(hooks(), sendRequest, session);
        await waitFor(() => server.calls.opened.length === 1);

        expect(server.calls.opened[0]).to.deep.include({
            url: 'wss://example.com/chat',
            protocols: ['chat', 'superchat'],
            options: { ignoreHostHttpsErrors: ['example.com'] }
        });
        expect(server.calls.opened[0].headers).to.deep.include(['X-Token', 'abc']);
    });

    it("explains URLs it can't connect to, under the URL", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);

        await connectTab(hooks(), wsTab('{{baseUrl}}/socket'), session);
        expect(session.connectProblem?.message).to.include('isn\'t a full URL');
        expect(server.calls.opened.length).to.equal(0);

        await connectTab(hooks(), wsTab('ftp://example.com'), session);
        expect(session.connectProblem?.message).to.include('start with ws:// or wss://');

        // Nothing is tried when the collections hook says the request can't be sent
        await connectTab(hooks({ prepareRequestInput: async () => undefined }), wsTab('wss://example.com'), session);
        expect(server.calls.opened.length).to.equal(0);
    });

    it("fills in variables and checks binary messages before sending", async () => {
        const server = fakeServer();
        const session = new WebSocketSession(server.api);
        const sendRequest = wsTab('wss://example.com');

        await connectTab(hooks(), sendRequest, session);
        await waitFor(() => server.calls.opened.length === 1);
        server.emit(openEvent());
        await waitFor(() => session.isOpen);

        await sendComposedMessage(hooks(), sendRequest, session, 'Hello {{name}}', 'text');
        await sendComposedMessage(hooks(), sendRequest, session, 'AAEC/w==', 'binary');
        await sendComposedMessage(hooks(), sendRequest, session, 'not base64!', 'binary');

        expect(server.calls.sent.map(({ data, isBinary }) => [data, isBinary])).to.deep.equal([
            ['Hello Wirepane', false],
            [Buffer.from([0, 1, 2, 255]).toString(), true]
        ]);
        expect(session.sendProblem).to.deep.equal({
            content: 'not base64!',
            message: 'Binary messages are written as base64, and this isn\'t valid base64.'
        });
    });

});
