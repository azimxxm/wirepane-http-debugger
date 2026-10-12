import { expect } from '../../../test-setup';

import { BrunoItem, BrunoRequest } from '../../../../src/model/collections/collection-types';
import {
    itemToRequestParts,
    RequestParts,
    requestPartsToItem
} from '../../../../src/model/collections/request-mapping';
import { isSameSnapshot, snapshotOf } from '../../../../src/model/collections/tab-snapshots';
import { QueryParam, SendExtras, SendExtrasData } from '../../../../src/model/send/send-extras';
import { getQueryParams, withQueryParams } from '../../../../src/model/send/params/query-params';
import { withPathParamValue } from '../../../../src/model/send/params/path-params';

/**
 * The Params tab's state in collections: disabled query params and path params, when opening
 * an item into a tab and when saving the tab back.
 */

const UID = 'AAAAAAAAAAAAAAAAAAAA1';

function httpItem(request: Partial<BrunoRequest>): BrunoItem {
    return {
        uid: UID,
        type: 'http-request',
        name: 'List todos',
        seq: 1,
        request: {
            method: 'GET',
            url: 'https://api.example.com/todos',
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
        }
    };
}

const open = (item: BrunoItem) => itemToRequestParts(item).parts;
const save = (parts: RequestParts, base: BrunoItem) => requestPartsToItem(parts, '', base, { name: base.name }).item;

// A Params tab edit on opened parts: the rows it shows change, and the URL follows
function editParams(parts: RequestParts, change: (rows: QueryParam[]) => QueryParam[]): RequestParts {
    const rows = change([...getQueryParams(parts.url, parts.extras?.queryParams)]);
    return { ...parts, url: withQueryParams(parts.url, rows), extras: { ...parts.extras!, queryParams: rows } };
}

const withExtras = (parts: RequestParts, extras: Partial<SendExtrasData>): RequestParts =>
    ({ ...parts, extras: { ...(parts.extras ?? new SendExtras().toData()), ...extras } });

