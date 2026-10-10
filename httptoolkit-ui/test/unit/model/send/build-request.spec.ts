import * as zlib from 'zlib';

import { expect } from '../../../test-setup';

import { RawHeaders } from '../../../../src/types';
import { RequestInput } from '../../../../src/model/send/send-request-model';
import { FileRef, FormField, MultipartField, SendExtrasData } from '../../../../src/model/send/send-extras';
import { sendFileStore } from '../../../../src/model/send/send-files';
import {
    buildRequestForSend,
    encodeFormBody,
    encodeMultipartBody,
    multipartBoundaryOf,
    SendBuildError
} from '../../../../src/model/send/build-request';

const formField = (name: string, value: string, enabled = true): FormField =>
    ({ id: name, name, value, enabled });

const textPart = (name: string, value: string, extra: Partial<MultipartField> = {}): MultipartField =>
    ({ id: name, name, value, enabled: true, kind: 'text', files: [], ...extra });

const filePart = (name: string, files: FileRef[], extra: Partial<MultipartField> = {}): MultipartField =>
    ({ id: name, name, value: '', enabled: true, kind: 'file', files, ...extra });

const header = (headers: RawHeaders, name: string) =>
    headers.find(([key]) => key.toLowerCase() === name)?.[1];

function requestWith(extras: Partial<SendExtrasData>, options: {
    method?: string,
    url?: string,
    headers?: RawHeaders,
    rawBody?: string
} = {}) {
    return new RequestInput({
        method: options.method ?? 'POST',
        url: options.url ?? 'https://example.com/upload',
        headers: options.headers ?? [['host', 'example.com']],
        requestContentType: 'text',
        rawBody: Buffer.from(options.rawBody ?? ''),
        extras
    });
}

// Bytes that aren't valid UTF-8, to check files go through untouched
const BINARY_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe, 0x0d, 0x0a, 0x80]);

