import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { expect } from 'chai';

import { CollectionsService } from '../../src/collections/collections-service';
import { BrunoCollection, BrunoItem } from '../../src/collections/bruno-types';
import { exportCollection } from '../../src/collections/export';
import { importCollectionFile } from '../../src/collections/import';
import { newUid } from '../../src/collections/collection-model';
import { unzipToText } from './collections-fixtures';

// fflate's typings need TypeScript 5.7+, so it's loaded untyped like in the source
const { unzipSync }: { unzipSync(data: Uint8Array): Record<string, Uint8Array> } = require('fflate');
const unzipBytes = (base64: string) => new Map(
    Object.entries(unzipSync(Buffer.from(base64, 'base64'))).map(([name, data]) => [name, Buffer.from(data)])
);

const PNG_BYTES = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

const request = (name: string, type: string, request: BrunoItem['request']): BrunoItem => ({ type, name, request });

const httpRequest = (name: string, body: NonNullable<BrunoItem['request']>['body'], extra: Partial<NonNullable<BrunoItem['request']>> = {}) =>
    request(name, 'http-request', {
        method: 'POST',
        url: '{{baseUrl}}/upload',
        headers: [],
        params: [],
        auth: { mode: 'inherit' },
        body,
        script: {},
        vars: {},
        assertions: [],
        tests: '',
        docs: '',
        ...extra
    });

// A collection with a request of every body mode that Send has, and a WebSocket request
function everyModeCollection(): BrunoCollection {
    return {
        version: '1',
        uid: newUid(),
        name: 'Every mode',
        environments: [],
        root: { request: { headers: [], auth: { mode: 'none' }, vars: { req: [] } }, docs: '' },
        items: [
            httpRequest('Multipart', {
                mode: 'multipartForm',
                multipartForm: [
                    { type: 'text', name: 'title', value: 'Hello {{name}}', enabled: true },
                    { type: 'file', name: 'avatar', value: ['files/photo.png'], enabled: true, contentType: 'image/png' }
                ]
            }),
            httpRequest('Form', {
                mode: 'formUrlEncoded',
                formUrlEncoded: [
                    { name: 'user name', value: 'Ann & Bob', enabled: true },
                    { name: 'api_key', value: 'abc123secret', enabled: true }
                ]
            }),
            httpRequest('Binary', {
                mode: 'file',
                file: [{ filePath: 'files/photo.png', contentType: 'image/png', selected: true }]
            }, { method: 'PUT' }),
            request('GraphQL', 'graphql-request', {
                method: 'POST',
                url: 'https://countries.trevorblades.com/',
                headers: [],
                params: [],
                auth: { mode: 'none' },
                body: { mode: 'graphql', graphql: { query: 'query ($code: ID!) { country(code: $code) { name } }', variables: '{ "code": "{{code}}" }' } },
                script: {},
                vars: {},
                assertions: [],
                tests: '',
                docs: ''
            }),
            request('Echo', 'ws-request', {
                url: 'wss://echo.websocket.org',
                headers: [{ name: 'X-Client', value: 'wirepane', enabled: true }],
                auth: { mode: 'inherit' },
                body: {
                    mode: 'ws',
                    ws: [
                        { name: 'hello', type: 'text', content: 'hi {{name}}' },
                        { name: 'login', type: 'json', content: '{ "token": "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" }' }
                    ]
                },
                script: {},
                vars: {},
                assertions: [],
                tests: '',
                docs: ''
            })
        ]
    };
}

interface PostmanRequest {
    name: string;
    request: { method: string, body?: Record<string, any> };
}

