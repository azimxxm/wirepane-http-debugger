import * as stream from 'stream';
import * as tls from 'tls';
import type * as http from 'http';
import type { EventEmitter } from 'events';
import { randomUUID } from 'crypto';
import WebSocket from 'ws';
import { StatusError } from '@httptoolkit/util';

// The same Mockttp passthrough helpers as http-client.ts, so WebSocket connections use the
// same TLS settings as sent requests and proxied traffic:
import { getUpstreamTlsOptions as getUpstreamMockttpTlsOptions } from 'mockttp/dist/rules/passthrough-handling';
import { getEffectivePort } from 'mockttp/dist/util/url';

import { getUpstreamProxyAgent } from './upstream-proxy';
import { HttpClient, pairFlatRawHeaders } from './http-client';
import { RawHeaders, RequestOptions } from './client-types';
import * as fs from '../util/fs';

/**
 * Wirepane: the WebSocket client behind Send. The server opens the connection (not the
 * browser), so proxy settings, upstream CAs, client certificates, DNS servers and ignored
 * HTTPS errors all work exactly as they do for HTTP requests sent from Send.
 *
 * Each connection has an id and a stream of events (WebSocketEvent), which ends once the
 * socket is closed or failed to open.
 */

export interface WebSocketRequestDefinition {
    // ws:// or wss://. http:// and https:// work too, like they do in browsers.
    url: string;
    // Sent with the opening handshake. The headers the handshake itself needs (Connection,
    // Upgrade, Sec-WebSocket-Key...) are always set here instead.
    headers: RawHeaders;
    // Subprotocols to offer. If unset, they're read from a Sec-WebSocket-Protocol header.
    protocols?: string[];
}

export type WebSocketEvent =
    | WebSocketOpenEvent
    | WebSocketMessageEvent
    | WebSocketCloseEvent
    | WebSocketErrorEvent;

export interface WebSocketOpenEvent {
    type: 'ws-open';
    id: string;
    // The subprotocol the server picked ('' if none)
    protocol: string;
    extensions: string;
    statusCode: number;
    statusMessage: string;
    // The handshake response headers
    headers: RawHeaders;
    timestamp: number;
}

export interface WebSocketMessageEvent {
    type: 'ws-message';
    data: Buffer;
    isBinary: boolean;
    timestamp: number;
}

export interface WebSocketCloseEvent {
    type: 'ws-close';
    code: number;
    reason: string;
    timestamp: number;
}

export interface WebSocketErrorEvent {
    type: 'error';
    error: { code?: string, message: string };
    // Set when the server answered the handshake with something other than a 101, e.g. a 401
    response?: FailedHandshakeResponse;
    timestamp: number;
}

export interface FailedHandshakeResponse {
    statusCode: number;
    statusMessage: string;
    headers: RawHeaders;
    body: Buffer;
    // True when the body was longer than MAX_FAILED_HANDSHAKE_BODY, and was cut there
    bodyTruncated?: boolean;
}

// Long enough for slow servers, short enough that a server that never answers doesn't
// leave the connection waiting forever
const HANDSHAKE_TIMEOUT_MS = 30_000;
// Failed handshakes keep their response body (to show why), up to this size
const MAX_FAILED_HANDSHAKE_BODY = 1024 * 1024;
const FAILED_HANDSHAKE_BODY_TIMEOUT_MS = 5_000;
// When the server stops, open sockets get this long to close cleanly
const CLOSE_ALL_TIMEOUT_MS = 1_000;

