import { expect } from '../../../test-setup';

import { BrunoItem, BrunoRequest, BrunoWsRequest } from '../../../../src/model/collections/collection-types';
import {
    defaultRequestName,
    itemToRequestParts,
    RequestParts,
    requestPartsToItem
} from '../../../../src/model/collections/request-mapping';
import { FilePathOf, ItemFiles, missingFileRef } from '../../../../src/model/collections/extras-mapping';
import { FileRef, SendExtras, SendExtrasData } from '../../../../src/model/send/send-extras';

const UID = 'AAAAAAAAAAAAAAAAAAAA1';

function httpItem(request: Partial<BrunoRequest>, extra: Partial<BrunoItem> = {}): BrunoItem {
    return {
        uid: UID,
        type: 'http-request',
        name: 'Get user',
        seq: 1,
        request: {
            method: 'GET',
            url: 'https://api.example.com/users',
            headers: [],
            params: [],
            body: { mode: 'none' },
            auth: { mode: 'inherit' },
            script: {},
            vars: {},
            assertions: [],
            tests: '',
            docs: '',
            ...request
        },
        ...extra
    };
}

// ws-request items store no method or params, so their request is cast like newItem() does
const wsRequest = (request: BrunoWsRequest) => request as BrunoRequest;

const parts = (overrides: Partial<RequestParts>): RequestParts => ({
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: [],
    body: Buffer.alloc(0),
    contentType: 'text',
    ...overrides
});

const roundTrip = (item: BrunoItem, files: ItemFiles = new Map(), filePathOf?: FilePathOf) => {
    const { parts: opened } = itemToRequestParts(item, files);
    return requestPartsToItem(opened, item.request?.docs ?? '', item, { name: item.name }, filePathOf).item;
};

const fileRef = (fileId: string, name: string, contentType = ''): FileRef => ({ fileId, name, size: 4, contentType });
const PHOTO = fileRef('photo-sha', 'photo.png', 'image/png');
const NOTES = fileRef('notes-sha', 'notes.txt', 'text/plain');

// The files of a collection, as opening an item loads them: path -> file
const filesOf = (entries: Array<[string, FileRef]>): ItemFiles => new Map(entries);
// Where tab files are stored, as saving finds them: file -> path
const storedAt = (entries: Array<[FileRef, string]>): FilePathOf =>
    (file) => entries.find(([candidate]) => candidate.fileId === file.fileId && candidate.name === file.name)?.[1];

const extras = (data: Partial<SendExtrasData>): SendExtrasData => new SendExtras(data).toData();

const headerValue = (parts: RequestParts, name: string) =>
    parts.headers.find(([headerName]) => headerName.toLowerCase() === name)?.[1];

