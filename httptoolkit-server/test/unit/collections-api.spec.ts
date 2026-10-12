import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type * as http from 'http';
import type { AddressInfo } from 'net';
import type { Application } from 'express';
import { expect } from 'chai';

import { HttpToolkitServerApi } from '../../src/api/api-server';
import { HttpClient } from '../../src/client/http-client';
import { readCollectionFixture, unzipToText } from './collections-fixtures';

const ORIGIN = 'http://localhost:45458';
const AUTH_TOKEN = 'collections-test-token';

describe("Collections REST API", function () {
    this.timeout(10000);

    let configPath: string;
    let server: http.Server;
    let baseUrl: string;

    const call = async (method: string, urlPath: string, body?: unknown, headers: Record<string, string> = {}) => {
        const response = await fetch(`${baseUrl}${urlPath}`, {
            method,
            headers: {
                origin: ORIGIN,
                authorization: `Bearer ${AUTH_TOKEN}`,
                ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
                ...headers
            },
            body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
    };

    before(async () => {
        configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wirepane-collections-api-test-'));
        const certPath = path.join(configPath, 'ca.pem');
        fs.writeFileSync(certPath, 'unused'); // Read (but not parsed) when interceptors are created

        // The real API server's middleware (CORS/Origin checks, auth token, routes), on a
        // random local port. start() isn't called: it would also open the UI bridge socket.
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

        server = app.listen(0, '127.0.0.1');
        await new Promise((resolve) => server.once('listening', resolve));
        baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
        server.close();
        fs.rmSync(configPath, { recursive: true, force: true });
    });

    it("rejects requests without an allowed Origin or the auth token", async () => {
        const noOrigin = await fetch(`${baseUrl}/collections`, { headers: { authorization: `Bearer ${AUTH_TOKEN}` } });
        expect(noOrigin.status).to.equal(403);

        const otherOrigin = await call('GET', '/collections', undefined, { origin: 'https://example.com' });
        expect(otherOrigin.status).to.equal(403);

        const noToken = await fetch(`${baseUrl}/collections`, { headers: { origin: ORIGIN } });
        expect(noToken.status).to.equal(403);

        const wrongToken = await call('PUT', '/collections/abc', { collection: {} }, { authorization: 'Bearer nope' });
        expect(wrongToken.status).to.equal(403);
    });

    it("imports, reads, saves, exports and deletes a collection", async () => {
        const imported = await call('POST', '/collections/import', {
            fileName: 'Pet Store API.postman_collection.json',
            content: readCollectionFixture('postman-v21.json')
        });
        expect(imported.status).to.equal(200);
        expect(imported.body.format).to.equal('postman');
        expect(imported.body.warnings).to.deep.equal([]);

        const id: string = imported.body.collection.uid;
        expect((await call('GET', '/collections')).body.collections.map((c: { id: string }) => c.id)).to.deep.equal([id]);

        const { status, body: loaded } = await call('GET', `/collections/${id}`);
        expect(status).to.equal(200);
        expect(loaded.collection).to.deep.equal(imported.body.collection);

        const edited = { ...loaded.collection, name: 'Pet Store API v2' };
        const saved = await call('PUT', `/collections/${id}`, { collection: edited });
        expect(saved.status).to.equal(200);
        expect(saved.body.collection.name).to.equal('Pet Store API v2');

        const postman = await call('POST', `/collections/${id}/export`, { format: 'postman' });
        expect(postman.status).to.equal(200);
        expect(postman.body).to.deep.include({
            fileName: 'Pet Store API v2.postman_collection.json',
            mimeType: 'application/json',
            encoding: 'utf8',
            redactionReport: []
        });
        expect(JSON.parse(postman.body.content).info.name).to.equal('Pet Store API v2');

        const bruno = await call('POST', `/collections/${id}/export`, { format: 'bruno' });
        expect(bruno.body).to.deep.include({ fileName: 'Pet Store API v2.zip', encoding: 'base64' });
        expect(unzipToText(bruno.body.content).get('bruno.json')).to.include('"name": "Pet Store API v2"');

        expect((await call('DELETE', `/collections/${id}`)).body).to.deep.equal({ success: true });
        expect((await call('GET', `/collections/${id}`)).status).to.equal(404);
    });

    it("accepts imports far bigger than the default 100kb JSON limit", async () => {
        const har = JSON.parse(readCollectionFixture('traffic.har'));
        har.log.entries[0].response.content.text = JSON.stringify({ data: 'x'.repeat(500 * 1024) });

        const imported = await call('POST', '/collections/import', { fileName: 'big.har', content: JSON.stringify(har) });
        expect(imported.status).to.equal(200);
        expect(imported.body.format).to.equal('har');
    });

    it("adds an imported environment file to an existing collection", async () => {
        const imported = await call('POST', '/collections/import', {
            fileName: 'pets.json',
            content: readCollectionFixture('postman-v21.json')
        });
        const id: string = imported.body.collection.uid;

        const environment = await call('POST', '/collections/import', {
            fileName: 'Local.postman_environment.json',
            content: JSON.stringify({ name: 'Local', values: [{ key: 'baseUrl', value: 'http://localhost:3000' }] }),
            collectionId: id
        });
        expect(environment.status).to.equal(200);
        expect(environment.body.collection.uid).to.equal(id);
        expect(environment.body.collection.environments.map((e: { name: string }) => e.name)).to.deep.equal(['Local']);
    });

    it("stores and serves the files that requests send", async () => {
        const imported = await call('POST', '/collections/import', {
            fileName: 'pets.json',
            content: readCollectionFixture('postman-v21.json')
        });
        const id: string = imported.body.collection.uid;
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

        const upload = (name: string, bytes: Buffer) => fetch(`${baseUrl}/collections/${id}/files?name=${encodeURIComponent(name)}`, {
            method: 'POST',
            headers: { origin: ORIGIN, authorization: `Bearer ${AUTH_TOKEN}`, 'content-type': 'application/octet-stream' },
            body: bytes
        });
        const download = (filePath: string) => fetch(`${baseUrl}/collections/${id}/files?path=${encodeURIComponent(filePath)}`, {
            headers: { origin: ORIGIN, authorization: `Bearer ${AUTH_TOKEN}` }
        });

        const uploaded = await upload('cat photo.png', png);
        expect(uploaded.status).to.equal(200);
        expect(await uploaded.json()).to.deep.equal({ path: 'files/cat photo.png', name: 'cat photo.png', size: png.byteLength });

        const downloaded = await download('files/cat photo.png');
        expect(downloaded.status).to.equal(200);
        expect(downloaded.headers.get('content-type')).to.equal('image/png');
        expect(Buffer.from(await downloaded.arrayBuffer()).equals(png)).to.equal(true);

        expect((await download('files/other.png')).status).to.equal(404);
        const outside = await download('../../ca.pem');
        expect(outside.status).to.equal(400);
        expect((await outside.json()).error.message).to.equal("../../ca.pem isn't a file inside the collection folder");

        const noName = await fetch(`${baseUrl}/collections/${id}/files`, {
            method: 'POST',
            headers: { origin: ORIGIN, authorization: `Bearer ${AUTH_TOKEN}` },
            body: png
        });
        expect(noName.status).to.equal(400);

        // The files are kept when the collection is saved
        const { body: loaded } = await call('GET', `/collections/${id}`);
        expect((await call('PUT', `/collections/${id}`, { collection: loaded.collection })).status).to.equal(200);
        expect((await download('files/cat photo.png')).status).to.equal(200);
    });

    it("answers bad requests with JSON errors", async () => {
        const invalidJson = await call('POST', '/collections/import', '{not json');
        expect(invalidJson.status).to.equal(400);
        expect(invalidJson.body.error.message).to.equal('The request body is not valid JSON');

        const unknownFormat = await call('POST', '/collections/import', { fileName: 'a.txt', content: 'hello' });
        expect(unknownFormat.status).to.equal(400);
        expect(unknownFormat.body.error.message).to.include("Couldn't recognise the format of a.txt");

        const missingContent = await call('POST', '/collections/import', { fileName: 'a.json' });
        expect(missingContent.status).to.equal(400);

        expect((await call('GET', '/collections/not-a-valid-id')).status).to.equal(400);
        expect((await call('PUT', '/collections/AAAAAAAAAAAAAAAAAAAAA', { name: 'No wrapper' })).status).to.equal(400);
        expect((await call('POST', '/collections/AAAAAAAAAAAAAAAAAAAAA/export', { format: 'har' })).status).to.equal(400);
        expect((await call('POST', '/collections/AAAAAAAAAAAAAAAAAAAAA/export', { format: 'postman' })).status).to.equal(404);
    });
});
