import { expect } from '../../../test-setup';

import { BrunoItem, BrunoRequest } from '../../../../src/model/collections/collection-types';
import {
    defaultRequestName,
    itemToRequestParts,
    RequestParts,
    requestPartsToItem
} from '../../../../src/model/collections/request-mapping';

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

const parts = (overrides: Partial<RequestParts>): RequestParts => ({
    method: 'GET',
    url: 'https://api.example.com/users',
    headers: [],
    body: Buffer.alloc(0),
    contentType: 'text',
    ...overrides
});

const roundTrip = (item: BrunoItem) => {
    const { parts: opened } = itemToRequestParts(item);
    return requestPartsToItem(opened, item.request?.docs ?? '', item, { name: item.name }).item;
};

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

        it("form-encodes URL-encoded fields, leaving {{variables}} readable", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                method: 'POST',
                body: {
                    mode: 'formUrlEncoded',
                    formUrlEncoded: [
                        { name: 'user name', value: 'Ann & Bob', enabled: true },
                        { name: 'token', value: '{{token}}', enabled: true },
                        { name: 'debug', value: '1', enabled: false }
                    ]
                }
            }));

            expect(opened.body.toString()).to.equal('user+name=Ann+%26+Bob&token={{token}}');
            expect(opened.headers).to.deep.include(['content-type', 'application/x-www-form-urlencoded']);
        });

        it("builds multipart bodies from text fields, and warns about file fields", () => {
            const { parts: opened, warnings } = itemToRequestParts(httpItem({
                method: 'POST',
                body: {
                    mode: 'multipartForm',
                    multipartForm: [
                        { type: 'text', name: 'title', value: 'Hello', enabled: true },
                        { type: 'file', name: 'avatar', value: ['/tmp/avatar.png'], enabled: true }
                    ]
                }
            }));

            const contentType = opened.headers.find(([name]) => name === 'content-type')![1];
            const boundary = /boundary=(.+)$/.exec(contentType)![1];
            expect(opened.body.toString()).to.equal(
                `--${boundary}\r\nContent-Disposition: form-data; name="title"\r\n\r\nHello\r\n--${boundary}--\r\n`
            );
            expect(warnings).to.have.length(1);
        });

        it("sends GraphQL requests as JSON", () => {
            const { parts: opened } = itemToRequestParts(httpItem({
                method: 'POST',
                body: { mode: 'graphql', graphql: { query: 'query { me { id } }', variables: '{ "id": {{id}} }' } }
            }, { type: 'graphql-request' }));

            expect(opened.body.toString()).to.equal(
                '{\n  "query": "query { me { id } }",\n  "variables": { "id": {{id}} }\n}'
            );
            expect(opened.contentType).to.equal('json');
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

    it("names requests after their method and path", () => {
        expect(defaultRequestName('get', 'https://api.example.com/users/42?expand=true')).to.equal('GET /users/42');
        expect(defaultRequestName('POST', '{{baseUrl}}/a%20b')).to.equal('POST {{baseUrl}}/a b');
        expect(defaultRequestName('GET', 'https://example.com')).to.equal('GET /');
    });
});