// Close codes a client may send (the same rule as the ws package)
export function isValidCloseCode(code: number) {
    return Number.isInteger(code) && (
        (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
        (code >= 3000 && code <= 4999)
    );
}

// The close reason is sent in a control frame, which can't be bigger than 125 bytes
const MAX_CLOSE_REASON_BYTES = 123;

// Headers the ws package sets itself for the opening handshake. Sending the tab's copies
// too would duplicate them (e.g. after resending a captured WebSocket from View).
const HANDSHAKE_MANAGED_HEADERS = [
    'connection',
    'upgrade',
    'sec-websocket-key',
    'sec-websocket-version',
    'sec-websocket-extensions',
    'sec-websocket-protocol',
    // The handshake has no body
    'content-length',
    'transfer-encoding'
];

// RFC 9110 token characters
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function parseSubprotocols(headerValues: string[]): string[] {
    return headerValues
        .flatMap((value) => value.split(','))
        .map((protocol) => protocol.trim())
        .filter((protocol) => protocol.length > 0);
}

/**
 * Turns the tab's headers into the ws package's header object. Repeated headers are
 * joined, as HTTP allows (cookies with '; ', the rest with ', '), and the subprotocols
 * come from Sec-WebSocket-Protocol unless they're given separately.
 */
export function getHandshakeHeaders(rawHeaders: RawHeaders, protocols: string[] | undefined) {
    const headers: { [name: string]: string } = {};
    const namesByLowerCase: { [lowerCaseName: string]: string } = {};
    const protocolHeaderValues: string[] = [];

    for (const [name, value] of rawHeaders) {
        if (!HEADER_NAME_PATTERN.test(name)) {
            throw new StatusError(400, name
                ? `"${name}" isn't a valid header name.`
                : `A handshake header with the value "${value}" has no name. Name it, or remove it.`
            );
        }

        const lowerCaseName = name.toLowerCase();

        if (lowerCaseName === 'sec-websocket-protocol') protocolHeaderValues.push(value);
        if (HANDSHAKE_MANAGED_HEADERS.includes(lowerCaseName)) continue;

        const existingName = namesByLowerCase[lowerCaseName];
        if (existingName === undefined) {
            namesByLowerCase[lowerCaseName] = name;
            headers[name] = value;
        } else {
            const separator = lowerCaseName === 'cookie' ? '; ' : ', ';
            headers[existingName] = `${headers[existingName]}${separator}${value}`;
        }
    }

    return {
        headers,
        protocols: protocols ?? parseSubprotocols(protocolHeaderValues)
    };
}

function parseWebSocketUrl(input: string): URL {
    let url: URL;
    try {
        url = new URL(input);
    } catch (error) {
        throw new StatusError(400, `Invalid WebSocket URL: ${input}`);
    }

    // Like browsers do, http(s) URLs connect over ws(s)
    if (url.protocol === 'http:') url.protocol = 'ws:';
    if (url.protocol === 'https:') url.protocol = 'wss:';

    if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
        throw new StatusError(400, `WebSocket URLs start with ws:// or wss://, but this one is ${url.protocol}`);
    }
    if (url.hash) {
        throw new StatusError(400, 'WebSocket URLs can\'t contain a #fragment');
    }

    return url;
}

function toBuffer(data: WebSocket.RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (Array.isArray(data)) return Buffer.concat(data);
    return Buffer.from(data);
}

// Reads the body of a failed handshake response (e.g. a 401's explanation), up to a limit
function readFailedHandshake(response: http.IncomingMessage): Promise<FailedHandshakeResponse> {
    return new Promise((resolve) => {
        const chunks: Buffer[] = [];
        let size = 0;
        let truncated = false;

        const done = () => resolve({
            statusCode: response.statusCode ?? 0,
            statusMessage: response.statusMessage ?? '',
            headers: pairFlatRawHeaders(response.rawHeaders),
            body: Buffer.concat(chunks),
            ...(truncated ? { bodyTruncated: true } : {})
        });

        response.on('data', (chunk: Buffer) => {
            if (truncated) return;

            const room = MAX_FAILED_HANDSHAKE_BODY - size;
            chunks.push(chunk.subarray(0, room));
            size += Math.min(chunk.byteLength, room);

            if (chunk.byteLength > room) {
                truncated = true;
                done();
            }
        });
        response.on('end', done);
        // Whatever arrived before an error or a slow body is still worth showing:
        response.on('error', done);
        response.on('close', done);
        setTimeout(done, FAILED_HANDSHAKE_BODY_TIMEOUT_MS).unref();
    });
}

export class WebSocketClient {

    private readonly sockets = new Map<string, WebSocket>();

    constructor(
        // For its DNS lookups & rule parameters (Docker proxy settings), shared with Send
        private httpClient: HttpClient
    ) {}

    get openCount() {
        return this.sockets.size;
    }

