import * as _ from 'lodash';

import {
    FileRef,
    FormField,
    GraphqlBody,
    MultipartField,
    SendBodyMode,
    SendExtrasData,
    WebSocketDraft,
    WebSocketMessage,
    WebSocketMessageType
} from '../send/send-extras';

import {
    BrunoBody,
    BrunoBodyMode,
    BrunoFileEntry,
    BrunoItem,
    BrunoKeyValue,
    BrunoMultipartField,
    BrunoWsMessage
} from './collection-types';
import { newUid } from './collection-tree';

/**
 * Maps the structured parts of a Send tab (send-extras.ts) to and from a Bruno item:
 *
 *   form fields         <-> body.formUrlEncoded
 *   multipart fields    <-> body.multipartForm, whose file fields hold file paths
 *   the binary file     <-> the selected entry of body.file
 *   the GraphQL query   <-> body.graphql
 *   WebSocket messages  <-> body.ws of a ws-request item
 *
 * Bruno keeps the data of every body mode side by side, and so do Send tabs, so each is
 * mapped on its own: switching modes and saving loses nothing. Items refer to files by
 * their path in the collection folder (files/photo.png), tabs by their bytes in the Send
 * file store (FileRef). A file that couldn't be loaded keeps its path in a "missing"
 * FileRef, so saving the tab again keeps the reference.
 */

// Path in the collection folder -> the file, loaded into the Send file store
export type ItemFiles = ReadonlyMap<string, FileRef>;

// Where a tab's file is stored in the collection, if it is
export type FilePathOf = (file: FileRef) => string | undefined;

type StructuredMode = Exclude<SendBodyMode, 'raw'>;

const BRUNO_BODY_MODES: { [mode in StructuredMode]: BrunoBodyMode } = {
    form: 'formUrlEncoded',
    multipart: 'multipartForm',
    binary: 'file',
    graphql: 'graphql'
};

export const brunoBodyModeOf = (mode: StructuredMode): BrunoBodyMode => BRUNO_BODY_MODES[mode];

// The Send body mode that shows an item's body. Text bodies (JSON, XML...) use 'raw'.
export function sendBodyModeOf(item: BrunoItem): SendBodyMode {
    const mode = item.request?.body?.mode;
    if (item.type === 'graphql-request' && (!mode || mode === 'none')) return 'graphql';
    return (_.findKey(BRUNO_BODY_MODES, (brunoMode) => brunoMode === mode) as StructuredMode | undefined) ?? 'raw';
}

// --- Files ---------------------------------------------------------------------------

const MISSING_FILE_PREFIX = 'missing:';

export const fileNameOf = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;

// A file the item refers to that couldn't be loaded. Sending the request says it's missing.
export const missingFileRef = (filePath: string, contentType = ''): FileRef => ({
    fileId: `${MISSING_FILE_PREFIX}${filePath}`,
    name: fileNameOf(filePath),
    size: 0,
    contentType
});

export const missingFilePath = (file: FileRef): string | undefined =>
    file.fileId.startsWith(MISSING_FILE_PREFIX) ? file.fileId.slice(MISSING_FILE_PREFIX.length) : undefined;

export const isMissingFile = (file: FileRef) => missingFilePath(file) !== undefined;

