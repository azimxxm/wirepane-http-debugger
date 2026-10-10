import { expect } from 'chai';

import { importCollectionFile } from '../../src/collections/import';
import { collectionToFiles, filesToCollection } from '../../src/collections/bruno-folder';
import { exportCollection } from '../../src/collections/export';
import { flattenPostmanRequests, PostmanItem, readCollectionFixture } from './collections-fixtures';

interface PostmanCollection {
    info: { name: string, description?: string, schema: string };
    item: PostmanItem[];
    variable?: Array<{ key: string, value: string }>;
}

const summarise = (items: PostmanItem[]) => flattenPostmanRequests(items).map((item) => ({
    name: item.name,
    method: item.request?.method,
    url: item.request?.url.raw,
    docs: item.request?.description
}));

describe("Postman -> Bruno -> Postman round trip", function () {
    this.timeout(10000);

    let original: PostmanCollection;
    let exported: PostmanCollection;

    before(async () => {
        const content = readCollectionFixture('postman-v21.json');
        original = JSON.parse(content);

        const { collection } = await importCollectionFile({ fileName: 'pets.postman_collection.json', content });

        // Through the .bru files too, exactly as the collection is stored on disk
        const { collection: reloaded, warnings } = await filesToCollection(collectionToFiles(collection), collection.uid);
        expect(warnings).to.deep.equal([]);

        exported = JSON.parse(exportCollection(reloaded, 'postman').content);
    });

    it("produces a Postman Collection v2.1", () => {
        expect(exported.info.schema).to.equal('https://schema.getpostman.com/json/collection/v2.1.0/collection.json');
        expect(exported.info.name).to.equal(original.info.name);
    });

    it("keeps every request, with its method, URL and docs", () => {
        expect(flattenPostmanRequests(exported.item)).to.have.length(4);
        expect(summarise(exported.item)).to.deep.equal(summarise(original.item));
    });

    it("keeps the collection and folder docs", () => {
        expect(exported.info.description).to.equal(original.info.description);
        expect(exported.item.map(({ name, description }) => [name, description])).to.deep.equal([
            ['Pets', 'Everything about pets.'],
            ['Auth', undefined],
            ['Health check', undefined]
        ]);
    });

    it("keeps saved examples and collection variables", () => {
        const listPets = flattenPostmanRequests(exported.item).find((item) => item.name === 'List pets');
        expect(listPets?.response?.map(({ name, code, body }) => ({ name, code, body }))).to.deep.equal([
            { name: 'Two pets', code: 200, body: '[{"id": 1, "name": "Rex"}, {"id": 2, "name": "Tom"}]' }
        ]);

        const variables = new Map(exported.variable?.map(({ key, value }) => [key, value]));
        expect(variables.get('baseUrl')).to.equal('https://api.petstore.test/v1');
        expect(variables.get('petId')).to.equal('42');
    });

    it("splits URLs into Postman's parts without the query string in the path", () => {
        const listPets = flattenPostmanRequests(exported.item).find((item) => item.name === 'List pets');
        expect(listPets?.request?.url).to.deep.include({
            raw: '{{baseUrl}}/pets?limit=10',
            host: ['{{baseUrl}}'],
            path: ['pets'],
            query: [{ key: 'limit', value: '10' }]
        });
    });
});