    async open(
        request: WebSocketRequestDefinition,
        options: RequestOptions
    ): Promise<{ id: string, events: stream.Readable }> {
        const url = parseWebSocketUrl(request.url);
        const isSecure = url.protocol === 'wss:';

        // As in http-client.ts, each option closely matches the passthrough rules, with the
        // values themselves calculated by the UI (which owns the passthrough settings).
        const effectivePort = getEffectivePort(url);
        const additionalCAs = options.additionalTrustedCAs || options.trustAdditionalCAs;

        const agent = await getUpstreamProxyAgent({
            hostname: url.hostname,
            port: effectivePort,
            proxyConfig: options.proxyConfig,
            ruleParameters: this.httpClient.ruleParameters
        });

        const { headers, protocols } = getHandshakeHeaders(request.headers ?? [], request.protocols);

        const socketOptions = {
            headers,
            agent,
            lookup: this.httpClient.getDns(options.lookupOptions?.servers),
            handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
            // Like browsers: a redirect is a failed handshake, shown with its Location header
            followRedirects: false,

            ...(isSecure ? {
                // Proxy agents can't always tell that the target is TLS, as ws doesn't set
                // a protocol in the request options:
                secureEndpoint: true,
                ...getUpstreamMockttpTlsOptions({
                    hostname: url.hostname,
                    port: effectivePort,

                    ignoreHostHttpsErrors: options.ignoreHostHttpsErrors ?? [],
                    clientCertificateHostMap: options.clientCertificate
                        ? { '*': options.clientCertificate }
                        : {},
                    trustedCAs: additionalCAs
                        ? tls.rootCertificates.concat(additionalCAs.map(({ cert }) => cert))
                        : undefined
                })
            } : {})
        } as WebSocket.ClientOptions; // Lookup, servername & TLS fingerprint options aren't in its types

        let socket: WebSocket;
        try {
            socket = new WebSocket(url, protocols, socketOptions);
        } catch (error: any) {
            // Thrown straight away for invalid input, e.g. a subprotocol with spaces in it
            throw new StatusError(400, error.message ?? String(error));
        }

        const id = randomUUID();
        this.sockets.set(id, socket);

        if (options.keyLogFile) logTlsKeys(socket, options.keyLogFile);

        return { id, events: this.trackEvents(id, socket) };
    }

    // Turns the socket's events into a stream, which ends when the socket is gone
    private trackEvents(id: string, socket: WebSocket): stream.Readable {
        const events = new stream.Readable({
            objectMode: true,
            read() {} // Can't pull data - we push events as they happen instead
        });

        let ended = false;
        let opened = false;
        let closeReported = false;
        // Set once a failed handshake is reported, so the errors that follow aren't repeated
        let failed = false;
        let handshakeResponse: http.IncomingMessage | undefined;

        const push = (event: WebSocketEvent) => {
            if (!ended) events.push(event);
        };
        const end = () => {
            this.sockets.delete(id);
            if (ended) return;
            ended = true;
            events.push(null);
        };
        const reportClose = (code: number, reason: Buffer) => {
            // A socket that never opened only reports its error, not a close
            if (!opened || closeReported) return;
            closeReported = true;
            push({
                type: 'ws-close',
                code,
                reason: reason.toString('utf8'),
                timestamp: Date.now()
            });
        };

        socket.on('upgrade', (response) => {
            handshakeResponse = response;
        });

        socket.on('open', () => {
            opened = true;

            // ws only emits 'close' once the server has closed the TCP connection too, which
            // some servers (or their proxies) take seconds to do. The server's close frame is
            // the real end of the conversation, so that's when the close is reported. ws only
            // exposes that moment on its receiver.
            const receiver = (socket as unknown as { _receiver?: EventEmitter })._receiver;
            receiver?.on('conclude', reportClose);

            push({
                type: 'ws-open',
                id,
                protocol: socket.protocol,
                extensions: socket.extensions,
                statusCode: handshakeResponse?.statusCode ?? 101,
                statusMessage: handshakeResponse?.statusMessage ?? 'Switching Protocols',
                headers: handshakeResponse ? pairFlatRawHeaders(handshakeResponse.rawHeaders) : [],
                timestamp: Date.now()
            });
        });

        socket.on('message', (data, isBinary) => {
            push({
                type: 'ws-message',
                data: toBuffer(data),
                isBinary,
                timestamp: Date.now()
            });
        });

        // The server answered the handshake without upgrading (e.g. 401, 404 or a redirect).
        // With this listener, ws leaves the response to us instead of failing straight away.
        socket.on('unexpected-response', (_request, response) => {
            failed = true;

            readFailedHandshake(response).then((failedResponse) => {
                push({
                    type: 'error',
                    error: {
                        code: 'unexpected-response',
                        message: `The server answered the handshake with ${failedResponse.statusCode}${
                            failedResponse.statusMessage ? ` ${failedResponse.statusMessage}` : ''
                        } instead of upgrading to a WebSocket`
                    },
                    response: failedResponse,
                    timestamp: Date.now()
                });
                end();
                socket.terminate(); // Ends the handshake request. Its errors are ignored now.
            });
        });

        socket.on('error', (error: Error & { code?: string }) => {
            if (failed && !opened) return; // Already reported
            if (!opened) failed = true;

            push({
                type: 'error',
                error: {
                    code: error.code,
                    message: error.message
                },
                timestamp: Date.now()
            });
        });

        socket.on('close', (code, reason) => {
            reportClose(code, reason);
            end();
        });

        return events;
    }

