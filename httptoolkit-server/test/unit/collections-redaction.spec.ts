import * as _ from 'lodash';
import { expect } from 'chai';

import { importCollectionFile } from '../../src/collections/import';
import { redactCollection, isSecretName } from '../../src/collections/redaction';
import { exportCollection } from '../../src/collections/export';
import { BrunoCollection, BrunoItem } from '../../src/collections/bruno-types';
import { readCollectionFixture, unzipToText } from './collections-fixtures';

const SECRETS = {
    bearerToken: 'bearer-secret-0123456789',
    cookie: 'session=cookie-secret-abcdef',
    apiKey: 'apikey-secret-987654321',
    jwt: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IldpcmVwYW5lIn0.c2lnbmF0dXJlLXNlY3JldA',
    environmentSecret: 'env-secret-value-42'
};

const searchItems = (items: BrunoItem[], name: string): BrunoItem | undefined => {
    for (const item of items) {
        if (item.name === name) return item;
        const nested = searchItems(item.items ?? [], name);
        if (nested) return nested;
    }
    return undefined;
};

const findItem = (items: BrunoItem[], name: string): BrunoItem => {
    const item = searchItems(items, name);
    if (!item) throw new Error(`No item called ${name}`);
    return item;
};

// The Postman fixture with one of each kind of secret a developer might leave behind
async function collectionWithSecrets(): Promise<BrunoCollection> {
    const { collection } = await importCollectionFile({
        fileName: 'pets.postman_collection.json',
        content: readCollectionFixture('postman-v21.json')
    });

    const listPets = findItem(collection.items, 'List pets').request!;
    listPets.auth = { mode: 'bearer', bearer: { token: SECRETS.bearerToken } };
    listPets.headers!.push({ name: 'Cookie', value: SECRETS.cookie, enabled: true });
    listPets.url = `{{baseUrl}}/pets?limit=10&api_key=${SECRETS.apiKey}`;
    listPets.params!.push({ name: 'api_key', value: SECRETS.apiKey, type: 'query', enabled: true });

    const login = findItem(collection.items, 'Login').request!;
    login.body = { mode: 'json', json: `{\n  "email": "dev@example.com",\n  "invite": "${SECRETS.jwt}"\n}` };

    collection.environments = [{
        name: 'Production',
        variables: [
            { name: 'baseUrl', value: 'https://api.petstore.test/v1', type: 'text', enabled: true, secret: false },
            { name: 'clientSecret', value: SECRETS.environmentSecret, type: 'text', enabled: true, secret: true }
        ]
    }];

    return collection;
}

const EXPECTED_REPORT = [
    { location: 'Pets / List pets › query', name: 'api_key', variable: 'apiKey' },
    { location: 'Pets / List pets › header', name: 'Cookie', variable: 'cookie' },
    { location: 'Pets / List pets › auth', name: 'bearer token', variable: 'authToken' },
    { location: 'Auth / Login › body', name: 'JWT', variable: 'jwt' },
    { location: 'Environment "Production"', name: 'clientSecret', variable: 'clientSecret' }
];

const expectNoSecrets = (text: string) => {
    for (const secret of Object.values(SECRETS)) expect(text).to.not.include(secret);
};