describe("Collection requests in the Params tab", () => {

    // The URL has the enabled params, in their order
    const listTodos = httpItem({
        url: '{{baseUrl}}/todos?limit=10&sort=due',
        params: [
            { uid: 'p1', name: 'limit', value: '10', enabled: true, type: 'query', description: 'Page size' },
            { uid: 'p2', name: 'done', value: 'true', enabled: false, type: 'query' },
            { uid: 'p3', name: 'sort', value: 'due', enabled: true, type: 'query' }
        ]
    });

    describe("opening an item", () => {
        it("shows its disabled query params in their place", () => {
            const parts = open(listTodos);
            expect(parts.url).to.equal('{{baseUrl}}/todos?limit=10&sort=due');
            expect(getQueryParams(parts.url, parts.extras!.queryParams).map((row) => [row.name, row.value, row.enabled]))
                .to.deep.equal([['limit', '10', true], ['done', 'true', false], ['sort', 'due', true]]);
        });

        it("keeps the tab state small for items without disabled params or path params", () => {
            const { extras } = open(httpItem({ url: 'https://api.example.com/todos?limit=10' }));
            expect(extras).not.to.have.property('queryParams');
            expect(extras).not.to.have.property('pathTemplate');
        });

        it("remembers the path that :name params fill in", () => {
            const parts = open(httpItem({
                url: '{{baseUrl}}/users/:userId/todos/:id',
                params: [{ name: 'userId', value: '{{me}}', enabled: true, type: 'path' }]
            }));
            expect(parts.url).to.equal('{{baseUrl}}/users/{{me}}/todos/:id');
            expect(parts.extras!.pathTemplate).to.equal('{{baseUrl}}/users/:userId/todos/:id');
        });
    });

    describe("saving a tab", () => {
        it("gives back the same item when nothing changed", () => {
            expect(save(open(listTodos), listTodos)).to.deep.equal(listTodos);
        });

        it("saves params that were unticked as disabled, in their place", () => {
            const parts = editParams(open(listTodos), (rows) =>
                rows.map((row) => row.name === 'limit' ? { ...row, enabled: false } : row)
            );
            expect(parts.url).to.equal('{{baseUrl}}/todos?sort=due');

            const item = save(parts, listTodos);
            expect(item.request!.url).to.equal('{{baseUrl}}/todos?sort=due');
            expect(item.request!.params).to.deep.equal([
                { uid: 'p1', description: 'Page size', name: 'limit', value: '10', enabled: false, type: 'query' },
                { uid: 'p2', name: 'done', value: 'true', enabled: false, type: 'query' },
                { uid: 'p3', name: 'sort', value: 'due', enabled: true, type: 'query' }
            ]);
        });

        it("saves ticked params as enabled, and drops removed ones", () => {
            const ticked = editParams(open(listTodos), (rows) => rows.map((row) => ({ ...row, enabled: true })));
            expect(save(ticked, listTodos).request!.params!.map((param) => [param.name, param.enabled])).to.deep.equal([
                ['limit', true], ['done', true], ['sort', true]
            ]);
            expect(save(ticked, listTodos).request!.url).to.equal('{{baseUrl}}/todos?limit=10&done=true&sort=due');

            // A removed disabled param leaves the URL as it was, but not the item
            const removed = editParams(open(listTodos), (rows) => rows.filter((row) => row.name !== 'done'));
            expect(removed.url).to.equal('{{baseUrl}}/todos?limit=10&sort=due');
            expect(save(removed, listTodos).request!.params!.map((param) => param.name)).to.deep.equal(['limit', 'sort']);
        });

        it("saves disabled params as typed, and sent ones as written in the URL", () => {
            const parts = editParams(open(listTodos), (rows) => [
                ...rows,
                { name: 'q', value: 'a&b', enabled: true },
                { name: 'tag', value: 'x#y', enabled: false }
            ]);
            const params = save(parts, listTodos).request!.params!;
            expect(params.slice(3)).to.deep.equal([
                { name: 'q', value: 'a%26b', enabled: true, type: 'query' },
                { name: 'tag', value: 'x#y', enabled: false, type: 'query' }
            ]);
        });

        it("keeps a path template when its values are edited, in the table or the URL", () => {
            const base = httpItem({
                url: '{{baseUrl}}/todos/:id?verbose=true',
                params: [
                    { uid: 'q1', name: 'verbose', value: 'true', enabled: true, type: 'query' },
                    { uid: 'p1', name: 'id', value: '1', enabled: true, type: 'path', description: 'Todo id' }
                ]
            });
            const opened = open(base);
            expect(opened.url).to.equal('{{baseUrl}}/todos/1?verbose=true');

            // Filled in from the Params tab
            const filledIn = withPathParamValue(opened.url, opened.extras!.pathTemplate, 0, '2');
            expect(filledIn.url).to.equal('{{baseUrl}}/todos/2?verbose=true');
            const saved = save(withExtras({ ...opened, url: filledIn.url }, { pathTemplate: filledIn.template }), base);
            expect(saved.request!.url).to.equal('{{baseUrl}}/todos/:id?verbose=true');
            expect(saved.request!.params).to.deep.equal([
                { uid: 'q1', name: 'verbose', value: 'true', enabled: true, type: 'query' },
                { uid: 'p1', name: 'id', value: '2', enabled: true, type: 'path', description: 'Todo id' }
            ]);

            // ...or typed in the URL field
            expect(save({ ...opened, url: '{{baseUrl}}/todos/2?verbose=true' }, base)).to.deep.equal(saved);

            // Editing only the query used to lose the template, as the URL no longer matched the item's
            const queryEdited = save({ ...opened, url: '{{baseUrl}}/todos/1?verbose=false' }, base);
            expect(queryEdited.request!.url).to.equal('{{baseUrl}}/todos/:id?verbose=false');
            expect(queryEdited.request!.params!.find((param) => param.type === 'path')).to.deep.equal(
                { uid: 'p1', name: 'id', value: '1', enabled: true, type: 'path', description: 'Todo id' }
            );
        });

        it("drops a path template once the path has another shape", () => {
            const base = httpItem({
                url: '{{baseUrl}}/todos/:id',
                params: [{ uid: 'p1', name: 'id', value: '1', enabled: true, type: 'path' }]
            });
            const item = save({ ...open(base), url: '{{baseUrl}}/todos/1/comments' }, base);
            expect(item.request!.url).to.equal('{{baseUrl}}/todos/1/comments');
            expect(item.request!.params).to.deep.equal([]);
        });

        it("saves path params filled in on a new request", () => {
            const parts: RequestParts = {
                method: 'GET',
                url: 'https://api.example.com/users/42',
                headers: [],
                body: Buffer.alloc(0),
                contentType: 'text',
                extras: new SendExtras({ pathTemplate: 'https://api.example.com/users/:id' }).toData()
            };
            const { item } = requestPartsToItem(parts, '', undefined, { name: 'Get user' });
            expect(item.request!.url).to.equal('https://api.example.com/users/:id');
            expect(item.request!.params).to.deep.equal([{ name: 'id', value: '42', enabled: true, type: 'path' }]);
        });
    });

    describe("unsaved changes", () => {
        const snapshot = (parts: RequestParts) => snapshotOf(parts, '');

        it("include disabled params, which the URL doesn't show", () => {
            const opened = open(listTodos);
            const edited = editParams(opened, (rows) => rows.map((row) => row.name === 'done' ? { ...row, value: 'false' } : row));
            expect(edited.url).to.equal(opened.url);
            expect(isSameSnapshot(snapshot(opened), snapshot(edited))).to.equal(false);

            const unchanged = editParams(opened, (rows) => rows);
            expect(isSameSnapshot(snapshot(opened), snapshot(unchanged))).to.equal(true);
        });

        it("ignore the picked tab and the path template", () => {
            const opened = open(listTodos);
            expect(isSameSnapshot(snapshot(opened), snapshot(withExtras(opened, { editorTab: 'docs' })))).to.equal(true);
            expect(isSameSnapshot(snapshot(opened), snapshot(withExtras(opened, { pathTemplate: '{{baseUrl}}/:x' })))).to.equal(true);
        });
    });
});
