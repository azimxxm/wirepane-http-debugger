import { expect } from '../../../test-setup';

import { RequestInput } from '../../../../src/model/send/send-request-model';
import {
    decodePathValue,
    encodePathValue,
    getPathParams,
    matchPathTemplate,
    pathTemplateOf,
    setPathParamValue,
    withPathParamValue
} from '../../../../src/model/send/params/path-params';

const requestFor = (url: string) => new RequestInput({
    method: 'GET',
    url,
    headers: [],
    requestContentType: 'text',
    rawBody: Buffer.alloc(0)
});

describe("Send path params", () => {

    it("are the :name segments of the path, not ports or other colons", () => {
        expect(getPathParams('https://api.example.com:8443/users/:id/posts/:postId?x=:y', undefined)).to.deep.equal([
            { name: 'id', value: '' },
            { name: 'postId', value: '' }
        ]);
        expect(getPathParams('https://example.com/a:b/:/time:12', undefined)).to.deep.equal([]);
        expect(getPathParams('{{baseUrl}}/todos/:id', undefined)).to.deep.equal([{ name: 'id', value: '' }]);
    });

    it("get a template from a URL with :name segments only", () => {
        expect(pathTemplateOf('{{baseUrl}}/users/:id?verbose=true#top')).to.equal('{{baseUrl}}/users/:id');
        expect(pathTemplateOf('https://example.com/users/1')).to.equal(undefined);
    });

    it("are filled in from the table, and keep their rows", () => {
        let { url, template } = withPathParamValue('https://example.com/users/:id/posts/:postId?x=1', undefined, 0, '42');
        expect(url).to.equal('https://example.com/users/42/posts/:postId?x=1');
        expect(template).to.equal('https://example.com/users/:id/posts/:postId');
        expect(getPathParams(url, template)).to.deep.equal([
            { name: 'id', value: '42' },
            { name: 'postId', value: '' }
        ]);

        ({ url, template } = withPathParamValue(url, template, 1, '{{postId}}'));
        expect(url).to.equal('https://example.com/users/42/posts/{{postId}}?x=1');

        // Clearing a value puts its :name back
        ({ url, template } = withPathParamValue(url, template, 0, ''));
        expect(url).to.equal('https://example.com/users/:id/posts/{{postId}}?x=1');
    });

    it("follow values edited in the URL itself, while the path keeps its shape", () => {
        const template = '{{baseUrl}}/todos/:id';
        expect(getPathParams('{{baseUrl}}/todos/7?done=true', template)).to.deep.equal([{ name: 'id', value: '7' }]);
        expect(matchPathTemplate(template, '{{baseUrl}}/todos/7/comments')).to.equal(undefined);
        expect(matchPathTemplate(template, '{{baseUrl}}/users/7')).to.equal(undefined);
        expect(matchPathTemplate(template, 'https://example.com/todos/7')).to.equal(undefined);

        // Once it doesn't fit, only the URL's own :name segments are params
        expect(getPathParams('{{baseUrl}}/users/:userId/todos/7', template)).to.deep.equal([{ name: 'userId', value: '' }]);
    });

    it("encode what would split the path, and show it decoded", () => {
        expect(encodePathValue('a/b?c#d e%20')).to.equal('a%2Fb%3Fc%23d e%20');
        expect(decodePathValue('a%2Fb%3fc%23d e%20')).to.equal('a/b?c#d e%20');

        const { url, template } = withPathParamValue('https://example.com/files/:path', undefined, 0, 'docs/readme.md');
        expect(url).to.equal('https://example.com/files/docs%2Freadme.md');
        expect(getPathParams(url, template).map(({ value }) => decodePathValue(value))).to.deep.equal(['docs/readme.md']);
    });

    it("are set on a request together with its template", () => {
        const input = requestFor('https://example.com/users/:id');
        setPathParamValue(input, 0, '5');

        expect(input.url).to.equal('https://example.com/users/5');
        expect(input.extras.pathTemplate).to.equal('https://example.com/users/:id');
        expect(new RequestInput(input).extras.pathTemplate).to.equal('https://example.com/users/:id');
    });
});
