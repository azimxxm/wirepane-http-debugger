import { RawHeaders } from '../../types';
import { getHeaderValue, removeHeader, setHeaderValue } from '../http/headers';
import { RequestInput } from '../send/send-request-model';
import { SendExtrasData } from '../send/send-extras';

import {
    BrunoAuth,
    BrunoCollection,
    BrunoEnvironment,
    BrunoKeyValue,
    BrunoVariable
} from './collection-types';
import { ItemLocation } from './collection-tree';
import {
    hostOf,
    isUtf8Text,
    partsToRequestInput,
    pathParamNames,
    RequestParts,
    requestInputToParts
} from './request-mapping';
import { hasTemplate, splitTemplate, templateVariableNames } from './templates';

/**
 * {{variable}} resolution for requests sent from Send.
 *
 * A variable's value comes from the first of these that defines it (Bruno's precedence):
 * the request's own variables, its folders' variables (nearest first), the active
 * environment, then the collection's variables. Values can use other variables. Requests
 * opened from a collection also get the collection's and folders' headers and auth, like
 * Bruno and Postman send them. A {{variable}} that nothing defines is sent as written.
 *
 * Variables are filled in wherever text is sent: the URL, headers, the raw body, form
 * and multipart text fields, GraphQL queries and variables, and WebSocket messages. The
 * contents of files are sent as they are.
 */

export type VariableSource = 'request' | 'folder' | 'environment' | 'collection';

export interface ScopeVariable {
    name: string;
    value: string;
    secret: boolean;
    source: VariableSource;
}

// Variables by name, holding the definition that wins for each
export type VariableScope = ReadonlyMap<string, ScopeVariable>;

export interface InheritedHeader {
    name: string;
    value: string;
    // Where it's defined, e.g. "the collection" or "folder Pets"
    source: string;
}

export interface EffectiveAuth {
    auth: BrunoAuth;
    source: string;
}

export interface SendContext {
    scope: VariableScope;
    // The active environment, for messages about variables it doesn't set
    environmentName?: string;
    // Only for requests opened from a collection: never sent to unrelated requests
    inheritedHeaders?: InheritedHeader[];
    auth?: EffectiveAuth;
}

export const SECRET_MASK = '••••••••';

// A request that can't be sent as it is. The message says why, for showing to the user.
export class UnsendableRequestError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnsendableRequestError';
    }
}

const EMPTY_CONTEXT: SendContext = { scope: new Map() };

const variableText = (value: unknown): string =>
    typeof value === 'string' ? value
    : value === undefined || value === null ? ''
    : typeof value === 'object' ? JSON.stringify(value)
    : String(value);

const isUsable = (variable: { name?: string | null, enabled?: boolean }) =>
    variable.enabled !== false && !!variable.name?.trim();

export function buildVariableScope(options: {
    collection: BrunoCollection,
    environment?: BrunoEnvironment,
    location?: ItemLocation
}): VariableScope {
    const { collection, environment, location } = options;
    const scope = new Map<string, ScopeVariable>();

    // Levels are added from the highest precedence down, so the first definition wins
    const addAll = (
        variables: Array<BrunoVariable & { secret?: boolean }> | null | undefined,
        source: VariableSource
    ) => {
        for (const variable of variables ?? []) {
            if (!isUsable(variable)) continue;
            const name = variable.name!.trim();
            if (scope.has(name)) continue;
            scope.set(name, { name, value: variableText(variable.value), secret: variable.secret === true, source });
        }
    };

    addAll(location?.item.request?.vars?.req, 'request');
    [...(location?.parents ?? [])].reverse().forEach((folder) => addAll(folder.root?.request?.vars?.req, 'folder'));
    addAll(environment?.variables, 'environment');
    addAll(collection.root?.request?.vars?.req, 'collection');

    return scope;
}

