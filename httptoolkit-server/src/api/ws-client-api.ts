import express from 'express';
import type { Application, NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorLike, StatusError } from '@httptoolkit/util';

import { logError } from '../error-tracking';
import { addShutdownHandler } from '../shutdown';
import { HttpClient } from '../client/http-client';
import { RawHeaders, RequestOptions } from '../client/client-types';
import {
    WebSocketClient,
    WebSocketEvent,
    WebSocketRequestDefinition
} from '../client/ws-client';

/**
 * Wirepane: REST endpoints for Send's WebSocket client, in the same style as /client/send.
 *
 *   POST /client/ws/open        { request: { url, headers?, protocols? }, options? }
 *                               -> an NDJSON stream of events, one JSON object per line:
 *                                  { type: 'ws-open', id, protocol, extensions, statusCode,
 *                                    statusMessage, headers, timestamp }
 *                                  { type: 'ws-message', data (base64), isBinary, timestamp }
 *                                  { type: 'ws-close', code, reason, timestamp }
 *                                  { type: 'error', error: { code?, message }, timestamp,
 *                                    response?: { statusCode, statusMessage, headers,
 *                                                 body (base64), bodyTruncated? } }
 *                                  The stream ends after ws-close, or after an error before
 *                                  the socket opened. Closing it closes the socket.
 *   POST /client/ws/:id/send    { data (base64), isBinary? } -> { success: true }
 *   POST /client/ws/:id/close   { code?, reason? } -> { success: true }
 *
 * The options are Send's request options (proxy, CAs, client certificate, DNS servers,
 * ignored HTTPS errors), as for /client/send. Timestamps are milliseconds since the epoch.
 * Errors are { error: { code?, message } } with a 4xx/5xx status, like the rest of the API.
 *
 * The API server registers these after its Origin and auth token checks, and before its
 * default JSON parser, so messages can be bigger than that parser allows.
 */

const MAX_BODY_SIZE = '64mb';

export function exposeWebSocketClientAPI(server: Application, httpClient: HttpClient) {
    const client = new WebSocketClient(httpClient);
    addShutdownHandler(() => client.closeAll());

    const parseJson = express.json({ limit: MAX_BODY_SIZE });

    server.post('/client/ws/open', parseJson, handle(async (req, res) => {
        const { request, options } = parseOpenRequest(req.body);

        let openerGone = false;
        res.on('close', () => { openerGone = true; });

        const { id, events } = await client.open(request, options);

        // If the opener stops reading (or goes away), nobody would see this socket any more
        if (openerGone) return client.abandon(id);
        res.on('close', () => client.abandon(id));

        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        // Answer straight away, so the opener knows it's connecting (events come later)
        res.flushHeaders();
        events.on('data', (event: WebSocketEvent) => {
            res.write(JSON.stringify(serializeEvent(event)) + '\n');
        });
        events.on('end', () => res.end());
    }));

    server.post('/client/ws/:id/send', parseJson, handle(async (req, res) => {
        const body = isRecord(req.body) ? req.body : {};
        if (typeof body.data !== 'string') {
            throw new StatusError(400, 'Expected a JSON body like { "data": "<base64>", "isBinary": false }');
        }
        if (body.isBinary !== undefined && typeof body.isBinary !== 'boolean') {
            throw new StatusError(400, 'isBinary must be true or false');
        }

        await client.send(socketIdOf(req), Buffer.from(body.data, 'base64'), body.isBinary ?? false);
        res.send({ success: true });
    }));

    server.post('/client/ws/:id/close', parseJson, handle(async (req, res) => {
        const body = isRecord(req.body) ? req.body : {};
        if (body.code !== undefined && typeof body.code !== 'number') {
            throw new StatusError(400, 'code must be a number, e.g. 1000');
        }
        if (body.reason !== undefined && typeof body.reason !== 'string') {
            throw new StatusError(400, 'reason must be a string');
        }

        client.close(socketIdOf(req), body.code, body.reason);
        res.send({ success: true });
    }));
}

function isRecord(value: unknown): value is Record<string, any> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Express types route parameters as string | string[], as wildcard parameters are arrays
function socketIdOf(req: Request): string {
    const { id } = req.params;
    if (typeof id !== 'string') throw new StatusError(400, 'Missing WebSocket id');
    return id;
}

function isRawHeaders(value: unknown): value is RawHeaders {
    return Array.isArray(value) && value.every((header) =>
        Array.isArray(header) &&
        header.length === 2 &&
        typeof header[0] === 'string' &&
        typeof header[1] === 'string'
    );
}

function parseOpenRequest(body: unknown): { request: WebSocketRequestDefinition, options: RequestOptions } {
    if (!isRecord(body) || !isRecord(body.request)) {
        throw new StatusError(400, 'Expected a JSON body like { "request": { "url": "wss://..." }, "options": {} }');
    }

    const { url, headers = [], protocols } = body.request;
    if (typeof url !== 'string' || !url) {
        throw new StatusError(400, 'request.url must be a ws:// or wss:// URL');
    }
    if (!isRawHeaders(headers)) {
        throw new StatusError(400, 'request.headers must be a list of [name, value] pairs');
    }
    if (protocols !== undefined && !(Array.isArray(protocols) && protocols.every((p) => typeof p === 'string'))) {
        throw new StatusError(400, 'request.protocols must be a list of strings');
    }

    const options: RequestOptions = isRecord(body.options) ? { ...body.options } : {};
    // Buffers are sent as base64, as in /client/send
    if (options.clientCertificate) {
        options.clientCertificate = {
            ...options.clientCertificate,
            pfx: Buffer.from(options.clientCertificate.pfx as unknown as string, 'base64')
        };
    }

    return { request: { url, headers, protocols }, options };
}

function serializeEvent(event: WebSocketEvent) {
    switch (event.type) {
        case 'ws-message':
            return { ...event, data: event.data.toString('base64') };
        case 'error':
            return event.response
                ? { ...event, response: { ...event.response, body: event.response.body.toString('base64') } }
                : event;
        default:
            return event;
    }
}

// Async error handling for these routes, as in rest-api.ts: errors before the response starts
// become JSON error responses, later ones end the connection.
function handle(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await handler(req, res);
        } catch (e) {
            const error = e as ErrorLike;

            console.log(`Error handling request to ${req.path}: ${error.message ?? error}`);
            if (!error.statusCode || error.statusCode >= 500) logError(error);

            if (res.headersSent) {
                setImmediate(() => next(error));
                return;
            }

            const status = (error.statusCode && error.statusCode >= 400 && error.statusCode < 600)
                ? error.statusCode
                : 500;

            res.status(status).send({
                error: {
                    code: error.code,
                    message: error.message
                }
            });
        }
    };
}
