import { expect } from '../../../test-setup';

import { RequestInput } from '../../../../src/model/send/send-request-model';
import { SendExtrasData } from '../../../../src/model/send/send-extras';
import { sendFileStore } from '../../../../src/model/send/send-files';
import { newMultipartField } from '../../../../src/model/send/body-modes/body-fields';
import { generateSendSnippet } from '../../../../src/model/send/body-modes/send-snippets';
import { generateCodeSnippetFromRequestInput } from '../../../../src/model/ui/export';
import { getCodeSnippetOptionFromKey } from '../../../../src/model/ui/snippet-formats';

const curl = getCodeSnippetOptionFromKey('shell~~curl');

const requestWith = (extras: Partial<SendExtrasData>, contentType?: string, rawBody = '') => new RequestInput({
    method: 'POST',
    url: 'https://example.com/upload',
    headers: [['host', 'example.com'], ...(contentType ? [['content-type', contentType] as [string, string]] : [])],
    requestContentType: 'text',
    rawBody: Buffer.from(rawBody),
    extras
});

describe("Send code snippets", function () {
    this.timeout(10000);

    it("are unchanged for raw bodies", async () => {
        const input = requestWith({}, 'text/plain', 'hello');
        expect(await generateSendSnippet(input, curl)).to.equal(generateCodeSnippetFromRequestInput(input, curl));
    });

    it("send form fields as url-encoded data", async () => {
        const snippet = await generateSendSnippet(requestWith({
            bodyMode: 'form',
            formFields: [
                { id: '1', name: 'first', value: 'one', enabled: true },
                { id: '2', name: 'second', value: 'two words', enabled: true }
            ]
        }, 'application/x-www-form-urlencoded'), curl);

        expect(snippet).to.include('first=one');
        expect(snippet).to.include('second=two');
        expect(snippet).to.include('application/x-www-form-urlencoded');
    });

    it("refer to multipart files by name, like curl -F", async () => {
        const photo = await sendFileStore.put(Buffer.from([1, 2, 3]), { name: 'photo.png', contentType: 'image/png' });
        const snippet = await generateSendSnippet(requestWith({
            bodyMode: 'multipart',
            multipartFields: [
                newMultipartField({ name: 'note', value: 'hello' }),
                newMultipartField({ name: 'image', kind: 'file', files: [photo] }),
                newMultipartField({ name: 'off', value: 'x', enabled: false })
            ]
        }, 'multipart/form-data; boundary=----WirepaneFormBoundary0123456789abcdef'), curl);

        expect(snippet).to.include("--form note=hello");
        expect(snippet).to.include("--form image=@photo.png");
        expect(snippet).not.to.include('off=x');
        expect(snippet).not.to.include('WirepaneFormBoundary');
    });

    it("send GraphQL queries as JSON", async () => {
        const snippet = await generateSendSnippet(requestWith({
            bodyMode: 'graphql',
            graphql: { query: '{ countries { code } }', variables: '' }
        }, 'application/json'), curl);

        expect(snippet).to.include('{"query":"{ countries { code } }"}');
    });
});
