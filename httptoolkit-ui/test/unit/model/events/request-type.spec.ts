import { expect } from '../../../test-setup';
import { getExchangeData, getFailedTls } from '../../unit-test-helpers';

import { RTCConnection } from '../../../../src/model/webrtc/rtc-connection';
import { HttpExchange } from '../../../../src/model/http/http-exchange';
import {
    describeRequestType,
    getRequestType,
    getRequestTypeForContentType,
    REQUEST_TYPE_LABELS,
    RequestTypes
} from '../../../../src/model/events/request-type';

const exchange = (options: Parameters<typeof getExchangeData>[0]) => getExchangeData(options);

const asWebSocket = (base: HttpExchange) => Object.assign(base, { isWebSocket: () => true }) as HttpExchange;

describe('Request types', () => {

    describe('from a content type', () => {
        it('recognizes each kind of resource', () => {
            const cases: Array<[string, string | undefined]> = [
                ['text/html; charset=utf-8', 'document'],
                ['application/xhtml+xml', 'document'],
                ['application/json', 'fetch'],
                ['application/vnd.api+json', 'fetch'],
                ['application/problem+json', 'fetch'],
                ['application/xml', 'fetch'],
                ['text/plain', 'fetch'],
                ['application/x-www-form-urlencoded', 'fetch'],
                ['multipart/form-data; boundary=abc', 'fetch'],
                ['text/event-stream', 'fetch'],
                ['application/grpc', 'fetch'],
                ['application/x-ndjson', 'fetch'],
                ['application/javascript', 'script'],
                ['text/javascript; charset=utf-8', 'script'],
                ['text/css', 'stylesheet'],
                ['image/png', 'image'],
                ['image/svg+xml', 'image'],
                ['image/webp', 'image'],
                ['font/woff2', 'font'],
                ['application/font-woff', 'font'],
                ['application/vnd.ms-fontobject', 'font'],
                ['video/mp4', 'media'],
                ['audio/mpeg', 'media'],
                ['application/vnd.apple.mpegurl', 'media'],
                ['application/dash+xml', 'media'],
                ['application/octet-stream', undefined],
                ['application/zip', undefined],
                ['', undefined],
                [undefined as any, undefined]
            ];

            for (const [contentType, expected] of cases) {
                expect(getRequestTypeForContentType(contentType), contentType).to.equal(expected);
            }
        });

        it('has a label for every type', () => {
            for (const type of RequestTypes) {
                expect(REQUEST_TYPE_LABELS[type]).to.be.a('string').and.not.equal('');
            }
            expect(REQUEST_TYPE_LABELS.fetch).to.equal('Fetch/XHR');
        });
    });

    describe('for an exchange', () => {
        it("follows the browser's sec-fetch-dest header first", () => {
            // An <img> that got an HTML error page is still an image request
            expect(getRequestType(exchange({
                requestHeaders: { 'sec-fetch-dest': 'image' },
                responseHeaders: { 'content-type': 'text/html' }
            }))).to.equal('image');

            expect(getRequestType(exchange({ requestHeaders: { 'sec-fetch-dest': 'document' } }))).to.equal('document');
            expect(getRequestType(exchange({ requestHeaders: { 'sec-fetch-dest': 'iframe' } }))).to.equal('document');
            expect(getRequestType(exchange({ requestHeaders: { 'sec-fetch-dest': 'script' } }))).to.equal('script');
            expect(getRequestType(exchange({ requestHeaders: { 'sec-fetch-dest': 'serviceworker' } }))).to.equal('script');
            expect(getRequestType(exchange({ requestHeaders: { 'sec-fetch-dest': 'style' } }))).to.equal('stylesheet');
            expect(getRequestType(exchange({ requestHeaders: { 'sec-fetch-dest': 'font' } }))).to.equal('font');
            expect(getRequestType(exchange({ requestHeaders: { 'sec-fetch-dest': 'video' } }))).to.equal('media');
        });

        it('treats fetch() and XHR requests as fetch, whatever comes back', () => {
            expect(getRequestType(exchange({
                requestHeaders: { 'sec-fetch-dest': 'empty' },
                responseHeaders: { 'content-type': 'text/html' }
            }))).to.equal('fetch');
        });

        it('uses the response content type for clients without sec-fetch-dest', () => {
            const typeOf = (contentType: string) => getRequestType(exchange({
                responseHeaders: { 'content-type': contentType }
            }));

            expect(typeOf('application/json; charset=utf-8')).to.equal('fetch');
            expect(typeOf('text/html')).to.equal('document');
            expect(typeOf('image/jpeg')).to.equal('image');
            expect(typeOf('application/javascript')).to.equal('script');
            expect(typeOf('text/css')).to.equal('stylesheet');
            expect(typeOf('font/woff2')).to.equal('font');
            expect(typeOf('video/mp4')).to.equal('media');
            expect(typeOf('application/octet-stream')).to.equal('other');
        });

        it("falls back to the request's own hints without a useful response", () => {
            expect(getRequestType(exchange({
                responseState: 'pending',
                requestHeaders: { accept: 'image/avif,image/webp,*/*;q=0.8' }
            }))).to.equal('image');

            expect(getRequestType(exchange({
                responseState: 'pending',
                requestHeaders: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' }
            }))).to.equal('document');

            expect(getRequestType(exchange({
                responseState: 'aborted',
                requestHeaders: { accept: 'application/json, text/plain, */*' }
            }))).to.equal('fetch');

            expect(getRequestType(exchange({
                responseState: 'pending',
                requestHeaders: { accept: 'image/webp, image/apng' }
            }))).to.equal('image');

            expect(getRequestType(exchange({
                method: 'POST',
                responseState: 'pending',
                requestHeaders: { 'content-type': 'application/json' }
            }))).to.equal('fetch');

            expect(getRequestType(exchange({
                responseState: 'pending',
                requestHeaders: { 'x-requested-with': 'XMLHttpRequest' }
            }))).to.equal('fetch');

            // An empty 204 for a JSON POST is still an API call
            expect(getRequestType(exchange({
                method: 'POST',
                statusCode: 204,
                requestHeaders: { 'content-type': 'application/json' }
            }))).to.equal('fetch');

            expect(getRequestType(exchange({ requestHeaders: { accept: '*/*' } }))).to.equal('other');
        });

        it('marks WebSockets, WebRTC and non-HTTP events', () => {
            expect(getRequestType(asWebSocket(exchange({
                statusCode: 101,
                requestHeaders: { 'sec-fetch-dest': 'websocket' }
            })))).to.equal('websocket');

            expect(getRequestType(Object.create(RTCConnection.prototype))).to.equal('webrtc');
            expect(getRequestType(getFailedTls())).to.equal('other');
        });

        it('explains the type, with the content type behind it', () => {
            expect(describeRequestType(exchange({
                responseHeaders: { 'content-type': 'application/json; charset=utf-8' }
            }))).to.equal('Fetch/XHR: an API or data request, like JSON, XML, form data or text (application/json)');

            expect(describeRequestType(exchange({
                responseState: 'pending',
                requestHeaders: { 'sec-fetch-dest': 'image' }
            }))).to.equal('Image: an image');
        });
    });
});
