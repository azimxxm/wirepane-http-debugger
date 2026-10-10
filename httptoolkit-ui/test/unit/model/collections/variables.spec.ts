import { expect } from '../../../test-setup';

import { RequestInput } from '../../../../src/model/send/send-request-model';
import { BrunoCollection, BrunoItem } from '../../../../src/model/collections/collection-types';
import { findItem } from '../../../../src/model/collections/collection-tree';
import { RequestParts } from '../../../../src/model/collections/request-mapping';
import {
    buildVariableScope,
    effectiveAuth,
    findUnsetValues,
    inheritedHeaders,
    prepareRequest,
    resolveTemplate,
    resolveVariables,
    ScopeVariable,
    SendContext,
    VariableScope
} from '../../../../src/model/collections/variables';

const scopeOf = (values: { [name: string]: string }, secret: string[] = []): VariableScope =>
    new Map(Object.entries(values).map(([name, value]): [string, ScopeVariable] =>
        [name, { name, value, secret: secret.includes(name), source: 'environment' }]
    ));

const parts = (overrides: Partial<RequestParts>): RequestParts => ({
    method: 'GET',
    url: 'https://api.example.com/',
    headers: [],
    body: Buffer.alloc(0),
    contentType: 'text',
    ...overrides
});

const request = (uid: string, extra: Partial<BrunoItem> = {}): BrunoItem => ({
    uid,
    type: 'http-request',
    name: uid,
    request: { method: 'GET', url: '{{baseUrl}}/users', headers: [], params: [], auth: { mode: 'inherit' } },
    ...extra
});

function petCollection(): BrunoCollection {
    return {
        version: '1',
        uid: 'CCCCCCCCCCCCCCCCCCCCC',
        name: 'Pets',
        environments: [{
            name: 'Dev',
            variables: [
                { name: 'baseUrl', value: 'https://dev.example.com', enabled: true },
                { name: 'token', value: 'dev-token', enabled: true, secret: true },
                { name: 'off', value: 'not used', enabled: false }
            ]
        }],
        root: {
            request: {
                auth: { mode: 'bearer', bearer: { token: '{{token}}' } },
                headers: [{ name: 'X-Client', value: 'wirepane', enabled: true }],
                vars: { req: [
                    { name: 'baseUrl', value: 'https://collection.example.com', enabled: true },
                    { name: 'version', value: 'v1', enabled: true }
                ] }
            }
        },
        items: [{
            uid: 'FFFFFFFFFFFFFFFFFFFFF',
            type: 'folder',
            name: 'Admin',
            root: {
                request: {
                    auth: { mode: 'inherit' },
                    headers: [{ name: 'X-Client', value: 'admin-panel', enabled: true }],
                    vars: { req: [{ name: 'version', value: 'v2', enabled: true }] }
                }
            },
            items: [
                request('RRRRRRRRRRRRRRRRRRRR1', {
                    request: {
                        method: 'GET',
                        url: '{{baseUrl}}/{{version}}/users',
                        headers: [],
                        params: [],
                        auth: { mode: 'inherit' },
                        vars: { req: [{ name: 'page', value: '2', enabled: true }] }
                    }
                }),
                request('RRRRRRRRRRRRRRRRRRRR2', {
                    request: {
                        method: 'GET',
                        url: '{{baseUrl}}/login',
                        headers: [],
                        params: [],
                        auth: { mode: 'basic', basic: { username: 'admin', password: '{{adminPassword}}' } }
                    }
                }),
                request('RRRRRRRRRRRRRRRRRRRR3', {
                    request: { method: 'GET', url: '/health', headers: [], params: [], auth: { mode: 'none' } }
                })
            ]
        }]
    };
}

