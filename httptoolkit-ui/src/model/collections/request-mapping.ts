import * as _ from 'lodash';

import { RawHeaders } from '../../types';
import { getHeaderValue } from '../http/headers';
import { EditableContentType, getEditableContentType } from '../events/content-types';
import { RequestInput } from '../send/send-request-model';
import { SendBodyMode, SendExtras, SendExtrasData } from '../send/send-extras';
import { newMultipartBoundary } from '../send/build-request';

import {
    BrunoBody,
    BrunoBodyMode,
    BrunoItem,
    BrunoKeyValue,
    BrunoMultipartField,
    BrunoParam,
    BrunoRequest,
    BrunoWsRequest,
    isTextBodyMode,
    TEXT_BODY_MODES,
    TextBodyMode
} from './collection-types';
import { newUid } from './collection-tree';
import { hasTemplate } from './templates';
import {
    brunoBodyModeOf,
    FilePathOf,
    fileNameOf,
    fromBinaryFile,
    fromFormFields,
    fromGraphqlBody,
    fromMultipartFields,
    fromWebSocketMessages,
    isPlainHttp,
    ItemFiles,
    itemFilePaths,
    sendBodyModeOf,
    toBinaryFile,
    toFormFields,
    toGraphqlBody,
    toMultipartFields,
    toWebSocketDraft
} from './extras-mapping';

/**
 * Maps between a Send tab's request and a Bruno request item: http-request,
 * graphql-request or ws-request.
 *
 * Send works with a request line, headers and a body, which is raw text or one of the
 * structured modes (form, multipart, binary, GraphQL: see extras-mapping.ts). Items hold
 * more structure (query & path params, disabled entries, auth, scripts, docs, examples),
 * so saving a tab updates its item in place: whatever the tab can't show is kept from the
 * item, and values that Send derives (Host, Content-Length, the body's default
 * Content-Type) aren't stored, just as Bruno and Postman don't store them.
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

const formDecode = (text: string) => safeDecodeURIComponent(text.replace(/\+/g, ' '));

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

const textModeOf = (contentType: EditableContentType): TextBodyMode =>
    contentType === 'json' ? 'json' : contentType === 'xml' ? 'xml' : 'text';

// The text a tab's raw editor shows for an item: the body itself for text modes. With a
// structured mode, it's text kept from an earlier mode, so switching back brings it back.
function rawTextOf(body: BrunoBody | undefined, bodyMode: SendBodyMode): { text: string, textMode?: TextBodyMode } {
    const mode = body?.mode;
    if (bodyMode === 'raw') return isTextBodyMode(mode) ? { text: body?.[mode] ?? '', textMode: mode } : { text: '' };

    const textMode = TEXT_BODY_MODES.find((candidate) => !!body?.[candidate]);
    return textMode ? { text: body![textMode]!, textMode } : { text: '' };
}

// The Content-Type that a body implies, for requests without one
function impliedContentType(body: BrunoBody | undefined, extras: SendExtrasData): string | undefined {
    switch (extras.bodyMode) {
        case 'raw': return IMPLIED_CONTENT_TYPES[body?.mode ?? 'none'];
        case 'form': return 'application/x-www-form-urlencoded';
        case 'multipart': return `multipart/form-data; boundary=${newMultipartBoundary()}`;
        case 'binary': return extras.binaryFile?.contentType || 'application/octet-stream';
        case 'graphql': return 'application/json';
    }
}

// Saves a raw body: its type comes from the Content-Type, and forms and multipart bodies
// are read back into fields
function textToBody(
    parts: RequestParts,
    baseBody: BrunoBody | undefined,
    isGraphqlBase: boolean,
    warnings: string[]
): BrunoBody {
    const contentTypeHeader = getHeaderValue(parts.headers, 'content-type') ?? '';
    const contentType = contentTypeHeader.toLowerCase();
    const keep = (body: BrunoBody): BrunoBody => ({ ...baseBody, ...body });

    if (!parts.body.length) {
        // An emptied body keeps its type, so a JSON request stays one
        const mode = baseBody?.mode;
        if (!isTextBodyMode(mode)) return keep({ mode: 'none' });

        const emptied: BrunoBody = keep({ mode });
        emptied[mode] = '';
        return emptied;
    }

    if (!isUtf8Text(parts.body)) {
        warnings.push('The request body is binary data, which a collection can\'t store, so it was left out. Use the Binary body mode to send a file.');
        return keep({ mode: 'none' });
    }

    const text = parts.body.toString('utf8');

    if (contentType.includes('application/x-www-form-urlencoded')) {
        return keep({ mode: 'formUrlEncoded', formUrlEncoded: decodeFormFields(text, baseBody?.formUrlEncoded ?? []) });
    }

    // Boundaries are case-sensitive, so they're read from the header as written
    const boundary = contentType.includes('multipart/form-data') ? boundaryOf(contentTypeHeader) : undefined;
    const multipartFields = boundary ? decodeMultipartFields(text, boundary) : undefined;
    if (multipartFields) {
        const fileFields = (baseBody?.multipartForm ?? []).filter((field) => field.type === 'file');
        return keep({ mode: 'multipartForm', multipartForm: [...multipartFields, ...fileFields] });
    }

    // Tabs opened before GraphQL had its own mode hold GraphQL requests as JSON text
    if (isGraphqlBase) {
        const graphql = decodeGraphqlBody(text);
        if (graphql) return keep({ mode: 'graphql', graphql });
    }

    if (contentType.includes('sparql')) return keep({ mode: 'sparql', sparql: text });
    if (parts.contentType === 'json' || contentType.includes('json')) return keep({ mode: 'json', json: text });
    if (parts.contentType === 'xml' || contentType.includes('xml')) return keep({ mode: 'xml', xml: text });
    return keep({ mode: 'text', text });
}

// Saves a structured body. Its data is added by addStructuredData.
function structuredBody(parts: RequestParts, bodyMode: Exclude<SendBodyMode, 'raw'>, baseBody: BrunoBody | undefined): BrunoBody {
    const body: BrunoBody = { ...baseBody, mode: brunoBodyModeOf(bodyMode) };

    // The raw editor's text is kept too, as switching back to it brings it back
    if (parts.body.length && isUtf8Text(parts.body)) body[textModeOf(parts.contentType)] = parts.body.toString('utf8');
    return body;
}

/**
 * Adds the data of every structured body mode, not only the one in use: switching modes
 * and saving loses nothing. Tabs without any (e.g. captured traffic) save their raw body
 * only, so they're saved exactly as before structured modes existed.
 */
