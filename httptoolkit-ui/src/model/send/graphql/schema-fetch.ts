import { GraphQLSchema } from 'graphql';

import { RawHeaders } from '../../../types';
import { asHeaderArray, getHeaderValue, getHeaderValues } from '../../http/headers';
import { decodeBody } from '../../../services/ui-worker-api';
import * as ServerApi from '../../../services/server-api';

import { RequestInput, SendRequest } from '../send-request-model';
import { ResponseHeadEvent, ResponseStreamEvent } from '../send-response-model';
import type { SendStore } from '../send-store';
import {
    GraphqlSchemaError,
    INTROSPECTION_OPERATION_NAME,
    INTROSPECTION_QUERY,
    IntrospectionResponse,
    parseIntrospectionResponse
} from './introspection';

/**
 * Fetching a GraphQL schema with an introspection query. It goes through the same server
 * path as Send (`/client/send`), so the proxy, certificates and {{variables}} work as for
 * the tab's own requests.
 */

// These describe the tab's own body. The introspection request has its own JSON body.
const BODY_HEADERS = ['content-type', 'content-length', 'transfer-encoding', 'content-encoding'];

// A copy of the tab's request (same URL & headers) that sends the introspection query
export function buildIntrospectionRequest(request: RequestInput): RequestInput {
    const headers: RawHeaders = request.headers
        .filter(([name]) => !BODY_HEADERS.includes(name.toLowerCase()))
        .map(([name, value]) => [name, value]);

    headers.push(['content-type', 'application/json']);
    if (getHeaderValue(headers, 'accept') === undefined) {
        headers.push(['accept', 'application/graphql-response+json, application/json']);
    }

    return new RequestInput({
        method: 'POST',
        url: request.url,
        headers,
        requestContentType: 'json',
        rawBody: Buffer.alloc(0),
        extras: {
            requestType: 'http',
            bodyMode: 'graphql',
            graphql: {
                query: INTROSPECTION_QUERY,
                variables: '',
                operationName: INTROSPECTION_OPERATION_NAME
            }
        }
    });
}

// Reads Send's response events to the end, and decodes the body
export async function readIntrospectionResponse(
    responseStream: ReadableStream<ResponseStreamEvent>
): Promise<IntrospectionResponse> {
    const reader = responseStream.getReader();
    let head: ResponseHeadEvent | undefined;
    const bodyParts: Buffer[] = [];

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        if (value.type === 'response-head') {
            head = value;
        } else if (value.type === 'response-body-part') {
            bodyParts.push(value.rawBody);
        } else if (value.type === 'error') {
            const { message, code } = value.error;
            throw new GraphqlSchemaError(
                `The request failed: ${message || 'unknown error'}${code ? ` (${code})` : ''}`
            );
        }
    }

    if (!head) throw new GraphqlSchemaError('The connection closed before the server answered.');

    const encodings = asHeaderArray(getHeaderValues(head.headers, 'content-encoding'));
    let body: Buffer;
    try {
        body = (await decodeBody(Buffer.concat(bodyParts), encodings)).decoded;
    } catch (error: any) {
        throw new GraphqlSchemaError(`The response body couldn't be decoded: ${error?.message ?? error}`);
    }

    return {
        statusCode: head.statusCode,
        statusMessage: head.statusMessage,
        body: body.toString('utf8')
    };
}

export async function fetchGraphqlSchema(
    sendStore: SendStore,
    sendRequest: SendRequest,
    abortSignal: AbortSignal
): Promise<GraphQLSchema> {
    // Collections fill in {{variables}} and auth here, then the JSON body is built
    const request = await sendStore.prepareRequestInput({
        ...sendRequest,
        request: buildIntrospectionRequest(sendRequest.request)
    });
    if (!request) {
        throw new GraphqlSchemaError("The schema request couldn't be built. The reason is shown under the URL.");
    }

    let url: URL;
    try {
        url = new URL(request.url);
    } catch {
        throw new GraphqlSchemaError('Enter a full URL, like https://example.com/graphql, to fetch its schema.');
    }

    const rawBody = await request.rawBody.encodingBestEffortPromise;
    const responseStream = await ServerApi.sendRequest(
        {
            url: request.url,
            method: request.method,
            headers: request.headers,
            rawBody
        },
        sendStore.getRequestOptions(url),
        abortSignal
    );

    return parseIntrospectionResponse(await readIntrospectionResponse(responseStream));
}