describe("Collection files and modes", function () {
    this.timeout(10000);

    let configPath: string;
    let service: CollectionsService;

    beforeEach(() => {
        configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wirepane-collection-files-test-'));
        service = new CollectionsService(configPath);
    });

    afterEach(() => {
        fs.rmSync(configPath, { recursive: true, force: true });
    });

    const collectionDir = (id: string) => path.join(configPath, 'collections', id);

    describe("storage", () => {
        it("stores files under files/, reusing the path for the same file and numbering other files", async () => {
            const { uid } = everyModeCollection();
            await service.save(uid, { ...everyModeCollection(), uid });

            const first = await service.addFile(uid, 'photo.png', PNG_BYTES);
            expect(first).to.deep.equal({ path: 'files/photo.png', name: 'photo.png', size: PNG_BYTES.byteLength });

            expect((await service.addFile(uid, 'photo.png', PNG_BYTES)).path).to.equal('files/photo.png');
            expect((await service.addFile(uid, 'photo.png', Buffer.from('other'))).path).to.equal('files/photo (2).png');
            expect((await service.addFile(uid, '../../escape.png', PNG_BYTES)).path).to.equal('files/-..-escape.png');

            const read = await service.readFile(uid, 'files/photo.png');
            expect(read.name).to.equal('photo.png');
            expect(read.bytes.equals(PNG_BYTES)).to.equal(true);
        });

        it("keeps the files when the collection is saved again, and doesn't read them as requests", async () => {
            const collection = everyModeCollection();
            await service.save(collection.uid, collection);
            await service.addFile(collection.uid, 'photo.png', PNG_BYTES);
            await service.addFile(collection.uid, 'notes.bru', Buffer.from('not a request'));

            const { collection: loaded, warnings } = await service.get(collection.uid);
            await service.save(collection.uid, { ...loaded, name: 'Renamed' });

            expect(warnings).to.deep.equal([]);
            expect(fs.readFileSync(path.join(collectionDir(collection.uid), 'files', 'photo.png')).equals(PNG_BYTES)).to.equal(true);
            expect(loaded.items.map((item) => item.name)).to.deep.equal(['Multipart', 'Form', 'Binary', 'GraphQL', 'Echo']);

            const [summary] = await service.list();
            expect(summary.requestCount).to.equal(5);
        });

        it("doesn't let a folder take the files/ folder's name", async () => {
            const collection = everyModeCollection();
            collection.items.push({ type: 'folder', name: 'files', root: {}, items: [httpRequest('Inside', { mode: 'none' })] });
            await service.save(collection.uid, collection);
            await service.addFile(collection.uid, 'photo.png', PNG_BYTES);

            const { collection: loaded } = await service.get(collection.uid);
            const folder = loaded.items.find((item) => item.type === 'folder');
            expect(folder?.name).to.equal('files');
            expect(folder?.items?.map((item) => item.name)).to.deep.equal(['Inside']);
            expect(fs.existsSync(path.join(collectionDir(collection.uid), 'files (2)', 'Inside.bru'))).to.equal(true);
        });

        it("only reads files inside the collection folder", async () => {
            const collection = everyModeCollection();
            await service.save(collection.uid, collection);
            fs.writeFileSync(path.join(configPath, 'outside.txt'), 'secret');
            fs.mkdirSync(path.join(collectionDir(collection.uid), 'files'), { recursive: true });
            fs.symlinkSync(path.join(configPath, 'outside.txt'), path.join(collectionDir(collection.uid), 'files', 'link.txt'));

            const statusOf = (filePath: string) => service.readFile(collection.uid, filePath).then(() => 200, (e) => e.statusCode);
            expect(await statusOf('../outside.txt')).to.equal(400);
            expect(await statusOf('files/../../outside.txt')).to.equal(400);
            expect(await statusOf(path.join(configPath, 'outside.txt'))).to.equal(400);
            expect(await statusOf('C:\\outside.txt')).to.equal(400);
            expect(await statusOf('files/.hidden')).to.equal(400);
            expect(await statusOf('files/link.txt')).to.equal(404);
            expect(await statusOf('files/missing.png')).to.equal(404);

            const unknown = newUid();
            expect(await service.addFile(unknown, 'a.png', PNG_BYTES).then(() => 200, (e) => e.statusCode)).to.equal(404);
            expect(await service.readFile(unknown, 'files/a.png').then(() => 200, (e) => e.statusCode)).to.equal(404);
        });

        it("saves WebSocket requests, which Bruno reads back with a method they can't be saved with", async () => {
            const collection = everyModeCollection();
            await service.save(collection.uid, collection);

            const { collection: loaded } = await service.get(collection.uid);
            const echo = loaded.items.find((item) => item.name === 'Echo')!;
            expect(echo.type).to.equal('ws-request');
            expect(echo.request).to.not.have.property('method');
            expect(echo.request?.body?.ws?.map(({ name, type, content }) => [name, type, content])).to.deep.equal([
                ['hello', 'text', 'hi {{name}}'],
                ['login', 'json', '{ "token": "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB" }']
            ]);

            // Saving what was read must work, e.g. after renaming the collection
            const saved = await service.save(collection.uid, { ...loaded, name: 'Saved again' });
            expect(saved.collection.items.find((item) => item.name === 'Echo')?.request?.body?.ws).to.have.length(2);
        });
    });

    describe("import", () => {
        it("keeps the body modes of Postman requests: urlencoded, formdata, file and GraphQL", async () => {
            const postman = {
                info: { name: 'Modes', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
                item: [
                    { name: 'Form', request: { method: 'POST', url: 'https://example.com/form', body: {
                        mode: 'urlencoded', urlencoded: [{ key: 'a', value: '1' }, { key: 'b', value: '2', disabled: true }]
                    } } },
                    { name: 'Multipart', request: { method: 'POST', url: 'https://example.com/upload', body: {
                        mode: 'formdata', formdata: [{ key: 'title', value: 'Hi', type: 'text' }, { key: 'photo', src: 'photo.png', type: 'file' }]
                    } } },
                    { name: 'Binary', request: { method: 'PUT', url: 'https://example.com/raw', body: { mode: 'file', file: { src: 'photo.png' } } } },
                    { name: 'GraphQL', request: { method: 'POST', url: 'https://example.com/graphql', body: {
                        mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{}' }
                    } } }
                ]
            };

            const { collection } = await importCollectionFile({ fileName: 'modes.json', content: JSON.stringify(postman) });
            const byName = (name: string) => collection.items.find((item) => item.name === name)!;

            expect(byName('Form').request?.body?.mode).to.equal('formUrlEncoded');
            expect(byName('Form').request?.body?.formUrlEncoded?.map(({ name, value, enabled }) => [name, value, enabled])).to.deep.equal([
                ['a', '1', true],
                ['b', '2', false]
            ]);
            expect(byName('Multipart').request?.body?.mode).to.equal('multipartForm');
            expect(byName('Multipart').request?.body?.multipartForm?.map(({ type, name, value }) => [type, name, value])).to.deep.equal([
                ['text', 'title', 'Hi'],
                ['file', 'photo', ['photo.png']]
            ]);
            expect(byName('Binary').request?.body?.mode).to.equal('file');
            expect(byName('Binary').request?.body?.file?.map(({ filePath, selected }) => [filePath, selected])).to.deep.equal([['photo.png', true]]);
            expect(byName('GraphQL').type).to.equal('graphql-request');
            expect(byName('GraphQL').request?.body?.graphql).to.deep.equal({ query: '{ me { id } }', variables: '{}' });

            // ...and they can be saved as they are
            const saved = await service.save(collection.uid, collection);
            expect(saved.collection.items.map((item) => item.request?.body?.mode)).to.deep.equal(['formUrlEncoded', 'multipartForm', 'file', 'graphql']);
        });

        it("imports Bruno WebSocket requests from .bru files", async () => {
            const bru = [
                'meta {', '  name: Echo', '  type: ws', '  seq: 1', '}', '',
                'ws {', '  url: wss://echo.websocket.org', '  body: ws', '  auth: none', '}', '',
                'body:ws {', '  name: hello', '  type: json', '  selected: true', "  content: '''", '    {"hi": true}', "  '''", '}', ''
            ].join('\n');

            const imported = await service.importFile({ fileName: 'Echo.bru', content: bru });
            const [echo] = imported.collection.items;
            expect(imported.format).to.equal('bruno-request');
            expect(echo.type).to.equal('ws-request');
            expect(echo.request?.url).to.equal('wss://echo.websocket.org');
            expect(echo.request?.body?.ws).to.deep.equal([{ name: 'hello', type: 'json', content: '{"hi": true}', selected: true }]);
        });
    });

    describe("export", () => {
        it("exports every body mode to Postman, with file names only, leaving WebSocket requests out", () => {
            const result = exportCollection(everyModeCollection(), 'postman');
            const requests: PostmanRequest[] = JSON.parse(result.content).item;
            const bodyOf = (name: string) => requests.find((item) => item.name === name)?.request.body;

            expect(requests.map((item) => item.name)).to.deep.equal(['Multipart', 'Form', 'Binary', 'GraphQL']);
            expect(bodyOf('Multipart')).to.deep.equal({
                mode: 'formdata',
                formdata: [
                    { key: 'title', disabled: false, type: 'text', description: '', value: 'Hello {{name}}' },
                    { key: 'avatar', disabled: false, type: 'file', description: '', src: 'photo.png', contentType: 'image/png' }
                ]
            });
            expect(bodyOf('Form')).to.deep.equal({
                mode: 'urlencoded',
                urlencoded: [
                    { key: 'user name', value: 'Ann & Bob', disabled: false, type: 'default', description: '' },
                    { key: 'api_key', value: '{{apiKey}}', disabled: false, type: 'default', description: '' }
                ]
            });
            expect(bodyOf('Binary')).to.deep.equal({ mode: 'file', file: { src: 'photo.png' } });
            expect(bodyOf('GraphQL')).to.deep.equal({
                mode: 'graphql',
                graphql: { query: 'query ($code: ID!) { country(code: $code) { name } }', variables: '{ "code": "{{code}}" }' }
            });

            expect(result.warnings).to.deep.equal([
                '2 files aren\'t included: Postman JSON doesn\'t carry files, only their names. Use the Bruno format to include them.',
                '1 WebSocket request was left out: Postman Collection v2.1 has no WebSocket requests. Use the Bruno format to keep them.'
            ]);
            expect(result.redactionReport.map(({ location, name }) => [location, name])).to.deep.equal([
                ['Form › body', 'api_key'],
                ['Echo › body › message "login"', 'token']
            ]);
        });

        it("has no warnings for collections that Postman can hold", () => {
            const collection = everyModeCollection();
            collection.items = collection.items.filter((item) => item.name === 'Form' || item.name === 'GraphQL');
            expect(exportCollection(collection, 'postman').warnings).to.deep.equal([]);
        });

        it("exports Bruno zips with the files the requests send, and imports them back", async () => {
            const collection = everyModeCollection();
            await service.save(collection.uid, collection);
            expect((await service.addFile(collection.uid, 'photo.png', PNG_BYTES)).path).to.equal('files/photo.png');
            await service.addFile(collection.uid, 'unused.txt', Buffer.from('not referenced'));

            const exported = await service.exportCollection(collection.uid, 'bruno');
            expect(exported.warnings).to.deep.equal([]);

            const entries = unzipBytes(exported.content);
            expect([...entries.keys()].sort()).to.deep.equal([
                'Binary.bru', 'Echo.bru', 'Form.bru', 'GraphQL.bru', 'Multipart.bru', 'bruno.json', 'collection.bru', 'files/photo.png'
            ]);
            expect(entries.get('files/photo.png')!.equals(PNG_BYTES)).to.equal(true);
            expect(entries.get('Multipart.bru')!.toString()).to.include('avatar: @file(files/photo.png) @contentType(image/png)');
            expect(entries.get('Binary.bru')!.toString()).to.include('file: @file(files/photo.png) @contentType(image/png)');
            // The secret in the WebSocket message was replaced
            expect(unzipToText(exported.content).get('Echo.bru')).to.include('{ "token": "{{token}}" }');

            const imported = await service.importFile({ fileName: 'Every mode.zip', content: exported.content, encoding: 'base64' });
            expect(imported.warnings).to.deep.equal([]);
            const importedId = imported.collection.uid;
            const multipart = imported.collection.items.find((item) => item.name === 'Multipart')!;
            expect(multipart.request?.body?.multipartForm?.[1].value).to.deep.equal(['files/photo.png']);
            expect((await service.readFile(importedId, 'files/photo.png')).bytes.equals(PNG_BYTES)).to.equal(true);
            expect(fs.existsSync(path.join(collectionDir(importedId), 'files', 'unused.txt'))).to.equal(false);
        });

        it("says which files a Bruno zip couldn't include", async () => {
            const collection = everyModeCollection();
            const binary = collection.items.find((item) => item.name === 'Binary')!;
            binary.request!.body!.file = [{ filePath: '/Users/someone/elsewhere.png', contentType: 'image/png', selected: true }];
            await service.save(collection.uid, collection);

            const exported = await service.exportCollection(collection.uid, 'bruno');
            expect(exported.warnings).to.deep.equal([
                '2 files aren\'t in the collection folder, so the zip doesn\'t include them: files/photo.png and /Users/someone/elsewhere.png'
            ]);
        });

        it("moves files from anywhere in an imported Bruno folder into files/", async () => {
            const collection = everyModeCollection();
            const binary = collection.items.find((item) => item.name === 'Binary')!;
            binary.request!.body!.file = [{ filePath: 'assets/photo.png', contentType: 'image/png', selected: true }];

            // A zip made by Bruno: the collection in a folder, its files next to the requests
            const exported = exportCollection(collection, 'bruno', { attachments: new Map([
                ['assets/photo.png', PNG_BYTES],
                ['files/photo.png', Buffer.from('a different photo')]
            ]) });
            const { format, attachments } = await importCollectionFile({ fileName: 'mine.zip', content: exported.content, encoding: 'base64' });
            expect(format).to.equal('bruno-zip');
            expect([...attachments!.keys()].sort()).to.deep.equal(['assets/photo.png', 'files/photo.png']);

            const imported = await service.importFile({ fileName: 'mine.zip', content: exported.content, encoding: 'base64' });
            const bodyOf = (name: string) => imported.collection.items.find((item) => item.name === name)?.request?.body;
            // Files in files/ keep their paths, others move there
            expect(bodyOf('Multipart')?.multipartForm?.[1].value).to.deep.equal(['files/photo.png']);
            expect(bodyOf('Binary')?.file?.[0].filePath).to.equal('files/photo (2).png');
            expect((await service.readFile(imported.collection.uid, 'files/photo.png')).bytes.toString()).to.equal('a different photo');
            expect((await service.readFile(imported.collection.uid, 'files/photo (2).png')).bytes.equals(PNG_BYTES)).to.equal(true);
        });
    });
});