function addStructuredData(
    body: BrunoBody,
    parts: RequestParts,
    baseBody: BrunoBody | undefined,
    filePathOf: FilePathOf,
    warnings: string[]
) {
    const { extras } = parts;
    if (!extras || isPlainHttp(extras)) return;

    // A raw form or multipart body was read back into fields already: those win
    const readFromText = extras.bodyMode === 'raw' ? body.mode : undefined;

    if (readFromText !== 'formUrlEncoded' && (extras.formFields.length || baseBody?.formUrlEncoded)) {
        body.formUrlEncoded = fromFormFields(extras.formFields, baseBody?.formUrlEncoded);
    }

    if (readFromText !== 'multipartForm' && (extras.multipartFields.length || baseBody?.multipartForm)) {
        body.multipartForm = fromMultipartFields(extras.multipartFields, baseBody?.multipartForm, filePathOf, warnings);
    }

    if (extras.binaryFile || baseBody?.file) {
        // Bruno sends a binary body with its file's type, so the tab's Content-Type goes there
        const contentType = extras.bodyMode === 'binary'
            ? getHeaderValue(parts.headers, 'content-type') ?? extras.binaryFile?.contentType ?? ''
            : extras.binaryFile?.contentType ?? '';
        body.file = fromBinaryFile(extras.binaryFile, contentType, baseBody?.file, filePathOf, warnings);
    }

    const hasGraphql = extras.bodyMode === 'graphql' || !!extras.graphql.query || !!extras.graphql.variables;
    if (readFromText !== 'graphql' && (hasGraphql || baseBody?.graphql)) {
        body.graphql = fromGraphqlBody(extras.graphql, baseBody?.graphql);
    }
}

// --- Headers -----------------------------------------------------------------------

const normalizeMediaType = (value: string) => value.toLowerCase().replace(/\s+/g, '');

function isDerivedHeader(
    [name, value]: [string, string],
    url: string,
    body: BrunoBody,
    baseHadContentType: boolean
): boolean {
    const lowerName = name.toLowerCase();
    if (lowerName === 'content-length') return true;
    if (lowerName === 'host') return value.toLowerCase() === hostOf(url)?.toLowerCase();
    if (lowerName !== 'content-type') return false;

    // The client picks a new boundary for every multipart request
    if (body.mode === 'multipartForm') return normalizeMediaType(value).startsWith('multipart/form-data');

    // A binary body is sent with its file's type
    const implied = body.mode === 'file'
        ? body.file?.find((entry) => entry.selected)?.contentType
        : IMPLIED_CONTENT_TYPES[body.mode];
    return !baseHadContentType && !!implied && normalizeMediaType(value) === normalizeMediaType(implied);
}

