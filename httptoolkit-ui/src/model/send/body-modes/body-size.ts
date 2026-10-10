import { getHeaderValue } from '../../http/headers';

import { RequestInput } from '../send-request-model';
import { MultipartField } from '../send-extras';
import {
    encodeFormBody,
    graphqlPayload,
    MULTIPART_BOUNDARY_PREFIX,
    multipartBoundaryOf,
    quoteMultipartValue
} from '../build-request';

/**
 * The size of a request body as it will be sent, for the body card's size pill. It's worked
 * out from the tab's data without building the body, so file bytes aren't read for it.
 */

// Same length as the boundary build-request.ts makes when the request has none
const PLACEHOLDER_BOUNDARY = MULTIPART_BOUNDARY_PREFIX + '0'.repeat(16);

const byteLength = (text: string) => Buffer.byteLength(text, 'utf8');

const partHeadSize = (boundary: string, headers: string[]) =>
    byteLength(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`);

// Mirrors encodeMultipartBody (build-request.ts), which tests check it against
export function multipartBodySize(fields: readonly MultipartField[], boundary: string): number {
    let size = 0;

    for (const field of fields) {
        if (!field.enabled || field.name === '') continue;
        const disposition = `Content-Disposition: form-data; name="${quoteMultipartValue(field.name)}"`;

        if (field.kind === 'text') {
            const headers = field.contentType
                ? [disposition, `Content-Type: ${field.contentType}`]
                : [disposition];
            size += partHeadSize(boundary, headers) + byteLength(field.value) + 2;
            continue;
        }

        for (const file of field.files) {
            size += partHeadSize(boundary, [
                `${disposition}; filename="${quoteMultipartValue(file.name)}"`,
                `Content-Type: ${field.contentType || file.contentType || 'application/octet-stream'}`
            ]) + file.size + 2;
        }
    }

    return size + byteLength(`--${boundary}--\r\n`);
}

function graphqlBodySize(input: RequestInput): number {
    if (['GET', 'HEAD'].includes(input.method.toUpperCase())) return 0; // Sent in the URL

    const { graphql } = input.extras;
    try {
        return byteLength(JSON.stringify(graphqlPayload(graphql)));
    } catch {
        // Variables that aren't valid JSON yet: roughly what's been written
        return byteLength(graphql.query) + byteLength(graphql.variables);
    }
}

// Before any Content-Encoding, like the size shown for raw bodies
export function getSendBodySize(input: RequestInput): number {
    const { extras } = input;

    switch (extras.bodyMode) {
        case 'form':
            return byteLength(encodeFormBody(extras.formFields));
        case 'multipart':
            return multipartBodySize(
                extras.multipartFields,
                multipartBoundaryOf(getHeaderValue(input.headers, 'content-type')) ?? PLACEHOLDER_BOUNDARY
            );
        case 'binary':
            return extras.binaryFile?.size ?? 0;
        case 'graphql':
            return graphqlBodySize(input);
        case 'raw':
            return input.rawBody.decoded.byteLength;
    }
}
