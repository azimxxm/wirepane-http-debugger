import { runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { RequestInput } from '../../../../src/model/send/send-request-model';
import { SendExtrasData } from '../../../../src/model/send/send-extras';
import {
    defaultEditorTab,
    headersCount,
    paramsCount,
    pickEditorTab,
    shownEditorTab
} from '../../../../src/model/send/request-editor-tabs';
import { setQueryParams } from '../../../../src/model/send/params/query-params';

function requestWith(options: {
    method?: string,
    url?: string,
    rawBody?: string,
    extras?: Partial<SendExtrasData>
} = {}) {
    return new RequestInput({
        method: options.method ?? 'GET',
        url: options.url ?? 'https://example.com/items',
        headers: [],
        requestContentType: 'text',
        rawBody: Buffer.from(options.rawBody ?? ''),
        extras: options.extras
    });
}

const ALL_TABS = ['params', 'headers', 'body', 'docs'] as const;
const WITHOUT_DOCS = ['params', 'headers', 'body'] as const;

describe("Send request editor tabs", () => {

    describe("the default tab", () => {
        it("is Body for methods that usually send one", () => {
            for (const method of ['POST', 'PUT', 'PATCH', 'post']) {
                expect(defaultEditorTab(requestWith({ method }))).to.equal('body', method);
            }
        });

        it("is Body when the request has a body, whatever the method", () => {
            expect(defaultEditorTab(requestWith({ rawBody: '{"query": "x"}' }))).to.equal('body');
            expect(defaultEditorTab(requestWith({ extras: { bodyMode: 'form' } }))).to.equal('body');
            expect(defaultEditorTab(requestWith({ extras: { bodyMode: 'graphql' } }))).to.equal('body');
        });

        it("is Params when the URL has query or path params", () => {
            expect(defaultEditorTab(requestWith({ url: 'https://example.com/get?a=1' }))).to.equal('params');
            expect(defaultEditorTab(requestWith({ method: 'DELETE', url: 'https://example.com/items?id=1' }))).to.equal('params');
            expect(defaultEditorTab(requestWith({ url: 'https://example.com/items/:id' }))).to.equal('params');
            expect(defaultEditorTab(requestWith({ url: '{{baseUrl}}/items/1', extras: { pathTemplate: '{{baseUrl}}/items/:id' } })))
                .to.equal('params');
        });

        it("is Headers otherwise", () => {
            expect(defaultEditorTab(requestWith())).to.equal('headers');
            expect(defaultEditorTab(requestWith({ url: '' }))).to.equal('headers');
            expect(defaultEditorTab(requestWith({ url: 'https://example.com/get?' }))).to.equal('headers');
            expect(defaultEditorTab(requestWith({ method: 'HEAD' }))).to.equal('headers');
        });

        it("follows the request until a tab is picked, and then stays", () => {
            const input = requestWith();
            expect(shownEditorTab(input, WITHOUT_DOCS)).to.equal('headers');

            runInAction(() => { input.url = 'https://example.com/items?page=2'; });
            expect(shownEditorTab(input, WITHOUT_DOCS)).to.equal('params');
            runInAction(() => { input.method = 'POST'; });
            expect(shownEditorTab(input, WITHOUT_DOCS)).to.equal('body');

            pickEditorTab(input, 'headers');
            runInAction(() => { input.method = 'PUT'; input.url = 'https://example.com/items?page=3'; });
            expect(shownEditorTab(input, WITHOUT_DOCS)).to.equal('headers');
        });

        it("comes back when the picked tab isn't there", () => {
            const input = requestWith({ method: 'POST' });
            pickEditorTab(input, 'docs');
            expect(shownEditorTab(input, ALL_TABS)).to.equal('docs');
            expect(shownEditorTab(input, WITHOUT_DOCS)).to.equal('body');
        });
    });

    it("keep the picked tab per request, in its saved data and copies", () => {
        const input = requestWith();
        pickEditorTab(input, 'body');

        expect(input.extras.toData().editorTab).to.equal('body');
        expect(new RequestInput(input).extras.editorTab).to.equal('body');
        expect(requestWith().extras.toData()).not.to.have.property('editorTab');
    });

    describe("counts", () => {
        it("count the query params sent and the path params", () => {
            const input = requestWith({ url: 'https://example.com/users/:id?a=1&b=2' });
            expect(paramsCount(input)).to.equal(3);

            setQueryParams(input, [
                { name: 'a', value: '1', enabled: true },
                { name: 'b', value: '2', enabled: false },
                { name: '', value: '', enabled: true }
            ]);
            expect(paramsCount(input)).to.equal(2);
        });

        it("count headers with a name", () => {
            expect(headersCount([['host', 'example.com'], ['accept', '*/*'], ['', 'x']])).to.equal(2);
        });
    });
});