// Postman & Bruno's built-in dynamic variables that are worth supporting
const DYNAMIC_VARIABLES: { [name: string]: () => string } = {
    '$guid': () => crypto.randomUUID(),
    '$randomUUID': () => crypto.randomUUID(),
    '$timestamp': () => Math.floor(Date.now() / 1000).toString(),
    '$isoTimestamp': () => new Date().toISOString(),
    '$randomInt': () => Math.floor(Math.random() * 1001).toString()
};

interface ResolveOptions {
    // Collects the names of variables that nothing defines
    unresolved?: Set<string>;
    // Collects the names of variables that are defined, but empty
    empty?: Set<string>;
    // Applied to every filled-in value, e.g. form encoding for form bodies
    encode?: (value: string) => string;
}

export function resolveTemplate(text: string, scope: VariableScope, options: ResolveOptions = {}): string {
    return resolveWithin(text, scope, options, []);
}

function resolveWithin(text: string, scope: VariableScope, options: ResolveOptions, resolving: string[]): string {
    if (!text.includes('{{')) return text;

    return splitTemplate(text).map((part) => {
        if (!part.isVariable) return part.text;
        if (!part.text) return '{{}}';

        const dynamic = DYNAMIC_VARIABLES[part.text];
        const variable = scope.get(part.text);
        const isCycle = resolving.includes(part.text);

        if (!dynamic && (!variable || isCycle)) {
            options.unresolved?.add(part.text);
            return `{{${part.text}}}`;
        }

        if (variable && !variable.value) options.empty?.add(part.text);

        // Nested values are resolved without encoding: the whole value is encoded once
        const value = dynamic
            ? dynamic()
            : resolveWithin(variable!.value, scope, { unresolved: options.unresolved, empty: options.empty }, [...resolving, part.text]);
        return options.encode ? options.encode(value) : value;
    }).join('');
}

export function effectiveAuth(collection: BrunoCollection, location: ItemLocation): EffectiveAuth | undefined {
    const levels: Array<{ auth: BrunoAuth | null | undefined, source: string }> = [
        { auth: location.item.request?.auth, source: 'this request' },
        ...[...location.parents].reverse().map((folder) => ({
            auth: folder.root?.request?.auth,
            source: `folder ${folder.name}`
        })),
        { auth: collection.root?.request?.auth, source: 'the collection' }
    ];

    for (const { auth, source } of levels) {
        if (!auth || auth.mode === 'inherit') continue;
        return auth.mode === 'none' ? undefined : { auth, source };
    }
    return undefined;
}

export function inheritedHeaders(collection: BrunoCollection, location: ItemLocation): InheritedHeader[] {
    const levels: Array<{ headers: BrunoKeyValue[] | null | undefined, source: string }> = [
        ...[...location.parents].reverse().map((folder) => ({
            headers: folder.root?.request?.headers,
            source: `folder ${folder.name}`
        })),
        { headers: collection.root?.request?.headers, source: 'the collection' }
    ];

    // The nearest level wins for each header name
    const byName = new Map<string, InheritedHeader>();
    for (const { headers, source } of levels) {
        for (const header of headers ?? []) {
            if (!isUsable(header)) continue;
            const key = header.name!.toLowerCase();
            if (!byName.has(key)) byName.set(key, { name: header.name!, value: header.value ?? '', source });
        }
    }
    return [...byName.values()];
}

const AUTH_MODE_NAMES: { [mode: string]: string } = {
    bearer: 'Bearer token',
    basic: 'Basic auth',
    apikey: 'API key',
    digest: 'Digest auth',
    ntlm: 'NTLM',
    oauth1: 'OAuth 1.0',
    oauth2: 'OAuth 2.0',
    awsv4: 'AWS Signature v4',
    wsse: 'WSSE',
    'akamai-edgegrid': 'Akamai EdgeGrid'
};

export const authModeName = (mode: string) => AUTH_MODE_NAMES[mode] ?? mode;

interface AuthEntries {
    header?: [string, string];
    query?: [string, string];
    // Set for auth modes that Send can't apply
    unsupported?: boolean;
}

