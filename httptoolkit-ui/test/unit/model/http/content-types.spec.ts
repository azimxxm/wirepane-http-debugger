import { expect } from '../../../test-setup';

import { getContentType, getEditableContentType, getCompatibleTypes } from '../../../../src/model/events/content-types';

describe('Content type parsing', () => {
    describe('getContentType', () => {
        it('should render application/json as JSON', () => {
            const ct = getContentType('application/json');
            expect(ct).to.equal('json');
        });

        it('should render text/json as JSON', () => {
            const ct = getContentType('text/json');
            expect(ct).to.equal('json');
        });

        it('should render application/vnd.npm.install-v1+json as JSON', () => {
            const ct = getContentType('application/vnd.npm.install-v1+json');
            expect(ct).to.equal('json');
        });

        it('should render application/xml as XML', () => {
            const ct = getContentType('application/xml');
            expect(ct).to.equal('xml');
        });

        it('should render application/xml+extra with charset as XML', () => {
            const ct = getContentType('application/xml+extra; charset=utf-8');
            expect(ct).to.equal('xml');
        });

        it('should render text/plain as text', () => {
            const ct = getContentType('text/plain');
            expect(ct).to.equal('text');
        });

        it('should render image/gif as image', () => {
            const ct = getContentType('image/gif');
            expect(ct).to.equal('image');
        });

        it('should render image/svg+xml as image', () => {
            const ct = getContentType('image/svg+xml');
            expect(ct).to.equal('image');
        });

        it('should render application/octet-stream as raw data', () => {
            const ct = getContentType('application/octet-stream');
            expect(ct).to.equal('raw');
        });

        it('should render application/grpc as protobuf grpc', () => {
            const ct = getContentType('application/grpc');
            expect(ct).to.equal('grpc-proto');
        });

        it('should render application/grpc+proto as protobuf grpc', () => {
            const ct = getContentType('application/grpc+proto');
            expect(ct).to.equal('grpc-proto');
        });

        it('should render application/grpc+protobuf as protobuf grpc', () => {
            const ct = getContentType('application/grpc+protobuf');
            expect(ct).to.equal('grpc-proto');
        });

        it('should render application/grpc-proto as protobuf grpc', () => {
            const ct = getContentType('application/grpc-proto');
            expect(ct).to.equal('grpc-proto');
        });

        it('should render application/grpc-protobuf as protobuf grpc', () => {
            const ct = getContentType('application/grpc-protobuf');
            expect(ct).to.equal('grpc-proto');
        });

        it('should render application/grpc+json as JSON', () => {
            const ct = getContentType('application/grpc+json');
            expect(ct).to.equal('json');
        });

        it('should return undefined for unknown content', () => {
            const ct = getContentType('application/unknownsomething');
            expect(ct).to.equal(undefined);
        });
    });

    describe('getEditableContentType', () => {
        it('should allow editing application/json as JSON', () => {
            const ct = getContentType('application/json');
            expect(ct).to.equal('json');
        });

        it('should not allow editing image/gif as an image', () => {
            const ct = getEditableContentType('image/gif');
            expect(ct).to.equal(undefined);
        });
    });

    describe('getCompatibleTypes', () => {
        it('should detect standard base64 text', () => {
            const cts = getCompatibleTypes('text', 'text/plain', Buffer.from('FWTkm2+ZvMo=', 'ascii'));
            expect(cts).to.deep.equal({
                preferredContentType: 'text',
                availableContentTypes: ['text', 'base64', 'raw']
            });
        });

        it('should detect URL-safe (without padding) base64 text', () => {
            const cts = getCompatibleTypes('text', 'text/plain', Buffer.from('FWTkm2-ZvMo', 'ascii'));
            expect(cts).to.deep.equal({
                preferredContentType: 'text',
                availableContentTypes: ['text', 'base64', 'raw']
            });
        });

        it('should work even if first character is not ASCII', () => {
            const cts = getCompatibleTypes('raw', 'application/octet-stream', Buffer.from('1f8d08', 'hex')); // GZIP magic bytes
            expect(cts).to.deep.equal({
                preferredContentType: 'raw',
                availableContentTypes: ['raw', 'text']
            });
        });

        it('should flag application/grpc as compatible with [grpc-proto,text,raw]', () => {
            const cts = getCompatibleTypes('grpc-proto', 'application/grpc', undefined);
            expect(cts).to.deep.equal({
                preferredContentType: 'grpc-proto',
                availableContentTypes: ['grpc-proto', 'text', 'raw']
            });
        });

        it('should flag application/grpc+proto as compatible with [grpc-proto,text,raw]', () => {
            const cts = getCompatibleTypes('grpc-proto', 'application/grpc+proto', undefined);
            expect(cts).to.deep.equal({
                preferredContentType: 'grpc-proto',
                availableContentTypes: ['grpc-proto', 'text', 'raw']
            });
        });

        it('should flag application/grpc+json as compatible with [grpc-proto,text,raw]', () => {
            const cts = getCompatibleTypes('json', 'application/grpc+json', undefined);
            expect(cts).to.deep.equal({
                preferredContentType: 'json',
                availableContentTypes: ['json', 'text', 'raw']
            });
        });

        it('should detect & override default for undeclared protobuf', () => {
            const cts = getCompatibleTypes('raw', 'application/octet-stream', Buffer.from('0a0b48656c6c6f20576f726c64', 'hex'));
            expect(cts).to.deep.equal({
                preferredContentType: 'protobuf',
                availableContentTypes: ['raw', 'protobuf', 'text']
            });
        });

        it('should not detect truncated protobuf as protobuf', () => {
            // Starts like the message above, but the last field is cut short:
            const cts = getCompatibleTypes('raw', 'application/octet-stream', Buffer.from('0a0b48656c6c6f', 'hex'));
            expect(cts).to.deep.equal({
                preferredContentType: 'raw',
                availableContentTypes: ['raw', 'text']
            });
        });

        it('should not detect text that starts with a tab as protobuf', () => {
            // A leading tab (0x09) looks like field 1 with a 64-bit value:
            const cts = getCompatibleTypes('raw', 'application/octet-stream', Buffer.from('\tindented text, not protobuf\n'));
            expect(cts).to.deep.equal({
                preferredContentType: 'raw',
                availableContentTypes: ['raw', 'text']
            });
        });

        it('should detect & override default for undeclared grpc+proto', () => {
            const cts = getCompatibleTypes('raw', 'application/octet-stream', Buffer.from('AAAAAAIIAQ==', 'base64'));
            expect(cts).to.deep.equal({
                preferredContentType: 'grpc-proto',
                availableContentTypes: ['raw', 'grpc-proto', 'text']
            });
        });

        it('should detect & override default for undeclared XML', () => {
            const cts = getCompatibleTypes('text', 'text/plain', Buffer.from('<hello></hello', 'ascii'));
            expect(cts).to.deep.equal({
                preferredContentType: 'xml',
                availableContentTypes: ['text', 'xml', 'html', 'raw']
            });
        });

        it('should detect & override default for undeclared JSON', () => {
            const cts = getCompatibleTypes('text', 'text/plain', Buffer.from('{"hello": "world"}', 'ascii'));
            expect(cts).to.deep.equal({
                preferredContentType: 'json',
                availableContentTypes: ['text', 'json', 'raw']
            });
        });

        it('should detect & override default for undeclared JSON records', () => {
            const cts = getCompatibleTypes('text', 'text/plain', Buffer.from('{"hello": "world"}\n[]\n', 'ascii'));
            expect(cts).to.deep.equal({
                preferredContentType: 'json-records',
                availableContentTypes: ['text', 'json-records', 'raw']
            });
        });
    });
});

