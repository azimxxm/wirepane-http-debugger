import express from 'express';
import type { Application, NextFunction, Request, RequestHandler, Response } from 'express';
import { ErrorLike, StatusError } from '@httptoolkit/util';

import { logError } from '../error-tracking';
import { isRecord } from './bruno-types';
import { CollectionsService, ImportRequest } from './collections-service';
import { EXPORT_FORMATS, ExportFormat } from './export';
import { MAX_ATTACHMENT_BYTES } from './attachments';

/**
 * REST endpoints for API collections:
 *
 *   GET    /collections              -> { collections: CollectionSummary[] }
 *   GET    /collections/:id          -> { collection, warnings }
 *   PUT    /collections/:id          { collection } -> { collection, warnings }
 *   DELETE /collections/:id          -> { success: true }
 *   POST   /collections/import       { fileName, content, encoding?, collectionId? }
 *                                    -> { format, collection, warnings }
 *   POST   /collections/:id/export   { format: 'postman' | 'bruno' }
 *                                    -> { fileName, mimeType, encoding, content, redactionReport, warnings }
 *   POST   /collections/:id/files?name=<file name>   the file's bytes as the body (up to 100 MB)
 *                                    -> { path, name, size }: requests refer to the file by `path`
 *   GET    /collections/:id/files?path=<path>        -> the file's bytes
 *
 * Errors are { error: { code?, message } } with a 4xx/5xx status, like the rest of the API.
 *
 * The API server registers these after its Origin (CORS) and auth token checks, so they're
 * protected like every other endpoint, but before its default JSON parser, so these routes
 * can take bigger bodies: collections with saved responses, or zips as base64.
 */

const MAX_BODY_SIZE = '64mb';

// mime-types has no typings of its own
const mimeTypes: { lookup(fileName: string): string | false } = require('mime-types');

export function exposeCollectionsAPI(server: Application, configPath: string) {
    const service = new CollectionsService(configPath);
    const parseJson = jsonBodyParser();

    server.get('/collections', handle(async (_req, res) => {
        res.send({ collections: await service.list() });
    }));

    server.post('/collections/import', parseJson, handle(async (req, res) => {
        res.send(await service.importFile(parseImportRequest(req.body)));
    }));

    server.get('/collections/:id', handle(async (req, res) => {
        res.send(await service.get(collectionIdOf(req)));
    }));

    server.put('/collections/:id', parseJson, handle(async (req, res) => {
        if (!isRecord(req.body) || !('collection' in req.body)) {
            throw new StatusError(400, 'Expected a JSON body like { "collection": { ... } }');
        }
        res.send(await service.save(collectionIdOf(req), req.body.collection));
    }));

    server.delete('/collections/:id', handle(async (req, res) => {
        await service.delete(collectionIdOf(req));
        res.send({ success: true });
    }));

    server.post('/collections/:id/export', parseJson, handle(async (req, res) => {
        res.send(await service.exportCollection(collectionIdOf(req), parseExportFormat(req.body)));
    }));

    // Files that requests send (multipart file fields, binary bodies), as raw bytes
    server.post('/collections/:id/files', rawBodyParser(MAX_ATTACHMENT_BYTES), handle(async (req, res) => {
        const name = queryString(req, 'name');
        const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        res.send(await service.addFile(collectionIdOf(req), name, bytes));
    }));

    server.get('/collections/:id/files', handle(async (req, res) => {
        const file = await service.readFile(collectionIdOf(req), queryString(req, 'path'));
        res.set({
            'content-type': mimeTypes.lookup(file.name) || 'application/octet-stream',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff'
        });
        res.send(file.bytes);
    }));
}

function queryString(req: Request, name: string): string {
    const value = req.query[name];
    if (typeof value !== 'string' || !value.trim()) {
        throw new StatusError(400, `The ${name} query parameter must be a non-empty string`);
    }
    return value;
}

// Express types route parameters as string | string[], as wildcard parameters are arrays
function collectionIdOf(req: Request): string {
    const { id } = req.params;
    if (typeof id !== 'string') throw new StatusError(400, 'Missing collection id');
    return id;
}

function parseImportRequest(body: unknown): ImportRequest {
    if (!isRecord(body)) throw new StatusError(400, 'Expected a JSON body');

    const { fileName, content, encoding, collectionId } = body;
    if (typeof fileName !== 'string' || !fileName.trim()) {
        throw new StatusError(400, 'fileName must be a non-empty string');
    }
    if (typeof content !== 'string' || !content) {
        throw new StatusError(400, 'content must be a non-empty string (text, or base64 for zip files)');
    }
    if (encoding !== undefined && encoding !== 'utf8' && encoding !== 'base64') {
        throw new StatusError(400, 'encoding must be "utf8" or "base64"');
    }
    if (collectionId !== undefined && typeof collectionId !== 'string') {
        throw new StatusError(400, 'collectionId must be a string');
    }

    return { fileName: fileName.trim(), content, encoding, collectionId };
}

function parseExportFormat(body: unknown): ExportFormat {
    const format = isRecord(body) ? body.format : undefined;
    const knownFormat = EXPORT_FORMATS.find((candidate) => candidate === format);
    if (!knownFormat) {
        throw new StatusError(400, `format must be one of: ${EXPORT_FORMATS.join(', ')}`);
    }
    return knownFormat;
}

// express.json() with a bigger limit, answering bad or oversized bodies with JSON errors
function jsonBodyParser(): RequestHandler {
    return withJsonErrors(express.json({ limit: MAX_BODY_SIZE }), MAX_BODY_SIZE, 'The request body is not valid JSON');
}

// Takes the body as bytes, whatever its Content-Type
function rawBodyParser(limitBytes: number): RequestHandler {
    const limit = `${Math.round(limitBytes / (1024 * 1024))}mb`;
    return withJsonErrors(express.raw({ type: () => true, limit }), limit, 'The request body couldn\'t be read');
}

function withJsonErrors(parser: RequestHandler, limit: string, invalidMessage: string): RequestHandler {
    return (req, res, next) => parser(req, res, (error?: unknown) => {
        if (!error) return next();

        const tooLarge = isRecord(error) && error.type === 'entity.too.large';
        res.status(tooLarge ? 413 : 400).send({
            error: { message: tooLarge ? `The request body is larger than ${limit}` : invalidMessage }
        });
    });
}

// Sends thrown errors as JSON, using their status code when they have one. Only
// unexpected (5xx) errors are logged and reported: 4xx ones are the client's mistakes.
function handle(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
    return async (req: Request, res: Response, next: NextFunction) => {
        try {
            await handler(req, res);
        } catch (e) {
            const error = e as ErrorLike;
            const status = error.statusCode && error.statusCode >= 400 && error.statusCode < 600
                ? error.statusCode
                : 500;

            if (status >= 500) {
                console.log(`Error handling ${req.method} ${req.path}: ${error.message ?? error}`);
                logError(error);
            }

            if (res.headersSent) return next(error);
            res.status(status).send({ error: { code: error.code, message: error.message } });
        }
    };
}
