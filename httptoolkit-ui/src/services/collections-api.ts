import { DesktopApi, getServerPort } from './desktop-api';
import { waitUntilServerReady } from './server-api';

import type {
    BrunoCollection,
    CollectionSummary,
    ExportFormat,
    ExportResult,
    ImportFileInput,
    ImportResult,
    LoadedCollection,
    StoredCollectionFile
} from '../model/collections/collection-types';

/**
 * Client for the server's /collections endpoints (httptoolkit-server/src/collections/).
 * They sit behind the same Origin and auth token checks as the rest of the server API,
 * so requests carry the same Bearer token as RestApiClient's.
 */

// Read at startup, while the page URL still has the token the desktop app put there
const authToken = DesktopApi.getServerAuthToken?.() ??
    new URLSearchParams(window.location.search).get('authToken') ??
    undefined;

// Imports & exports can carry megabytes (base64 zips, saved examples)
const REQUEST_TIMEOUT_MS = 60_000;

export class CollectionsApiError extends Error {
    constructor(
        message: string,
        readonly status?: number,
        readonly code?: string
    ) {
        super(message);
        this.name = 'CollectionsApiError';
    }
}

async function readErrorMessage(response: Response): Promise<{ message?: string, code?: string }> {
    try {
        const body = await response.json() as { error?: { message?: string, code?: string } };
        return body.error ?? {};
    } catch {
        return {};
    }
}

// Sends a request to the server, throwing a CollectionsApiError for any failure
async function send(method: string, path: string, body?: { json: object } | { bytes: Uint8Array }): Promise<Response> {
    await waitUntilServerReady();

    let response: Response;
    try {
        response = await fetch(`http://127.0.0.1:${getServerPort()}${path}`, {
            method,
            headers: {
                ...(authToken ? { 'Authorization': `Bearer ${authToken}` } : {}),
                ...(body ? { 'content-type': 'json' in body ? 'application/json' : 'application/octet-stream' } : {})
            },
            // A copy for bytes: fetch only takes ones backed by a plain ArrayBuffer
            body: !body ? undefined : 'json' in body ? JSON.stringify(body.json) : new Uint8Array(body.bytes),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
        });
    } catch (error) {
        const isTimeout = error instanceof DOMException && error.name === 'TimeoutError';
        throw new CollectionsApiError(isTimeout
            ? 'Wirepane\'s server took too long to answer. Try again in a moment.'
            : 'Couldn\'t reach Wirepane\'s server. Check that Wirepane is still running.'
        );
    }

    if (!response.ok) {
        const { message, code } = await readErrorMessage(response);
        throw new CollectionsApiError(
            message ?? `The server answered ${response.status} ${response.statusText}`,
            response.status,
            code
        );
    }

    return response;
}

async function request<T>(method: string, path: string, body?: object): Promise<T> {
    const response = await send(method, path, body ? { json: body } : undefined);
    return await response.json() as T;
}

const collectionPath = (id: string) => `/collections/${encodeURIComponent(id)}`;

export async function listCollections(): Promise<CollectionSummary[]> {
    const { collections } = await request<{ collections: CollectionSummary[] }>('GET', '/collections');
    return collections;
}

export const getCollection = (id: string) =>
    request<LoadedCollection>('GET', collectionPath(id));

// Creates or replaces a collection. The answer is the collection as stored, which is
// what later reads return too, so callers replace their copy with it.
export const saveCollection = (id: string, collection: BrunoCollection) =>
    request<LoadedCollection>('PUT', collectionPath(id), { collection });

export const deleteCollection = (id: string) =>
    request<{ success: true }>('DELETE', collectionPath(id));

export const importCollectionFile = (input: ImportFileInput) =>
    request<ImportResult>('POST', '/collections/import', input);

export const exportCollection = (id: string, format: ExportFormat) =>
    request<ExportResult>('POST', `${collectionPath(id)}/export`, { format });

// Stores a file that a request sends in the collection's folder. Storing the same file
// under the same name again gives the same path.
export const storeCollectionFile = (id: string, name: string, bytes: Uint8Array) =>
    send('POST', `${collectionPath(id)}/files?name=${encodeURIComponent(name)}`, { bytes })
        .then((response) => response.json() as Promise<StoredCollectionFile>);

// A file of the collection, by the path its requests refer to it by. Undefined when it's
// not in the collection folder.
export async function readCollectionFile(id: string, filePath: string): Promise<{ bytes: Buffer, contentType: string } | undefined> {
    try {
        const response = await send('GET', `${collectionPath(id)}/files?path=${encodeURIComponent(filePath)}`);
        return {
            bytes: Buffer.from(await response.arrayBuffer()),
            contentType: response.headers.get('content-type') ?? ''
        };
    } catch (error) {
        if (error instanceof CollectionsApiError && (error.status === 404 || error.status === 400)) return undefined;
        throw error;
    }
}