describe("Collection variables", () => {

    describe("scopes", () => {
        it("take each value from the request, then folders, the environment, then the collection", () => {
            const collection = petCollection();
            const location = findItem(collection, 'RRRRRRRRRRRRRRRRRRRR1')!;
            const scope = buildVariableScope({ collection, environment: collection.environments[0], location });

            expect(scope.get('page')).to.deep.include({ value: '2', source: 'request' });
            expect(scope.get('version')).to.deep.include({ value: 'v2', source: 'folder' });
            expect(scope.get('baseUrl')).to.deep.include({ value: 'https://dev.example.com', source: 'environment' });
            expect(scope.get('token')).to.deep.include({ value: 'dev-token', secret: true });
            expect(scope.has('off')).to.equal(false);
        });

        it("fall back to collection variables without an environment", () => {
            const collection = petCollection();
            const scope = buildVariableScope({ collection });

            expect(scope.get('baseUrl')).to.deep.include({ value: 'https://collection.example.com', source: 'collection' });
            expect(scope.get('version')!.value).to.equal('v1');
        });
    });

    describe("templates", () => {
        it("fill in variables, including variables inside values", () => {
            const scope = scopeOf({ host: 'api.example.com', baseUrl: 'https://{{host}}/v1', id: '42' });
            expect(resolveTemplate('{{baseUrl}}/users/{{ id }}', scope)).to.equal('https://api.example.com/v1/users/42');
        });

        it("leave unknown variables as written, and report them", () => {
            const unresolved = new Set<string>();
            const text = resolveTemplate('Bearer {{token}} {{}}', scopeOf({}), { unresolved });

            expect(text).to.equal('Bearer {{token}} {{}}');
            expect([...unresolved]).to.deep.equal(['token']);
        });

        it("stop at variables that refer to themselves", () => {
            const unresolved = new Set<string>();
            const text = resolveTemplate('{{a}}', scopeOf({ a: 'x{{b}}', b: '{{a}}' }), { unresolved });

            expect(text).to.equal('x{{a}}');
            expect([...unresolved]).to.deep.equal(['a']);
        });

        it("support the common dynamic variables", () => {
            const text = resolveTemplate('{{$guid}} {{$timestamp}} {{$randomInt}}', scopeOf({}));
            const [guid, timestamp, randomInt] = text.split(' ');

            expect(guid).to.match(/^[0-9a-f-]{36}$/);
            expect(Number(timestamp)).to.be.closeTo(Date.now() / 1000, 5);
            expect(Number(randomInt)).to.be.within(0, 1000);
        });

        it("encode filled-in values when asked", () => {
            const text = resolveTemplate('q={{query}}', scopeOf({ query: 'a&b c' }), { encode: encodeURIComponent });
            expect(text).to.equal('q=a%26b%20c');
        });
    });

    describe("prepared requests", () => {
        it("fill in the URL, headers and body, and add Host for a variable origin", () => {
            const body = '{"token":"{{token}}"}';
            const prepared = prepareRequest(parts({
                method: 'POST',
                url: '{{baseUrl}}/login',
                headers: [['X-Env', '{{env}}'], ['content-length', Buffer.byteLength(body).toString()]],
                body: Buffer.from(body)
            }), { scope: scopeOf({ baseUrl: 'https://api.example.com', env: 'dev', token: 'abc' }) });

            expect(prepared.changed).to.equal(true);
            expect(prepared.unresolved).to.deep.equal([]);
            expect(prepared.parts.url).to.equal('https://api.example.com/login');
            expect(prepared.parts.body.toString()).to.equal('{"token":"abc"}');
            expect(prepared.parts.headers).to.deep.equal([
                ['host', 'api.example.com'],
                ['X-Env', 'dev'],
                ['content-length', '15']
            ]);
        });

        it("form-encode values that go into URL-encoded bodies", () => {
            const prepared = prepareRequest(parts({
                method: 'POST',
                headers: [['content-type', 'application/x-www-form-urlencoded']],
                body: Buffer.from('q={{query}}')
            }), { scope: scopeOf({ query: 'a&b c' }) });

            expect(prepared.parts.body.toString()).to.equal('q=a%26b+c');
            expect(prepared.parts.headers).to.deep.include(['content-length', '9']);
        });

        it("are unchanged when there's nothing to fill in", () => {
            const original = parts({ headers: [['Accept', '*/*']] });
            const prepared = prepareRequest(original, { scope: scopeOf({ a: 'b' }) });

            expect(prepared.changed).to.equal(false);
            expect(prepared.parts.headers).to.deep.equal(original.headers);
        });

        it("add the collection's headers and auth, unless the request sets them", () => {
            const collection = petCollection();
            const location = findItem(collection, 'RRRRRRRRRRRRRRRRRRRR1')!;
            const context: SendContext = {
                scope: buildVariableScope({ collection, environment: collection.environments[0], location }),
                inheritedHeaders: inheritedHeaders(collection, location),
                auth: effectiveAuth(collection, location)
            };

            const prepared = prepareRequest(parts({ url: '{{baseUrl}}/{{version}}/users' }), context);
            expect(prepared.parts.headers).to.deep.equal([
                ['host', 'dev.example.com'],
                ['X-Client', 'admin-panel'],
                ['Authorization', 'Bearer dev-token']
            ]);

            const withOwnAuth = prepareRequest(parts({
                url: 'https://dev.example.com/',
                headers: [['authorization', 'Bearer mine'], ['x-client', 'cli']]
            }), context);
            expect(withOwnAuth.parts.headers).to.deep.equal([['authorization', 'Bearer mine'], ['x-client', 'cli']]);
        });

        it("build Basic auth from the filled-in username & password", () => {
            const collection = petCollection();
            const location = findItem(collection, 'RRRRRRRRRRRRRRRRRRRR2')!;
            const auth = effectiveAuth(collection, location);

            const prepared = prepareRequest(parts({}), { scope: scopeOf({ adminPassword: 's3cret' }), auth });
            expect(prepared.parts.headers).to.deep.include(['Authorization', `Basic ${Buffer.from('admin:s3cret').toString('base64')}`]);
        });

        it("put API keys in a header or the query string", () => {
            const header = prepareRequest(parts({}), {
                scope: scopeOf({ key: 'k1' }),
                auth: { auth: { mode: 'apikey', apikey: { key: 'X-Api-Key', value: '{{key}}', placement: 'header' } }, source: 'the collection' }
            });
            expect(header.parts.headers).to.deep.include(['X-Api-Key', 'k1']);

            const query = prepareRequest(parts({ url: 'https://api.example.com/items?page=2#top' }), {
                scope: scopeOf({ key: 'k 1' }),
                auth: { auth: { mode: 'apikey', apikey: { key: 'api_key', value: '{{key}}', placement: 'queryparams' } }, source: 'the collection' }
            });
            expect(query.parts.url).to.equal('https://api.example.com/items?page=2&api_key=k%201#top');
        });

        it("report unset and empty variables, and unfilled path params", () => {
            const unset = findUnsetValues(parts({
                url: '{{baseUrl}}/todos/:id',
                headers: [['Authorization', 'Bearer {{token}}'], ['X-Api-Key', '{{apiKey}}']]
            }), {
                scope: scopeOf({ baseUrl: 'https://api.example.com', apiKey: '' })
            });

            expect(unset).to.deep.equal({ variables: ['token'], emptyVariables: ['apiKey'], pathParams: ['id'] });
        });
    });

    describe("auth inheritance", () => {
        it("goes up through folders to the collection, and stops at 'none'", () => {
            const collection = petCollection();

            expect(effectiveAuth(collection, findItem(collection, 'RRRRRRRRRRRRRRRRRRRR1')!)).to.deep.equal({
                auth: { mode: 'bearer', bearer: { token: '{{token}}' } },
                source: 'the collection'
            });
            expect(effectiveAuth(collection, findItem(collection, 'RRRRRRRRRRRRRRRRRRRR2')!)!.source).to.equal('this request');
            expect(effectiveAuth(collection, findItem(collection, 'RRRRRRRRRRRRRRRRRRRR3')!)).to.equal(undefined);
        });

        it("takes the nearest definition of each inherited header", () => {
            const collection = petCollection();
            expect(inheritedHeaders(collection, findItem(collection, 'RRRRRRRRRRRRRRRRRRRR1')!)).to.deep.equal([
                { name: 'X-Client', value: 'admin-panel', source: 'folder Admin' }
            ]);
        });
    });

    describe("the Send hook", () => {
        const input = (url: string, headers: Array<[string, string]> = []) => new RequestInput({
            method: 'GET',
            url,
            headers,
            requestContentType: 'text',
            rawBody: Buffer.alloc(0)
        });

        it("sends the same request when there's nothing to fill in", () => {
            const original = input('https://example.com/', [['host', 'example.com']]);
            expect(resolveVariables(original, undefined)).to.equal(original);
        });

        it("sends a filled-in copy, leaving the tab as it was", () => {
            const original = input('{{baseUrl}}/users');
            const sent = resolveVariables(original, { scope: scopeOf({ baseUrl: 'https://api.example.com' }) });

            expect(sent).to.not.equal(original);
            expect(sent.url).to.equal('https://api.example.com/users');
            expect(sent.headers).to.deep.equal([['host', 'api.example.com']]);
            expect(original.url).to.equal('{{baseUrl}}/users');
        });

        it("explains a URL variable that isn't set, naming the environment", () => {
            expect(() => resolveVariables(input('{{baseUrl}}/users'), {
                scope: scopeOf({}),
                environmentName: 'Environment 1'
            })).to.throw("{{baseUrl}} isn't set in Environment 1, so the URL isn't complete.");

            expect(() => resolveVariables(input('{{baseUrl}}/users'), { scope: scopeOf({}) }))
                .to.throw(/No environment is active/);

            expect(() => resolveVariables(input('{{baseUrl}}/users'), undefined))
                .to.throw(/No collection applies to this tab/);
        });

        it("blocks an empty URL", () => {
            expect(() => resolveVariables(input('  '), undefined)).to.throw('Enter a URL to send this request.');
        });

        it("blocks URLs that aren't full URLs, without repeating filled-in values", () => {
            expect(() => resolveVariables(input('https://'), undefined)).to.throw('"https://" isn\'t a full URL.');

            const notAUrl = () => resolveVariables(input('{{baseUrl}}/users'), {
                scope: scopeOf({ baseUrl: 'secret-host-name' }, ['baseUrl']),
                environmentName: 'Staging'
            });
            expect(notAUrl).to.throw("{{baseUrl}}/users isn't a full URL once its variables are filled in. Check {{baseUrl}} in Staging");
            expect(notAUrl).to.not.throw(/secret-host-name/);
        });

        it("still sends other unset variables as written", () => {
            const sent = resolveVariables(input('https://example.com/', [['x-token', '{{token}}']]), { scope: scopeOf({}) });
            expect(sent.headers).to.deep.equal([['x-token', '{{token}}']]);
        });
    });
});