function authEntries(auth: BrunoAuth, resolve: (text: string) => string): AuthEntries {
    switch (auth.mode) {
        case 'bearer':
            return { header: ['Authorization', `Bearer ${resolve(auth.bearer?.token ?? '')}`] };
        case 'basic': {
            const credentials = `${resolve(auth.basic?.username ?? '')}:${resolve(auth.basic?.password ?? '')}`;
            return { header: ['Authorization', `Basic ${Buffer.from(credentials).toString('base64')}`] };
        }
        case 'apikey': {
            const key = resolve(auth.apikey?.key ?? '');
            if (!key) return {};
            const entry: [string, string] = [key, resolve(auth.apikey?.value ?? '')];
            return auth.apikey?.placement === 'queryparams' ? { query: entry } : { header: entry };
        }
        default:
            return { unsupported: true };
    }
}

export const isAuthSupported = (auth: BrunoAuth) => !authEntries(auth, (text) => text).unsupported;

// The variables an auth setting uses, e.g. ['authToken'] for "Bearer {{authToken}}"
export function authTemplates(auth: BrunoAuth): string[] {
    const fields = auth.mode === 'bearer' ? [auth.bearer?.token]
        : auth.mode === 'basic' ? [auth.basic?.username, auth.basic?.password]
        : auth.mode === 'apikey' ? [auth.apikey?.key, auth.apikey?.value]
        : [];
    return fields.filter((field): field is string => !!field);
}

const asHeaderKey = (name: string) => name.toLowerCase() as Lowercase<string>;
const hasHeader = (headers: RawHeaders, name: string) => getHeaderValue(headers, asHeaderKey(name)) !== undefined;

function withQueryParam(url: string, [name, value]: [string, string]): string {
    const [withoutHash, ...hash] = url.split('#');
    const [base, ...query] = withoutHash.split('?');
    const queryString = query.join('?');
    const encodedName = encodeURIComponent(name);

    const alreadySet = queryString.split('&').some((pair) => pair.split('=')[0] === encodedName);
    if (alreadySet) return url;

    const pair = `${encodedName}=${encodeURIComponent(value)}`;
    const newQuery = queryString ? `${queryString}&${pair}` : pair;
    return `${base}?${newQuery}${hash.length ? `#${hash.join('#')}` : ''}`;
}

// Bodies are only filled in up to this size: bigger ones are sent as they are
const MAX_RESOLVED_BODY_BYTES = 2 * 1024 * 1024;

const formEncodeValue = (value: string) => encodeURIComponent(value).replace(/%20/g, '+');

function resolveBody(body: Buffer, headers: RawHeaders, resolve: (text: string, encode?: (value: string) => string) => string): Buffer {
    if (body.length > MAX_RESOLVED_BODY_BYTES || !body.includes('{{') || !isUtf8Text(body)) return body;

    const text = body.toString('utf8');
    const isForm = /application\/x-www-form-urlencoded/i.test(getHeaderValue(headers, 'content-type') ?? '');
    const resolved = resolve(text, isForm ? formEncodeValue : undefined);
    return resolved === text ? body : Buffer.from(resolved);
}

// The raw body is only sent by HTTP tabs in a raw body mode: other modes keep it for later
const sendsRawBody = (extras: SendExtrasData | undefined) =>
    !extras || (extras.requestType === 'http' && extras.bodyMode === 'raw');

type Resolve = (text: string) => string;

