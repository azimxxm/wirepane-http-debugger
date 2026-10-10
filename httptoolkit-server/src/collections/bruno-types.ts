/**
 * The in-memory collection model is Bruno's collection JSON (the shape validated by
 * @usebruno/schema's collectionSchema), so Bruno's converters work on it directly.
 * These interfaces only describe the fields this service reads or writes. Every
 * other field is carried through untouched.
 */

export interface BrunoKeyValue {
    uid?: string;
    name?: string | null;
    value?: unknown;
    description?: string | null;
    enabled?: boolean;
    type?: string;
}

export interface BrunoAuth {
    mode: string;
    basic?: Record<string, unknown> | null;
    bearer?: Record<string, unknown> | null;
    digest?: Record<string, unknown> | null;
    ntlm?: Record<string, unknown> | null;
    wsse?: Record<string, unknown> | null;
    apikey?: Record<string, unknown> | null;
    awsv4?: Record<string, unknown> | null;
    oauth1?: Record<string, unknown> | null;
    oauth2?: Record<string, unknown> | null;
    akamaiEdgegrid?: Record<string, unknown> | null;
}

export interface BrunoBody {
    mode?: string;
    json?: string | null;
    text?: string | null;
    xml?: string | null;
    sparql?: string | null;
    formUrlEncoded?: BrunoKeyValue[] | null;
    multipartForm?: BrunoKeyValue[] | null;
    graphql?: { query?: string | null, variables?: string | null } | null;
}

export interface BrunoVars {
    req?: BrunoKeyValue[] | null;
    res?: BrunoKeyValue[] | null;
}

export interface BrunoScript {
    req?: string | null;
    res?: string | null;
}

export interface BrunoRequest {
    url?: string;
    method?: string;
    headers?: BrunoKeyValue[];
    params?: BrunoKeyValue[];
    auth?: BrunoAuth;
    body?: BrunoBody;
    script?: BrunoScript;
    vars?: BrunoVars | null;
    assertions?: BrunoKeyValue[] | null;
    tests?: string | null;
    docs?: string | null;
}

export interface BrunoExample {
    uid?: string;
    itemUid?: string;
    name: string;
    description?: string | null;
    type?: string;
    request?: {
        url?: string;
        method?: string;
        headers?: BrunoKeyValue[];
        params?: BrunoKeyValue[];
        body?: BrunoBody;
    } | null;
    response?: {
        status?: number | null;
        statusText?: string | null;
        headers?: BrunoKeyValue[] | null;
        body?: { type?: string | null, content?: unknown } | null;
    } | null;
}

export interface BrunoFolderRoot {
    request?: {
        headers?: BrunoKeyValue[] | null;
        auth?: BrunoAuth;
        script?: BrunoScript | null;
        vars?: BrunoVars | null;
        tests?: string | null;
    } | null;
    docs?: string | null;
    meta?: { name?: string | null, seq?: number | null, tags?: string[] | null } | null;
}

export interface BrunoItem {
    uid?: string;
    type: string;
    name: string;
    seq?: number;
    tags?: string[];
    request?: BrunoRequest;
    settings?: Record<string, unknown> | null;
    root?: BrunoFolderRoot | null;
    items?: BrunoItem[];
    examples?: BrunoExample[] | null;
}

export interface BrunoEnvironmentVariable {
    uid?: string;
    name?: string | null;
    value?: unknown;
    type?: string;
    enabled?: boolean;
    secret?: boolean;
}

export interface BrunoEnvironment {
    uid?: string;
    name: string;
    variables: BrunoEnvironmentVariable[];
    color?: string | null;
}

export interface BrunoCollection {
    version: '1';
    uid: string;
    name: string;
    items: BrunoItem[];
    environments: BrunoEnvironment[];
    root?: BrunoFolderRoot;
    brunoConfig?: Record<string, unknown>;
}

export const REQUEST_ITEM_TYPES: ReadonlySet<string> = new Set([
    'http-request',
    'graphql-request',
    'grpc-request',
    'ws-request'
]);

export const isFolder = (item: BrunoItem) => item.type === 'folder';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);
