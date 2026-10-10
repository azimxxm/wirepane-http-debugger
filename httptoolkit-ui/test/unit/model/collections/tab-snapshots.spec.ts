import { expect } from '../../../test-setup';

import { RequestParts } from '../../../../src/model/collections/request-mapping';
import { isSameSnapshot, snapshotOf } from '../../../../src/model/collections/tab-snapshots';
import { SendExtras, SendExtrasData } from '../../../../src/model/send/send-extras';

const parts = (extras?: Partial<SendExtrasData>): RequestParts => ({
    method: 'POST',
    url: 'https://api.example.com/',
    headers: [],
    body: Buffer.alloc(0),
    contentType: 'text',
    ...(extras ? { extras: new SendExtras(extras).toData() } : {})
});

const isUnchanged = (before: RequestParts, after: RequestParts) =>
    isSameSnapshot(snapshotOf(before, ''), snapshotOf(after, ''));

describe("Tab snapshots", () => {

    const form = (value: string): Partial<SendExtrasData> => ({
        bodyMode: 'form',
        formFields: [{ id: 'a', name: 'q', value, enabled: true }]
    });

    it("change when a form field changes", () => {
        expect(isUnchanged(parts(form('one')), parts(form('one')))).to.equal(true);
        expect(isUnchanged(parts(form('one')), parts(form('two')))).to.equal(false);
    });

    it("change when the body mode or a file changes", () => {
        const file = { fileId: 'sha-1', name: 'a.png', size: 1, contentType: 'image/png' };
        expect(isUnchanged(parts({ bodyMode: 'binary', binaryFile: file }), parts({ bodyMode: 'raw', binaryFile: file }))).to.equal(false);
        expect(isUnchanged(
            parts({ bodyMode: 'binary', binaryFile: file }),
            parts({ bodyMode: 'binary', binaryFile: { ...file, fileId: 'sha-2' } })
        )).to.equal(false);
    });

    it("ignore what collections don't store: WebSocket drafts and GraphQL operation names", () => {
        const webSocket = (message: string): Partial<SendExtrasData> => ({
            requestType: 'websocket',
            websocket: { message, messageType: 'text', savedMessages: [{ id: '1', name: 'ping', type: 'text', content: 'ping' }] }
        });
        expect(isUnchanged(parts(webSocket('a')), parts(webSocket('b')))).to.equal(true);

        const graphql = (operationName: string): Partial<SendExtrasData> => ({
            bodyMode: 'graphql',
            graphql: { query: 'query A { a } query B { b }', variables: '', operationName }
        });
        expect(isUnchanged(parts(graphql('A')), parts(graphql('B')))).to.equal(true);
    });

    it("ignore empty editor rows", () => {
        const withEmptyRow: Partial<SendExtrasData> = {
            ...form('one'),
            formFields: [...form('one').formFields!, { id: 'b', name: '', value: '', enabled: true }]
        };
        expect(isUnchanged(parts(form('one')), parts(withEmptyRow))).to.equal(true);
    });

    it("of plain HTTP tabs match snapshots saved before structured bodies existed", () => {
        const { extras: _extras, ...oldSnapshot } = snapshotOf(parts(), '');
        expect(isSameSnapshot(oldSnapshot, snapshotOf(parts({}), ''))).to.equal(true);
        expect(isSameSnapshot(oldSnapshot, snapshotOf(parts(form('one')), ''))).to.equal(false);
    });
});