describe("Send request building", function () {
    this.timeout(10000);

    let pngFile: FileRef;
    let textFile: FileRef;

    before(async () => {
        pngFile = await sendFileStore.put(BINARY_BYTES, { name: 'photo.png', contentType: 'image/png' });
        textFile = await sendFileStore.put(Buffer.from('plain text file'), { name: 'notes.txt', contentType: 'text/plain' });
    });

    describe("encodeFormBody", () => {
        it("url-encodes the enabled, named fields in order", () => {
            expect(encodeFormBody([
                formField('name', 'Ada Lovelace'),
                formField('skipped', 'x', false),
                formField('', 'no name'),
                formField('maths & more', 'a=b&c/d?é'),
                formField('name', 'again')
            ])).to.equal('name=Ada+Lovelace&maths+%26+more=a%3Db%26c%2Fd%3F%C3%A9&name=again');
        });

        it("gives an empty body for no fields", () => {
            expect(encodeFormBody([])).to.equal('');
        });
    });

    describe("encodeMultipartBody", () => {
        it("encodes text parts", async () => {
            const body = await encodeMultipartBody([
                textPart('note', 'hello'),
                textPart('json', '{"a":1}', { contentType: 'application/json' }),
                textPart('off', 'x', { enabled: false }),
                textPart('', 'no name')
            ], 'BOUNDARY');

            expect(body.toString('utf8')).to.equal(
                '--BOUNDARY\r\n' +
                'Content-Disposition: form-data; name="note"\r\n' +
                '\r\n' +
                'hello\r\n' +
                '--BOUNDARY\r\n' +
                'Content-Disposition: form-data; name="json"\r\n' +
                'Content-Type: application/json\r\n' +
                '\r\n' +
                '{"a":1}\r\n' +
                '--BOUNDARY--\r\n'
            );
        });

        it("encodes file parts with their names, types and exact bytes", async () => {
            const body = await encodeMultipartBody([
                filePart('upload', [pngFile, textFile]),
                filePart('typed', [textFile], { contentType: 'application/x-custom' })
            ], 'B');

            const expected = Buffer.concat([
                Buffer.from(
                    '--B\r\n' +
                    'Content-Disposition: form-data; name="upload"; filename="photo.png"\r\n' +
                    'Content-Type: image/png\r\n' +
                    '\r\n'
                ),
                BINARY_BYTES,
                Buffer.from(
                    '\r\n--B\r\n' +
                    'Content-Disposition: form-data; name="upload"; filename="notes.txt"\r\n' +
                    'Content-Type: text/plain\r\n' +
                    '\r\n' +
                    'plain text file\r\n' +
                    '--B\r\n' +
                    'Content-Disposition: form-data; name="typed"; filename="notes.txt"\r\n' +
                    'Content-Type: application/x-custom\r\n' +
                    '\r\n' +
                    'plain text file\r\n' +
                    '--B--\r\n'
                )
            ]);

            expect(body.equals(expected)).to.equal(true);
        });

        it("escapes quotes and newlines in names, and keeps non-ASCII names as UTF-8", async () => {
            const body = await encodeMultipartBody([
                textPart('say "hi"\r\nnow', 'x'),
                filePart('файл', [{ ...pngFile, name: 'фото "1".png' }])
            ], 'B');

            const text = body.toString('utf8');
            expect(text).to.include('Content-Disposition: form-data; name="say %22hi%22%0D%0Anow"\r\n');
            expect(text).to.include('Content-Disposition: form-data; name="файл"; filename="фото %221%22.png"\r\n');
            expect(body.includes(Buffer.from('name="файл"', 'utf8'))).to.equal(true);
        });

        it("defaults a file part's type to application/octet-stream", async () => {
            const body = await encodeMultipartBody([filePart('blob', [{ ...pngFile, contentType: '' }])], 'B');
            expect(body.toString('latin1')).to.include('Content-Type: application/octet-stream\r\n');
        });

        it("only closes the body when there are no fields", async () => {
            const body = await encodeMultipartBody([], 'B');
            expect(body.toString()).to.equal('--B--\r\n');
        });

        it("fails clearly when a file's bytes are gone", async () => {
            const missing: FileRef = { fileId: 'not-a-stored-file', name: 'gone.png', size: 3, contentType: 'image/png' };

            await expect(encodeMultipartBody([filePart('f', [missing])], 'B'))
                .to.be.rejectedWith(SendBuildError, 'The file "gone.png" isn\'t available any more. Attach it again.');
        });
    });

    describe("buildRequestForSend", () => {
        it("returns raw requests as they are", async () => {
            const input = requestWith({}, { rawBody: 'raw text' });
            expect(await buildRequestForSend(input)).to.equal(input);
        });

        it("builds a form body, with a default Content-Type and its Content-Length", async () => {
            const input = requestWith({
                bodyMode: 'form',
                formFields: [formField('a', '1'), formField('b', 'two words')]
            }, { rawBody: 'the raw body is ignored' });

            const built = await buildRequestForSend(input);

            expect(built).not.to.equal(input);
            expect(built.rawBody.decoded.toString()).to.equal('a=1&b=two+words');
            expect(header(built.headers, 'content-type')).to.equal('application/x-www-form-urlencoded');
            expect(header(built.headers, 'content-length')).to.equal('15');

            // The tab's own request isn't changed
            expect(input.headers).to.deep.equal([['host', 'example.com']]);
            expect(input.rawBody.decoded.toString()).to.equal('the raw body is ignored');
        });

        it("keeps a Content-Type that's already set", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'form',
                formFields: [formField('a', '1')]
            }, { headers: [['Content-Type', 'application/x-www-form-urlencoded; charset=utf-8']] }));

            expect(built.headers).to.deep.equal([
                ['Content-Type', 'application/x-www-form-urlencoded; charset=utf-8'],
                ['content-length', '3']
            ]);
        });

        it("builds a multipart body with a boundary that matches its Content-Type", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'multipart',
                multipartFields: [textPart('note', 'hello'), filePart('image', [pngFile])]
            }));

            const contentType = header(built.headers, 'content-type')!;
            const boundary = multipartBoundaryOf(contentType)!;
            expect(contentType).to.match(/^multipart\/form-data; boundary=----WirepaneFormBoundary[0-9a-f]{16}$/);

            const body = built.rawBody.decoded;
            expect(body.toString('latin1').startsWith(`--${boundary}\r\n`)).to.equal(true);
            expect(body.toString('latin1').endsWith(`--${boundary}--\r\n`)).to.equal(true);
            expect(body.includes(BINARY_BYTES)).to.equal(true);
            expect(header(built.headers, 'content-length')).to.equal(body.byteLength.toString());
        });

        it("uses the boundary of the tab's multipart Content-Type", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'multipart',
                multipartFields: [textPart('note', 'hello')]
            }, { headers: [['content-type', 'multipart/form-data; boundary="my boundary"']] }));

            expect(header(built.headers, 'content-type')).to.equal('multipart/form-data; boundary="my boundary"');
            expect(built.rawBody.decoded.toString()).to.equal(
                '--my boundary\r\nContent-Disposition: form-data; name="note"\r\n\r\nhello\r\n--my boundary--\r\n'
            );
        });

        it("sends a binary file's bytes, with its type", async () => {
            const built = await buildRequestForSend(requestWith({ bodyMode: 'binary', binaryFile: pngFile }));

            expect(built.rawBody.decoded.equals(BINARY_BYTES)).to.equal(true);
            expect(header(built.headers, 'content-type')).to.equal('image/png');
            expect(header(built.headers, 'content-length')).to.equal(BINARY_BYTES.byteLength.toString());
        });

        it("defaults a binary body without a type to application/octet-stream", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'binary',
                binaryFile: { ...pngFile, contentType: '' }
            }));
            expect(header(built.headers, 'content-type')).to.equal('application/octet-stream');
        });

        it("asks for a file when a binary body has none", async () => {
            await expect(buildRequestForSend(requestWith({ bodyMode: 'binary' })))
                .to.be.rejectedWith(SendBuildError, 'Choose a file to send as the request body.');
        });

        it("fails clearly when a binary file's bytes are gone", async () => {
            await expect(buildRequestForSend(requestWith({
                bodyMode: 'binary',
                binaryFile: { fileId: 'missing', name: 'old.bin', size: 1, contentType: '' }
            }))).to.be.rejectedWith(SendBuildError, 'The file "old.bin" isn\'t available any more.');
        });

        it("sends GraphQL as JSON", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'graphql',
                graphql: {
                    query: 'query One { a } query Two { b }',
                    variables: ' { "id": 1 } ',
                    operationName: 'Two'
                }
            }));

            const body = built.rawBody.decoded.toString();
            expect(JSON.parse(body)).to.deep.equal({
                query: 'query One { a } query Two { b }',
                variables: { id: 1 },
                operationName: 'Two'
            });
            expect(header(built.headers, 'content-type')).to.equal('application/json');
            expect(header(built.headers, 'content-length')).to.equal(Buffer.byteLength(body).toString());
        });

        it("leaves out empty GraphQL variables", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'graphql',
                graphql: { query: '{ a }', variables: '  ' }
            }));
            expect(JSON.parse(built.rawBody.decoded.toString())).to.deep.equal({ query: '{ a }' });
        });

        it("sends GraphQL over GET in the URL, without a body", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'graphql',
                graphql: { query: '{ user(id: $id) { name } }', variables: '{"id":"7"}', operationName: 'User' }
            }, {
                method: 'GET',
                url: 'https://example.com/graphql?x=1',
                headers: [['host', 'example.com'], ['content-length', '99']]
            }));

            const url = new URL(built.url);
            expect(url.searchParams.get('x')).to.equal('1');
            expect(url.searchParams.get('query')).to.equal('{ user(id: $id) { name } }');
            expect(url.searchParams.get('variables')).to.equal('{"id":"7"}');
            expect(url.searchParams.get('operationName')).to.equal('User');
            expect(built.rawBody.decoded.byteLength).to.equal(0);
            expect(header(built.headers, 'content-length')).to.equal(undefined);
        });

        it("explains a GET GraphQL request with an unfinished URL", async () => {
            await expect(buildRequestForSend(requestWith({
                bodyMode: 'graphql',
                graphql: { query: '{ a }', variables: '' }
            }, { method: 'GET', url: 'example.com/graphql' }))).to.be.rejectedWith(SendBuildError, 'Enter a full URL');
        });

        it("rejects GraphQL variables that aren't JSON", async () => {
            await expect(buildRequestForSend(requestWith({
                bodyMode: 'graphql',
                graphql: { query: '{ a }', variables: '{ id: 1 }' }
            }))).to.be.rejectedWith(SendBuildError, "The GraphQL variables aren't valid JSON");
        });

        it("doesn't add Content-Length to chunked requests", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'form',
                formFields: [formField('a', '1')]
            }, { headers: [['transfer-encoding', 'chunked']] }));

            expect(header(built.headers, 'content-length')).to.equal(undefined);
        });

        it("sets Content-Length from the encoded body", async () => {
            const built = await buildRequestForSend(requestWith({
                bodyMode: 'form',
                formFields: [formField('text', 'a'.repeat(1000))]
            }, { headers: [['content-encoding', 'gzip']] }));

            const encoded = await built.rawBody.encodingPromise;
            expect(zlib.gunzipSync(encoded).toString()).to.equal('text=' + 'a'.repeat(1000));
            expect(header(built.headers, 'content-length')).to.equal(encoded.byteLength.toString());
            expect(encoded.byteLength).to.be.lessThan(1005);
        });

        it("doesn't share its extras with the tab", async () => {
            const input = requestWith({ bodyMode: 'form', formFields: [formField('a', '1')] });
            const built = await buildRequestForSend(input);

            expect(built.extras).not.to.equal(input.extras);
            expect(built.extras.formFields).not.to.equal(input.extras.formFields);
            expect(built.extras.formFields).to.deep.equal(input.extras.formFields);
        });
    });
});
