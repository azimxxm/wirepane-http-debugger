import * as _ from 'lodash';
import { StatusError } from '@httptoolkit/util';

import { BrunoBody, BrunoCollection, BrunoExample, BrunoItem, BrunoKeyValue, isRecord } from './bruno-types';
import { newUid } from './collection-model';

/**
 * Builds a collection from a HAR file (e.g. exported from Wirepane's View page or a
 * browser): one folder per host, one request per entry, and each entry's response
 * saved as that request's example.
 */

interface NameValue {
    name: string;
    value: string;
}

interface HarRequest {
    method: string;
    url: string;
    headers: NameValue[];
    queryString: NameValue[];
    postData: unknown;
}

type ExampleRequest = NonNullable<BrunoExample['request']>;

interface HostGroup {
    items: BrunoItem[];
    // How often each request name was used, to number repeats: "GET /users (2)"
    names: Map<string, number>;
}

const MAX_REQUEST_NAME_LENGTH = 80;

const toNameValues = (list: unknown): NameValue[] => Array.isArray(list)
    ? list
        .filter(isRecord)
        .filter((entry) => typeof entry.name === 'string')
        .map((entry) => ({
            name: entry.name as string,
            value: typeof entry.value === 'string' ? entry.value : String(entry.value ?? '')
        }))
    : [];

const enabled = (entries: NameValue[]): BrunoKeyValue[] =>
    entries.map((entry) => ({ ...entry, enabled: true }));

// The HTTP client sets these itself: HTTP/2 pseudo-headers, Host and Content-Length
const isDerivedHeader = (name: string) =>
    name.startsWith(':') || ['host', 'content-length'].includes(name.toLowerCase());

function toHarRequest(entry: unknown): HarRequest | undefined {
    const request = isRecord(entry) ? entry.request : undefined;
    if (!isRecord(request) || typeof request.method !== 'string' || typeof request.url !== 'string') {
        return undefined;
    }

    return {
        method: request.method.toUpperCase(),
        url: request.url,
        headers: toNameValues(request.headers).filter((header) => !isDerivedHeader(header.name)),
        queryString: toNameValues(request.queryString),
        postData: request.postData
    };
}

const parseUrl = (url: string) => {
    try {
        return new URL(url);
    } catch {
        return undefined;
    }
};

const safeDecode = (value: string) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

function toBody(postData: unknown): BrunoBody {
    if (!isRecord(postData)) return { mode: 'none' };

    const mimeType = typeof postData.mimeType === 'string' ? postData.mimeType.toLowerCase() : '';
    const text = typeof postData.text === 'string' ? postData.text : '';
    const params = toNameValues(postData.params);

    if (mimeType.includes('application/x-www-form-urlencoded')) {
        const fields = params.length
            ? params
            : [...new URLSearchParams(text)].map(([name, value]) => ({ name, value }));
        return { mode: 'formUrlEncoded', formUrlEncoded: enabled(fields) };
    }

    // HAR keeps no file contents, so every multipart field becomes a text field
    if (mimeType.includes('multipart/form-data') && params.length) {
        return { mode: 'multipartForm', multipartForm: enabled(params).map((field) => ({ ...field, type: 'text' })) };
    }

    if (!text) return { mode: 'none' };
    if (mimeType.includes('json')) return { mode: 'json', json: text };
    if (mimeType.includes('xml')) return { mode: 'xml', xml: text };
    return { mode: 'text', text };
}

function responseBodyType(mimeType: string): 'json' | 'xml' | 'html' | 'text' | 'binary' {
    if (mimeType.includes('json')) return 'json';
    if (mimeType.includes('html')) return 'html';
    if (mimeType.includes('xml')) return 'xml';
    if (!mimeType || mimeType.startsWith('text/') || mimeType.includes('javascript')) return 'text';
    return 'binary';
}