const filePathsOf = (value: BrunoMultipartField['value']): string[] =>
    (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string' && !!entry);

// Bruno sends the selected file of a binary body
const selectedFileIndex = (entries: BrunoFileEntry[] | null | undefined) =>
    (entries ?? []).findIndex((entry) => !!entry.selected && !!entry.filePath);

// The files an item's request sends, by their path in the collection folder, each once
export function itemFilePaths(item: BrunoItem): string[] {
    if (item.type === 'ws-request') return [];
    const body = item.request?.body;
    const binaryEntry = body?.file?.[selectedFileIndex(body?.file)];

    return _.uniq([
        ..._.flatMap(body?.multipartForm ?? [], (field) => field.type === 'file' ? filePathsOf(field.value) : []),
        ...(binaryEntry?.filePath ? [binaryEntry.filePath] : [])
    ]);
}

// Every file a tab refers to, in any of its body modes
export const extrasFiles = (extras: SendExtrasData): FileRef[] => [
    ..._.flatMap(extras.multipartFields, (field) => field.kind === 'file' ? field.files : []),
    ...(extras.binaryFile ? [extras.binaryFile] : [])
];

const fileOf = (filePath: string, files: ItemFiles) => files.get(filePath) ?? missingFileRef(filePath);

const savedPathOf = (file: FileRef, filePathOf: FilePathOf) => missingFilePath(file) ?? filePathOf(file);

const unsavedFileWarning = (file: FileRef) =>
    `“${file.name}” isn't available any more, so it wasn't saved with the request. Attach it again.`;

function savedFilePaths(files: FileRef[], filePathOf: FilePathOf, warnings: string[]): string[] {
    return _.flatMap(files, (file) => {
        const filePath = savedPathOf(file, filePathOf);
        if (!filePath) warnings.push(unsavedFileWarning(file));
        return filePath ? [filePath] : [];
    });
}

// --- Entries -------------------------------------------------------------------------

const isNothing = (value: unknown) => value === undefined || value === null || value === '';

/**
 * The item's entry with the tab's values, keeping what Send doesn't know about it (uids,
 * annotations...). An empty value stays written the way the item wrote it.
 */
function updated<T extends object>(base: T | undefined, values: Partial<T>): T {
    if (!base) return _.omitBy(values, _.isUndefined) as T;

    const entry = { ...base } as Record<string, unknown>;
    for (const [key, value] of Object.entries(values)) {
        if (isNothing(value) && isNothing(entry[key])) continue;
        if (value === undefined) delete entry[key];
        else entry[key] = value;
    }
    return entry as T;
}

// Tab entries use their item entry's uid as their id, so saving finds the entry again
const idOf = (entry: { uid?: string }) => entry.uid || newUid();

const entriesByUid = <T extends { uid?: string }>(entries: T[] | null | undefined) =>
    new Map((entries ?? []).filter((entry) => !!entry.uid).map((entry) => [entry.uid!, entry]));

const withDescription = (description: string | null | undefined) => description ? { description } : {};

// Rows with nothing in them (like an editor's empty last row) aren't saved
const isBlankFormField = (field: FormField) => !field.name && !field.value && !field.description;
const isBlankMultipartField = (field: MultipartField) =>
    !field.name && !field.value && !field.files.length && !field.contentType && !field.description;

// --- Form ----------------------------------------------------------------------------

export const toFormFields = (entries: BrunoKeyValue[] | null | undefined): FormField[] =>
    (entries ?? []).map((entry) => ({
        id: idOf(entry),
        name: entry.name ?? '',
        value: entry.value ?? '',
        enabled: entry.enabled !== false,
        ...withDescription(entry.description)
    }));

export function fromFormFields(fields: FormField[], baseEntries: BrunoKeyValue[] | null | undefined): BrunoKeyValue[] {
    const base = entriesByUid(baseEntries);
    return fields.filter((field) => !isBlankFormField(field)).map((field) => updated(base.get(field.id), {
        name: field.name,
        value: field.value,
        enabled: field.enabled,
        description: field.description
    }));
}

// --- Multipart -----------------------------------------------------------------------

export const toMultipartFields = (entries: BrunoMultipartField[] | null | undefined, files: ItemFiles): MultipartField[] =>
    (entries ?? []).map((entry): MultipartField => {
        const isFile = entry.type === 'file';
        return {
            id: idOf(entry),
            name: entry.name ?? '',
            enabled: entry.enabled !== false,
            kind: isFile ? 'file' : 'text',
            value: !isFile && typeof entry.value === 'string' ? entry.value : '',
            files: isFile ? filePathsOf(entry.value).map((filePath) => fileOf(filePath, files)) : [],
            ...(entry.contentType ? { contentType: entry.contentType } : {}),
            ...withDescription(entry.description)
        };
    });

export function fromMultipartFields(
    fields: MultipartField[],
    baseEntries: BrunoMultipartField[] | null | undefined,
    filePathOf: FilePathOf,
    warnings: string[]
): BrunoMultipartField[] {
    const base = entriesByUid(baseEntries);
    return fields.filter((field) => !isBlankMultipartField(field)).map((field) => updated(base.get(field.id), {
        type: field.kind,
        name: field.name,
        value: field.kind === 'text' ? field.value : savedFilePaths(field.files, filePathOf, warnings),
        enabled: field.enabled,
        contentType: field.contentType,
        description: field.description
    }));
}

// --- Binary --------------------------------------------------------------------------

export function toBinaryFile(entries: BrunoFileEntry[] | null | undefined, files: ItemFiles): FileRef | undefined {
    const entry = entries?.[selectedFileIndex(entries)];
    if (!entry?.filePath) return undefined;

    const file = fileOf(entry.filePath, files);
    return entry.contentType ? { ...file, contentType: entry.contentType } : file;
}

/**
 * The item's file entries with the tab's binary file as the selected one. `contentType`
 * is the type it's sent with: Bruno sends a binary body with its file's type.
 */
export function fromBinaryFile(
    file: FileRef | undefined,
    contentType: string,
    baseEntries: BrunoFileEntry[] | null | undefined,
    filePathOf: FilePathOf,
    warnings: string[]
): BrunoFileEntry[] {
    const entries = [...(baseEntries ?? [])];
    const selectedIndex = selectedFileIndex(entries);

    const filePath = file && savedPathOf(file, filePathOf);
    if (file && !filePath) warnings.push(unsavedFileWarning(file));

    if (!filePath) {
        // The file was removed: files that weren't selected stay
        if (selectedIndex !== -1) entries.splice(selectedIndex, 1);
        return entries;
    }

    const entry = updated(entries[selectedIndex], { filePath, contentType, selected: true });
    if (selectedIndex === -1) entries.push(entry);
    else entries[selectedIndex] = entry;
    return entries;
}

// --- GraphQL -------------------------------------------------------------------------

export const toGraphqlBody = (graphql: BrunoBody['graphql']): GraphqlBody => ({
    query: graphql?.query ?? '',
    variables: graphql?.variables ?? ''
});

// Bruno has no field for the operation name: the GraphQL editor picks it from the query
export const fromGraphqlBody = (graphql: GraphqlBody, base: BrunoBody['graphql']): NonNullable<BrunoBody['graphql']> =>
    updated(base ?? undefined, { query: graphql.query, variables: graphql.variables });

// --- WebSocket -----------------------------------------------------------------------

const MESSAGE_TYPES: readonly WebSocketMessageType[] = ['text', 'json', 'xml', 'binary'];
const toMessageType = (type: string | null | undefined): WebSocketMessageType =>
    MESSAGE_TYPES.find((candidate) => candidate === type) ?? 'text';

export function toWebSocketDraft(messages: BrunoWsMessage[] | null | undefined): WebSocketDraft {
    const savedMessages = (messages ?? []).map((message): WebSocketMessage => ({
        id: newUid(),
        name: message.name ?? '',
        type: toMessageType(message.type),
        content: message.content ?? ''
    }));

    // The composer starts with the message Bruno shows as selected
    const selected = savedMessages[(messages ?? []).findIndex((message) => message.selected)];
    return { message: selected?.content ?? '', messageType: selected?.type ?? 'text', savedMessages };
}

export function fromWebSocketMessages(messages: WebSocketMessage[], baseMessages: BrunoWsMessage[] | null | undefined): BrunoWsMessage[] {
    const unused = [...(baseMessages ?? [])];

    return messages.map((message) => {
        const index = unused.findIndex((candidate) => (candidate.name ?? '') === message.name);
        const base = index === -1 ? undefined : unused.splice(index, 1)[0];
        // Types that read as text (none, or one Wirepane doesn't know) stay as written
        const type = base && toMessageType(base.type) === message.type ? base.type : message.type;
        return updated(base, { name: message.name, type, content: message.content });
    });
}

// --- Unsaved changes -----------------------------------------------------------------

// True for tabs that hold only upstream's raw HTTP request: no structured body data at all
export function isPlainHttp(extras: SendExtrasData | undefined): boolean {
    return !extras || (
        extras.requestType === 'http' &&
        extras.bodyMode === 'raw' &&
        !extras.formFields.length &&
        !extras.multipartFields.length &&
        !extras.binaryFile &&
        !extras.graphql.query &&
        !extras.graphql.variables
    );
}

const fileKey = (file: FileRef) => `${file.fileId}/${file.name}`;

/**
 * What a collection request stores of a tab's extras, as a string that changes whenever
 * that does, to tell when the tab has unsaved changes. WebSocket drafts and the GraphQL
 * operation name aren't stored, so they don't count. Empty for plain HTTP tabs.
 */
export function savedExtrasKey(extras: SendExtrasData | undefined): string {
    if (!extras || isPlainHttp(extras)) return '';

    if (extras.requestType === 'websocket') {
        return JSON.stringify(['websocket', extras.websocket.savedMessages.map(({ name, type, content }) => [name, type, content])]);
    }

    return JSON.stringify([
        extras.bodyMode,
        extras.formFields.filter((field) => !isBlankFormField(field))
            .map(({ name, value, enabled, description }) => [name, value, enabled, description ?? '']),
        extras.multipartFields.filter((field) => !isBlankMultipartField(field)).map((field) => [
            field.name,
            field.enabled,
            field.kind,
            field.kind === 'text' ? field.value : field.files.map(fileKey),
            field.contentType ?? '',
            field.description ?? ''
        ]),
        extras.binaryFile ? [fileKey(extras.binaryFile), extras.binaryFile.contentType] : null,
        [extras.graphql.query, extras.graphql.variables]
    ]);
}
