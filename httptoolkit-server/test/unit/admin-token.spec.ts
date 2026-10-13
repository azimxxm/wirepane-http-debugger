import * as http from 'http';
import type { AddressInfo } from 'net';
import { expect } from 'chai';
import WebSocket from 'ws';
import { PluggableAdmin } from 'mockttp';
import { MockttpAdminPlugin } from 'mockttp/dist/pluggable-admin-api/mockttp-pluggable-admin';

import { requireAdminToken } from '../../src/index';
import { MOCKTTP_ALLOWED_ORIGINS } from '../../src/constants';

// The Mockttp admin API with the same CORS setup as runHTK() in src/index.ts, plus our token check
const ORIGIN = 'http://localhost:45458';
const WEBEXTENSION_ORIGIN = 'chrome-extension://oeehdgfohghfelggpifolochpnkdmpog';
const TOKEN = 'admin-token-test-token';

async function startAdminServer(authToken: string | undefined) {
    const admin = new PluggableAdmin.AdminServer<{ http: MockttpAdminPlugin }>({
        adminPlugins: { http: MockttpAdminPlugin },
        corsOptions: {
            strict: true,
            origin: MOCKTTP_ALLOWED_ORIGINS,
            maxAge: 86400,
            allowPrivateNetworkAccess: true
        }
    });
    await admin.start({ port: 0, host: '127.0.0.1' });
    const server: http.Server = (admin as any)['server'];
    requireAdminToken(server, authToken);

    const { port } = server.address() as AddressInfo;
    return { admin, url: `http://127.0.0.1:${port}`, wsUrl: `ws://127.0.0.1:${port}` };
}

function startSession(adminUrl: string, headers: Record<string, string> = {}) {
    return fetch(`${adminUrl}/start`, {
        method: 'POST',
        headers: { origin: ORIGIN, 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ plugins: { http: { options: {} } } })
    });
}

// Resolves 'open' when the upgrade worked, or the HTTP status/error when it was refused
function tryWebSocket(url: string, headers: Record<string, string> = {}) {
    return new Promise<string>((resolve) => {
        const ws = new WebSocket(url, { headers: { origin: ORIGIN, ...headers } });
        ws.on('open', () => { ws.close(); resolve('open'); });
        ws.on('unexpected-response', (_req, res) => { resolve(`status ${res.statusCode}`); ws.terminate(); });
        ws.on('error', (e) => resolve(`error ${e.message}`));
    });
}