function toItemHeaders(parts: RequestParts, body: BrunoBody, baseRequest: BrunoWsRequest | undefined): BrunoKeyValue[] {
    const baseHeaders = baseRequest?.headers ?? [];
    const enabledBaseHeaders = baseHeaders.filter((header) => header.enabled !== false);
    const baseHadContentType = enabledBaseHeaders.some((header) => header.name?.toLowerCase() === 'content-type');
    const reuse = matchingEntries(enabledBaseHeaders, false);

    const headers: BrunoKeyValue[] = parts.headers
        .filter(([name]) => !!name)
        .filter((header) => !isDerivedHeader(header, parts.url, body, baseHadContentType))
        .map(([name, value]) => ({ ...reuse(name), name, value, enabled: true }));

    return [...headers, ...baseHeaders.filter((header) => header.enabled === false)];
}

// The enabled headers of an item, plus Host like Send adds it
function itemHeaders(request: BrunoWsRequest, url: string): RawHeaders {
    const headers: RawHeaders = (request.headers ?? [])
        .filter((header) => header.enabled !== false && header.name)
        .map((header) => [header.name!, header.value ?? '']);

    const host = hostOf(url);
    if (host && !hasHeader(headers, 'host')) headers.unshift(['host', host]);
    return headers;
}

// --- Items <-> requests --------------------------------------------------------------

function editorContentType(headers: RawHeaders, mode: BrunoBodyMode | undefined): EditableContentType {
    const fromHeader = getEditableContentType(getHeaderValue(headers, 'content-type'));
    if (fromHeader) return fromHeader;
    return mode === 'json' || mode === 'graphql' ? 'json'
        : mode === 'xml' ? 'xml'
        : 'text';
}

const listNames = (names: string[]) => names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

function missingFilesWarnings(filePaths: string[]): string[] {
    if (!filePaths.length) return [];

    const names = listNames(filePaths.map((filePath) => `“${fileNameOf(filePath)}”`));
    return [filePaths.length === 1
        ? `The file ${names} (${filePaths[0]}) isn't in the collection folder, so it can't be sent. Attach it again.`
        : `${filePaths.length} files aren't in the collection folder, so they can't be sent: ${names}. Attach them again.`
    ];
}

function httpItemToParts(item: BrunoItem, request: BrunoRequest, files: ItemFiles): RequestParts {
    const url = applyPathParams(request.url ?? '', request.params ?? []);
    const headers = itemHeaders(request, url);
    const body = request.body;

    const extras = new SendExtras({
        bodyMode: sendBodyModeOf(item),
        formFields: toFormFields(body?.formUrlEncoded),
        multipartFields: toMultipartFields(body?.multipartForm, files),
        binaryFile: toBinaryFile(body?.file, files),
        graphql: toGraphqlBody(body?.graphql)
    }).toData();

    const { text, textMode } = rawTextOf(body, extras.bodyMode);
    const rawBody = Buffer.from(text);

    const contentType = impliedContentType(body, extras);
    if (contentType && !hasHeader(headers, 'content-type')) headers.push(['content-type', contentType]);

    // Structured bodies are only built when sending, which sets their Content-Length then
    const isFramed = hasHeader(headers, 'content-length') || hasHeader(headers, 'transfer-encoding');
    if (extras.bodyMode === 'raw' && rawBody.length && !isFramed && !hasHeader(headers, 'content-encoding')) {
        headers.push(['content-length', rawBody.byteLength.toString()]);
    }

    return {
        method: (request.method || 'GET').toUpperCase(),
        url,
        headers,
        body: rawBody,
        contentType: editorContentType(headers, extras.bodyMode === 'graphql' ? 'graphql' : textMode),
        extras
    };
}

function webSocketItemToParts(request: BrunoWsRequest): RequestParts {
    const url = request.url ?? '';
    return {
        // The opening handshake is a GET
        method: 'GET',
        url,
        headers: itemHeaders(request, url),
        body: Buffer.alloc(0),
        contentType: 'text',
        extras: new SendExtras({ requestType: 'websocket', websocket: toWebSocketDraft(request.body?.ws) }).toData()
    };
}

/**
 * The request a Send tab shows for an item. Filled-in path params are applied to the
 * URL, and Host, Content-Type & Content-Length are added like Send does for typed
 * requests. Variables stay as {{templates}}: they're filled in when the request is sent.
 *
 * `files` holds the files the item sends (itemFilePaths), loaded into the Send file
 * store. Files that aren't there are shown as missing.
 */
