import { expect } from "../../../test-setup";

import { getCompatibleTypes } from "../../../../src/model/events/content-types";

const WINDOWS_1251_TEXT = Buffer.from('cff0e8e2e5f22c20ece8f021', 'hex'); // 'Привет, мир!'

// Like an MPEG transport stream: 188 byte packets, each starting with the 0x47 sync byte
const mpegTsLikeBody = (size: number) => {
    const body = Buffer.alloc(size);
    for (let i = 0; i < size; i++) body[i] = i % 188 === 0 ? 0x47 : (i * 31) % 256;
    body[3] = 0x10; // Adaptation field control, which is a control character
    return body;
};

describe("Content type detection", () => {

    describe("for binary bodies", () => {
        it("opens a small one as hex, whatever its content type header says", () => {
            const types = getCompatibleTypes('text', 'video/mp2t', mpegTsLikeBody(188 * 5));

            expect(types.preferredContentType).to.equal('raw');
            expect(types.availableContentTypes).to.include.members(['raw', 'text']);
        });

        it("opens a big one as a summary, with hex and text still on offer", () => {
            const types = getCompatibleTypes('text', 'video/mp2t', mpegTsLikeBody(300_000));

            expect(types.preferredContentType).to.equal('summary');
            expect(types.availableContentTypes).to.include.members(['summary', 'raw', 'text']);
        });

        it("keeps multipart bodies as text", () => {
            const types = getCompatibleTypes('text', 'multipart/form-data; boundary=x', mpegTsLikeBody(1000));
            expect(types.preferredContentType).to.equal('text');
        });
    });

    describe("for text in a legacy charset", () => {
        it("is not taken for binary", () => {
            const types = getCompatibleTypes('text', 'text/plain; charset=windows-1251', WINDOWS_1251_TEXT);
            expect(types.preferredContentType).to.equal('text');
        });
    });

    describe("for relaxed JSON", () => {
        const relaxedJson = Buffer.from("{app_id:'1:2:ios:3', \"b\": 1}");

        it("opens it as JSON even when it's served as plain text", () => {
            expect(
                getCompatibleTypes('text', 'text/plain', relaxedJson).preferredContentType
            ).to.equal('json');
        });

        it("doesn't open text that only starts like JSON as JSON", () => {
            expect(
                getCompatibleTypes('text', 'text/plain', Buffer.from('404 page not found')).preferredContentType
            ).to.equal('text');
        });
    });
});