describe("The Mockttp admin API token check", function () {
    this.timeout(10000);

    describe("with a token configured", () => {
        let server: Awaited<ReturnType<typeof startAdminServer>>;
        let sessionId: string;

        beforeEach(async () => {
            server = await startAdminServer(TOKEN);
            const response = await startSession(server.url, { authorization: `Bearer ${TOKEN}` });
            expect(response.status).to.equal(200);
            sessionId = (await response.json()).id;
        });

        afterEach(() => server.admin.stop());

        it("rejects starting a session without the token", async () => {
            const response = await startSession(server.url);
            expect(response.status).to.equal(403);
            expect(await response.json()).to.deep.equal({ error: { message: 'Valid token required' } });
        });

        it("rejects a wrong token, in the header or the path", async () => {
            expect((await startSession(server.url, { authorization: 'Bearer nope' })).status).to.equal(403);
            expect((await startSession(`${server.url}/token/nope`)).status).to.equal(403);
        });

        it("rejects a reset without the token, and keeps the session running", async () => {
            const reset = await fetch(`${server.url}/reset`, { method: 'POST', headers: { origin: ORIGIN } });
            expect(reset.status).to.equal(403);

            const query = await fetch(`${server.url}/session/${sessionId}`, {
                method: 'POST',
                headers: { origin: ORIGIN, 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
                body: JSON.stringify({ query: '{ ruleParameterKeys }' })
            });
            expect(query.status).to.equal(200);
        });

        it("accepts the token as a path prefix, and removes it before Mockttp routes the request", async () => {
            const response = await startSession(`${server.url}/token/${TOKEN}`);
            expect(response.status).to.equal(200);
            expect((await response.json()).id).to.be.a('string');
        });

        it("rejects session requests and stops without the token", async () => {
            const stop = await fetch(`${server.url}/session/${sessionId}/stop`, {
                method: 'POST', headers: { origin: ORIGIN }
            });
            expect(stop.status).to.equal(403);

            const query = await fetch(`${server.url}/session/${sessionId}`, {
                method: 'POST',
                headers: { origin: ORIGIN, 'content-type': 'application/json' },
                body: JSON.stringify({ query: '{ ruleParameterKeys }' })
            });
            expect(query.status).to.equal(403);
        });

        it("lets the web extension query its own session, but nothing else", async () => {
            const query = await fetch(`${server.url}/session/${sessionId}`, {
                method: 'POST',
                headers: { origin: WEBEXTENSION_ORIGIN, 'content-type': 'application/json' },
                body: JSON.stringify({ query: '{ ruleParameterKeys }' })
            });
            expect(query.status).to.equal(200);

            const stop = await fetch(`${server.url}/session/${sessionId}/stop`, {
                method: 'POST', headers: { origin: WEBEXTENSION_ORIGIN }
            });
            expect(stop.status).to.equal(403);

            const start = await fetch(`${server.url}/start`, {
                method: 'POST',
                headers: { origin: WEBEXTENSION_ORIGIN, 'content-type': 'application/json' },
                body: JSON.stringify({ plugins: { http: { options: {} } } })
            });
            expect(start.status).to.equal(403);
        });

        it("answers CORS preflights, and allows the Authorization header", async () => {
            const response = await fetch(`${server.url}/start`, {
                method: 'OPTIONS',
                headers: {
                    origin: ORIGIN,
                    'access-control-request-method': 'POST',
                    'access-control-request-headers': 'authorization,content-type'
                }
            });
            expect(response.status).to.equal(204);
            expect(response.headers.get('access-control-allow-origin')).to.equal(ORIGIN);
            expect(response.headers.get('access-control-allow-headers')).to.include('authorization');
        });

        it("rejects WebSockets without the token", async () => {
            expect(await tryWebSocket(`${server.wsUrl}/session/${sessionId}/stream`)).to.equal('status 403');
            expect(await tryWebSocket(`${server.wsUrl}/session/${sessionId}/subscription`)).to.equal('status 403');
            expect(await tryWebSocket(`${server.wsUrl}/token/nope/session/${sessionId}/stream`)).to.equal('status 403');
        });

        it("accepts WebSockets with the token in the path or the header", async () => {
            expect(await tryWebSocket(`${server.wsUrl}/token/${TOKEN}/session/${sessionId}/stream`)).to.equal('open');
            expect(await tryWebSocket(`${server.wsUrl}/session/${sessionId}/stream`, {
                authorization: `Bearer ${TOKEN}`
            })).to.equal('open');
        });

        it("works with Mockttp's own admin client, given the token only in its URL like the UI", async () => {
            const client = new PluggableAdmin.AdminClient<{ http: MockttpAdminPlugin }>({
                adminServerUrl: `${server.url}/token/${TOKEN}`,
                // Node needs the Origin set explicitly, browsers send it themselves
                requestOptions: { headers: { origin: ORIGIN } }
            });
            // start() also opens the stream WebSocket, and fails if that's refused
            const metadata = await client.start({ http: { options: {} } } as any);
            expect((metadata as any).http.port).to.be.a('number');
            await client.stop();
        });
    });

    describe("with no token configured (dev runs)", () => {
        let server: Awaited<ReturnType<typeof startAdminServer>>;
        beforeEach(async () => { server = await startAdminServer(undefined); });
        afterEach(() => server.admin.stop());

        it("stays open, with or without a token", async () => {
            expect((await startSession(server.url)).status).to.equal(200);
            expect((await startSession(server.url, { authorization: 'Bearer anything' })).status).to.equal(200);
            expect((await startSession(`${server.url}/token/anything`)).status).to.equal(200);
        });

        it("still requires an allowed Origin, as before", async () => {
            const response = await fetch(`${server.url}/start`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ plugins: { http: { options: {} } } })
            });
            expect(response.status).to.equal(403);
        });

        it("accepts WebSockets without a token", async () => {
            const response = await startSession(server.url);
            const { id } = await response.json();
            expect(await tryWebSocket(`${server.wsUrl}/session/${id}/stream`)).to.equal('open');
            expect(await tryWebSocket(`${server.wsUrl}/token/anything/session/${id}/stream`)).to.equal('open');
        });
    });
});
