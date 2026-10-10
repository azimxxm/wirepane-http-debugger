import { expect } from 'chai';

import { importCollectionFile } from '../../src/collections/import';
import { collectionToFiles } from '../../src/collections/bruno-folder';
import { filesToZip } from '../../src/collections/folder-storage';
import { BrunoCollection, BrunoItem } from '../../src/collections/bruno-types';
import { readCollectionFixture } from './collections-fixtures';

const requestsOf = (items: BrunoItem[]): BrunoItem[] =>
    items.flatMap((item) => item.type === 'folder' ? requestsOf(item.items ?? []) : [item]);

const importPostmanFixture = async () => (await importCollectionFile({
    fileName: 'Pet Store API.postman_collection.json',
    content: readCollectionFixture('postman-v21.json')
})).collection;

describe("Collection import", function () {
    this.timeout(10000); // The first test pays for loading Bruno's packages

    it("imports a Postman v2.1 collection with folders, auth, variables, docs and examples", async () => {
        const { format, collection, warnings } = await importCollectionFile({
            fileName: 'Pet Store API.postman_collection.json',
            content: readCollectionFixture('postman-v21.json')
        });

        expect(format).to.equal('postman');
        expect(warnings).to.deep.equal([]);
        expect(collection.name).to.equal('Pet Store API');
        expect(collection.root?.docs).to.equal(
            'Pet Store backend for the mobile and web apps.\n\nSet `baseUrl` in your environment.'
        );
        expect(collection.root?.request?.auth?.mode).to.equal('bearer');
        expect(collection.root?.request?.auth?.bearer).to.deep.equal({ token: '{{authToken}}' });
        expect(collection.root?.request?.vars?.req?.map(({ name, value }) => [name, value])).to.deep.equal([
            ['baseUrl', 'https://api.petstore.test/v1'],
            ['petId', '42']
        ]);

        expect(collection.items.map(({ type, name }) => [type, name])).to.deep.equal([
            ['folder', 'Pets'],
            ['folder', 'Auth'],
            ['http-request', 'Health check']
        ]);

        const [pets, , healthCheck] = collection.items;
        expect(pets.root?.docs).to.equal('Everything about pets.');

        const listPets = pets.items?.[0];
        expect(listPets?.request).to.deep.include({
            method: 'GET',
            url: '{{baseUrl}}/pets?limit=10',
            docs: 'Returns all pets, newest first.'
        });
        expect(listPets?.examples?.map(({ name, response }) => [name, response?.status, response?.body?.content])).to.deep.equal([
            ['Two pets', 200, '[{"id": 1, "name": "Rex"}, {"id": 2, "name": "Tom"}]']
        ]);

        expect(healthCheck.request?.auth?.mode).to.equal('basic');
        expect(healthCheck.request?.auth?.basic).to.deep.equal({ username: 'admin', password: '{{adminPassword}}' });
    });

    it("imports an OpenAPI 3 spec written in YAML", async () => {
        const { format, collection } = await importCollectionFile({
            fileName: 'todo-api.yaml',
            content: readCollectionFixture('openapi-3.yaml')
        });

        expect(format).to.equal('openapi');
        expect(collection.name).to.equal('Tiny Todo API');
        expect(collection.root?.docs).to.equal('A tiny todo API used by the collection import tests.');

        const todos = collection.items[0];
        expect(todos).to.deep.include({ type: 'folder', name: 'Todos' });
        expect(requestsOf(collection.items).map(({ request }) => `${request?.method} ${request?.url}`)).to.deep.equal([
            'GET {{baseUrl}}/todos',
            'POST {{baseUrl}}/todos',
            'GET {{baseUrl}}/todos/:id'
        ]);

        expect(collection.environments).to.have.length(1);
        expect(collection.environments[0].variables.map(({ name, value }) => [name, value])).to.deep.equal([
            ['baseUrl', 'https://todo.example.test/api']
        ]);
    });

    it("imports a HAR file as one folder per host, keeping each response as an example", async () => {
        const { format, collection, warnings } = await importCollectionFile({
            fileName: 'traffic.har',
            content: readCollectionFixture('traffic.har')
        });

        expect(format).to.equal('har');
        expect(warnings).to.deep.equal([]);
        expect(collection.name).to.equal('traffic');
        expect(collection.items.map((folder) => [folder.name, folder.items?.map((item) => item.name)])).to.deep.equal([
            ['api.example.test', ['GET /users', 'POST /users']],
            ['cdn.example.test', ['GET /logo.png']]
        ]);

        const [listUsers, createUser] = collection.items[0].items ?? [];
        expect(listUsers.request?.url).to.equal('https://api.example.test/users?page=1');
        expect(listUsers.request?.params?.map(({ name, value, type }) => [name, value, type])).to.deep.equal([
            ['page', '1', 'query']
        ]);
        // Host is derived from the URL, so it isn't kept as a header
        expect(listUsers.request?.headers?.map(({ name }) => name)).to.deep.equal(['Accept', 'Authorization']);

        expect(createUser.request?.body).to.deep.include({ mode: 'json', json: '{"name":"Vali"}' });
        expect(createUser.examples?.[0]).to.deep.include({ name: '201 Created' });
        expect(createUser.examples?.[0].response?.body).to.deep.equal({
            type: 'json',
            content: '{"id":2,"name":"Vali"}'
        });

        const logo = collection.items[1].items?.[0];
        expect(logo?.request?.headers?.map(({ name }) => name)).to.deep.equal(['accept']); // No :authority
        expect(logo?.examples?.[0].response?.body).to.deep.equal({ type: 'binary', content: 'iVBORw0KGgo=' });
    });

    it("adds a Postman environment to an existing collection", async () => {
        const target = await importPostmanFixture();
        const environment = JSON.stringify({
            name: 'Staging',
            _postman_variable_scope: 'environment',
            values: [
                { key: 'baseUrl', value: 'https://staging.petstore.test', type: 'default', enabled: true },
                { key: 'authToken', value: 'staging-token', type: 'secret', enabled: true }
            ]
        });

        const { format, collection } = await importCollectionFile(
            { fileName: 'Staging.postman_environment.json', content: environment },
            { into: target }
        );

        expect(format).to.equal('postman-environment');
        expect(collection.uid).to.equal(target.uid);
        expect(collection.environments.map(({ name }) => name)).to.deep.equal(['Staging']);
        expect(collection.environments[0].variables.map(({ name, secret }) => [name, secret])).to.deep.equal([
            ['baseUrl', false],
            ['authToken', true]
        ]);
    });

    it("refuses an environment file without a collection to add it to", async () => {
        const environment = JSON.stringify({ name: 'Staging', _postman_variable_scope: 'environment', values: [] });

        const error = await importCollectionFile({ fileName: 'Staging.json', content: environment }).catch((e) => e);
        expect(error.statusCode).to.equal(400);
        expect(error.message).to.include('is an environment, not a collection');
    });

    it("imports an Insomnia v4 export without duplicating requests in folders", async () => {
        const insomnia = JSON.stringify({
            _type: 'export',
            __export_format: 4,
            resources: [
                { _id: 'wrk_1', _type: 'workspace', name: 'Shop', parentId: null },
                { _id: 'fld_1', _type: 'request_group', name: 'Orders', parentId: 'wrk_1' },
                {
                    _id: 'req_1', _type: 'request', parentId: 'fld_1', name: 'List orders',
                    method: 'GET', url: 'https://shop.example.test/orders', headers: [], parameters: [], body: {}
                },
                {
                    _id: 'req_2', _type: 'request', parentId: 'fld_1', name: 'Get order',
                    method: 'GET', url: 'https://shop.example.test/orders/1', headers: [], parameters: [], body: {}
                }
            ]
        });

        const { format, collection } = await importCollectionFile({ fileName: 'shop.json', content: insomnia });

        expect(format).to.equal('insomnia');
        expect(collection.name).to.equal('Shop');
        expect(collection.items.map((folder) => [folder.name, folder.items?.map((item) => item.name)])).to.deep.equal([
            ['Orders', ['List orders', 'Get order']]
        ]);
    });

    it("imports a single .bru request file", async () => {
        const bru = [
            'meta {', '  name: Get profile', '  type: http', '  seq: 1', '}', '',
            'get {', '  url: https://api.example.test/me', '  body: none', '  auth: none', '}', '',
            'docs {', '  Returns the signed-in user.', '}', ''
        ].join('\n');

        const { format, collection } = await importCollectionFile({ fileName: 'Get profile.bru', content: bru });

        expect(format).to.equal('bruno-request');
        expect(collection.name).to.equal('Get profile');
        expect(collection.items[0].request).to.deep.include({
            method: 'GET',
            url: 'https://api.example.test/me',
            docs: 'Returns the signed-in user.'
        });
    });

    it("imports a zipped Bruno collection, with or without a top-level folder", async () => {
        const source = await importPostmanFixture();
        const files = collectionToFiles(source);
        const nestedFiles = new Map([...files].map(([filePath, content]) => [`Pet Store API/${filePath}`, content]));

        for (const zipFiles of [files, nestedFiles]) {
            const { format, collection } = await importCollectionFile({
                fileName: 'Pet Store API.zip',
                content: filesToZip(zipFiles).toString('base64'),
                encoding: 'base64'
            });

            expect(format).to.equal('bruno-zip');
            expect(collection.name).to.equal('Pet Store API');
            expect(requestsOf(collection.items).map((item) => item.name)).to.deep.equal(
                requestsOf(source.items).map((item) => item.name)
            );
        }
    });

    it("rejects files it can't recognise, with a helpful message", async () => {
        const error = await importCollectionFile({ fileName: 'notes.txt', content: 'just some notes' }).catch((e) => e);
        expect(error.statusCode).to.equal(400);
        expect(error.message).to.include("Couldn't recognise the format of notes.txt");

        const v1 = JSON.stringify({ id: '1', name: 'Old', requests: [], order: [] });
        const v1Error = await importCollectionFile({ fileName: 'old.json', content: v1 }).catch((e) => e);
        expect(v1Error.message).to.include('Postman Collection v1');
    });

    it("gives every imported collection a fresh id", async () => {
        const first: BrunoCollection = await importPostmanFixture();
        const second: BrunoCollection = await importPostmanFixture();

        expect(first.uid).to.match(/^[A-Za-z0-9]{21}$/);
        expect(first.uid).to.not.equal(second.uid);
    });
});
