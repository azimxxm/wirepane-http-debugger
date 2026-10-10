import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as _ from 'lodash';
import { expect } from 'chai';

import { CollectionsService } from '../../src/collections/collections-service';
import { collectionToFiles, filesToCollection } from '../../src/collections/bruno-folder';
import { importCollectionFile } from '../../src/collections/import';
import { newUid } from '../../src/collections/collection-model';
import { BrunoCollection, BrunoItem } from '../../src/collections/bruno-types';
import { readCollectionFixture } from './collections-fixtures';

const listFiles = (dir: string, relativeDir = ''): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
        return entry.isDirectory()
            ? listFiles(path.join(dir, entry.name), relativePath)
            : [relativePath];
    }).sort();

// The parts a user cares about, without generated uids
const describeItems = (items: BrunoItem[]): unknown[] => items.map((item) => item.type === 'folder'
    ? { folder: item.name, docs: item.root?.docs, items: describeItems(item.items ?? []) }
    : {
        request: item.name,
        method: item.request?.method,
        url: item.request?.url,
        docs: item.request?.docs,
        auth: _.omitBy(item.request?.auth, _.isNil),
        headers: item.request?.headers?.map(({ name, value }) => [name, value]),
        examples: (item.examples ?? []).map(({ name, response }) => [name, response?.status, response?.body?.content])
    });

