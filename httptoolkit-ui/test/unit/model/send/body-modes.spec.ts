import { runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { RawHeaders } from '../../../../src/types';
import { delay } from '../../../../src/util/promise';
import { RequestInput, SendRequest } from '../../../../src/model/send/send-request-model';
import { FileRef, MultipartField, SendExtras, SendExtrasData } from '../../../../src/model/send/send-extras';
import { MAX_SEND_FILE_SIZE, SendFileStore, sendFileStore } from '../../../../src/model/send/send-files';
import { buildRequestForSend, encodeMultipartBody } from '../../../../src/model/send/build-request';
import {
    getBodyModeOption,
    selectBodyMode,
    setBinaryFile
} from '../../../../src/model/send/body-modes/body-mode-options';
import {
    addMultipartFiles,
    newFileFieldName,
    newMultipartField
} from '../../../../src/model/send/body-modes/body-fields';
import {
    attachBinaryFile,
    detectFileContentType,
    storeFilesForSend
} from '../../../../src/model/send/body-modes/attach-files';
import { getSendBodySize, multipartBodySize } from '../../../../src/model/send/body-modes/body-size';
import { dropUnusedSendFiles, usedSendFileIds } from '../../../../src/model/send/body-modes/file-cleanup';

const header = (headers: RawHeaders, name: string) =>
    headers.find(([key]) => key.toLowerCase() === name)?.[1];

function requestWith(options: {
    method?: string,
    headers?: RawHeaders,
    rawBody?: string,
    contentType?: 'text' | 'json',
    extras?: Partial<SendExtrasData>
} = {}) {
    return new RequestInput({
        method: options.method ?? 'POST',
        url: 'https://example.com/',
        headers: options.headers ?? [],
        requestContentType: options.contentType ?? 'text',
        rawBody: Buffer.from(options.rawBody ?? ''),
        extras: options.extras
    });
}

const fileRef = (name: string, extra: Partial<FileRef> = {}): FileRef =>
    ({ fileId: `id-${name}`, name, size: 10, contentType: 'image/png', ...extra });

// Enough of a File for storeFilesForSend: it says it's `size` bytes, without making them
const fakeFile = (name: string, size: number, type = '') =>
    ({ name, size, type, arrayBuffer: async () => new TextEncoder().encode(name).buffer }) as unknown as File;

const sendRequestFor = (extras: Partial<SendExtrasData>): SendRequest =>
    ({ id: 'tab', request: requestWith({ extras }), sentExchange: undefined });

describe("Send body modes", function () {
    this.timeout(10000);

    describe("picking a mode", () => {
        it("shows the raw type, or the structured mode", () => {
            const input = requestWith({ contentType: 'json' });
            expect(getBodyModeOption(input)).to.equal('json');

            selectBodyMode(input, 'multipart');
            expect(getBodyModeOption(input)).to.equal('multipart');
        });

        it("sets each structured mode's Content-Type and drops Content-Length", () => {
            const input = requestWith({
                headers: [['host', 'example.com'], ['content-type', 'text/plain'], ['content-length', '5']],
                rawBody: 'hello'
            });

            selectBodyMode(input, 'form');
            expect(input.extras.bodyMode).to.equal('form');
            expect(input.headers).to.deep.equal([
                ['host', 'example.com'],
                ['content-type', 'application/x-www-form-urlencoded']
            ]);

            selectBodyMode(input, 'multipart');
            expect(header(input.headers, 'content-type'))
                .to.match(/^multipart\/form-data; boundary=----WirepaneFormBoundary[0-9a-f]{16}$/);

            selectBodyMode(input, 'binary');
            expect(header(input.headers, 'content-type')).to.equal('application/octet-stream');

            selectBodyMode(input, 'graphql');
            expect(header(input.headers, 'content-type')).to.equal('application/json');
            expect(header(input.headers, 'content-length')).to.equal(undefined);

            // The raw body is left alone the whole time
            expect(input.rawBody.decoded.toString()).to.equal('hello');
        });

        it("keeps a Content-Type that already fits the mode", () => {
            const form = requestWith({ headers: [['content-type', 'application/x-www-form-urlencoded; charset=utf-8']] });
            selectBodyMode(form, 'form');
            expect(header(form.headers, 'content-type')).to.equal('application/x-www-form-urlencoded; charset=utf-8');

            const multipart = requestWith({ headers: [['content-type', 'multipart/form-data; boundary=abc']] });
            selectBodyMode(multipart, 'multipart');
            expect(header(multipart.headers, 'content-type')).to.equal('multipart/form-data; boundary=abc');

            const graphql = requestWith({ headers: [['Content-Type', 'application/json; charset=utf-8']] });
            selectBodyMode(graphql, 'graphql');
            expect(graphql.headers).to.deep.equal([['Content-Type', 'application/json; charset=utf-8']]);
        });

        it("uses a binary file's own type", () => {
            const input = requestWith({ extras: { binaryFile: fileRef('photo.png') } });
            selectBodyMode(input, 'binary');
            expect(header(input.headers, 'content-type')).to.equal('image/png');
        });

        it("turns GET into POST for GraphQL, and leaves other methods alone", () => {
            const get = requestWith({ method: 'GET' });
            selectBodyMode(get, 'graphql');
            expect(get.method).to.equal('POST');

            const put = requestWith({ method: 'PUT' });
            selectBodyMode(put, 'graphql');
            expect(put.method).to.equal('PUT');

            const getForm = requestWith({ method: 'GET' });
            selectBodyMode(getForm, 'form');
            expect(getForm.method).to.equal('GET');
        });

        it("brings the raw body's Content-Type and Content-Length back", async () => {
            const input = requestWith({ rawBody: '{"a":1}', contentType: 'json' });
            await delay(10); // The raw body's first encoding
            selectBodyMode(input, 'form');

            selectBodyMode(input, 'json');
            expect(input.extras.bodyMode).to.equal('raw');
            expect(input.requestContentType).to.equal('json');
            expect(header(input.headers, 'content-type')).to.equal('application/json');
            expect(header(input.headers, 'content-length')).to.equal('7');
            expect(input.rawBody.decoded.toString()).to.equal('{"a":1}');
        });

        it("keeps a GraphQL Content-Type for a JSON body", () => {
            const input = requestWith({ rawBody: 'x' });
            selectBodyMode(input, 'graphql');
            selectBodyMode(input, 'json');
            expect(header(input.headers, 'content-type')).to.equal('application/json');
        });

        it("adds no Content-Length for an empty raw body, nor to chunked requests", () => {
            const empty = requestWith();
            selectBodyMode(empty, 'form');
            selectBodyMode(empty, 'text');
            expect(header(empty.headers, 'content-type')).to.equal('text/plain');
            expect(header(empty.headers, 'content-length')).to.equal(undefined);

            const chunked = requestWith({ rawBody: 'hello', headers: [['transfer-encoding', 'chunked']] });
            selectBodyMode(chunked, 'multipart');
            selectBodyMode(chunked, 'text');
            expect(header(chunked.headers, 'content-length')).to.equal(undefined);
        });

        it("only changes the format between raw types, as before", () => {
            const input = requestWith({ rawBody: 'hello', headers: [['content-length', '5']] });
            selectBodyMode(input, 'xml');
            expect(input.extras.bodyMode).to.equal('raw');
            expect(input.requestContentType).to.equal('xml');
            expect(header(input.headers, 'content-length')).to.equal('5');
        });
    });

    describe("binary files", () => {
        it("updates the Content-Type with the file, unless it was changed by hand", () => {
            const input = requestWith();
            selectBodyMode(input, 'binary');

            setBinaryFile(input, fileRef('a.png'));
            expect(header(input.headers, 'content-type')).to.equal('image/png');

            setBinaryFile(input, fileRef('b.pdf', { contentType: 'application/pdf' }));
            expect(header(input.headers, 'content-type')).to.equal('application/pdf');

            setBinaryFile(input, undefined);
            expect(header(input.headers, 'content-type')).to.equal('application/octet-stream');

            runInAction(() => { input.headers[0][1] = 'application/vnd.custom'; });
            setBinaryFile(input, fileRef('c.png'));
            expect(header(input.headers, 'content-type')).to.equal('application/vnd.custom');
        });

        it("takes the first of several files, and says so", async () => {
            const input = requestWith();
            selectBodyMode(input, 'binary');

            const problems = await attachBinaryFile(input, [
                new File(['first'], 'first.txt', { type: 'text/plain' }),
                new File(['second'], 'second.txt', { type: 'text/plain' })
            ]);

            expect(input.extras.binaryFile).to.deep.include({ name: 'first.txt', size: 5, contentType: 'text/plain' });
            expect(problems).to.deep.equal(['A binary body is one file, so only "first.txt" was used.']);
            expect(header(input.headers, 'content-type')).to.equal('text/plain');
        });
    });

    describe("multipart files", () => {
        it("names new file fields file, file2, file3...", () => {
            expect(newFileFieldName([])).to.equal('file');
            expect(newFileFieldName([newMultipartField({ name: 'file' })])).to.equal('file2');
            expect(newFileFieldName([
                newMultipartField({ name: 'file' }),
                newMultipartField({ name: 'file2' })
            ])).to.equal('file3');
        });

        it("adds dropped files as a new file field", () => {
            const extras = new SendExtras({ bodyMode: 'multipart' });
            const id = addMultipartFiles(extras, [fileRef('a.png'), fileRef('b.png')]);

            expect(extras.multipartFields).to.have.length(1);
            expect(extras.multipartFields[0]).to.deep.include({ id, name: 'file', kind: 'file', enabled: true });
            expect(extras.multipartFields[0].files.map((file) => file.name)).to.deep.equal(['a.png', 'b.png']);
        });

        it("adds files to a row, which becomes a file row but keeps its text", () => {
            const field = newMultipartField({ name: 'avatar', value: 'some text' });
            const extras = new SendExtras({ bodyMode: 'multipart', multipartFields: [field] });

            addMultipartFiles(extras, [fileRef('a.png')], field.id);
            addMultipartFiles(extras, [fileRef('a.png'), fileRef('b.png')], field.id);

            const [row] = extras.multipartFields;
            expect(row).to.deep.include({ name: 'avatar', kind: 'file', value: 'some text' });
            expect(row.files.map((file) => file.name)).to.deep.equal(['a.png', 'b.png']);
        });

        it("names a nameless row that gets files", () => {
            const field = newMultipartField({ kind: 'file' });
            const extras = new SendExtras({
                bodyMode: 'multipart',
                multipartFields: [newMultipartField({ name: 'file' }), field]
            });

            addMultipartFiles(extras, [fileRef('a.png')], field.id);
            expect(extras.multipartFields[1].name).to.equal('file2');
        });
    });

    describe("file types and limits", () => {
        it("uses the browser's type, then the extension, then octet-stream", () => {
            expect(detectFileContentType({ name: 'a.png', type: 'image/webp' })).to.equal('image/webp');
            expect(detectFileContentType({ name: 'Photo.JPG', type: '' })).to.equal('image/jpeg');
            expect(detectFileContentType({ name: 'data.json' })).to.equal('application/json');
            expect(detectFileContentType({ name: 'archive.tar.gz' })).to.equal('application/gzip');
            expect(detectFileContentType({ name: 'mystery.xyz' })).to.equal('application/octet-stream');
            expect(detectFileContentType({ name: 'Makefile' })).to.equal('application/octet-stream');
        });

        it("refuses files over the size limit, with a message", async () => {
            const stored = await storeFilesForSend([
                fakeFile('huge.mov', MAX_SEND_FILE_SIZE + 1),
                new File(['ok'], 'small.txt')
            ]);

            expect(stored.files.map((file) => file.name)).to.deep.equal(['small.txt']);
            expect(stored.files[0].contentType).to.equal('text/plain');
            expect(stored.problems).to.deep.equal([
                '"huge.mov" is 104.9 MB. Files over 100 MB can\'t be attached.'
            ]);
        });

        it("accepts a file of exactly the limit", async () => {
            const stored = await storeFilesForSend([fakeFile('edge.bin', MAX_SEND_FILE_SIZE)]);
            expect(stored.problems).to.deep.equal([]);
            expect(stored.files.map((file) => file.name)).to.deep.equal(['edge.bin']);
        });
    });

    describe("body sizes", () => {
        let png: FileRef;
        let text: FileRef;

        before(async () => {
            png = await sendFileStore.put(Buffer.from([0, 1, 2, 3, 255]), { name: 'тест "1".png', contentType: 'image/png' });
            text = await sendFileStore.put(Buffer.from('some text'), { name: 'a.txt', contentType: '' });
        });

        it("matches the multipart body as built", async () => {
            const fields: MultipartField[] = [
                newMultipartField({ name: 'note', value: 'héllo' }),
                newMultipartField({ name: 'json', value: '{}', contentType: 'application/json' }),
                newMultipartField({ name: 'say "hi"\n', kind: 'file', files: [png, text] }),
                newMultipartField({ name: 'typed', kind: 'file', files: [text], contentType: 'text/csv' }),
                newMultipartField({ name: 'off', value: 'x', enabled: false }),
                newMultipartField({ name: '', value: 'nameless' })
            ];

            const body = await encodeMultipartBody(fields, '----WirepaneFormBoundary0123456789abcdef');
            expect(multipartBodySize(fields, '----WirepaneFormBoundary0123456789abcdef')).to.equal(body.byteLength);
        });

        it("matches the Content-Length sent, in every mode", async () => {
            const cases: Array<Partial<SendExtrasData>> = [
                { bodyMode: 'form', formFields: [{ id: '1', name: 'café', value: 'a b&c', enabled: true }] },
                { bodyMode: 'multipart', multipartFields: [newMultipartField({ name: 'f', kind: 'file', files: [png] })] },
                { bodyMode: 'binary', binaryFile: png },
                { bodyMode: 'graphql', graphql: { query: '{ é }', variables: '{"a": [1, 2]}' } }
            ];

            for (const extras of cases) {
                const input = requestWith({ extras });
                const built = await buildRequestForSend(input);
                expect(getSendBodySize(input), extras.bodyMode)
                    .to.equal(parseInt(header(built.headers, 'content-length')!, 10));
            }
        });

        it("counts no body for GraphQL over GET", () => {
            const input = requestWith({ method: 'GET', extras: { bodyMode: 'graphql', graphql: { query: '{ a }', variables: '' } } });
            expect(getSendBodySize(input)).to.equal(0);
        });

        it("counts unfinished GraphQL variables roughly", () => {
            const input = requestWith({ extras: { bodyMode: 'graphql', graphql: { query: '{ a }', variables: '{ "a": ' } } });
            expect(getSendBodySize(input)).to.equal('{ a }'.length + '{ "a": '.length);
        });
    });

    describe("file cleanup", () => {
        it("collects the files every tab refers to", () => {
            const tabs = [
                sendRequestFor({ multipartFields: [newMultipartField({ kind: 'file', files: [fileRef('a'), fileRef('b')] })] }),
                sendRequestFor({ binaryFile: fileRef('c') }),
                // Text rows keep no files, even with a value
                sendRequestFor({ multipartFields: [newMultipartField({ kind: 'text', files: [fileRef('d')] })] })
            ];

            expect(Array.from(usedSendFileIds(tabs)).sort()).to.deep.equal(['id-a', 'id-b', 'id-c']);
        });

        it("drops the stored files no tab refers to", async () => {
            const kept = await sendFileStore.put(Buffer.from('kept ' + Math.random()), { name: 'kept.txt', contentType: 'text/plain' });
            const dropped = await sendFileStore.put(Buffer.from('dropped ' + Math.random()), { name: 'dropped.txt', contentType: 'text/plain' });

            await dropUnusedSendFiles([sendRequestFor({ binaryFile: kept })]);

            expect(await sendFileStore.get(dropped.fileId)).to.equal(undefined);
            expect((await sendFileStore.get(kept.fileId))?.toString()).to.match(/^kept /);

            // Still in IndexedDB, for after a reload
            const reloadedStore = new SendFileStore();
            expect((await reloadedStore.get(kept.fileId))?.toString()).to.match(/^kept /);
            expect(await reloadedStore.get(dropped.fileId)).to.equal(undefined);
        });
    });

    describe("extras", () => {
        it("copies deeply, and tracks edits for persisting", () => {
            const extras = new SendExtras({
                bodyMode: 'multipart',
                multipartFields: [newMultipartField({ name: 'a' })],
                graphql: { query: '{ a }', variables: '' }
            });

            const data = extras.toData();
            expect(data.multipartFields).not.to.equal(extras.multipartFields);
            expect(data.multipartFields).to.deep.equal(extras.multipartFields);

            const copy = SendExtras.from(extras);
            runInAction(() => { copy.multipartFields[0].name = 'changed'; });
            expect(extras.multipartFields[0].name).to.equal('a');
        });
    });
});
