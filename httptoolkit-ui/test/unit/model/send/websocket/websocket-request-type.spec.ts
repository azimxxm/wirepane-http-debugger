import { runInAction } from 'mobx';

import { expect } from '../../../../test-setup';

import { RequestInput } from '../../../../../src/model/send/send-request-model';
import {
    requestTypeForUrl,
    subprotocolsFromHeaders,
    switchRequestType,
    takeSwitchFocus,
    withRequestTypeScheme
} from '../../../../../src/model/send/websocket/request-type';
import {
    encodeMessage,
    hexDump,
    messagePreview,
    prettyJson
} from '../../../../../src/model/send/websocket/websocket-messages';

const newRequest = (url = '', requestType: 'http' | 'websocket' = 'http') => new RequestInput({
    method: 'GET',
    url,
    headers: [],
    requestContentType: 'text',
    rawBody: Buffer.from([]),
    extras: { requestType }
});

describe("WebSocket request types", () => {

    it("are read from the URL's scheme", () => {
        expect(requestTypeForUrl('wss://echo.websocket.org')).to.equal('websocket');
        expect(requestTypeForUrl(' WS://localhost:8080/socket')).to.equal('websocket');
        expect(requestTypeForUrl('https://example.com')).to.equal('http');
        expect(requestTypeForUrl('http://')).to.equal('http');

        // Unfinished URLs and {{variable}} origins don't say
        expect(requestTypeForUrl('ws')).to.equal(undefined);
        expect(requestTypeForUrl('wss:/')).to.equal(undefined);
        expect(requestTypeForUrl('{{baseUrl}}/socket')).to.equal(undefined);
        expect(requestTypeForUrl('')).to.equal(undefined);
    });

    it("follow the URL as it's typed", () => {
        const request = newRequest();
        expect(request.extras.requestType).to.equal('http');

        runInAction(() => { request.url = 'wss://echo.websocket.org'; });
        expect(request.extras.requestType).to.equal('websocket');
        expect(takeSwitchFocus()).to.equal('url');

        // Editing within the same type, or a {{variable}} URL, changes nothing
        runInAction(() => { request.url = 'ws://localhost:8080'; });
        runInAction(() => { request.url = '{{baseUrl}}/socket'; });
        expect(request.extras.requestType).to.equal('websocket');
        expect(takeSwitchFocus()).to.equal(undefined);

        runInAction(() => { request.url = 'https://example.com'; });
        expect(request.extras.requestType).to.equal('http');
    });

    it("are kept when a stored request is loaded", () => {
        // A WebSocket tab with a {{variable}} URL stays a WebSocket tab
        const request = newRequest('{{baseUrl}}/socket', 'websocket');
        expect(request.extras.requestType).to.equal('websocket');

        // A stored type wins over the URL
        expect(newRequest('wss://example.com', 'http').extras.requestType).to.equal('http');
    });

    it("come from the URL for requests built without one", () => {
        const fromHar = new RequestInput({
            method: 'GET',
            url: 'wss://example.com/socket',
            headers: [],
            requestContentType: 'text',
            rawBody: Buffer.from([])
        });
        expect(fromHar.extras.requestType).to.equal('websocket');
        expect(new RequestInput().extras.requestType).to.equal('http');
    });

    it("can be switched explicitly, with the URL's scheme", () => {
        const request = newRequest('https://example.com/socket');

        switchRequestType(request, 'websocket');
        expect(request.url).to.equal('wss://example.com/socket');
        expect(request.extras.requestType).to.equal('websocket');
        expect(takeSwitchFocus()).to.equal('type');

        switchRequestType(request, 'http', 'POST');
        expect(request.url).to.equal('https://example.com/socket');
        expect(request.extras.requestType).to.equal('http');
        expect(request.method).to.equal('POST');

        const templated = newRequest('{{baseUrl}}/socket');
        switchRequestType(templated, 'websocket');
        expect(templated.url).to.equal('{{baseUrl}}/socket');
        expect(templated.extras.requestType).to.equal('websocket');
    });

    it("swap http and ws schemes", () => {
        expect(withRequestTypeScheme('http://localhost:3000', 'websocket')).to.equal('ws://localhost:3000');
        expect(withRequestTypeScheme('wss://example.com', 'http')).to.equal('https://example.com');
        expect(withRequestTypeScheme('wss://example.com', 'websocket')).to.equal('wss://example.com');
        expect(withRequestTypeScheme('ftp://example.com', 'websocket')).to.equal('ftp://example.com');
    });

    it("take subprotocols from Sec-WebSocket-Protocol", () => {
        expect(subprotocolsFromHeaders([
            ['host', 'example.com'],
            ['Sec-WebSocket-Protocol', 'graphql-ws, chat'],
            ['sec-websocket-protocol', ' , superchat ']
        ])).to.deep.equal(['graphql-ws', 'chat', 'superchat']);
        expect(subprotocolsFromHeaders([])).to.deep.equal([]);
    });

});

describe("WebSocket message helpers", () => {

    it("encode text and base64 binary messages", () => {
        expect(encodeMessage('{"a":1}', 'json')).to.deep.equal({ data: Buffer.from('{"a":1}'), isBinary: false });
        expect(encodeMessage('héllo', 'text').data.byteLength).to.equal(6);

        const binary = encodeMessage('AAEC\n/w==', 'binary');
        expect(binary.isBinary).to.equal(true);
        expect([...binary.data]).to.deep.equal([0, 1, 2, 255]);

        // URL-safe base64 too
        expect([...encodeMessage('-_8', 'binary').data]).to.deep.equal([0xfb, 0xff]);

        expect(() => encodeMessage('not base64!', 'binary')).to.throw('isn\'t valid base64');
        expect(() => encodeMessage('A', 'binary')).to.throw('isn\'t valid base64');
    });

    it("pretty-print JSON", () => {
        expect(prettyJson('{"a":[1,2]}')).to.equal('{\n  "a": [\n    1,\n    2\n  ]\n}');
        expect(prettyJson('hello')).to.equal(undefined);
        expect(prettyJson('{nope')).to.equal(undefined);
    });

    it("preview messages on one line", () => {
        expect(messagePreview(Buffer.from('line one\nline   two'), false)).to.equal('line one line two');
        expect(messagePreview(Buffer.from('x'.repeat(500)), false).length).to.equal(200);
        expect(messagePreview(Buffer.from([0, 255, 16]), true)).to.equal('00 ff 10');
    });

    it("dump binary data as hex", () => {
        expect(hexDump(Buffer.from('Hello, WebSocket!'))).to.equal(
            '00000000  48 65 6c 6c 6f 2c 20 57 65 62 53 6f 63 6b 65 74  Hello, WebSocket\n' +
            '00000010  21                                               !'
        );
    });

});
