import * as _ from 'lodash';

import { brunoConverters } from './bruno-libs';
import { BrunoBody, BrunoCollection, BrunoItem, isFolder, isRecord } from './bruno-types';
import { collectionToFiles } from './bruno-folder';
import { sanitizeFileName } from './file-names';
import { filesToZip } from './folder-storage';
import { RedactionEntry, redactCollection } from './redaction';
import {
    bodyFileReferences,
    collectionFileReferences,
    fileNameOf,
    rewriteFileReferences,
    toCollectionRelativePath
} from './attachments';

export type ExportFormat = 'postman' | 'bruno';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['postman', 'bruno'];

export interface ExportResult {
    fileName: string;
    mimeType: string;
    // 'utf8' for the Postman JSON text, 'base64' for the Bruno zip
    encoding: 'utf8' | 'base64';
    content: string;
    // Every secret that was replaced: never the secret itself
    redactionReport: RedactionEntry[];
    // What the file leaves out, e.g. requests the format can't hold, for showing to the user
    warnings: string[];
}

export interface ExportOptions {
    // For Bruno zips: the files that requests send, by their path in the collection folder
    attachments?: ReadonlyMap<string, Buffer>;
}

/**
 * Builds a single shareable file from a collection, always after redacting secrets:
 *   postman: Postman Collection v2.1 JSON, which Postman, Bruno, Insomnia and Hoppscotch open
 *   bruno:   a zip of the collection in Bruno's folder format (.bru files), e.g. for Git,
 *            with the files its requests send
 */
export function exportCollection(collection: BrunoCollection, format: ExportFormat, options: ExportOptions = {}): ExportResult {
    const { collection: redacted, report } = redactCollection(collection);
    const baseName = sanitizeFileName(collection.name);

    if (format === 'postman') {
        return {
            fileName: `${baseName}.postman_collection.json`,
            mimeType: 'application/json',
            encoding: 'utf8',
            content: `${JSON.stringify(toPostmanCollection(redacted), null, 2)}\n`,
            redactionReport: report,
            warnings: postmanWarnings(redacted)
        };
    }

    const { included, missing } = includedAttachments(redacted, options.attachments ?? new Map());
    return {
        fileName: `${baseName}.zip`,
        mimeType: 'application/zip',
        encoding: 'base64',
        content: filesToZip(collectionToFiles(redacted), included).toString('base64'),
        redactionReport: report,
        warnings: missing.length ? [missingFilesWarning(missing)] : []
    };
}

function toPostmanCollection(collection: BrunoCollection): Record<string, unknown> {
    // Postman can't use paths into our collection folder, so files are referred to by name,
    // for the receiver to pick again. brunoToPostman mutates its input (drops uids, blanks
    // secret env values), so it gets a copy either way.
    const copy = _.cloneDeep(collection);
    rewriteFileReferences(copy, fileNameOf);

    const postman = brunoConverters().brunoToPostman(copy);
    if (!isRecord(postman)) throw new Error('The Postman converter returned no collection');
    return postman;
}

const requestItems = (items: BrunoItem[]): BrunoItem[] =>
    items.flatMap((item) => isFolder(item) ? requestItems(item.items ?? []) : [item]);

// The files a request sends with its current body mode, as Postman exports only that one
function sentFileReferences(body: BrunoBody | undefined): string[] {
    if (body?.mode === 'multipartForm') {
        return bodyFileReferences({ multipartForm: (body.multipartForm ?? []).filter((field) => field.enabled !== false) });
    }
    if (body?.mode === 'file') {
        return bodyFileReferences({ file: (body.file ?? []).filter((entry) => entry.selected) });
    }
    return [];
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) =>
    `${count} ${count === 1 ? singular : pluralForm}`;

function postmanWarnings(collection: BrunoCollection): string[] {
    const requests = requestItems(collection.items);
    const webSocketCount = requests.filter((item) => item.type === 'ws-request').length;
    const fileCount = _.sum(requests.map((item) => sentFileReferences(item.request?.body).length));

    return [
        fileCount && `${plural(fileCount, 'file')} ${fileCount === 1 ? 'isn\'t' : 'aren\'t'} included: ` +
            'Postman JSON doesn\'t carry files, only their names. Use the Bruno format to include them.',
        webSocketCount && `${plural(webSocketCount, 'WebSocket request')} ${webSocketCount === 1 ? 'was' : 'were'} left out: ` +
            'Postman Collection v2.1 has no WebSocket requests. Use the Bruno format to keep them.'
    ].filter((warning): warning is string => !!warning);
}

// The attached files a Bruno zip carries: every file the requests refer to, if it's there
function includedAttachments(collection: BrunoCollection, attachments: ReadonlyMap<string, Buffer>) {
    const included = new Map<string, Buffer>();
    const missing: string[] = [];

    for (const filePath of collectionFileReferences(collection)) {
        const relativePath = toCollectionRelativePath(filePath);
        const bytes = relativePath !== undefined ? attachments.get(relativePath) : undefined;
        if (bytes && relativePath) included.set(relativePath, bytes);
        else missing.push(filePath);
    }

    return { included, missing };
}

const listNames = (names: string[]) => names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

const missingFilesWarning = (missing: string[]) =>
    `${plural(missing.length, 'file')} ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} in the collection folder, ` +
    `so the zip doesn't include ${missing.length === 1 ? 'it' : 'them'}: ${listNames(missing)}`;
