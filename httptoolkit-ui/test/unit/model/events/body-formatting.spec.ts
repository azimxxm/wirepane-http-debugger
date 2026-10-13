import { expect } from "../../../test-setup";

import { Formatters, EditorFormatter } from "../../../../src/model/events/body-formatting";
import { formatBuffer } from "../../../../src/services/ui-worker-formatters";
import { MAX_HEX_VIEW_BYTES } from "../../../../src/util/body-text";

const WINDOWS_1251_HELLO = Buffer.from('cff0e8e2e5f22c20ece8f021', 'hex'); // 'Привет, мир!'
const WINDOWS_1251_HEADERS = { 'content-type': 'text/plain; charset=windows-1251' };

// What the web worker does, without the worker
const formatInWorker = (content: Buffer, format: Parameters<typeof formatBuffer>[1], headers?: {}) =>
    formatBuffer(
        content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer,
        format,
        headers
    );

describe("Body formatting", () => {

    describe("in a legacy charset", () => {
        const render = (format: 'text' | 'json' | 'json-records', content: Buffer, headers?: {}) =>
            (Formatters[format] as EditorFormatter).render(content, headers);

        it("shows text in the charset the response declares", () => {
            expect(render('text', WINDOWS_1251_HELLO, WINDOWS_1251_HEADERS)).to.equal('Привет, мир!');
        });

        it("still shows text as UTF-8 by default", () => {
            const utf8Hello = Buffer.from('Привет, мир!', 'utf8');
            expect(render('text', utf8Hello)).to.equal('Привет, мир!');
            expect(render('text', utf8Hello, { 'content-type': 'text/plain' })).to.equal('Привет, мир!');
            expect(render('text', utf8Hello, { 'content-type': 'text/plain; charset=utf-8' })).to.equal('Привет, мир!');
        });

        it("formats small JSON in the declared charset", () => {
            const json = Buffer.concat([Buffer.from('{"greeting":"'), WINDOWS_1251_HELLO, Buffer.from('"}')]);
            expect(
                render('json', json, { 'content-type': 'application/json; charset=windows-1251' })
            ).to.equal('{\n  "greeting": "Привет, мир!"\n}');
        });

        it("formats the types that go through the worker in the declared charset", () => {
            const html = Buffer.concat([Buffer.from('<p>'), WINDOWS_1251_HELLO, Buffer.from('</p>')]);
            expect(formatInWorker(html, 'html', WINDOWS_1251_HEADERS)).to.include('Привет, мир!');
            expect(formatInWorker(html, 'html')).to.include('�'); // As UTF-8, which is the default

            const json = Buffer.concat([Buffer.from('{"a":"'), WINDOWS_1251_HELLO, Buffer.from('"}')]);
            expect(formatInWorker(json, 'json', WINDOWS_1251_HEADERS)).to.equal('{\n  "a": "Привет, мир!"\n}');
        });
    });

    describe("Hex view", () => {
        const hexBody = (size: number) => Buffer.alloc(size, 0xAB);

        it("shows all of a body that fits", () => {
            const formatted = formatInWorker(hexBody(MAX_HEX_VIEW_BYTES), 'raw');

            expect(formatted.split(' ')).to.have.length(MAX_HEX_VIEW_BYTES);
            expect(formatted).to.not.include('[--');
        });

        it("shows the start of a bigger body and says where to find the rest", () => {
            const formatted = formatInWorker(hexBody(MAX_HEX_VIEW_BYTES * 4), 'raw');
            const [hex, note] = formatted.split('\n');

            expect(hex.split(' ')).to.have.length(MAX_HEX_VIEW_BYTES);
            expect(note).to.equal(
                '[-- Only the first 250 kB of 1 MB is shown. Use the download button to save all of it. --]'
            );
        });

        it("offers a note above the editor for a big body only", async () => {
            const { metadata } = Formatters.raw;

            expect(await metadata!.extract(hexBody(MAX_HEX_VIEW_BYTES))).to.equal(undefined);
            expect(await metadata!.extract(hexBody(MAX_HEX_VIEW_BYTES + 1))).to.deep.equal({
                shown: MAX_HEX_VIEW_BYTES,
                total: MAX_HEX_VIEW_BYTES + 1
            });
        });
    });
});