describe("Collection redaction", function () {
    this.timeout(10000);

    it("replaces each secret with a {{variable}} and reports it", async () => {
        const original = await collectionWithSecrets();
        const { collection, report } = redactCollection(original);

        expect(report).to.have.deep.members(EXPECTED_REPORT);
        expect(report).to.have.length(EXPECTED_REPORT.length);

        const listPets = findItem(collection.items, 'List pets').request!;
        expect(listPets.auth?.bearer).to.deep.equal({ token: '{{authToken}}' });
        expect(listPets.headers?.find(({ name }) => name === 'Cookie')?.value).to.equal('{{cookie}}');
        expect(listPets.url).to.equal('{{baseUrl}}/pets?limit=10&api_key={{apiKey}}');
        expect(listPets.params?.map(({ name, value }) => [name, value])).to.deep.equal([
            ['limit', '10'],
            ['api_key', '{{apiKey}}']
        ]);

        expect(findItem(collection.items, 'Login').request?.body?.json)
            .to.equal('{\n  "email": "dev@example.com",\n  "invite": "{{jwt}}"\n}');

        expect(collection.environments[0].variables.map(({ name, value }) => [name, value])).to.deep.equal([
            ['baseUrl', 'https://api.petstore.test/v1'],
            ['clientSecret', '']
        ]);
    });

    it("never puts the secrets themselves in the report", async () => {
        const { report } = redactCollection(await collectionWithSecrets());
        expectNoSecrets(JSON.stringify(report));
    });

    it("leaves values that are already {{variables}} and the original collection alone", async () => {
        const original = await collectionWithSecrets();
        const before = _.cloneDeep(original);
        const { collection } = redactCollection(original);

        expect(original).to.deep.equal(before);
        expect(collection.root?.request?.auth?.bearer).to.deep.equal({ token: '{{authToken}}' });
        expect(findItem(collection.items, 'Health check').request?.auth?.basic)
            .to.deep.equal({ username: 'admin', password: '{{adminPassword}}' });
    });

    it("keeps every secret out of a Postman export and reports each one", async () => {
        const result = exportCollection(await collectionWithSecrets(), 'postman');

        expect(result).to.deep.include({
            fileName: 'Pet Store API.postman_collection.json',
            mimeType: 'application/json',
            encoding: 'utf8'
        });
        expectNoSecrets(result.content);
        expect(result.redactionReport).to.have.deep.members(EXPECTED_REPORT);

        // The placeholders become collection variables the receiver fills in
        const variables: Array<{ key: string, value: string }> = JSON.parse(result.content).variable;
        for (const name of ['authToken', 'cookie', 'apiKey', 'jwt']) {
            expect(variables).to.deep.include({ key: name, value: '', type: 'default' });
        }
    });

    it("keeps every secret out of a Bruno zip export, with secret variables left empty", async () => {
        const result = exportCollection(await collectionWithSecrets(), 'bruno');

        expect(result).to.deep.include({ fileName: 'Pet Store API.zip', mimeType: 'application/zip', encoding: 'base64' });
        expect(result.redactionReport).to.have.deep.members(EXPECTED_REPORT);

        const files = unzipToText(result.content);
        expect([...files.keys()]).to.include.members([
            'bruno.json', 'collection.bru', 'Pets/List pets.bru', 'environments/Production.bru'
        ]);
        for (const content of files.values()) expectNoSecrets(content);

        const environment = files.get('environments/Production.bru');
        expect(environment).to.include('baseUrl: https://api.petstore.test/v1');
        expect(environment).to.match(/vars:secret \[\s*clientSecret\s*\]/);
    });

    it("finds secrets by what they look like, anywhere", async () => {
        const collection = await collectionWithSecrets();
        const awsKey = 'AKIAIOSFODNN7EXAMPLE';
        const githubToken = `ghp_${'a1B2c3D4e5'.repeat(4)}`;
        const slackToken = 'xoxb-1234567890-abcdefghijkl';
        const privateKey = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\n-----END RSA PRIVATE KEY-----';

        const getPet = findItem(collection.items, 'Get pet');
        getPet.request!.docs = `Example: AWS key ${awsKey}`;
        getPet.request!.body = { mode: 'text', text: `${githubToken}\n${slackToken}\n${privateKey}` };

        const { collection: redacted, report } = redactCollection(collection);
        const request = findItem(redacted.items, 'Get pet').request!;

        expect(request.docs).to.equal('Example: AWS key {{awsAccessKeyId}}');
        expect(request.body?.text).to.equal('{{githubToken}}\n{{slackToken}}\n{{privateKey}}');
        expect(report.filter(({ location }) => location.startsWith('Pets / Get pet')).map(({ name }) => name))
            .to.have.members(['AWS access key', 'GitHub token', 'Slack token', 'private key']);
    });

    it("redacts key and token headers, URL passwords and secrets in saved responses", async () => {
        const collection = await collectionWithSecrets();
        const listPets = findItem(collection.items, 'List pets');
        listPets.request!.headers!.push(
            { name: 'X-Api-Key', value: 'x-api-key-secret', enabled: true },
            { name: 'X-Auth-Token', value: 'x-auth-token-secret', enabled: true },
            { name: 'Proxy-Authorization', value: 'Basic cHJveHk6c2VjcmV0', enabled: true },
            { name: 'Accept-Language', value: 'uz', enabled: true }
        );
        listPets.request!.url = 'https://admin:url-password-secret@api.petstore.test/pets?access_token=query-token-secret&page=2';
        listPets.examples![0].response!.headers!.push({ name: 'Set-Cookie', value: 'sid=set-cookie-secret; HttpOnly' });
        listPets.examples![0].response!.body!.content = '{"access_token": "response-token-secret", "token_type": "Bearer"}';

        const { collection: redacted } = redactCollection(collection);
        const request = findItem(redacted.items, 'List pets');

        expect(request.request?.headers?.map(({ name, value }) => [name, value])).to.deep.include.members([
            ['X-Api-Key', '{{apiKey}}'],
            // A different secret than the request's bearer token, which got {{authToken}}
            ['X-Auth-Token', '{{authToken2}}'],
            ['Proxy-Authorization', 'Basic {{proxyAuthorization}}'],
            ['Accept-Language', 'uz']
        ]);
        expect(request.request?.auth?.bearer).to.deep.equal({ token: '{{authToken}}' });
        expect(request.request?.url).to.equal(
            'https://admin:{{urlPassword}}@api.petstore.test/pets?access_token={{accessToken}}&page=2'
        );
        expect(request.examples?.[0].response?.headers?.find(({ name }) => name === 'Set-Cookie')?.value)
            .to.equal('{{setCookie}}');
        expect(request.examples?.[0].response?.body?.content)
            .to.equal('{"access_token": "{{accessToken2}}", "token_type": "Bearer"}');
    });

    it("gives the same secret the same variable everywhere", async () => {
        const collection = await collectionWithSecrets();
        findItem(collection.items, 'Get pet').request!.headers!.push(
            { name: 'Authorization', value: `Bearer ${SECRETS.bearerToken}`, enabled: true }
        );

        const { collection: redacted } = redactCollection(collection);
        expect(findItem(redacted.items, 'Get pet').request?.headers?.[0].value).to.equal('Bearer {{authToken}}');
    });

    it("tells secret names from ordinary ones", () => {
        for (const name of ['token', 'api_key', 'apiKey', 'X-Amz-Signature', 'client_secret', 'password', 'access_token', 'sig']) {
            expect(isSecretName(name), name).to.equal(true);
        }
        for (const name of ['limit', 'page', 'token_type', 'pageToken', 'public_key', 'keyword', 'zipcode', 'expires_in']) {
            expect(isSecretName(name), name).to.equal(false);
        }
    });
});

