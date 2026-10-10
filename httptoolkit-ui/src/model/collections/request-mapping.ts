import * as _ from 'lodash';

import { RawHeaders } from '../../types';
import { getHeaderValue } from '../http/headers';
import { EditableContentType, getEditableContentType } from '../events/content-types';
import { RequestInput } from '../send/send-request-model';
import { SendExtrasData } from '../send/send-extras';

import {
    BrunoBody,
    BrunoBodyMode,
    BrunoItem,
    BrunoKeyValue,
    BrunoMultipartField,
    BrunoParam,
    BrunoRequest
} from './collection-types';
import { newUid } from './collection-tree';
import { hasTemplate, mapTemplateLiterals } from './templates';

/**
 * Maps between a Send tab's request and a Bruno http-request item.
 *
 * Send works with a raw request: method, URL, headers and a body. Items hold more
 * structure (query & path params, body modes, disabled entries, auth, scripts, docs,
 * examples), so saving a tab updates its item in place: whatever the tab can't show is
 * kept from the item, and values that Send derives (Host, Content-Length, the body's
 * default Content-Type) aren't stored, just as Bruno and Postman don't store them.
 */

export interface RequestParts {
    method: string;
    url: string;
    headers: RawHeaders;
    body: Buffer;
    contentType: EditableContentType;
    // The request type and structured body modes (send-extras.ts). Missing means a raw HTTP request.
    extras?: SendExtrasData;
}

export interface OpenedRequest {
    parts: RequestParts;
    // Parts of the item that Send can't show, to tell the user about
    warnings: string[];
}

export interface NewItemDefaults {
    name: string;
    uid?: string;
    // Requests created in Send inherit the collection's auth. Captured requests carry
    // their own Authorization headers, so they don't.
    authMode?: 'inherit' | 'none';
}

const IMPLIED_CONTENT_TYPES: { [mode in BrunoBodyMode]?: string } = {
    json: 'application/json',
    text: 'text/plain',
    xml: 'application/xml',
    sparql: 'application/sparql-query',
    formUrlEncoded: 'application/x-www-form-urlencoded',
    graphql: 'application/json'
};

const TEXT_BODY_MODES = ['json', 'text', 'xml', 'sparql'] as const;
type TextBodyMode = typeof TEXT_BODY_MODES[number];
const isTextBodyMode = (mode: BrunoBodyMode | undefined): mode is TextBodyMode =>
    TEXT_BODY_MODES.includes(mode as TextBodyMode);

const MULTIPART_BOUNDARY_PREFIX = '----WirepaneFormBoundary';

const utf8Decoder = new TextDecoder('utf8', { fatal: true });
export function isUtf8Text(body: Buffer) {
    try {
        utf8Decoder.decode(body);
        return true;
    } catch {
        return false;
    }
}

const safeDecodeURIComponent = (value: string) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

const hasHeader = (headers: RawHeaders, name: Lowercase<string>) =>
    getHeaderValue(headers, name) !== undefined;

/**
 * The Host header value for a URL, or undefined when it can't be known yet: invalid
 * URLs, and URLs whose origin is still a {{variable}}.
 */
export function hostOf(url: string): string | undefined {
    const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*/i.exec(url)?.[0];
    if (!origin || hasTemplate(origin)) return undefined;

    try {
        return new URL(url).host || undefined;
    } catch {
        return undefined;
    }
}