describe("Collection request mapping", () => {

    describe("from an item to a Send request", () => {

        it("maps the method, URL and enabled headers, adding Host like Send does", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                method: 'delete',
                headers: [
                    { uid: 'h1', name: 'Accept', value: 'application/json', enabled: true },
                    { uid: 'h2', name: 'X-Debug', value: 'yes', enabled: false }
                ]
            }));

            expect(opened.method).to.equal('DELETE');
            expect(opened.url).to.equal('https://api.example.com/users');
            expect(opened.headers).to.deep.equal([
                ['host', 'api.example.com'],
                ['Accept', 'application/json']
            ]);
            expect(opened.body.length).to.equal(0);
        });

        it("keeps the query string and {{variables}} as written", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                url: '{{baseUrl}}/pets?limit=10&q={{search}}',
                params: [
                    { uid: 'p1', name: 'limit', value: '10', enabled: true, type: 'query' },
                    { uid: 'p2', name: 'q', value: '{{search}}', enabled: true, type: 'query' }
                ]
            }));

            expect(opened.url).to.equal('{{baseUrl}}/pets?limit=10&q={{search}}');
            // The origin is a variable, so the Host header waits until sending
            expect(opened.headers).to.deep.equal([]);
        });

        it("fills in path params that have a value, and leaves the others for the user", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                url: 'https://api.example.com:8443/users/:userId/posts/:postId',
                params: [
                    { name: 'userId', value: '{{userId}}', enabled: true, type: 'path' },
                    { name: 'postId', value: '', enabled: true, type: 'path' }
                ]
            }));

            expect(opened.url).to.equal('https://api.example.com:8443/users/{{userId}}/posts/:postId');
        });

        it("turns a JSON body into the request body with its default Content-Type and length", () => {
            const json = '{\n  "name": "{{name}}"\n}';
            const { parts: opened } = itemToRequestParts(httpItem({
                method: 'POST',
                body: { mode: 'json', json }
            }));

            expect(opened.body.toString()).to.equal(json);
            expect(opened.contentType).to.equal('json');
            expect(opened.headers).to.deep.equal([
                ['host', 'api.example.com'],
                ['content-type', 'application/json'],
                ['content-length', Buffer.byteLength(json).toString()]
            ]);
        });

        it("keeps an item's own Content-Type", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                method: 'POST',
                headers: [{ name: 'Content-Type', value: 'application/vnd.api+json', enabled: true }],
                body: { mode: 'json', json: '{}' }
            }));

            expect(opened.headers.filter(([name]) => name.toLowerCase() === 'content-type')).to.deep.equal([
                ['Content-Type', 'application/vnd.api+json']
            ]);
        });

        it("opens URL-encoded fields in the form editor, with all their fields", () => {
            const { parts: opened, warnings } = itemToRequestParts(httpItem({
                method: 'POST',
                body: {
                    mode: 'formUrlEncoded',
                    formUrlEncoded: [
                        { uid: 'f1', name: 'user name', value: 'Ann & Bob', enabled: true, description: 'Full name' },
                        { uid: 'f2', name: 'token', value: '{{token}}', enabled: true },
                        { uid: 'f3', name: 'debug', value: '1', enabled: false }
                    ]
                }
            }));

            expect(warnings).to.deep.equal([]);
            expect(opened.extras!.bodyMode).to.equal('form');
            expect(opened.extras!.formFields).to.deep.equal([
                { id: 'f1', name: 'user name', value: 'Ann & Bob', enabled: true, description: 'Full name' },
                { id: 'f2', name: 'token', value: '{{token}}', enabled: true },
                { id: 'f3', name: 'debug', value: '1', enabled: false }
            ]);
            // The body is built when sending, which sets Content-Length then
            expect(opened.body.length).to.equal(0);
            expect(opened.headers).to.deep.equal([
                ['host', 'api.example.com'],
                ['content-type', 'application/x-www-form-urlencoded']
            ]);
        });

        it("opens multipart forms with their text and file fields", () => {
            const { parts: opened, warnings } = itemToRequestParts(httpItem({
                method: 'POST',
                body: {
                    mode: 'multipartForm',
                    multipartForm: [
                        { uid: 'm1', type: 'text', name: 'title', value: 'Hello', enabled: true, contentType: '' },
                        { uid: 'm2', type: 'file', name: 'avatar', value: ['files/photo.png', 'files/notes.txt'], enabled: true, contentType: 'image/png' }
                    ]
                }
            }), filesOf([['files/photo.png', PHOTO], ['files/notes.txt', NOTES]]));

            expect(warnings).to.deep.equal([]);
            expect(opened.extras!.bodyMode).to.equal('multipart');
            expect(opened.extras!.multipartFields).to.deep.equal([
                { id: 'm1', name: 'title', enabled: true, kind: 'text', value: 'Hello', files: [] },
                { id: 'm2', name: 'avatar', enabled: true, kind: 'file', value: '', files: [PHOTO, NOTES], contentType: 'image/png' }
            ]);
            expect(headerValue(opened, 'content-type')).to.match(/^multipart\/form-data; boundary=----WirepaneFormBoundary\w+$/);
            expect(headerValue(opened, 'content-length')).to.equal(undefined);
        });

        it("shows files that aren't in the collection folder as missing, with a warning", () => {
            const { parts: opened, warnings } = itemToRequestParts(httpItem({
                method: 'POST',
                body: {
                    mode: 'multipartForm',
                    multipartForm: [{ type: 'file', name: 'avatar', value: ['files/photo.png'], enabled: true }]
                }
            }));

            expect(opened.extras!.multipartFields[0].files).to.deep.equal([missingFileRef('files/photo.png')]);
            expect(warnings).to.deep.equal([
                'The file “photo.png” (files/photo.png) isn\'t in the collection folder, so it can\'t be sent. Attach it again.'
            ]);
        });

        it("opens binary bodies with their selected file, sent with its type", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                method: 'PUT',
                body: {
                    mode: 'file',
                    file: [
                        { uid: 'b1', filePath: 'files/old.bin', contentType: '', selected: false },
                        { uid: 'b2', filePath: 'files/photo.png', contentType: 'image/webp', selected: true }
                    ]
                }
            }), filesOf([['files/photo.png', PHOTO]]));

            expect(opened.extras!.bodyMode).to.equal('binary');
            expect(opened.extras!.binaryFile).to.deep.equal({ ...PHOTO, contentType: 'image/webp' });
            expect(headerValue(opened, 'content-type')).to.equal('image/webp');
        });

        it("opens GraphQL requests in the GraphQL editor", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                method: 'POST',
                body: { mode: 'graphql', graphql: { query: 'query { me { id } }', variables: '{ "id": {{id}} }' } }
            }, { type: 'graphql-request' }));

            expect(opened.extras!.bodyMode).to.equal('graphql');
            expect(opened.extras!.graphql).to.deep.equal({ query: 'query { me { id } }', variables: '{ "id": {{id}} }' });
            expect(opened.body.length).to.equal(0);
            expect(opened.contentType).to.equal('json');
            expect(headerValue(opened, 'content-type')).to.equal('application/json');
        });

        it("keeps the text of earlier body modes for the raw editor", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                method: 'POST',
                body: { mode: 'formUrlEncoded', formUrlEncoded: [], json: '{"a":1}' }
            }));

            expect(opened.extras!.bodyMode).to.equal('form');
            expect(opened.body.toString()).to.equal('{"a":1}');
            expect(opened.contentType).to.equal('json');
        });

        it("opens WebSocket requests with their saved messages", () => {
            const { parts: opened } = itemToRequestParts({
                uid: UID,
                type: 'ws-request',
                name: 'Echo',
                request: wsRequest({
                    url: 'wss://echo.example.com/socket',
                    headers: [{ name: 'Sec-WebSocket-Protocol', value: 'chat', enabled: true }],
                    auth: { mode: 'inherit' },
                    body: { mode: 'ws', ws: [
                        { name: 'hello', type: 'text', content: 'hi {{name}}' },
                        { name: 'login', type: 'json', content: '{"user":"ann"}', selected: true }
                    ] }
                })
            });

            expect(opened.method).to.equal('GET');
            expect(opened.url).to.equal('wss://echo.example.com/socket');
            expect(opened.headers).to.deep.equal([['host', 'echo.example.com'], ['Sec-WebSocket-Protocol', 'chat']]);
            expect(opened.extras!.requestType).to.equal('websocket');

            const { message, messageType, savedMessages } = opened.extras!.websocket;
            expect(savedMessages.map(({ name, type, content }) => [name, type, content])).to.deep.equal([
                ['hello', 'text', 'hi {{name}}'],
                ['login', 'json', '{"user":"ann"}']
            ]);
            // The composer starts with the selected message
            expect([message, messageType]).to.deep.equal(['{"user":"ann"}', 'json']);
        });
    });

    describe("from a Send request back to its item", () => {

        it("gives back the same item when nothing changed", () => {
            const item = httpItem({
                method: 'POST',
                url: '{{baseUrl}}/users/:id?verbose=true',
                headers: [
                    { uid: 'h1', name: 'Accept', value: 'application/json', enabled: true, description: 'Always JSON' },
                    { uid: 'h2', name: 'X-Debug', value: 'yes', enabled: false }
                ],
                params: [
                    { uid: 'p1', name: 'verbose', value: 'true', enabled: true, type: 'query' },
                    { uid: 'p2', name: 'page', value: '2', enabled: false, type: 'query' },
                    { uid: 'p3', name: 'id', value: '{{userId}}', enabled: true, type: 'path' }
                ],
                body: { mode: 'json', json: '{"name":"Ann"}', text: 'kept from an earlier mode' },
                docs: '# Get a user'
            }, { examples: [{ name: '200 OK', type: 'http-request' }] });

            expect(roundTrip(item)).to.deep.equal(item);
        });

        it("updates headers, keeping uids, descriptions and disabled headers", () => {
            const base = httpItem({
                headers: [
                    { uid: 'h1', name: 'Accept', value: 'text/plain', enabled: true, description: 'What we want back' },
                    { uid: 'h2', name: 'X-Debug', value: 'yes', enabled: false }
                ]
            });

            const { item } = requestPartsToItem(parts({
                headers: [
                    ['host', 'api.example.com'],
                    ['accept', 'application/json'],
                    ['Authorization', 'Bearer {{token}}'],
                    ['content-length', '0']
                ]
            }), '', base, { name: base.name });

            expect(item.request!.headers).to.deep.equal([
                { uid: 'h1', description: 'What we want back', name: 'accept', value: 'application/json', enabled: true },
                { name: 'Authorization', value: 'Bearer {{token}}', enabled: true },
                { uid: 'h2', name: 'X-Debug', value: 'yes', enabled: false }
            ]);
        });

        it("keeps a Host header that doesn't match the URL", () => {
            const { item } = requestPartsToItem(parts({ headers: [['Host', 'internal.example.com']] }), '', undefined, { name: 'x' });
            expect(item.request!.headers).to.deep.equal([{ name: 'Host', value: 'internal.example.com', enabled: true }]);
        });

        it("reads query params from an edited URL, keeping disabled ones", () => {
            const base = httpItem({
                url: 'https://api.example.com/users?limit=10',
                params: [
                    { uid: 'p1', name: 'limit', value: '10', enabled: true, type: 'query', description: 'Page size' },
                    { uid: 'p2', name: 'page', value: '2', enabled: false, type: 'query' }
                ]
            });

            const { item } = requestPartsToItem(parts({
                url: 'https://api.example.com/users?limit=50&q=a%20b&flag'
            }), '', base, { name: base.name });

            expect(item.request!.url).to.equal('https://api.example.com/users?limit=50&q=a%20b&flag');
            expect(item.request!.params).to.deep.equal([
                { uid: 'p1', description: 'Page size', name: 'limit', value: '50', enabled: true, type: 'query' },
                { name: 'q', value: 'a%20b', enabled: true, type: 'query' },
                { name: 'flag', value: '', enabled: true, type: 'query' },
                { uid: 'p2', name: 'page', value: '2', enabled: false, type: 'query' }
            ]);
        });

        it("keeps path params whose :name is still in the URL, and adds new ones", () => {
            const base = httpItem({
                url: '{{baseUrl}}/todos/:id',
                params: [{ uid: 'p1', name: 'id', value: '', enabled: true, type: 'path' }]
            });

            const kept = requestPartsToItem(parts({ url: '{{baseUrl}}/users/:userId/todos/:id' }), '', base, { name: 'x' }).item;
            expect(kept.request!.params).to.deep.equal([
                { name: 'userId', value: '', enabled: true, type: 'path' },
                { uid: 'p1', name: 'id', value: '', enabled: true, type: 'path' }
            ]);

            const filledIn = requestPartsToItem(parts({ url: '{{baseUrl}}/todos/1' }), '', base, { name: 'x' }).item;
            expect(filledIn.request!.url).to.equal('{{baseUrl}}/todos/1');
            expect(filledIn.request!.params).to.deep.equal([]);
        });

        it("saves JSON bodies, dropping the default Content-Type and Content-Length", () => {
            const { item } = requestPartsToItem(parts({
                method: 'post',
                headers: [['content-type', 'application/json'], ['content-length', '13']],
                body: Buffer.from('{"name":"Ann"}'),
                contentType: 'json'
            }), '', undefined, { name: 'Create user' });

            expect(item.request!.method).to.equal('POST');
            expect(item.request!.body).to.deep.equal({ mode: 'json', json: '{"name":"Ann"}' });
            expect(item.request!.headers).to.deep.equal([]);
        });

        it("keeps a JSON Content-Type that isn't the default one", () => {
            const { item } = requestPartsToItem(parts({
                headers: [['Content-Type', 'application/json; charset=utf-8']],
                body: Buffer.from('{}'),
                contentType: 'json'
            }), '', undefined, { name: 'x' });

            expect(item.request!.body).to.deep.equal({ mode: 'json', json: '{}' });
            expect(item.request!.headers).to.deep.equal([
                { name: 'Content-Type', value: 'application/json; charset=utf-8', enabled: true }
            ]);
        });

        it("saves text and XML bodies by their type", () => {
            const text = requestPartsToItem(parts({
                headers: [['content-type', 'text/plain']],
                body: Buffer.from('hello')
            }), '', undefined, { name: 'x' }).item;
            expect(text.request!.body).to.deep.equal({ mode: 'text', text: 'hello' });
            expect(text.request!.headers).to.deep.equal([]);

            const xml = requestPartsToItem(parts({
                headers: [['content-type', 'application/xml']],
                body: Buffer.from('<a/>'),
                contentType: 'xml'
            }), '', undefined, { name: 'x' }).item;
            expect(xml.request!.body).to.deep.equal({ mode: 'xml', xml: '<a/>' });
        });

        it("saves URL-encoded bodies as form fields, keeping disabled fields", () => {
            const base = httpItem({
                method: 'POST',
                body: {
                    mode: 'formUrlEncoded',
                    formUrlEncoded: [
                        { uid: 'f1', name: 'user name', value: 'Ann', enabled: true },
                        { uid: 'f2', name: 'debug', value: '1', enabled: false }
                    ]
                }
            });

            const { item } = requestPartsToItem(parts({
                method: 'POST',
                headers: [['content-type', 'application/x-www-form-urlencoded']],
                body: Buffer.from('user+name=Ann+%26+Bob&token={{token}}')
            }), '', base, { name: base.name });

            expect(item.request!.body!.mode).to.equal('formUrlEncoded');
            expect(item.request!.body!.formUrlEncoded).to.deep.equal([
                { uid: 'f1', name: 'user name', value: 'Ann & Bob', enabled: true },
                { name: 'token', value: '{{token}}', enabled: true },
                { uid: 'f2', name: 'debug', value: '1', enabled: false }
            ]);
            expect(item.request!.headers).to.deep.equal([]);
        });

        it("reads multipart bodies back into text fields, keeping file fields", () => {
            const base = httpItem({
                method: 'POST',
                body: {
                    mode: 'multipartForm',
                    multipartForm: [{ type: 'file', name: 'avatar', value: ['/tmp/a.png'], enabled: true }]
                }
            });
            const body = '--XYZ\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n--XYZ--\r\n';

            const { item } = requestPartsToItem(parts({
                method: 'POST',
                headers: [['content-type', 'multipart/form-data; boundary=XYZ']],
                body: Buffer.from(body)
            }), '', base, { name: base.name });

            expect(item.request!.body!.multipartForm).to.deep.equal([
                { type: 'text', name: 'title', value: 'Hello', enabled: true },
                { type: 'file', name: 'avatar', value: ['/tmp/a.png'], enabled: true }
            ]);
            expect(item.request!.headers).to.deep.equal([]);
        });

        it("keeps an emptied JSON body as JSON", () => {
            const base = httpItem({ method: 'POST', body: { mode: 'json', json: '{"a":1}' } });
            const { item } = requestPartsToItem(parts({ method: 'POST' }), '', base, { name: base.name });
            expect(item.request!.body).to.deep.equal({ mode: 'json', json: '' });
        });

        it("leaves binary bodies out, with a warning", () => {
            const { item, warnings } = requestPartsToItem(parts({
                method: 'POST',
                headers: [['content-type', 'application/octet-stream']],
                body: Buffer.from([0xff, 0xfe, 0x00, 0x80])
            }), '', undefined, { name: 'Upload' });

            expect(item.request!.body).to.deep.equal({ mode: 'none' });
            expect(warnings).to.have.length(1);
        });

        it("saves the docs with the request", () => {
            const { item } = requestPartsToItem(parts({}), '## Lists users\n\nNewest first.', undefined, { name: 'List users' });
            expect(item.request!.docs).to.equal('## Lists users\n\nNewest first.');
        });

        it("creates new items that inherit the collection's auth", () => {
            const { item } = requestPartsToItem(parts({}), '', undefined, { name: 'List users' });

            expect(item.type).to.equal('http-request');
            expect(item.name).to.equal('List users');
            expect(item.uid).to.match(/^[A-Za-z0-9]{21}$/);
            expect(item.request!.auth).to.deep.equal({ mode: 'inherit' });
            expect(item.request!.params).to.deep.equal([]);
        });

        it("keeps GraphQL requests as GraphQL", () => {
            const item = httpItem({
                method: 'POST',
                body: { mode: 'graphql', graphql: { query: 'query { me { id } }', variables: '{ "id": {{id}} }' } }
            }, { type: 'graphql-request' });

            const saved = roundTrip(item);
            expect(saved.type).to.equal('graphql-request');
            expect(saved.request!.body).to.deep.equal(item.request!.body);
        });
    });

    describe("round trips of every body mode", () => {

        it("gives back the same form request", () => {
            const item = httpItem({
                method: 'POST',
                headers: [{ uid: 'h1', name: 'Accept', value: '*/*', enabled: true }],
                body: {
                    mode: 'formUrlEncoded',
                    formUrlEncoded: [
                        { uid: 'f1', name: 'user name', value: 'Ann & Bob', enabled: true, description: 'Full name' },
                        { uid: 'f2', name: 'empty', value: '', enabled: true },
                        { uid: 'f3', name: 'debug', value: '1', enabled: false }
                    ],
                    json: '{"kept": true}'
                }
            });
            expect(roundTrip(item)).to.deep.equal(item);
        });

        it("gives back the same multipart request, keeping its file paths", () => {
            const item = httpItem({
                method: 'POST',
                body: {
                    mode: 'multipartForm',
                    multipartForm: [
                        { uid: 'm1', type: 'text', name: 'title', value: 'Hello {{name}}', enabled: true, contentType: '' },
                        { uid: 'm2', type: 'file', name: 'avatar', value: ['files/photo.png'], enabled: true, contentType: 'image/png' },
                        { uid: 'm3', type: 'file', name: 'gone', value: ['files/gone.png'], enabled: false, contentType: '' }
                    ]
                }
            });

            // gone.png isn't in the folder: its path stays, so it's back once the file is
            const saved = roundTrip(item, filesOf([['files/photo.png', PHOTO]]), storedAt([[PHOTO, 'files/photo.png']]));
            expect(saved).to.deep.equal(item);
        });

        it("gives back the same binary request", () => {
            const item = httpItem({
                method: 'PUT',
                body: {
                    mode: 'file',
                    file: [
                        { uid: 'b1', filePath: 'files/old.bin', contentType: '', selected: false },
                        { uid: 'b2', filePath: 'files/photo.png', contentType: 'image/png', selected: true }
                    ]
                }
            });
            expect(roundTrip(item, filesOf([['files/photo.png', PHOTO]]), storedAt([[PHOTO, 'files/photo.png']]))).to.deep.equal(item);
        });

        it("gives back the same GraphQL request", () => {
            const item = httpItem({
                method: 'POST',
                url: 'https://countries.example.com/graphql',
                body: { mode: 'graphql', graphql: { query: 'query ($code: ID!) { country(code: $code) { name } }', variables: '{ "code": "{{code}}" }' } }
            }, { type: 'graphql-request' });
            expect(roundTrip(item)).to.deep.equal(item);
        });

        it("gives back the same WebSocket request", () => {
            const item: BrunoItem = {
                uid: UID,
                type: 'ws-request',
                name: 'Echo',
                seq: 2,
                settings: { timeout: 0, keepAliveInterval: 0 },
                request: wsRequest({
                    url: '{{wsUrl}}/socket',
                    headers: [{ uid: 'h1', name: 'X-Client', value: 'wirepane', enabled: true }],
                    auth: { mode: 'inherit' },
                    body: { mode: 'ws', ws: [
                        { name: 'hello', type: 'text', content: 'hi {{name}}', selected: true },
                        { name: 'untyped', type: '', content: 'plain' },
                        { name: 'data', type: 'binary', content: 'AAEC' }
                    ] },
                    script: {},
                    vars: {},
                    assertions: [],
                    tests: '',
                    docs: '# Echo'
                })
            };
            expect(roundTrip(item)).to.deep.equal(item);
        });
    });

    describe("saving structured bodies", () => {

        it("saves form fields from the form editor, leaving out empty rows", () => {
            const { item } = requestPartsToItem(parts({
                method: 'POST',
                headers: [['content-type', 'application/x-www-form-urlencoded']],
                extras: extras({
                    bodyMode: 'form',
                    formFields: [
                        { id: 'a', name: 'q', value: '{{search}}', enabled: true },
                        { id: 'b', name: '', value: '', enabled: true }
                    ]
                })
            }), '', undefined, { name: 'Search' });

            expect(item.request!.body).to.deep.equal({
                mode: 'formUrlEncoded',
                formUrlEncoded: [{ name: 'q', value: '{{search}}', enabled: true }]
            });
            expect(item.request!.headers).to.deep.equal([]);
        });

        it("saves multipart file fields as the paths their files are stored at", () => {
            const { item, warnings } = requestPartsToItem(parts({
                method: 'POST',
                headers: [['content-type', 'multipart/form-data; boundary=XYZ']],
                extras: extras({
                    bodyMode: 'multipart',
                    multipartFields: [
                        { id: 'a', name: 'title', enabled: true, kind: 'text', value: 'Hi', files: [] },
                        { id: 'b', name: 'photos', enabled: true, kind: 'file', value: '', files: [PHOTO, NOTES], contentType: 'image/png' }
                    ]
                })
            }), '', undefined, { name: 'Upload' }, storedAt([[PHOTO, 'files/photo.png']]));

            expect(item.request!.body!.multipartForm).to.deep.equal([
                { type: 'text', name: 'title', value: 'Hi', enabled: true },
                // notes.txt was never stored: it's left out, and the save says so
                { type: 'file', name: 'photos', value: ['files/photo.png'], enabled: true, contentType: 'image/png' }
            ]);
            expect(warnings).to.deep.equal([
                '“notes.txt” isn\'t available any more, so it wasn\'t saved with the request. Attach it again.'
            ]);
            expect(item.request!.headers).to.deep.equal([]);
        });

        it("saves binary bodies with the Content-Type they're sent with", () => {
            const { item } = requestPartsToItem(parts({
                method: 'PUT',
                headers: [['content-type', 'image/webp']],
                extras: extras({ bodyMode: 'binary', binaryFile: PHOTO })
            }), '', undefined, { name: 'Upload' }, storedAt([[PHOTO, 'files/photo.png']]));

            expect(item.request!.body).to.deep.equal({
                mode: 'file',
                file: [{ filePath: 'files/photo.png', contentType: 'image/webp', selected: true }]
            });
            expect(item.request!.headers).to.deep.equal([]);
        });

        it("saves GraphQL bodies as GraphQL requests", () => {
            const { item } = requestPartsToItem(parts({
                method: 'POST',
                headers: [['content-type', 'application/json']],
                extras: extras({ bodyMode: 'graphql', graphql: { query: '{ me { id } }', variables: '', operationName: 'Me' } })
            }), '', undefined, { name: 'Me' });

            expect(item.type).to.equal('graphql-request');
            expect(item.request!.body).to.deep.equal({ mode: 'graphql', graphql: { query: '{ me { id } }', variables: '' } });
            expect(item.request!.headers).to.deep.equal([]);
        });

        it("keeps every mode's data, so switching modes and saving loses nothing", () => {
            const base = httpItem({
                method: 'POST',
                body: { mode: 'formUrlEncoded', formUrlEncoded: [{ uid: 'f1', name: 'a', value: '1', enabled: true }] }
            });
            const { parts: opened } = itemToRequestParts(base);

            // Switched to JSON in the tab, and saved
            const { item } = requestPartsToItem({
                ...opened,
                headers: [['content-type', 'application/json']],
                body: Buffer.from('{"a":1}'),
                contentType: 'json',
                extras: { ...opened.extras!, bodyMode: 'raw' }
            }, '', base, { name: base.name });

            expect(item.request!.body).to.deep.equal({
                mode: 'json',
                json: '{"a":1}',
                formUrlEncoded: [{ uid: 'f1', name: 'a', value: '1', enabled: true }]
            });

            // ...and opening it again shows the JSON, with the form one switch away
            const { parts: reopened } = itemToRequestParts(item);
            expect(reopened.extras!.bodyMode).to.equal('raw');
            expect(reopened.extras!.formFields.map(({ name, value }) => [name, value])).to.deep.equal([['a', '1']]);
        });

        it("saves WebSocket tabs as ws-request items, without a method or params", () => {
            const base = httpItem({
                url: 'https://api.example.com/socket',
                params: [{ name: 'debug', value: '1', enabled: false, type: 'query' }],
                body: { mode: 'json', json: '{}' }
            }, { settings: { encodeUrl: true, timeout: 5000 }, examples: [{ name: '200 OK', type: 'http-request' }] });

            const { item } = requestPartsToItem(parts({
                url: 'wss://api.example.com/socket',
                headers: [['host', 'api.example.com'], ['Sec-WebSocket-Protocol', 'chat']],
                extras: extras({
                    requestType: 'websocket',
                    websocket: { message: 'draft', messageType: 'text', savedMessages: [{ id: 'x', name: 'ping', type: 'json', content: '{"op":"ping"}' }] }
                })
            }), 'Docs', base, { name: base.name });

            expect(item.type).to.equal('ws-request');
            expect(item.settings).to.deep.equal({ timeout: 5000 });
            expect(item).to.not.have.property('examples');
            expect(item.request).to.not.have.property('method');
            expect(item.request).to.not.have.property('params');
            expect(item.request!.url).to.equal('wss://api.example.com/socket');
            expect(item.request!.headers).to.deep.equal([{ name: 'Sec-WebSocket-Protocol', value: 'chat', enabled: true }]);
            expect(item.request!.body).to.deep.equal({ mode: 'ws', ws: [{ name: 'ping', type: 'json', content: '{"op":"ping"}' }] });
            expect(item.request!.docs).to.equal('Docs');
        });

        it("turns WebSocket requests back into HTTP ones", () => {
            const base: BrunoItem = {
                uid: UID,
                type: 'ws-request',
                name: 'Echo',
                settings: { timeout: 0, keepAliveInterval: 10 },
                request: wsRequest({
                    url: 'wss://api.example.com/socket',
                    headers: [],
                    auth: { mode: 'inherit' },
                    body: { mode: 'ws', ws: [{ name: 'hello', type: 'text', content: 'hi' }] }
                })
            };

            const { item } = requestPartsToItem(parts({ url: 'https://api.example.com/socket?v=2' }), '', base, { name: base.name });

            expect(item.type).to.equal('http-request');
            expect(item.settings).to.deep.equal({ timeout: 0 });
            expect(item.request!.method).to.equal('GET');
            expect(item.request!.params).to.deep.equal([{ name: 'v', value: '2', enabled: true, type: 'query' }]);
            expect(item.request!.body).to.deep.equal({ mode: 'none' });
        });
    });

    it("names requests after their method and path", () => {
        expect(defaultRequestName('get', 'https://api.example.com/users/42?expand=true')).to.equal('GET /users/42');
        expect(defaultRequestName('POST', '{{baseUrl}}/a%20b')).to.equal('POST {{baseUrl}}/a b');
        expect(defaultRequestName('GET', 'https://example.com')).to.equal('GET /');
    });
});
