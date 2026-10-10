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
        for (const name of ['token', 'api_key', 'apiKey', 'X-Amz-Signature', 'client_secret', 'password', 'code', 'access_token', 'sig']) {
            expect(isSecretName(name), name).to.equal(true);
        }
        for (const name of ['limit', 'page', 'token_type', 'pageToken', 'public_key', 'keyword', 'zipcode', 'expires_in']) {
            expect(isSecretName(name), name).to.equal(false);
        }
    });
});