// "Get /users/{id}"-style default names, as used when saving captured requests
const MAX_DEFAULT_NAME_LENGTH = 80;
export function defaultRequestName(method: string, url: string): string {
    const withoutQuery = url.split(/[?#]/)[0];
    const pathname = withoutQuery.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '') || '/';
    return `${method.toUpperCase()} ${safeDecodeURIComponent(pathname)}`.slice(0, MAX_DEFAULT_NAME_LENGTH);
}

// --- URLs & params ----------------------------------------------------------------

function splitUrl(url: string) {
    const suffixStart = url.search(/[?#]/);
    return suffixStart === -1
        ? { path: url, suffix: '' }
        : { path: url.slice(0, suffixStart), suffix: url.slice(suffixStart) };
}

// The path part of a URL, without its scheme and host, so ports aren't read as params
function pathSegments(url: string) {
    const { path } = splitUrl(url);
    const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(path)?.[0] ?? '';
    return { origin, segments: path.slice(origin.length).split('/') };
}

// Names of the :name path segments in a URL, e.g. ['id'] for "/todos/:id"
export function pathParamNames(url: string): string[] {
    return pathSegments(url).segments
        .filter((segment) => /^:[^/:]+$/.test(segment))
        .map((segment) => segment.slice(1));
}

// Fills in the :name path segments that have a value
export function applyPathParams(url: string, params: BrunoParam[]): string {
    const values = new Map(params
        .filter((param) => param.type === 'path' && param.enabled !== false && param.name && param.value)
        .map((param) => [param.name!, param.value!])
    );
    if (!values.size) return url;

    const { suffix } = splitUrl(url);
    const { origin, segments } = pathSegments(url);
    const filled = segments.map((segment) =>
        segment.startsWith(':') && values.has(segment.slice(1)) ? values.get(segment.slice(1))! : segment
    );
    return `${origin}${filled.join('/')}${suffix}`;
}

function parseQuery(url: string): Array<{ name: string, value: string }> {
    const query = url.split('#')[0].split('?').slice(1).join('?');
    if (!query) return [];

    // Kept as written (not decoded), like Bruno, so {{variables}} & encodings round-trip
    return query.split('&').filter(Boolean).map((pair) => {
        const separator = pair.indexOf('=');
        return separator === -1
            ? { name: pair, value: '' }
            : { name: pair.slice(0, separator), value: pair.slice(separator + 1) };
    });
}

// Reuses an existing entry's uid & description when one of the same name is still there
function matchingEntries<T extends { name?: string | null }>(existing: T[], caseSensitive: boolean) {
    const unused = [...existing];
    const sameName = (a: string, b: string) => caseSensitive ? a === b : a.toLowerCase() === b.toLowerCase();

    return (name: string): Pick<BrunoKeyValue, 'uid' | 'description'> => {
        const index = unused.findIndex((entry) => entry.name !== null && entry.name !== undefined && sameName(entry.name, name));
        if (index === -1) return {};
        const [match] = unused.splice(index, 1);
        return _.pick(match, ['uid', 'description']) as Pick<BrunoKeyValue, 'uid' | 'description'>;
    };
}

function toUrlAndParams(url: string, baseRequest: BrunoRequest | undefined): { url: string, params: BrunoParam[] } {
    const baseParams = baseRequest?.params ?? [];

    // An unchanged URL keeps the item's own URL & params, including its :path templates
    if (baseRequest && applyPathParams(baseRequest.url, baseParams) === url) {
        return { url: baseRequest.url, params: baseParams };
    }

    const reuseQuery = matchingEntries(baseParams.filter((param) => param.type === 'query' && param.enabled !== false), true);
    const queryParams: BrunoParam[] = parseQuery(url).map(({ name, value }) => ({
        ...reuseQuery(name),
        name,
        value,
        enabled: true,
        type: 'query'
    }));
    // Disabled params aren't in the URL, so Send never shows them: they're kept as they were
    const disabledQueryParams = baseParams.filter((param) => param.type === 'query' && param.enabled === false);

    const basePathParams = baseParams.filter((param) => param.type === 'path');
    const pathParams: BrunoParam[] = pathParamNames(url).map((name) =>
        basePathParams.find((param) => param.name === name) ?? { name, value: '', enabled: true, type: 'path' }
    );

    return { url, params: [...queryParams, ...disabledQueryParams, ...pathParams] };
}

// --- Bodies ------------------------------------------------------------------------

// Form encoding (spaces as +, like URLSearchParams) that leaves {{variables}} readable
const formEncode = (text: string) =>
    mapTemplateLiterals(text, (literal) => encodeURIComponent(literal).replace(/%20/g, '+'));
const formDecode = (text: string) => safeDecodeURIComponent(text.replace(/\+/g, ' '));

function encodeFormFields(fields: BrunoKeyValue[]): string {
    return fields
        .filter((field) => field.enabled !== false && field.name)
        .map((field) => `${formEncode(field.name!)}=${formEncode(field.value ?? '')}`)
        .join('&');
}

function decodeFormFields(text: string, baseFields: BrunoKeyValue[]): BrunoKeyValue[] {
    const reuse = matchingEntries(baseFields.filter((field) => field.enabled !== false), true);
    const fields: BrunoKeyValue[] = text.split('&').filter(Boolean).map((pair) => {
        const separator = pair.indexOf('=');
        const name = formDecode(separator === -1 ? pair : pair.slice(0, separator));
        const value = separator === -1 ? '' : formDecode(pair.slice(separator + 1));
        return { ...reuse(name), name, value, enabled: true };
    });

    return [...fields, ...baseFields.filter((field) => field.enabled === false)];
}

const quoteMultipartName = (name: string) => name.replace(/["\\\r\n]/g, (char) => encodeURIComponent(char));

function encodeMultipartFields(fields: BrunoMultipartField[], boundary: string): string {
    const parts = fields.map((field) => {
        const headers = [`Content-Disposition: form-data; name="${quoteMultipartName(field.name ?? '')}"`];
        if (field.contentType) headers.push(`Content-Type: ${field.contentType}`);
        return `--${boundary}\r\n${headers.join('\r\n')}\r\n\r\n${field.value ?? ''}\r\n`;
    });
    return `${parts.join('')}--${boundary}--\r\n`;
}

function boundaryOf(contentType: string): string | undefined {
    const match = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
    return match ? (match[1] ?? match[2]) : undefined;
}

// Text fields of a multipart body, or undefined if it can't be read as one
function decodeMultipartFields(text: string, boundary: string): BrunoMultipartField[] | undefined {
    const sections = text.split(`--${boundary}`);
    const fields: BrunoMultipartField[] = [];

    for (const section of sections.slice(1)) {
        if (section.startsWith('--')) break; // The closing delimiter

        const content = section.replace(/^\r?\n/, '');
        const separator = /\r?\n\r?\n/.exec(content);
        if (!separator) return undefined;

        const headerText = content.slice(0, separator.index);
        const name = /name="([^"]*)"/i.exec(headerText)?.[1];
        if (name === undefined) return undefined;
        if (/filename=/i.test(headerText)) continue; // File contents can't be kept: files stay as they were

        const contentType = /^content-type:\s*(.+)$/im.exec(headerText)?.[1]?.trim();
        fields.push({
            type: 'text',
            name: safeDecodeURIComponent(name),
            value: content.slice(separator.index + separator[0].length).replace(/\r?\n$/, ''),
            ...(contentType ? { contentType } : {}),
            enabled: true
        });
    }

    return fields;
}

function encodeGraphqlBody(graphql: BrunoBody['graphql']): string {
    const query = graphql?.query ?? '';
    // The variables stay as written: they may hold {{variables}}, so they aren't parsed here
    const variables = (graphql?.variables ?? '').trim() || '{}';
    return `{\n  "query": ${JSON.stringify(query)},\n  "variables": ${variables}\n}`;
}

function decodeGraphqlBody(text: string): BrunoBody['graphql'] | undefined {
    try {
        const parsed = JSON.parse(text) as { query?: unknown, variables?: unknown } | null;
        if (!_.isPlainObject(parsed) || typeof parsed!.query !== 'string') return undefined;
        const { query, variables } = parsed as { query: string, variables?: unknown };
        return { query, variables: variables === undefined ? '' : JSON.stringify(variables, null, 2) };
    } catch {
        // Not JSON (yet): {{variables}} make the variables part invalid until they're filled in
        const match = /^\s*\{\s*"query"\s*:\s*("(?:[^"\\]|\\.)*")\s*,\s*"variables"\s*:\s*([\s\S]*?)\s*\}\s*$/.exec(text);
        if (!match) return undefined;
        try {
            return { query: JSON.parse(match[1]) as string, variables: match[2] };
        } catch {
            return undefined;
        }
    }
}

interface BodyText {
    body: Buffer;
    // The Content-Type the body implies, for requests without one
    impliedContentType?: string;
    warnings: string[];
}

function bodyToText(body: BrunoBody | undefined): BodyText {
    const mode = body?.mode ?? 'none';
    const impliedContentType = IMPLIED_CONTENT_TYPES[mode];

    switch (mode) {
        case 'json':
        case 'text':
        case 'xml':
        case 'sparql':
            return { body: Buffer.from(body?.[mode] ?? ''), impliedContentType, warnings: [] };
        case 'formUrlEncoded':
            return { body: Buffer.from(encodeFormFields(body?.formUrlEncoded ?? [])), impliedContentType, warnings: [] };
        case 'graphql':
            return { body: Buffer.from(encodeGraphqlBody(body?.graphql)), impliedContentType, warnings: [] };
        case 'multipartForm': {
            const fields = (body?.multipartForm ?? []).filter((field) => field.enabled !== false);
            const textFields = fields.filter((field) => field.type !== 'file');
            const boundary = `${MULTIPART_BOUNDARY_PREFIX}${newUid().slice(0, 16)}`;
            return {
                body: Buffer.from(encodeMultipartFields(textFields, boundary)),
                impliedContentType: `multipart/form-data; boundary=${boundary}`,
                warnings: textFields.length < fields.length
                    ? ['File fields of this form aren\'t sent from Send yet. They stay saved in the collection.']
                    : []
            };
        }
        case 'file':
            return { body: Buffer.alloc(0), warnings: ['File bodies aren\'t sent from Send yet. The file stays saved in the collection.'] };
        default:
            return { body: Buffer.alloc(0), warnings: [] };
    }
}

function textToBody(parts: RequestParts, base: BrunoItem | undefined): { body: BrunoBody, warnings: string[] } {
    const baseBody = base?.request?.body;
    const contentTypeHeader = getHeaderValue(parts.headers, 'content-type') ?? '';
    const contentType = contentTypeHeader.toLowerCase();
    const keep = (body: BrunoBody): BrunoBody => ({ ...baseBody, ...body });

    if (!parts.body.length) {
        // An emptied body keeps its type, so a JSON request stays one
        const mode = baseBody?.mode;
        if (!isTextBodyMode(mode)) return { body: keep({ mode: 'none' }), warnings: [] };

        const emptied: BrunoBody = keep({ mode });
        emptied[mode] = '';
        return { body: emptied, warnings: [] };
    }

    if (!isUtf8Text(parts.body)) {
        return {
            body: keep({ mode: 'none' }),
            warnings: ['The request body is binary data, which a collection can\'t store, so it was left out.']
        };
    }

    const text = parts.body.toString('utf8');

    if (contentType.includes('application/x-www-form-urlencoded')) {
        return { body: keep({ mode: 'formUrlEncoded', formUrlEncoded: decodeFormFields(text, baseBody?.formUrlEncoded ?? []) }), warnings: [] };
    }

    // Boundaries are case-sensitive, so they're read from the header as written
    const boundary = contentType.includes('multipart/form-data') ? boundaryOf(contentTypeHeader) : undefined;
    const multipartFields = boundary ? decodeMultipartFields(text, boundary) : undefined;
    if (multipartFields) {
        const fileFields = (baseBody?.multipartForm ?? []).filter((field) => field.type === 'file');
        return { body: keep({ mode: 'multipartForm', multipartForm: [...multipartFields, ...fileFields] }), warnings: [] };
    }

    if (base?.type === 'graphql-request' || baseBody?.mode === 'graphql') {
        const graphql = decodeGraphqlBody(text);
        if (graphql) return { body: keep({ mode: 'graphql', graphql }), warnings: [] };
    }

    if (contentType.includes('sparql')) return { body: keep({ mode: 'sparql', sparql: text }), warnings: [] };
    if (parts.contentType === 'json' || contentType.includes('json')) return { body: keep({ mode: 'json', json: text }), warnings: [] };
    if (parts.contentType === 'xml' || contentType.includes('xml')) return { body: keep({ mode: 'xml', xml: text }), warnings: [] };
    return { body: keep({ mode: 'text', text }), warnings: [] };
}

// --- Headers -----------------------------------------------------------------------

const normalizeMediaType = (value: string) => value.toLowerCase().replace(/\s+/g, '');

function isDerivedHeader(
    [name, value]: [string, string],
    url: string,
    bodyMode: BrunoBodyMode,
    baseHadContentType: boolean
): boolean {
    const lowerName = name.toLowerCase();
    if (lowerName === 'content-length') return true;
    if (lowerName === 'host') return value.toLowerCase() === hostOf(url)?.toLowerCase();
    if (lowerName !== 'content-type') return false;

    // The client picks a new boundary for every multipart request
    if (bodyMode === 'multipartForm') return normalizeMediaType(value).startsWith('multipart/form-data');

    const implied = IMPLIED_CONTENT_TYPES[bodyMode];
    return !baseHadContentType && !!implied && normalizeMediaType(value) === implied;
}

function toItemHeaders(parts: RequestParts, bodyMode: BrunoBodyMode, baseRequest: BrunoRequest | undefined): BrunoKeyValue[] {
    const baseHeaders = baseRequest?.headers ?? [];
    const enabledBaseHeaders = baseHeaders.filter((header) => header.enabled !== false);
    const baseHadContentType = enabledBaseHeaders.some((header) => header.name?.toLowerCase() === 'content-type');
    const reuse = matchingEntries(enabledBaseHeaders, false);

    const headers: BrunoKeyValue[] = parts.headers
        .filter(([name]) => !!name)
        .filter((header) => !isDerivedHeader(header, parts.url, bodyMode, baseHadContentType))
        .map(([name, value]) => ({ ...reuse(name), name, value, enabled: true }));

    return [...headers, ...baseHeaders.filter((header) => header.enabled === false)];
}

// --- Items <-> requests --------------------------------------------------------------

function editorContentType(headers: RawHeaders, mode: BrunoBodyMode): EditableContentType {
    const fromHeader = getEditableContentType(getHeaderValue(headers, 'content-type'));
    if (fromHeader) return fromHeader;
    return mode === 'json' || mode === 'graphql' ? 'json'
        : mode === 'xml' ? 'xml'
        : 'text';
}

/**
 * The request a Send tab shows for an item. Filled-in path params are applied to the
 * URL, and Host, Content-Type & Content-Length are added like Send does for typed
 * requests. Variables stay as {{templates}}: they're filled in when the request is sent.
 */
export function itemToRequestParts(item: BrunoItem): OpenedRequest {
    const request = item.request;
    if (!request) {
        return {
            parts: { method: 'GET', url: '', headers: [], body: Buffer.alloc(0), contentType: 'text' },
            warnings: ['This item has no request to open.']
        };
    }

    const url = applyPathParams(request.url ?? '', request.params ?? []);
    const headers: RawHeaders = (request.headers ?? [])
        .filter((header) => header.enabled !== false && header.name)
        .map((header) => [header.name!, header.value ?? '']);
    const { body, impliedContentType, warnings } = bodyToText(request.body);

    const host = hostOf(url);
    if (host && !hasHeader(headers, 'host')) headers.unshift(['host', host]);
    if (impliedContentType && !hasHeader(headers, 'content-type')) headers.push(['content-type', impliedContentType]);
    const isFramed = hasHeader(headers, 'content-length') || hasHeader(headers, 'transfer-encoding');
    if (body.length && !isFramed && !hasHeader(headers, 'content-encoding')) {
        headers.push(['content-length', body.byteLength.toString()]);
    }

    const mode = request.body?.mode ?? 'none';
    return {
        parts: {
            method: (request.method || 'GET').toUpperCase(),
            url,
            headers,
            body,
            contentType: editorContentType(headers, mode)
        },
        warnings
    };
}

/**
 * Builds the item for a Send tab's request, updating `base` (the item the tab was opened
 * from) when there is one, so everything Send doesn't show is kept.
 */
export function requestPartsToItem(
    parts: RequestParts,
    docs: string,
    base: BrunoItem | undefined,
    defaults: NewItemDefaults
): { item: BrunoItem, warnings: string[] } {
    const baseRequest = base?.request;
    const { body, warnings } = textToBody(parts, base);
    const { url, params } = toUrlAndParams(parts.url, baseRequest);

    const request: BrunoRequest = {
        auth: { mode: defaults.authMode ?? 'inherit' },
        script: {},
        vars: {},
        assertions: [],
        tests: '',
        ...baseRequest,
        method: parts.method.toUpperCase(),
        url,
        params,
        headers: toItemHeaders(parts, body.mode, baseRequest),
        body,
        docs
    };

    const type = base?.type === 'graphql-request' && body.mode !== 'graphql'
        ? 'http-request'
        : base?.type ?? 'http-request';

    return {
        item: {
            ...base,
            uid: base?.uid ?? defaults.uid ?? newUid(),
            type,
            name: base?.name ?? defaults.name,
            request
        },
        warnings
    };
}

export function requestInputToParts(input: RequestInput): RequestParts {
    return {
        method: input.method,
        url: input.url,
        headers: input.headers.map(([name, value]) => [name, value]),
        body: input.rawBody.decoded,
        contentType: input.requestContentType,
        extras: input.extras.toData()
    };
}

export function partsToRequestInput(parts: RequestParts): RequestInput {
    return new RequestInput({
        method: parts.method,
        url: parts.url,
        headers: parts.headers.map(([name, value]) => [name, value]),
        requestContentType: parts.contentType,
        rawBody: parts.body,
        extras: parts.extras
    });
}