function toResponseBody(content: unknown): { type: string, content: string } {
    if (!isRecord(content)) return { type: 'text', content: '' };

    const mimeType = typeof content.mimeType === 'string' ? content.mimeType.toLowerCase() : '';
    const text = typeof content.text === 'string' ? content.text : '';
    const type = responseBodyType(mimeType);

    // Binary bodies stay as HAR stored them (normally base64); text bodies are decoded
    const isBase64 = content.encoding === 'base64';
    return {
        type,
        content: isBase64 && type !== 'binary' ? Buffer.from(text, 'base64').toString('utf8') : text
    };
}

function toExample(response: unknown, request: ExampleRequest, itemUid: string): BrunoExample | undefined {
    // Status 0 means the request never got a response (aborted, blocked or failed)
    if (!isRecord(response) || typeof response.status !== 'number' || response.status <= 0) return undefined;

    const statusText = typeof response.statusText === 'string' ? response.statusText : '';
    return {
        uid: newUid(),
        itemUid,
        name: `${response.status} ${statusText}`.trim(),
        description: '',
        type: 'http-request',
        request: _.cloneDeep(request),
        response: {
            status: response.status,
            statusText,
            headers: enabled(toNameValues(response.headers)),
            body: toResponseBody(response.content)
        }
    };
}

function toRequestItem(entry: Record<string, unknown>, harRequest: HarRequest, name: string, seq: number): BrunoItem {
    const uid = newUid();
    const request: ExampleRequest = {
        url: harRequest.url,
        method: harRequest.method,
        headers: enabled(harRequest.headers),
        params: enabled(harRequest.queryString).map((param) => ({ ...param, type: 'query' })),
        body: toBody(harRequest.postData)
    };
    const example = toExample(entry.response, request, uid);

    return {
        uid,
        type: 'http-request',
        name,
        seq,
        request: { ...request, auth: { mode: 'none' }, script: {}, vars: {}, assertions: [], tests: '', docs: '' },
        examples: example ? [example] : []
    };
}

function requestName(harRequest: HarRequest, takenNames: Map<string, number>): string {
    const pathname = parseUrl(harRequest.url)?.pathname ?? harRequest.url;
    const base = `${harRequest.method} ${safeDecode(pathname)}`.slice(0, MAX_REQUEST_NAME_LENGTH);

    const count = (takenNames.get(base) ?? 0) + 1;
    takenNames.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
}

const toFolder = (host: string, items: BrunoItem[], seq: number): BrunoItem => ({
    uid: newUid(),
    type: 'folder',
    name: host,
    seq,
    items,
    root: { request: { auth: { mode: 'inherit' } }, docs: '', meta: { name: host, seq } }
});

export function harToCollection(har: unknown, name: string): { collection: BrunoCollection, warnings: string[] } {
    const log = isRecord(har) ? har.log : undefined;
    if (!isRecord(log) || !Array.isArray(log.entries)) {
        throw new StatusError(400, 'Not a HAR file: log.entries is missing');
    }

    const warnings: string[] = [];
    const hosts = new Map<string, HostGroup>();

    log.entries.forEach((entry, index) => {
        const harRequest = toHarRequest(entry);
        if (!isRecord(entry) || !harRequest) {
            warnings.push(`Skipped HAR entry ${index + 1}: it has no request method or URL`);
            return;
        }

        const hostName = parseUrl(harRequest.url)?.host || 'Other';
        const host: HostGroup = hosts.get(hostName) ?? { items: [], names: new Map() };
        hosts.set(hostName, host);

        const name = requestName(harRequest, host.names);
        host.items.push(toRequestItem(entry, harRequest, name, host.items.length + 1));
    });

    const folders = [...hosts].map(([hostName, host], index) => toFolder(hostName, host.items, index + 1));
    const collection: BrunoCollection = {
        version: '1',
        uid: newUid(),
        name,
        items: folders,
        environments: [],
        root: { request: { auth: { mode: 'none' } }, docs: '', meta: { name } }
    };

    return { collection, warnings };
}
