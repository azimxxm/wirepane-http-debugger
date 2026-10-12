import { expect } from '../../../test-setup';

import { QueryParam } from '../../../../src/model/send/send-extras';
import { RequestInput } from '../../../../src/model/send/send-request-model';
import {
    disabledQueryParamsKey,
    getQueryParams,
    parseQueryString,
    serializeQueryParams,
    setQueryParams,
    splitQuery,
    withQueryParams
} from '../../../../src/model/send/params/query-params';

const param = (name: string, value: string, enabled = true): QueryParam => ({ name, value, enabled });

// What the Params tab does on an edit: change the rows it shows, then write them back
function edit(url: string, stored: QueryParam[] | undefined, change: (rows: QueryParam[]) => QueryParam[]) {
    const rows = change([...getQueryParams(url, stored)]);
    return { url: withQueryParams(url, rows), stored: rows };
}

const shown = (url: string, stored?: QueryParam[]) =>
    getQueryParams(url, stored).map((row) => `${row.enabled ? '' : '!'}${row.name}=${row.value}`);

describe("Send query params", () => {

    describe("reading the URL", () => {
        it("splits off the query and the fragment", () => {
            expect(splitQuery('https://a.com/x?b=1&c=2#top')).to.deep.equal({
                beforeQuery: 'https://a.com/x', query: 'b=1&c=2', fragment: '#top'
            });
            expect(splitQuery('https://a.com/x#a?b')).to.deep.equal({
                beforeQuery: 'https://a.com/x', query: undefined, fragment: '#a?b'
            });
            expect(splitQuery('https://a.com/x?')).to.deep.equal({
                beforeQuery: 'https://a.com/x', query: '', fragment: ''
            });
        });

        it("keeps names and values as written, with no decoding", () => {
            expect(parseQueryString('q=a%20b&plus=1+1&eq=x=y&unicode=привет')).to.deep.equal([
                param('q', 'a%20b'),
                param('plus', '1+1'),
                param('eq', 'x=y'),
                param('unicode', 'привет')
            ]);
        });

        it("tells a name without a value from one with an empty value, and skips empty pairs", () => {
            expect(parseQueryString('flag&empty=&&x=1&')).to.deep.equal([
                { name: 'flag', value: '', enabled: true },
                { name: 'empty', value: '', enabled: true, hasEquals: true },
                param('x', '1')
            ]);
        });

        it("writes a query back exactly as it was read", () => {
            const query = 'a=1&a=2&flag&empty=&q=%7B%7D+x&token={{token}}&{{name}}={{value}}';
            expect(serializeQueryParams(parseQueryString(query))).to.equal(query);
        });

        it("keeps duplicate names as separate rows, in order", () => {
            expect(shown('https://a.com/?tag=a&tag=b&tag=a')).to.deep.equal(['tag=a', 'tag=b', 'tag=a']);
        });
    });

    describe("editing the table", () => {
        it("encodes only what would change the query's structure", () => {
            const { url } = edit('https://a.com/?x=1', undefined, (rows) => [
                ...rows,
                param('a=b', 'c&d#e=f'),
                param('space', 'a b'),
                param('pct', '%20+')
            ]);
            expect(url).to.equal('https://a.com/?x=1&a%3Db=c%26d%23e=f&space=a b&pct=%20+');
        });

        it("keeps {{variables}} as text in names and values", () => {
            const { url } = edit('{{baseUrl}}/pets', undefined, () => [param('{{key}}', '{{value}}'), param('q', 'a{{b}}c')]);
            expect(url).to.equal('{{baseUrl}}/pets?{{key}}={{value}}&q=a{{b}}c');
        });

        it("shows typed text as typed, while the URL holds it encoded", () => {
            const { url, stored } = edit('https://a.com/', undefined, () => [param('q', 'rock & roll')]);
            expect(url).to.equal('https://a.com/?q=rock %26 roll');
            expect(shown(url, stored)).to.deep.equal(['q=rock & roll']);
        });

        it("updates one value without touching the others' text", () => {
            const before = 'https://a.com/?a=%2F&flag&empty=&b=1';
            const { url } = edit(before, undefined, (rows) => rows.map((row) => row.name === 'b' ? { ...row, value: '2' } : row));
            expect(url).to.equal('https://a.com/?a=%2F&flag&empty=&b=2');
        });

        it("writes a name without a value as just the name", () => {
            const { url } = edit('https://a.com/', undefined, () => [param('debug', '')]);
            expect(url).to.equal('https://a.com/?debug');
        });

        it("keeps a row being typed in, without putting it in the URL", () => {
            const { url, stored } = edit('https://a.com/?a=1', undefined, (rows) => [...rows, param('', '')]);
            expect(url).to.equal('https://a.com/?a=1');
            expect(shown(url, stored)).to.deep.equal(['a=1', '=']);
        });

        it("keeps the fragment, and drops the ? when no param is left", () => {
            expect(withQueryParams('https://a.com/x?a=1#top', [param('b', '2')])).to.equal('https://a.com/x?b=2#top');
            expect(withQueryParams('https://a.com/x?a=1#top', [])).to.equal('https://a.com/x#top');
            expect(withQueryParams('https://a.com/x', [param('a', '1', false)])).to.equal('https://a.com/x');
        });
    });

    describe("disabled params", () => {
        it("stay in the table but leave the URL", () => {
            const { url, stored } = edit('https://a.com/?a=1&b=2&c=3', undefined,
                (rows) => rows.map((row) => row.name === 'b' ? { ...row, enabled: false } : row)
            );
            expect(url).to.equal('https://a.com/?a=1&c=3');
            expect(shown(url, stored)).to.deep.equal(['a=1', '!b=2', 'c=3']);
        });

        it("keep their place when the URL is edited", () => {
            const stored = [param('a', '1'), param('b', '2', false), param('c', '3')];

            expect(shown('https://a.com/?a=1&c=3&d=4', stored)).to.deep.equal(['a=1', '!b=2', 'c=3', 'd=4']);
            expect(shown('https://a.com/?c=3', stored)).to.deep.equal(['c=3', '!b=2']);
            expect(shown('https://a.com/', stored)).to.deep.equal(['!b=2']);
            expect(shown('https://a.com/?z=0&a=1&c=3', [param('x', '0', false), ...stored]))
                .to.deep.equal(['!x=0', 'z=0', '!b=2', 'a=1', 'c=3']);
        });

        it("go back to their place when they're ticked again", () => {
            const { url, stored } = edit('https://a.com/?a=1&c=3', [param('a', '1'), param('b', '2', false), param('c', '3')],
                (rows) => rows.map((row) => ({ ...row, enabled: true }))
            );
            expect(url).to.equal('https://a.com/?a=1&b=2&c=3');
            expect(shown(url, stored)).to.deep.equal(['a=1', 'b=2', 'c=3']);
        });

        it("change the dirty-tracking key, which ignores everything the URL already shows", () => {
            const url = 'https://a.com/?a=1';
            expect(disabledQueryParamsKey(url, undefined)).to.equal('');
            expect(disabledQueryParamsKey(url, [param('a', '1')])).to.equal('');
            expect(disabledQueryParamsKey(url, [param('a', '1'), param('b', '2', false)])).to.equal('[["b","2"]]');
            expect(disabledQueryParamsKey(url, [param('a', '1'), param('b', '3', false)])).to.equal('[["b","3"]]');
        });
    });

    describe("the tab's own copy", () => {
        it("is used while it matches the URL, and read again from the URL once it doesn't", () => {
            const stored = [param('q', 'a&b')];
            expect(getQueryParams('https://a.com/?q=a%26b', stored)).to.equal(stored);

            // Edited in the URL field: rows still there as written keep their typed text
            expect(shown('https://a.com/?q=a%26b&n=1', stored)).to.deep.equal(['q=a&b', 'n=1']);
            expect(shown('https://a.com/?q=other', stored)).to.deep.equal(['q=other']);
        });

        it("is kept with the URL by setQueryParams", () => {
            const input = new RequestInput({
                method: 'GET',
                url: 'https://a.com/items?page=1#list',
                headers: [],
                requestContentType: 'text',
                rawBody: Buffer.alloc(0)
            });

            setQueryParams(input, [param('page', '2'), param('debug', 'true', false)]);
            expect(input.url).to.equal('https://a.com/items?page=2#list');
            expect(input.extras.queryParams).to.deep.equal([param('page', '2'), param('debug', 'true', false)]);

            // ...and persisted and copied with the tab
            const copy = new RequestInput(input);
            expect(copy.extras.queryParams).to.deep.equal(input.extras.queryParams);
            expect(copy.extras.queryParams).not.to.equal(input.extras.queryParams);
        });
    });
});
