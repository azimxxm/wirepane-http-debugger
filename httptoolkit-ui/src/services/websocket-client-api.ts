import { RawHeaders } from '../types';
import { byteStreamToLines } from '../util/streams';

import { DesktopApi, getServerPort } from './desktop-api';
import { waitUntilServerReady } from './server-api';

import type { RequestOptions } from '../model/send/send-request-model';

/**
 * Client for the server's WebSocket endpoints (httptoolkit-server/src/api/ws-client-api.ts).
 * The server opens the connection, so it uses Send's proxy, certificate & DNS settings.
 */

export interface WebSocketOpenRequest {
    url: string;
    headers: RawHeaders;
    protocols?: string[];
}

export interface FailedHandshakeResponse {
    statusCode: number;
    statusMessage: string;
    headers: RawHeaders;
    body: Buffer;
    bodyTruncated?: boolean;
}

export type WebSocketStreamEvent =
    | {
        type: 'ws-open',
        id: string,
        protocol: string,
        extensions: string,
        statusCode: number,
        statusMessage: string,
        headers: RawHeaders,
        timestamp: number
    }
    | { type: 'ws-message', data: Buffer, isBinary: boolean, timestamp: number }
    | { type: 'ws-close', code: number, reason: string, timestamp: number }
    | {
        type: 'error',
        error: { code?: string, message: string },
        response?: FailedHandshakeResponse,
        timestamp: number
    };

export class WebSocketApiError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly code?: string
    ) {
        super(message);
        this.name = 'WebSocketApiError';
    }
}

// Read at startup, while the page URL still has the token the desktop app put there
const authToken = DesktopApi.getServerAuthToken?.() ??
    new URLSearchParams(window.location.search).get('authToken') ??
    undefined;

// Sending a message or a close waits for the server, but not forever
const REQUEST_TIMEOUT_MS = 30_000;

async function readErrorMessage(response: Response): Promise<{ message?: string, code?: string }> {
    try {
        const body = await response.json() as { error?: { message?: string, code?: string } };
        return body.error ?? {};
    } catch {
        return {};
    }
}

async function post(path: string, body: object, signal: AbortSignal): Promise<Response> {
    await waitUntilServerReady();

    let response: Response;
    try {
        response = await fetch(`http://127.0.0.1:${getServerPort()}${path}`, {
            method: 'POST',
            headers: {
                ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
                'content-type': 'application/json'
            },
            body: JSON.stringify(body),
            signal
        });
    } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') throw error;
        const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
        throw new WebSocketApiError(isTimeout
            ? 'Wirepane\'s server took too long to answer. Try again in a moment.'
            : 'Couldn\'t reach Wirepane\'s server. Check that Wirepane is still running.'
        );
    }

    if (!response.ok) {
        const { message, code } = await readErrorMessage(response);
        throw new WebSocketApiError(
            message ?? `The server answered ${response.status} ${response.statusText}`,
            response.status,
            code
        );
    }

    return response;
}

// Buffers travel as base64, as for /client/send
function serializeOptions(options: RequestOptions) {
    return {
        ...options,
        ...(options.clientCertificate ? {
            clientCertificate: {
                ...options.clientCertificate,
                pfx: options.clientCertificate.pfx.toString('base64')
            }
        } : {})
    };
}

function parseEvent(line: string): WebSocketStreamEvent {
    const event = JSON.parse(line);

    if (event.type === 'ws-message') {
        return { ...event, data: Buffer.from(event.data, 'base64') };
    } else if (event.type === 'error' && event.response) {
        return { ...event, response: { ...event.response, body: Buffer.from(event.response.body, 'base64') } };
    } else {
        return event;
    }
}

/**
 * Opens a WebSocket. The result is its events, as they happen. The stream ends when the
 * socket closes (or fails to open), and aborting the signal closes the socket.
 */
export async function openWebSocket(
    request: WebSocketOpenRequest,
    options: RequestOptions,
    abortSignal: AbortSignal
): Promise<ReadableStream<WebSocketStreamEvent>> {
    const response = await post('/client/ws/open', {
        request,
        options: serializeOptions(options)
    }, abortSignal);

    if (!response.body) throw new WebSocketApiError('Wirepane\'s server didn\'t answer with any events');

    const lines = byteStreamToLines(response.body).getReader();
    return new ReadableStream<WebSocketStreamEvent>({
        async pull(controller) {
            while (true) {
                const { done, value } = await lines.read();
                if (done) return controller.close();
                if (!value.trim()) continue;

                controller.enqueue(parseEvent(value));
                return;
            }
        },
        cancel(reason) {
            return lines.cancel(reason);
        }
    });
}

export async function sendWebSocketMessage(id: string, data: Buffer, isBinary: boolean): Promise<void> {
    await post(`/client/ws/${encodeURIComponent(id)}/send`, {
        data: data.toString('base64'),
        isBinary
    }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
}

export async function closeWebSocket(id: string, code?: number, reason?: string): Promise<void> {
    await post(`/client/ws/${encodeURIComponent(id)}/close`, {
        ...(code !== undefined ? { code } : {}),
        ...(reason ? { reason } : {})
    }, AbortSignal.timeout(REQUEST_TIMEOUT_MS));
}
