import { expect } from "../../test-setup";

import { Headers } from "../../../src/types";
import { getDeclaredCharset, decodeWithDeclaredCharset } from "../../../src/util/body-text";

// 'Привет, мир!' in two legacy Cyrillic charsets
const WINDOWS_1251_HELLO = Buffer.from('cff0e8e2e5f22c20ece8f021', 'hex');
const KOI8_R_HELLO = Buffer.from('f0d2c9d7c5d42c20cdc9d221', 'hex');

describe("Body text utils", () => {

    describe("getDeclaredCharset", () => {
        it("reads the charset parameter of the content-type header", () => {
            expect(
                getDeclaredCharset({ 'content-type': 'text/plain; charset=windows-1251' })
            ).to.equal('windows-1251');
        });

        it("handles quotes, other casing and parameters around it", () => {
            expect(
                getDeclaredCharset({ 'Content-Type': 'text/html;boundary=x;charset="KOI8-R"; foo=bar' })
            ).to.equal('koi8-r');
        });

        it("uses the last value if the header is repeated", () => {
            expect(
                getDeclaredCharset({
                    'content-type': ['text/plain; charset=utf-8', 'text/plain; charset=koi8-r']
                } as unknown as Headers) // Typed as one string, but repeated headers do show up as arrays
            ).to.equal('koi8-r');
        });

        it("returns undefined without a charset or headers", () => {
            expect(getDeclaredCharset({ 'content-type': 'text/plain' })).to.equal(undefined);
            expect(getDeclaredCharset({ 'content-length': '5' })).to.equal(undefined);
            expect(getDeclaredCharset(undefined)).to.equal(undefined);
        });
    });

    describe("decodeWithDeclaredCharset", () => {
        it("decodes windows-1251 text", () => {
            expect(
                decodeWithDeclaredCharset(WINDOWS_1251_HELLO, { 'content-type': 'text/plain; charset=windows-1251' })
            ).to.equal('Привет, мир!');
        });

        it("decodes koi8-r text", () => {
            expect(
                decodeWithDeclaredCharset(KOI8_R_HELLO, { 'content-type': 'text/plain; charset=koi8-r' })
            ).to.equal('Привет, мир!');
        });

        it("decodes other charsets TextDecoder knows", () => {
            expect(
                decodeWithDeclaredCharset(Buffer.from('4dfc6e6368656e', 'hex'), { 'content-type': 'application/json; charset=ISO-8859-1' })
            ).to.equal('München');

            expect(
                decodeWithDeclaredCharset(Buffer.from('hi', 'utf16le'), { 'content-type': 'text/plain; charset=utf-16le' })
            ).to.equal('hi');
        });

        it("leaves UTF-8 to the caller, whether it's declared or not", () => {
            const content = Buffer.from('Привет', 'utf8');
            expect(decodeWithDeclaredCharset(content, { 'content-type': 'text/plain; charset=utf-8' })).to.equal(undefined);
            expect(decodeWithDeclaredCharset(content, { 'content-type': 'text/plain' })).to.equal(undefined);
            expect(decodeWithDeclaredCharset(content, undefined)).to.equal(undefined);
        });

        it("treats us-ascii as UTF-8, as servers that say it often send UTF-8", () => {
            expect(
                decodeWithDeclaredCharset(Buffer.from('Привет', 'utf8'), { 'content-type': 'text/plain; charset=us-ascii' })
            ).to.equal(undefined);
        });

        it("leaves charsets it doesn't know to the caller", () => {
            expect(
                decodeWithDeclaredCharset(WINDOWS_1251_HELLO, { 'content-type': 'text/plain; charset=x-no-such-charset' })
            ).to.equal(undefined);
        });
    });
});
