import * as _ from 'lodash';

import { expect } from '../../../test-setup';

import { BrunoCollection, BrunoItem } from '../../../../src/model/collections/collection-types';
import {
    buildUidRemap,
    findItem,
    listFolders,
    positionKeys,
    searchItems,
    uniqueName
} from '../../../../src/model/collections/collection-tree';
import { isEnvironmentFile } from '../../../../src/model/collections/collection-files';

const requestItem = (uid: string, name: string, url = `https://api.example.com/${name}`): BrunoItem => ({
    uid,
    type: 'http-request',
    name,
    request: { method: 'GET', url, headers: [], params: [] }
});

const folder = (uid: string, name: string, items: BrunoItem[]): BrunoItem => ({ uid, type: 'folder', name, items });

const collection = (items: BrunoItem[]): BrunoCollection => ({
    version: '1',
    uid: 'CCCCCCCCCCCCCCCCCCCCC',
    name: 'Shop',
    items,
    environments: []
});

// What the server sends back: uids from file paths, folders before requests
function asStoredByServer(sent: BrunoCollection): BrunoCollection {
    const restore = (items: BrunoItem[], path: string): BrunoItem[] => {
        const folders = items.filter((item) => item.type === 'folder');
        const files = items.filter((item) => item.type !== 'folder' && item.type !== 'js');
        return [
            ...folders.map((item) => ({ ...item, uid: `${path}/${item.name}/`, items: restore(item.items ?? [], `${path}/${item.name}`) })),
            ...files.map((item) => ({ ...item, uid: `${path}/${item.name}.bru` }))
        ];
    };
    return { ...sent, items: restore(sent.items, '') };
}

describe("Collection trees", () => {

    it("give each item a position key in the order the server stores them", () => {
        const items = [
            requestItem('r1', 'Health'),
            folder('f1', 'Users', [requestItem('r2', 'List'), folder('f2', 'Admin', []), requestItem('r3', 'Get')]),
            { uid: 'js', type: 'js', name: 'helpers' },
            folder('f3', 'Orders', [])
        ];

        expect(_.fromPairs([...positionKeys(items)])).to.deep.equal({
            r1: 'r0',
            f1: 'f0',
            r2: 'f0/r0',
            f2: 'f0/f0',
            r3: 'f0/r1',
            f3: 'f1'
        });
    });

    it("map uids to the server's after renames, additions and deletions", () => {
        const sent = collection([
            requestItem('health', 'Health'),
            folder('users', 'Users', [requestItem('list', 'List users (renamed)'), requestItem('added', 'Create user')]),
            folder('orders', 'Orders', [])
        ]);
        const received = asStoredByServer(sent);
        const remap = buildUidRemap(sent, received);

        expect(remap('health')).to.equal('/Health.bru');
        expect(remap('users')).to.equal('/Users/');
        expect(remap('list')).to.equal('/Users/List users (renamed).bru');
        expect(remap('added')).to.equal('/Users/Create user.bru');
        expect(remap('orders')).to.equal('/Orders/');
        expect(remap('deleted-before-saving')).to.equal(undefined);
    });

    it("find items with their folders", () => {
        const tree = collection([folder('f1', 'Users', [folder('f2', 'Admin', [requestItem('r1', 'Ban')])])]);
        const location = findItem(tree, 'r1')!;

        expect(location.parents.map((parent) => parent.name)).to.deep.equal(['Users', 'Admin']);
        expect(location.siblings).to.equal(tree.items[0].items![0].items);
        expect(listFolders(tree)).to.deep.equal([
            { uid: 'f1', label: 'Users' },
            { uid: 'f2', label: 'Users / Admin' }
        ]);
    });

    it("number repeated names", () => {
        expect(uniqueName('GET /users', ['GET /posts'])).to.equal('GET /users');
        expect(uniqueName('GET /users', ['get /users', 'GET /users (2)'])).to.equal('GET /users (3)');
        expect(uniqueName('  ', [])).to.equal('Untitled');
    });

    it("search requests by name, method and URL, keeping their folders", () => {
        const tree = collection([
            folder('f1', 'Users', [requestItem('r1', 'List users', 'https://api.example.com/users')]),
            requestItem('r2', 'Health', 'https://api.example.com/health')
        ]);

        expect(_.sortBy([...searchItems(tree, 'users')!])).to.deep.equal(['f1', 'r1']);
        expect([...searchItems(tree, 'get health')!]).to.deep.equal(['r2']);
        expect(searchItems(tree, 'nothing')!.size).to.equal(0);
        expect(searchItems(tree, '   ')).to.equal(undefined);
    });

    it("tell environment files apart from collections, like the server", () => {
        const file = (fileName: string, content: unknown) => ({
            fileName,
            content: typeof content === 'string' ? content : JSON.stringify(content),
            encoding: 'utf8' as const
        });

        expect(isEnvironmentFile(file('dev.json', { name: 'Dev', values: [], _postman_variable_scope: 'environment' }))).to.equal(true);
        expect(isEnvironmentFile(file('api.json', { info: { name: 'API' }, item: [] }))).to.equal(false);
        expect(isEnvironmentFile(file('dev.bru', 'vars {\n  baseUrl: https://dev\n}\n'))).to.equal(true);
        expect(isEnvironmentFile(file('get.bru', 'meta {\n  name: Get\n}\nvars {\n  a: b\n}\n'))).to.equal(false);
        expect(isEnvironmentFile(file('api.yaml', 'openapi: 3.0.0\n'))).to.equal(false);
        expect(isEnvironmentFile({ fileName: 'c.zip', content: 'UEsDB', encoding: 'base64' })).to.equal(false);
    });
});