export function itemToRequestParts(item: BrunoItem, files: ItemFiles = new Map()): OpenedRequest {
    const request = item.request;
    if (!request) {
        return {
            parts: { method: 'GET', url: '', headers: [], body: Buffer.alloc(0), contentType: 'text' },
            warnings: ['This item has no request to open.']
        };
    }

    return {
        parts: item.type === 'ws-request' ? webSocketItemToParts(request) : httpItemToParts(item, request, files),
        warnings: missingFilesWarnings(itemFilePaths(item).filter((filePath) => !files.has(filePath)))
    };
}

// Settings that only the other kind of request (HTTP or WebSocket) has are dropped
const HTTP_SETTINGS = ['encodeUrl', 'followRedirects', 'maxRedirects', 'timeout', 'forwardAuthorizationHeader', 'omitHeaders'];
const WEBSOCKET_SETTINGS = ['timeout', 'keepAliveInterval'];

function newItem(base: BrunoItem | undefined, defaults: NewItemDefaults, type: string, request: BrunoWsRequest): BrunoItem {
    const item: BrunoItem = {
        ...base,
        uid: base?.uid ?? defaults.uid ?? newUid(),
        type,
        name: base?.name ?? defaults.name,
        // ws-request items have no method or params, which BrunoRequest always lists
        request: request as BrunoRequest
    };

    const isWebSocket = type === 'ws-request';
    if (base?.settings && isWebSocket !== (base.type === 'ws-request')) {
        item.settings = _.pick(base.settings, isWebSocket ? WEBSOCKET_SETTINGS : HTTP_SETTINGS);
    }
    // Bruno keeps examples for HTTP, GraphQL and gRPC requests only
    if (isWebSocket) delete item.examples;
    return item;
}

function httpPartsToItem(
    parts: RequestParts,
    docs: string,
    base: BrunoItem | undefined,
    defaults: NewItemDefaults,
    filePathOf: FilePathOf
): { item: BrunoItem, warnings: string[] } {
    const isFromWebSocket = base?.type === 'ws-request';
    const baseRequest = base?.request;
    // A WebSocket request's messages have no place in an HTTP body
    const baseBody = isFromWebSocket ? undefined : baseRequest?.body;
    const bodyMode = parts.extras?.bodyMode ?? 'raw';
    const warnings: string[] = [];

    const body = bodyMode === 'raw'
        ? textToBody(parts, baseBody, base?.type === 'graphql-request' || baseBody?.mode === 'graphql', warnings)
        : structuredBody(parts, bodyMode, baseBody);
    addStructuredData(body, parts, baseBody, filePathOf, warnings);

    const { url, params } = toUrlAndParams(parts.url, isFromWebSocket ? undefined : baseRequest);
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
        headers: toItemHeaders(parts, body, baseRequest),
        body,
        docs
    };

    const type = body.mode === 'graphql' ? 'graphql-request'
        : base?.type === 'graphql-request' || isFromWebSocket ? 'http-request'
        : base?.type ?? 'http-request';

    return { item: newItem(base, defaults, type, request), warnings };
}

function webSocketPartsToItem(
    parts: RequestParts,
    docs: string,
    base: BrunoItem | undefined,
    defaults: NewItemDefaults
): { item: BrunoItem, warnings: string[] } {
    const baseRequest = base?.request;
    const baseMessages = base?.type === 'ws-request' ? baseRequest?.body?.ws : undefined;
    const body: BrunoBody = { mode: 'ws', ws: fromWebSocketMessages(parts.extras?.websocket.savedMessages ?? [], baseMessages) };

    const request: BrunoWsRequest = {
        auth: { mode: defaults.authMode ?? 'inherit' },
        script: {},
        vars: {},
        assertions: [],
        tests: '',
        ..._.omit(baseRequest, ['method', 'params', 'methodType']),
        url: parts.url,
        headers: toItemHeaders(parts, body, baseRequest),
        body,
        docs
    };

    return { item: newItem(base, defaults, 'ws-request', request), warnings: [] };
}

/**
 * Builds the item for a Send tab's request, updating `base` (the item the tab was opened
 * from) when there is one, so everything Send doesn't show is kept.
 *
 * `filePathOf` gives the path in the collection folder of each file the tab sends, for
 * files stored there already: files without one are left out, with a warning.
 */
export function requestPartsToItem(
    parts: RequestParts,
    docs: string,
    base: BrunoItem | undefined,
    defaults: NewItemDefaults,
    filePathOf: FilePathOf = () => undefined
): { item: BrunoItem, warnings: string[] } {
    return parts.extras?.requestType === 'websocket'
        ? webSocketPartsToItem(parts, docs, base, defaults)
        : httpPartsToItem(parts, docs, base, defaults, filePathOf);
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