describe("Collection redaction of codes", function () {
    this.timeout(10000);

    const AUTH_CODE = 'SplxlOBeZQQYbYS6WxSbIA';

    // A collection with a single request, so each case reads on its own
    const collectionWith = (request: BrunoItem['request'], type = 'http-request'): BrunoCollection => ({
        version: '1',
        uid: 'codes',
        name: 'Codes',
        environments: [],
        items: [{ uid: 'request', type, name: 'Request', request }]
    });

    const redactedRequest = (request: BrunoItem['request'], type?: string) => {
        const { collection, report } = redactCollection(collectionWith(request, type));
        return { request: collection.items[0].request!, report };
    };

    it("keeps ordinary codes in GraphQL variables", () => {
        const variables = '{\n  "code": "UZ",\n  "first": 10\n}';
        const { request, report } = redactedRequest({
            url: 'https://countries.trevorblades.com/graphql',
            method: 'POST',
            body: {
                mode: 'graphql',
                graphql: { query: 'query ($code: ID!) { country(code: $code) { name } }', variables }
            }
        }, 'graphql-request');

        expect(request.body?.graphql?.variables).to.equal(variables);
        expect(report).to.deep.equal([]);
    });

    it("keeps ordinary codes in JSON bodies, saved responses, query and path parameters", () => {
        const collection = collectionWith({
            url: 'https://api.example.test/countries/:code?code=UZ&currency_code=UZS',
            method: 'POST',
            params: [
                { name: 'code', value: 'UZ', type: 'path', enabled: true },
                { name: 'code', value: 'UZ', type: 'query', enabled: true }
            ],
            body: { mode: 'json', json: '{"code": "UZ", "discount": {"code": "SPRING"}}' }
        });
        collection.items[0].examples = [{
            name: 'Not found',
            response: { status: 404, body: { type: 'json', content: { error: { code: 'NOT_FOUND' } } } }
        }];

        const { collection: redacted, report } = redactCollection(collection);
        const request = redacted.items[0].request!;

        expect(request.url).to.equal('https://api.example.test/countries/:code?code=UZ&currency_code=UZS');
        expect(request.params?.map(({ value }) => value)).to.deep.equal(['UZ', 'UZ']);
        expect(request.body?.json).to.equal('{"code": "UZ", "discount": {"code": "SPRING"}}');
        expect(redacted.items[0].examples?.[0].response?.body?.content)
            .to.deep.equal({ error: { code: 'NOT_FOUND' } });
        expect(report).to.deep.equal([]);
    });

    it("still redacts OAuth authorization codes", () => {
        // The redirect back from the authorization server
        const callback = redactedRequest({
            url: `https://app.example.test/oauth/callback?code=${AUTH_CODE}&state=af0ifjsldkj`,
            method: 'GET'
        });
        expect(callback.request.url).to.equal('https://app.example.test/oauth/callback?code={{authCode}}&state=af0ifjsldkj');

        // The token request, as a form
        const tokenForm = redactedRequest({
            url: 'https://auth.example.test/connect/endpoint',
            method: 'POST',
            body: {
                mode: 'formUrlEncoded',
                formUrlEncoded: [
                    { name: 'grant_type', value: 'authorization_code', enabled: true },
                    { name: 'code', value: AUTH_CODE, enabled: true },
                    { name: 'redirect_uri', value: 'https://app.example.test/cb', enabled: true }
                ]
            }
        });
        expect(tokenForm.request.body?.formUrlEncoded?.map(({ name, value }) => [name, value])).to.deep.equal([
            ['grant_type', 'authorization_code'],
            ['code', '{{authCode}}'],
            ['redirect_uri', 'https://app.example.test/cb']
        ]);

        // ...and as JSON
        const tokenJson = redactedRequest({
            url: 'https://auth.example.test/v1/exchange',
            method: 'POST',
            body: { mode: 'json', json: `{"grant_type": "authorization_code", "code": "${AUTH_CODE}"}` }
        });
        expect(tokenJson.request.body?.json).to.equal('{"grant_type": "authorization_code", "code": "{{authCode}}"}');

        // OAuth 2 settings' extra parameters are always about auth
        const oauthSettings = redactedRequest({
            url: 'https://api.example.test/me',
            method: 'GET',
            auth: {
                mode: 'oauth2',
                oauth2: { additionalParameters: { token: [{ name: 'code', value: AUTH_CODE, enabled: true }] } }
            }
        });
        expect((oauthSettings.request.auth?.oauth2?.additionalParameters as any).token[0].value).to.equal('{{authCode}}');

        for (const result of [callback, tokenForm, tokenJson, oauthSettings]) {
            expect(JSON.stringify(result.request)).to.not.include(AUTH_CODE);
            expect(result.report.map(({ name }) => name)).to.deep.equal(['code']);
        }
    });

    it("still redacts tokens, passwords, keys and client secrets next to ordinary codes", () => {
        const { request } = redactedRequest({
            url: 'https://api.example.test/graphql?api_key=key-secret-123',
            method: 'POST',
            headers: [{ name: 'Authorization', value: 'Bearer bearer-secret-456', enabled: true }],
            body: {
                mode: 'graphql',
                graphql: {
                    query: 'mutation { login }',
                    variables: '{"code": "UZ", "password": "hunter2-secret", "access_token": "token-secret-789", "clientId": "my-app"}'
                }
            }
        }, 'graphql-request');

        expect(request.url).to.equal('https://api.example.test/graphql?api_key={{apiKey}}');
        expect(request.headers?.[0].value).to.equal('Bearer {{authToken}}');
        expect(request.body?.graphql?.variables).to.equal(
            '{"code": "UZ", "password": "{{password}}", "access_token": "{{accessToken}}", "clientId": "my-app"}'
        );

        // A client secret is an OAuth parameter, so a code next to it is an authorization code
        const tokenRequest = redactedRequest({
            url: 'https://api.example.test/v1/exchange',
            method: 'POST',
            body: { mode: 'json', json: '{"clientSecret": "client-secret-000", "code": "one-time-code-111"}' }
        });
        expect(tokenRequest.request.body?.json).to.equal('{"clientSecret": "{{clientSecret}}", "code": "{{authCode}}"}');
    });

    it("treats names that say they're auth codes as secrets anywhere", () => {
        for (const name of ['auth_code', 'authCode', 'authorization_code', 'AuthorizationCode']) {
            expect(isSecretName(name), name).to.equal(true);
        }
        for (const name of ['code', 'country_code', 'countryCode', 'status_code', 'promo-code', 'zipcode']) {
            expect(isSecretName(name), name).to.equal(false);
        }
    });
});