    private getSocket(id: string): WebSocket {
        const socket = this.sockets.get(id);
        if (!socket) throw new StatusError(404, `There's no WebSocket with id ${id}. It may have closed already.`);
        return socket;
    }

    async send(id: string, data: Buffer, isBinary: boolean): Promise<void> {
        const socket = this.getSocket(id);
        if (socket.readyState !== WebSocket.OPEN) {
            throw new StatusError(409, 'This WebSocket isn\'t open, so it can\'t send messages.');
        }

        await new Promise<void>((resolve, reject) => {
            socket.send(data, { binary: isBinary }, (error) => error ? reject(error) : resolve());
        });
    }

    close(id: string, code?: number, reason?: string) {
        const socket = this.getSocket(id);

        if (code !== undefined && !isValidCloseCode(code)) {
            throw new StatusError(400, `${code} isn't a close code a client can send. Use 1000, or a code from 3000 to 4999.`);
        }
        if (reason && Buffer.byteLength(reason) > MAX_CLOSE_REASON_BYTES) {
            throw new StatusError(400, `The close reason can be at most ${MAX_CLOSE_REASON_BYTES} bytes long.`);
        }

        if (socket.readyState === WebSocket.CONNECTING) {
            socket.terminate();
        } else {
            socket.close(code ?? 1000, reason);
        }
    }

    // Called when the opener stops listening for events (it closed the event stream, or went
    // away), so nobody would see what happens next on this socket.
    abandon(id: string) {
        const socket = this.sockets.get(id);
        if (!socket) return;

        if (socket.readyState === WebSocket.OPEN) {
            socket.close(1001, 'Going away');
        } else {
            socket.terminate();
        }
    }

    // When the server stops: close everything, cleanly if possible
    async closeAll(): Promise<void> {
        await Promise.all([...this.sockets.values()].map((socket) => new Promise<void>((resolve) => {
            if (socket.readyState === WebSocket.CLOSED) return resolve();

            socket.once('close', () => resolve());
            const timeout = setTimeout(() => {
                socket.terminate();
                resolve();
            }, CLOSE_ALL_TIMEOUT_MS);
            timeout.unref();

            if (socket.readyState === WebSocket.OPEN) {
                socket.close(1001, 'Wirepane is shutting down');
            } else {
                socket.terminate();
            }
        })));
    }

}

// TLS keys are only logged during the TLS handshake, before the WebSocket handshake finishes,
// so this hooks into the handshake request. ws doesn't expose it, apart from as _req.
function logTlsKeys(socket: WebSocket, keyLogFile: string) {
    const handshakeRequest = (socket as unknown as { _req?: http.ClientRequest })._req;

    handshakeRequest?.on('socket', (connection) => {
        connection.on('keylog', (line: Buffer) => {
            fs.appendOrCreateFile(keyLogFile, line).catch((error: Error) => {
                console.warn(`Couldn't write TLS keys to ${keyLogFile}: ${error.message}`);
            });
        });
    });
}