// Fills in the parts of a tab's extras that are sent, giving back the same object when
// nothing changes. Only the active body mode's fields (and enabled ones) are sent.
function resolveExtras(extras: SendExtrasData | undefined, resolve: Resolve): SendExtrasData | undefined {
    if (!extras) return extras;
    let changed = false;
    const resolved = (text: string) => {
        const result = resolve(text);
        if (result !== text) changed = true;
        return result;
    };

    let result: SendExtrasData;
    if (extras.requestType === 'websocket') {
        const { websocket } = extras;
        result = {
            ...extras,
            websocket: {
                ...websocket,
                // Binary messages are base64 data, which has no {{variables}}
                message: websocket.messageType === 'binary' ? websocket.message : resolved(websocket.message),
                savedMessages: websocket.savedMessages.map((message) =>
                    message.type === 'binary' ? message : { ...message, content: resolved(message.content) }
                )
            }
        };
    } else if (extras.bodyMode === 'form') {
        result = {
            ...extras,
            formFields: extras.formFields.map((field) => field.enabled
                ? { ...field, name: resolved(field.name), value: resolved(field.value) }
                : field
            )
        };
    } else if (extras.bodyMode === 'multipart') {
        result = {
            ...extras,
            multipartFields: extras.multipartFields.map((field) => !field.enabled ? field : {
                ...field,
                name: resolved(field.name),
                value: field.kind === 'text' ? resolved(field.value) : field.value
            })
        };
    } else if (extras.bodyMode === 'graphql') {
        result = {
            ...extras,
            graphql: { ...extras.graphql, query: resolved(extras.graphql.query), variables: resolved(extras.graphql.variables) }
        };
    } else {
        return extras;
    }

    return changed ? result : extras;
}

// Keeps Content-Length right after variables changed the body
function syncContentLength(headers: RawHeaders, body: Buffer) {
    // An encoded body's length is only known after encoding, so it's sent chunked instead
    const isEncoded = hasHeader(headers, 'content-encoding');

    if (hasHeader(headers, 'content-length')) {
        if (isEncoded) removeHeader(headers, 'content-length');
        else setHeaderValue(headers, 'content-length', body.byteLength.toString());
    } else if (!isEncoded && !hasHeader(headers, 'transfer-encoding') && body.length) {
        headers.push(['content-length', body.byteLength.toString()]);
    }
}

export interface PreparedRequest {
    parts: RequestParts;
    // False when nothing needed filling in, so the original request can be sent as is
    changed: boolean;
    // Variables that nothing defines, sent as {{name}}
    unresolved: string[];
    // Variables that are defined but empty, sent as nothing
    empty: string[];
}

/**
 * The request that actually gets sent: {{variables}} filled in, plus the collection's
 * headers and auth for requests that came from one.
 */
export function prepareRequest(parts: RequestParts, context: SendContext): PreparedRequest {
    const unresolved = new Set<string>();
    const empty = new Set<string>();
    const resolve = (text: string, encode?: (value: string) => string) =>
        resolveTemplate(text, context.scope, { unresolved, empty, encode });

    let url = resolve(parts.url);
    const headers: RawHeaders = parts.headers.map(([name, value]) => [resolve(name), resolve(value)]);
    let headersChanged = headers.some(([name, value], index) =>
        name !== parts.headers[index][0] || value !== parts.headers[index][1]
    );

    for (const header of context.inheritedHeaders ?? []) {
        if (hasHeader(headers, header.name)) continue;
        headers.push([header.name, resolve(header.value)]);
        headersChanged = true;
    }

    if (context.auth) {
        const entries = authEntries(context.auth.auth, (text) => resolve(text));
        if (entries.header && !hasHeader(headers, entries.header[0])) {
            headers.push(entries.header);
            headersChanged = true;
        }
        if (entries.query) url = withQueryParam(url, entries.query);
    }

    // Send keeps Host in sync with the URL, but not while the URL's origin is a variable
    if (url !== parts.url && !hostOf(parts.url)) {
        const host = hostOf(url);
        if (host && !hasHeader(headers, 'host')) {
            headers.unshift(['host', host]);
            headersChanged = true;
        }
    }

    const body = sendsRawBody(parts.extras) ? resolveBody(parts.body, headers, resolve) : parts.body;
    if (body !== parts.body) {
        syncContentLength(headers, body);
        headersChanged = true;
    }

    const extras = resolveExtras(parts.extras, (text) => resolve(text));

    return {
        parts: { ...parts, url, headers, body, extras },
        changed: headersChanged || url !== parts.url || body !== parts.body || extras !== parts.extras,
        unresolved: [...unresolved],
        empty: [...empty]
    };
}