describe("Collection storage", function () {
    this.timeout(10000);

    let configPath: string;
    let service: CollectionsService;
    let pets: BrunoCollection;

    beforeEach(async () => {
        configPath = fs.mkdtempSync(path.join(os.tmpdir(), 'wirepane-collections-test-'));
        service = new CollectionsService(configPath);
        pets = (await importCollectionFile({
            fileName: 'pets.postman_collection.json',
            content: readCollectionFixture('postman-v21.json')
        })).collection;
    });

    afterEach(() => {
        fs.rmSync(configPath, { recursive: true, force: true });
    });

    it("saves a collection as a Bruno folder of .bru files", async () => {
        await service.save(pets.uid, pets);

        const collectionDir = path.join(configPath, 'collections', pets.uid);
        expect(listFiles(collectionDir)).to.deep.equal([
            'Auth/Login.bru',
            'Auth/folder.bru',
            'Health check.bru',
            'Pets/Get pet.bru',
            'Pets/List pets.bru',
            'Pets/folder.bru',
            'bruno.json',
            'collection.bru'
        ]);

        expect(JSON.parse(fs.readFileSync(path.join(collectionDir, 'bruno.json'), 'utf8'))).to.deep.equal({
            version: '1',
            name: 'Pet Store API',
            type: 'collection',
            ignore: ['node_modules', '.git']
        });

        const listPets = fs.readFileSync(path.join(collectionDir, 'Pets', 'List pets.bru'), 'utf8');
        expect(listPets).to.include('url: {{baseUrl}}/pets?limit=10');
        expect(listPets).to.include('Returns all pets, newest first.');
        expect(listPets).to.include('name: Two pets');
    });

    it("loads a saved collection back with the same folders, requests, docs and examples", async () => {
        const saved = await service.save(pets.uid, pets);
        const { collection: loaded, warnings } = await service.get(pets.uid);

        expect(warnings).to.deep.equal([]);
        expect(loaded).to.deep.equal(saved.collection);
        expect(loaded.uid).to.equal(pets.uid);
        expect(loaded.name).to.equal('Pet Store API');
        expect(loaded.root?.docs).to.equal(pets.root?.docs);
        expect(loaded.root?.request?.vars?.req?.map(({ name, value }) => [name, value]))
            .to.deep.equal(pets.root?.request?.vars?.req?.map(({ name, value }) => [name, value]));
        expect(describeItems(loaded.items)).to.deep.equal(describeItems(pets.items));
    });

    it("gives the same uids every time an unchanged collection is read", async () => {
        await service.save(pets.uid, pets);

        const first = await service.get(pets.uid);
        const second = await service.get(pets.uid);
        expect(second.collection).to.deep.equal(first.collection);
    });

    it("leaves every file as it was when an unchanged collection is saved again", async () => {
        const collectionDir = path.join(configPath, 'collections', pets.uid);
        const readAll = () => listFiles(collectionDir).map((file) => [file, fs.readFileSync(path.join(collectionDir, file), 'utf8')]);
        const resave = async () => service.save(pets.uid, (await service.get(pets.uid)).collection);

        // Bruno's .bru parser fills in default request settings (timeout: 0) the first time
        // it reads a file, so the first re-save can add those. From then on, nothing changes.
        await service.save(pets.uid, pets);
        await resave();
        const before = readAll();

        await resave();
        expect(readAll()).to.deep.equal(before);
    });

    it("lists, updates and deletes collections", async () => {
        expect(await service.list()).to.deep.equal([]);
        await service.save(pets.uid, pets);

        const [summary] = await service.list();
        expect(_.omit(summary, 'updatedAt')).to.deep.equal({
            id: pets.uid,
            name: 'Pet Store API',
            requestCount: 4,
            environmentCount: 0
        });
        expect(Date.parse(summary.updatedAt)).to.be.closeTo(Date.now(), 60_000);

        const { collection } = await service.get(pets.uid);
        collection.name = 'Renamed API';
        collection.items = collection.items.filter((item) => item.name !== 'Health check');
        await service.save(pets.uid, collection);

        expect((await service.list()).map(({ name, requestCount }) => [name, requestCount])).to.deep.equal([
            ['Renamed API', 3]
        ]);
        expect(listFiles(path.join(configPath, 'collections', pets.uid))).to.not.include('Health check.bru');

        await service.delete(pets.uid);
        expect(await service.list()).to.deep.equal([]);
        expect(fs.existsSync(path.join(configPath, 'collections', pets.uid))).to.equal(false);
    });

    it("keeps secret environment values out of the collection folder but restores them on load", async () => {
        const secretValue = 'local-only-secret-value';
        pets.environments = [{
            name: 'Production',
            variables: [
                { name: 'baseUrl', value: 'https://api.petstore.test/v1', type: 'text', enabled: true, secret: false },
                { name: 'authToken', value: secretValue, type: 'text', enabled: true, secret: true }
            ]
        }];
        await service.save(pets.uid, pets);

        const collectionDir = path.join(configPath, 'collections', pets.uid);
        const environmentFile = fs.readFileSync(path.join(collectionDir, 'environments', 'Production.bru'), 'utf8');
        expect(environmentFile).to.include('vars:secret [');
        for (const file of listFiles(collectionDir)) {
            expect(fs.readFileSync(path.join(collectionDir, file), 'utf8')).to.not.include(secretValue);
        }

        const secretsFile = path.join(configPath, 'collection-secrets', `${pets.uid}.json`);
        expect(fs.readFileSync(secretsFile, 'utf8')).to.include(secretValue);
        if (process.platform !== 'win32') {
            expect(fs.statSync(secretsFile).mode & 0o777).to.equal(0o600);
        }

        const { collection } = await service.get(pets.uid);
        expect(collection.environments[0].variables.map(({ name, value, secret }) => [name, value, secret])).to.deep.equal([
            ['baseUrl', 'https://api.petstore.test/v1', false],
            ['authToken', secretValue, true]
        ]);

        await service.delete(pets.uid);
        expect(fs.existsSync(secretsFile)).to.equal(false);
    });

    it("restores secrets of environments whose names aren't valid file names", async () => {
        pets.environments = [{
            name: 'Prod/EU',
            variables: [{ name: 'apiKey', value: 'eu-secret', type: 'text', enabled: true, secret: true }]
        }];

        const saved = await service.save(pets.uid, pets);
        expect(saved.collection.environments.map(({ name }) => name)).to.deep.equal(['Prod-EU']);
        expect(saved.collection.environments[0].variables[0].value).to.equal('eu-secret');
    });

    it("stores items with the same name in separate files", async () => {
        const request = pets.items.find((item) => item.name === 'Health check');
        pets.items = [..._.cloneDeep(pets.items), { ..._.cloneDeep(request!), uid: undefined, name: 'Health check' }];
        await service.save(pets.uid, pets);

        const files = listFiles(path.join(configPath, 'collections', pets.uid));
        expect(files).to.include.members(['Health check.bru', 'Health check (2).bru']);

        const { collection } = await service.get(pets.uid);
        expect(collection.items.filter((item) => item.name === 'Health check')).to.have.length(2);
    });

    it("reads requests with very large bodies and docs quickly", async () => {
        // Parsed naively, Bruno's grammar would need several GB of memory for this file
        const largeJson = JSON.stringify({ items: 'x'.repeat(2 * 1024 * 1024) });
        const largeDocs = 'Long docs line\n'.repeat(20_000);
        const login = pets.items.find((item) => item.name === 'Auth')!.items![0];
        login.request!.body = { mode: 'json', json: largeJson };
        login.request!.docs = largeDocs;

        const started = Date.now();
        await service.save(pets.uid, pets);
        const { collection, warnings } = await service.get(pets.uid);

        expect(warnings).to.deep.equal([]);
        const loadedLogin = collection.items.find((item) => item.name === 'Auth')!.items![0];
        expect(loadedLogin.request?.body?.json).to.equal(largeJson);
        expect(loadedLogin.request?.docs).to.equal(largeDocs);
        expect(Date.now() - started).to.be.below(5000);
    });

    it("shortens very large saved examples, and says so", async () => {
        const listPets = pets.items[0].items![0];
        const hugeBody = JSON.stringify({ data: 'y'.repeat(200 * 1024) });
        const [example] = listPets.examples!;
        example.response!.body!.content = hugeBody;
        listPets.examples!.push({ ..._.cloneDeep(example), uid: undefined, name: 'Empty list', response: {
            ...example.response, body: { type: 'json', content: '[]' }
        } });

        const saved = await service.save(pets.uid, pets);
        expect(saved.warnings).to.deep.equal([
            'The saved example "Two pets" of Pets / List pets was shortened: examples keep up to 64 KB of body text per request'
        ]);

        const [savedHuge, savedSmall] = saved.collection.items[0].items![0].examples!;
        const content = savedHuge.response!.body!.content as string;
        expect(content.startsWith(hugeBody.slice(0, 1000))).to.equal(true);
        expect(content.length).to.be.below(65 * 1024);
        expect(content).to.match(/shortened by Wirepane, the full text was 201 KB$/);
        expect(savedSmall.response!.body!.content).to.equal('[]'); // Small texts are always kept
    });

    it("skips files too large to read safely, and still loads the rest", async () => {
        const files = collectionToFiles(pets);
        const bigExample = pets.items[0].items![0];
        bigExample.examples![0].response!.body!.content = 'z'.repeat(300 * 1024);
        files.set('Pets/List pets.bru', collectionToFiles(pets).get('Pets/List pets.bru')!);

        const { collection, warnings } = await filesToCollection(files, pets.uid);

        expect(warnings).to.have.length(1);
        expect(warnings[0]).to.match(/^Skipped Pets\/List pets\.bru: it has .* of text outside bodies and docs/);
        expect(collection.items[0].items!.map((item) => item.name)).to.deep.equal(['Get pet']);
    });

    it("rejects invalid ids and invalid collections", async () => {
        const badId = await service.save('../escape', pets).catch((e) => e);
        expect(badId.statusCode).to.equal(400);

        const noName = await service.save(newUid(), { items: [] }).catch((e) => e);
        expect(noName.statusCode).to.equal(400);

        const badItem = await service.save(newUid(), { name: 'Broken', items: [{ type: 'http-request' }] }).catch((e) => e);
        expect(badItem.statusCode).to.equal(400);
        expect(badItem.message).to.include('Invalid collection');

        expect(fs.existsSync(path.join(configPath, 'collections'))).to.equal(false);
    });

    it("reports unknown collections as not found", async () => {
        const id = newUid();
        expect((await service.get(id).catch((e) => e)).statusCode).to.equal(404);
        expect((await service.delete(id).catch((e) => e)).statusCode).to.equal(404);
    });
});
