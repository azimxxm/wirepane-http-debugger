/**
 * Collections use Bruno's collection JSON as their model (the shape checked by
 * @usebruno/schema), exactly as the server's /collections API returns it. These types
 * only describe the fields the UI reads or writes: every other field is carried through
 * untouched, because items are always updated by spreading the original.
 */

export interface BrunoKeyValue {
    uid?: string;
    name?: string | null;
    value?: string | null;
    description?: string | null;
    enabled?: boolean;
}

export interface BrunoParam extends BrunoKeyValue {
    type: 'query' | 'path';
}

export interface BrunoVariable {
    uid?: string;
    name?: string | null;
    value?: unknown;
    description?: string | null;
    enabled?: boolean;
}

export interface BrunoMultipartField {
    uid?: string;
    type: 'text' | 'file';
    name?: string | null;
    value?: string | string[] | null;
    contentType?: string | null;
    description?: string | null;
    enabled?: boolean;
}

export type BrunoBodyMode =
    | 'none'
    | 'json'
    | 'text'
    | 'xml'
    | 'sparql'
    | 'formUrlEncoded'
    | 'multipartForm'
    | 'graphql'
    | 'file';

export interface BrunoBody {
    mode: BrunoBodyMode;
    json?: string | null;
    text?: string | null;
    xml?: string | null;
    sparql?: string | null;
    formUrlEncoded?: BrunoKeyValue[] | null;
    multipartForm?: BrunoMultipartField[] | null;
    graphql?: { query?: string | null, variables?: string | null } | null;
    file?: unknown[] | null;
}

export interface BrunoAuth {
    mode: string;
    bearer?: { token?: string | null } | null;
    basic?: { username?: string | null, password?: string | null } | null;
    apikey?: {
        key?: string | null,
        value?: string | null,
        placement?: 'header' | 'queryparams' | null
    } | null;
}

export interface BrunoVars {
    req?: BrunoVariable[] | null;
    res?: BrunoVariable[] | null;
}

export interface BrunoRequest {
    url: string;
    method: string;
    headers: BrunoKeyValue[];
    params: BrunoParam[];
    auth?: BrunoAuth | null;
    body?: BrunoBody;
    script?: { req?: string | null, res?: string | null } | null;
    vars?: BrunoVars | null;
    assertions?: unknown[] | null;
    tests?: string | null;
    docs?: string | null;
}

export type ExampleBodyType = 'json' | 'text' | 'xml' | 'html' | 'binary';

export interface BrunoExample {
    uid?: string;
    itemUid?: string;
    name: string;
    description?: string | null;
    type: string;
    request?: {
        url: string,
        method: string,
        headers: BrunoKeyValue[],
        params: BrunoParam[],
        body?: BrunoBody
    } | null;
    response?: {
        status?: number | null,
        statusText?: string | null,
        headers?: BrunoKeyValue[] | null,
        body?: { type?: ExampleBodyType | null, content?: unknown } | null
    } | null;
}

export interface BrunoFolderRoot {
    request?: {
        headers?: BrunoKeyValue[] | null,
        auth?: BrunoAuth | null,
        script?: { req?: string | null, res?: string | null } | null,
        vars?: BrunoVars | null,
        tests?: string | null
    } | null;
    docs?: string | null;
    meta?: { name?: string | null, seq?: number | null } | null;
}

export interface BrunoItem {
    uid: string;
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
    type?: 'text';
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

// The server API's shapes, see httptoolkit-server/src/collections/collections-api.ts:

export interface CollectionSummary {
    id: string;
    name: string;
    requestCount: number;
    environmentCount: number;
    updatedAt: string;
}

export interface LoadedCollection {
    collection: BrunoCollection;
    warnings: string[];
}

export type ImportFormat =
    | 'postman'
    | 'postman-environment'
    | 'insomnia'
    | 'openapi'
    | 'wsdl'
    | 'har'
    | 'bruno-zip'
    | 'bruno-request'
    | 'bruno-environment';

export interface ImportFileInput {
    fileName: string;
    content: string;
    encoding?: 'utf8' | 'base64';
    // Required for environment files: the collection that receives the environment
    collectionId?: string;
}

export interface ImportResult {
    format: ImportFormat;
    collection: BrunoCollection;
    warnings: string[];
}

export type ExportFormat = 'postman' | 'bruno';

export interface RedactionEntry {
    // Where the secret was, e.g. "Users / Get user › header"
    location: string;
    // The header, parameter, field, setting or variable that held it
    name: string;
    // The {{variable}} that replaced it, or the name of the variable that was emptied
    variable: string;
}

export interface ExportResult {
    fileName: string;
    mimeType: string;
    encoding: 'utf8' | 'base64';
    content: string;
    redactionReport: RedactionEntry[];
}