// wirepane: bodies that used to open as garbled text, a URL-encoded table or mangled JSON
describe('getCompatibleTypes for binary and JSON-like bodies', () => {

    // An MPEG transport stream: 188 byte packets that each start with 0x47
    const makeVideoSegment = (size: number) => {
        const segment = Buffer.alloc(size, 0x5a);
        for (let i = 0; i < size; i += 188) segment.writeUInt8(0x47, i);
        segment.writeUInt8(0x00, 1); // The packet header has low bytes, like 0x00 and 0x10
        segment.writeUInt8(0x10, 3);
        return segment;
    };

    it('should open a big binary body with an unknown type as a summary, not text', () => {
        const cts = getCompatibleTypes('text', 'video/MP2T', makeVideoSegment(200_000));
        expect(cts).to.deep.equal({
            preferredContentType: 'summary',
            availableContentTypes: ['text', 'summary', 'raw']
        });
    });

    it('should open a big binary body of any default type as a summary', () => {
        const cts = getCompatibleTypes('raw', 'application/octet-stream', makeVideoSegment(200_000));
        expect(cts.preferredContentType).to.equal('summary');
        expect(cts.availableContentTypes).to.include.members(['summary', 'text', 'raw']);
    });

    it('should open a small binary body with a text type as hex', () => {
        const cts = getCompatibleTypes('text', 'video/MP2T', makeVideoSegment(5_000));
        expect(cts).to.deep.equal({
            preferredContentType: 'raw',
            availableContentTypes: ['text', 'raw']
        });
    });

    it('should open protobuf sent as a form in the protobuf view, not as a table', () => {
        // Field 1 is a varint (150), field 2 the string "hello":
        const body = Buffer.from('089601120568656c6c6f', 'hex');
        const cts = getCompatibleTypes(
            'url-encoded',
            'application/x-www-form-urlencoded',
            body
        );
        expect(cts).to.deep.equal({
            preferredContentType: 'protobuf',
            availableContentTypes: ['url-encoded', 'protobuf', 'text', 'raw']
        });
    });

    it('should open binary that is not protobuf sent as a form as hex', () => {
        const body = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
        const cts = getCompatibleTypes('url-encoded', 'application/x-www-form-urlencoded', body);
        expect(cts.preferredContentType).to.equal('raw');
    });

    it('should keep a real form as a URL-encoded table', () => {
        const cts = getCompatibleTypes(
            'url-encoded',
            'application/x-www-form-urlencoded',
            Buffer.from('a=1&b=hello%20world&c=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82')
        );
        expect(cts).to.deep.equal({
            preferredContentType: 'url-encoded',
            availableContentTypes: ['url-encoded', 'text', 'raw']
        });
    });

    it('should keep images, text and JSON as they are', () => {
        const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
        expect(getCompatibleTypes('image', 'image/png', png).preferredContentType).to.equal('image');

        const text = Buffer.from('Привет, мир!\nSecond line\tTabbed');
        expect(getCompatibleTypes('text', 'text/plain', text).preferredContentType).to.equal('text');

        const json = Buffer.from('{"a": [1, 2, 3]}');
        expect(getCompatibleTypes('json', 'application/json', json).preferredContentType).to.equal('json');
    });

    it('should keep text in a legacy charset as text', () => {
        // "Привет" in windows-1251 has no control characters, just high bytes
        const body = Buffer.from('cff0e8e2e5f2', 'hex');
        expect(getCompatibleTypes('text', 'text/plain', body).preferredContentType).to.equal('text');
    });

    it('should keep a multipart body as text, even with a binary file part', () => {
        const body = Buffer.concat([
            Buffer.from('--x\r\nContent-Disposition: form-data; name="f"; filename="a.bin"\r\n\r\n'),
            Buffer.from([0, 1, 2, 3, 4]),
            Buffer.from('\r\n--x--\r\n')
        ]);
        const cts = getCompatibleTypes('text', 'multipart/form-data; boundary=x', body);
        expect(cts.preferredContentType).to.equal('text');
    });

    it('should not open text that only starts like JSON as JSON', () => {
        const cts = getCompatibleTypes('text', 'text/plain', Buffer.from('404 page not found'));
        expect(cts).to.deep.equal({
            preferredContentType: 'text',
            availableContentTypes: ['text', 'json', 'raw']
        });
    });

    it('should open non-strict JSON sent as text in the JSON view', () => {
        const cts = getCompatibleTypes('text', 'text/plain', Buffer.from("{app_id:'1:2:ios:3'}"));
        expect(cts).to.deep.equal({
            preferredContentType: 'json',
            availableContentTypes: ['text', 'json', 'raw']
        });
    });
});
