import { RawHeaders } from '../../types';
import { getHeaderValue, removeHeader, setHeaderValue } from '../http/headers';

import { RequestInput } from './send-request-model';
import { FileRef, FormField, GraphqlBody, MultipartField, SendExtras } from './send-extras';
import { sendFileStore } from './send-files';

/**
 * Turns a Send tab's form, multipart, binary or GraphQL body into the raw request that is
 * actually sent. It runs on every Send, after {{variables}} are filled in. Raw-mode
 * requests are returned as they are.
 */

// Why a request can't be built. The message is shown to the user, under the URL.
export class SendBuildError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SendBuildError';
    }
}

export const MULTIPART_BOUNDARY_PREFIX = '----WirepaneFormBoundary';

export function newMultipartBoundary() {
    return MULTIPART_BOUNDARY_PREFIX + crypto.randomUUID().replace(/-/g, '').slice(0, 16);
}

export function multipartBoundaryOf(contentType: string | undefined): string | undefined {
    if (!contentType || !/^\s*multipart\/form-data/i.test(contentType)) return undefined;
    const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    return match ? (match[1] ?? match[2]) : undefined;
}

const enabledFields = <T extends { enabled: boolean, name: string }>(fields: T[]) =>
    fields.filter((field) => field.enabled && field.name !== '');

export function encodeFormBody(fields: FormField[]): string {
    const params = new URLSearchParams();
    for (const field of enabledFields(fields)) params.append(field.name, field.value);
    return params.toString();
}

// As browsers do it (HTML spec, multipart/form-data encoding): quotes and newlines are escaped
const quoteMultipartValue = (value: string) =>
    value.replace(/"/g, '%22').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

async function readFile(file: FileRef): Promise<Buffer> {
    const bytes = await sendFileStore.get(file.fileId);
    if (!bytes) throw new SendBuildError(`The file "${file.name}" isn't available any more. Attach it again.`);
    return bytes;
}

export async function encodeMultipartBody(fields: MultipartField[], boundary: string): Promise<Buffer> {
    const chunks: Buffer[] = [];
    const addPart = (headers: string[], content: Buffer) => {
        chunks.push(Buffer.from(`--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n`));
        chunks.push(content);
        chunks.push(Buffer.from('\r\n'));
    };

    for (const field of enabledFields(fields)) {
        const disposition = `Content-Disposition: form-data; name="${quoteMultipartValue(field.name)}"`;

        if (field.kind === 'text') {
            addPart(
                field.contentType ? [disposition, `Content-Type: ${field.contentType}`] : [disposition],
                Buffer.from(field.value)
            );
            continue;
        }

        for (const file of field.files) {
            addPart([
                `${disposition}; filename="${quoteMultipartValue(file.name)}"`,
                `Content-Type: ${field.contentType || file.contentType || 'application/octet-stream'}`
            ], await readFile(file));
        }
    }

    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return Buffer.concat(chunks);
}

// The JSON a GraphQL request sends, with its variables parsed
export function graphqlPayload(graphql: GraphqlBody): { query: string, variables?: unknown, operationName?: string } {
    const variablesText = graphql.variables.trim();
    let variables: unknown;
    if (variablesText) {
        try {
            variables = JSON.parse(variablesText);
        } catch (error: any) {
            throw new SendBuildError(`The GraphQL variables aren't valid JSON: ${error.message}`);
        }
    }

    return {
        query: graphql.query,
        ...(variables !== undefined ? { variables } : {}),
        ...(graphql.operationName ? { operationName: graphql.operationName } : {})
    };
}

// GraphQL over GET sends the query in the URL (GraphQL over HTTP spec)
function withGraphqlQueryParams(url: string, graphql: GraphqlBody): string {
    const payload = graphqlPayload(graphql);
    const parsed = new URL(url);
    parsed.searchParams.set('query', payload.query);
    if (payload.variables !== undefined) parsed.searchParams.set('variables', JSON.stringify(payload.variables));
    if (payload.operationName) parsed.searchParams.set('operationName', payload.operationName);
    return parsed.toString();
}

interface BuiltBody {
    url?: string;
    body: Buffer;
    // Used when the request has no Content-Type header. Multipart always sets its own.
    defaultContentType?: string;
}

async function buildBody(input: RequestInput, headers: RawHeaders): Promise<BuiltBody> {
    const { extras } = input;

    switch (extras.bodyMode) {
        case 'form':
            return {
                body: Buffer.from(encodeFormBody(extras.formFields)),
                defaultContentType: 'application/x-www-form-urlencoded'
            };
        case 'multipart': {
            const contentType = getHeaderValue(headers, 'content-type');
            let boundary = multipartBoundaryOf(contentType);
            if (!boundary) {
                boundary = newMultipartBoundary();
                setHeaderValue(headers, 'content-type', `multipart/form-data; boundary=${boundary}`);
            }
            return { body: await encodeMultipartBody(extras.multipartFields, boundary) };
        }
        case 'binary': {
            const file = extras.binaryFile;
            if (!file) throw new SendBuildError('Choose a file to send as the request body.');
            return {
                body: await readFile(file),
                defaultContentType: file.contentType || 'application/octet-stream'
            };
        }
        case 'graphql':
            if (['GET', 'HEAD'].includes(input.method.toUpperCase())) {
                return { url: withGraphqlQueryParams(input.url, extras.graphql), body: Buffer.alloc(0) };
            }
            return {
                body: Buffer.from(JSON.stringify(graphqlPayload(extras.graphql))),
                defaultContentType: 'application/json'
            };
        case 'raw':
            return { body: input.rawBody.decoded };
    }
}

export async function buildRequestForSend(input: RequestInput): Promise<RequestInput> {
    if (input.extras.sendsRawBody || input.extras.requestType !== 'http') return input;

    const headers: RawHeaders = input.headers.map(([name, value]) => [name, value]);
    const built = await buildBody(input, headers);

    if (built.defaultContentType && getHeaderValue(headers, 'content-type') === undefined) {
        setHeaderValue(headers, 'content-type', built.defaultContentType);
    }

    const request = new RequestInput({
        method: input.method,
        url: built.url ?? input.url,
        headers,
        requestContentType: input.requestContentType,
        rawBody: built.body,
        extras: SendExtras.from(input.extras)
    });

    // Content-Length follows the body as sent, after any Content-Encoding
    const encoded = await request.rawBody.encodingBestEffortPromise;
    if (!getHeaderValue(request.headers, 'transfer-encoding')) {
        if (encoded.byteLength) setHeaderValue(request.headers, 'content-length', encoded.byteLength.toString());
        else removeHeader(request.headers, 'content-length');
    }

    return request;
}