export interface UnsetValues {
    // {{variables}} that nothing defines
    variables: string[];
    // {{variables}} that are defined, but with an empty value
    emptyVariables: string[];
    // :path params still in the URL, with no value
    pathParams: string[];
}

export function findUnsetValues(parts: RequestParts, context: SendContext | undefined): UnsetValues {
    const prepared = prepareRequest(parts, context ?? EMPTY_CONTEXT);
    return {
        variables: prepared.unresolved,
        emptyVariables: prepared.empty,
        pathParams: pathParamNames(prepared.parts.url)
    };
}

const listNames = (names: string[]) => names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

// Where a variable could have come from, for the message when it's missing
function missingVariableHint(context: SendContext | undefined, count: number): string {
    const pronoun = count === 1 ? 'it' : 'them';
    if (!context) return 'No collection applies to this tab: select one in Collections to use its environments.';
    if (!context.environmentName) return `No environment is active: pick one in the Send header, or add ${pronoun} under Environments.`;
    return `Add ${pronoun} to ${context.environmentName} under Environments, or pick another environment.`;
}

/**
 * Requests can only be sent to a full URL. Instead of a generic URL error, this says
 * what's wrong: no URL, a {{variable}} that isn't set, or a value that doesn't make a
 * full URL. Filled-in values aren't repeated, as they may be secrets.
 */
function assertSendableUrl(originalUrl: string, prepared: PreparedRequest, context: SendContext | undefined) {
    const url = prepared.parts.url.trim();
    const isWebSocket = prepared.parts.extras?.requestType === 'websocket';
    if (!url) throw new UnsendableRequestError(isWebSocket ? 'Enter a URL to connect to.' : 'Enter a URL to send this request.');
    const schemes = isWebSocket ? 'wss:// or ws://' : 'https:// or http://';

    const missing = prepared.unresolved.filter((name) => url.includes(`{{${name}}}`));
    if (missing.length) {
        const names = listNames(missing.map((name) => `{{${name}}}`));
        const where = context?.environmentName ? ` in ${context.environmentName}` : '';
        throw new UnsendableRequestError(
            `${names} ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} set${where}, so the URL isn't complete. ` +
            missingVariableHint(context, missing.length)
        );
    }

    let host: string | undefined;
    try {
        host = new URL(url).host;
    } catch {}
    if (host) return;

    const usedVariables = templateVariableNames(originalUrl);
    if (!usedVariables.length) {
        const example = isWebSocket ? 'wss://echo.websocket.org' : 'https://api.example.com/users';
        throw new UnsendableRequestError(`"${url}" isn't a full URL. URLs start with ${schemes}, like ${example}.`);
    }

    const firstVariable = usedVariables[0];
    const source = context?.scope.get(firstVariable)?.source;
    const where = source === 'environment' ? ` in ${context!.environmentName}`
        : source === 'collection' ? ' in the collection variables'
        : source === 'folder' ? ' in the folder variables'
        : source === 'request' ? ' in the request variables'
        : '';
    throw new UnsendableRequestError(
        `${originalUrl.trim()} isn't a full URL once its variables are filled in. ` +
        `Check {{${firstVariable}}}${where}: a base URL starts with ${schemes}.`
    );
}

/**
 * Called by Send just before sending: returns the request to send, which is the same
 * request when there's nothing to fill in.
 */
export function resolveVariables(requestInput: RequestInput, context: SendContext | undefined): RequestInput {
    const prepared = prepareRequest(requestInputToParts(requestInput), context ?? EMPTY_CONTEXT);
    assertSendableUrl(requestInput.url, prepared, context);
    return prepared.changed ? partsToRequestInput(prepared.parts) : requestInput;
}
