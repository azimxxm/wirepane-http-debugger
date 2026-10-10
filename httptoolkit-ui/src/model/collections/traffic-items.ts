import { HttpExchangeView } from '../../types';
import { getHeaderValue } from '../http/headers';
import { getStatusMessage } from '../http/http-docs';
import { buildRequestInputFromExchange } from '../send/send-request-model';

import { BrunoCollection, BrunoExample, BrunoItem, ExampleBodyType } from './collection-types';
import { emptyFolder, isFolder, newUid, uniqueName } from './collection-tree';
import { defaultRequestName, isUtf8Text, requestInputToParts, requestPartsToItem } from './request-mapping';

/**
 * Turns captured exchanges (View's traffic) into collection requests, each with its
 * captured response saved as an example, grouped into one folder per host.
 */

export interface CapturedRequest {
    host: string;
    item: BrunoItem;
    warnings: string[];
}

const hostOfExchange = (exchange: HttpExchangeView) => exchange.request.parsedUrl.host || 'Other';

// How many of the exchanges go to each host folder, in first-seen order
export function countByHost(exchanges: readonly HttpExchangeView[]): Array<{ host: string, count: number }> {
    const counts = new Map<string, number>();
    for (const exchange of exchanges) {
        const host = hostOfExchange(exchange);
        counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    return Array.from(counts, ([host, count]) => ({ host, count }));
}

function exampleBodyType(mimeType: string, body: Buffer): ExampleBodyType {
    if (body.length && !isUtf8Text(body)) return 'binary';

    const type = mimeType.toLowerCase();
    if (type.includes('json')) return 'json';
    if (type.includes('html')) return 'html';
    if (type.includes('xml')) return 'xml';
    if (!type || type.startsWith('text/') || type.includes('javascript')) return 'text';
    return 'binary';
}

async function exampleFromExchange(exchange: HttpExchangeView, item: BrunoItem): Promise<BrunoExample | undefined> {
    const { response } = exchange;
    if (!response || response === 'aborted' || !item.request) return undefined;

    const body = await response.body.waitForDecoding() ?? Buffer.alloc(0);
    const bodyType = exampleBodyType(getHeaderValue(response.rawHeaders, 'content-type') ?? '', body);
    const statusText = response.statusMessage || getStatusMessage(response.statusCode);
    const { url, method, headers, params, body: requestBody } = item.request;

    return {
        uid: newUid(),
        itemUid: item.uid,
        name: `${response.statusCode} ${statusText}`.trim(),
        description: '',
        type: 'http-request',
        request: { url, method, headers, params, body: requestBody },
        response: {
            status: response.statusCode,
            statusText,
            headers: response.rawHeaders.map(([name, value]) => ({ name, value, enabled: true })),
            // Binary bodies are kept as base64, like the server's HAR import does
            body: { type: bodyType, content: bodyType === 'binary' ? body.toString('base64') : body.toString('utf8') }
        }
    };
}

export async function capturedRequestFromExchange(exchange: HttpExchangeView): Promise<CapturedRequest> {
    // The same request Resend would open in Send: HTTP/2 headers turned into HTTP/1 ones
    const parts = requestInputToParts(await buildRequestInputFromExchange(exchange));
    const { item, warnings } = requestPartsToItem(parts, '', undefined, {
        name: defaultRequestName(parts.method, parts.url),
        authMode: 'none'
    });

    const example = await exampleFromExchange(exchange, item);
    return {
        host: hostOfExchange(exchange),
        item: { ...item, examples: example ? [example] : [] },
        warnings: warnings.map((warning) => `${item.name}: ${warning}`)
    };
}

/**
 * Adds captured requests to a collection, in one top-level folder per host (reusing a
 * folder of that name). Repeated names are numbered: "GET /users (2)".
 */
export function addCapturedRequests(collection: BrunoCollection, captured: CapturedRequest[]): void {
    for (const { host, item } of captured) {
        let folder = collection.items.find((candidate) =>
            isFolder(candidate) && candidate.name.toLowerCase() === host.toLowerCase()
        );

        if (!folder) {
            folder = emptyFolder(newUid(), host);
            collection.items.push(folder);
        }

        const siblings = folder.items = folder.items ?? [];
        const takenNames = siblings.filter((sibling) => !isFolder(sibling)).map((sibling) => sibling.name);
        siblings.push({ ...item, name: uniqueName(item.name, takenNames) });
    }
}
