import * as _ from 'lodash';

import { brunoConverters } from './bruno-libs';
import { BrunoCollection, BrunoItem, isFolder, isRecord } from './bruno-types';
import { collectionToFiles } from './bruno-folder';
import { sanitizeFileName } from './file-names';
import { filesToZip } from './folder-storage';
import { RedactionEntry, redactCollection } from './redaction';

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
}

/**
 * Builds a single shareable file from a collection, always after redacting secrets:
 *   postman: Postman Collection v2.1 JSON, which Postman, Bruno, Insomnia and Hoppscotch open
 *   bruno:   a zip of the collection in Bruno's folder format (.bru files), e.g. for Git
 */
export function exportCollection(collection: BrunoCollection, format: ExportFormat): ExportResult {
    const { collection: redacted, report } = redactCollection(collection);
    const baseName = sanitizeFileName(collection.name);

    if (format === 'postman') {
        return {
            fileName: `${baseName}.postman_collection.json`,
            mimeType: 'application/json',
            encoding: 'utf8',
            content: `${JSON.stringify(toPostmanCollection(redacted), null, 2)}\n`,
            redactionReport: report
        };
    }

    return {
        fileName: `${baseName}.zip`,
        mimeType: 'application/zip',
        encoding: 'base64',
        content: filesToZip(collectionToFiles(redacted)).toString('base64'),
        redactionReport: report
    };
}

function toPostmanCollection(collection: BrunoCollection): Record<string, unknown> {
    // brunoToPostman mutates its input (drops uids, blanks secret env values), so it gets a copy
    const postman = brunoConverters().brunoToPostman(_.cloneDeep(collection));
    if (!isRecord(postman)) throw new Error('The Postman converter returned no collection');

    addFolderDescriptions(collection.items, postman.item);
    forEachPostmanRequest(postman.item, (request) => fixUrlParts(request.url));
    return postman;
}

// brunoToPostman doesn't export folder docs, though Postman folders have a description.
// Postman folders are matched to Bruno folders by name, in order.
function addFolderDescriptions(brunoItems: BrunoItem[], postmanItems: unknown) {
    if (!Array.isArray(postmanItems)) return;

    const foldersByName = new Map<string, BrunoItem[]>();
    for (const folder of brunoItems.filter(isFolder)) {
        foldersByName.set(folder.name, [...foldersByName.get(folder.name) ?? [], folder]);
    }

    for (const postmanItem of postmanItems) {
        if (!isRecord(postmanItem) || !Array.isArray(postmanItem.item)) continue;

        const folder = foldersByName.get(String(postmanItem.name))?.shift();
        if (!folder) continue;

        if (folder.root?.docs) postmanItem.description = folder.root.docs;
        addFolderDescriptions(folder.items ?? [], postmanItem.item);
    }
}

function forEachPostmanRequest(items: unknown, callback: (request: Record<string, unknown>) => void) {
    if (!Array.isArray(items)) return;

    for (const item of items.filter(isRecord)) {
        forEachPostmanRequest(item.item, callback);
        if (isRecord(item.request)) callback(item.request);

        const responses = Array.isArray(item.response) ? item.response.filter(isRecord) : [];
        for (const response of responses) {
            if (isRecord(response.originalRequest)) callback(response.originalRequest);
        }
    }
}

// brunoToPostman leaves the query string in the last path segment when a URL has no
// protocol, e.g. "{{baseUrl}}/pets?limit=10" gets path ["pets?limit=10"]. Postman builds
// URLs from these parts, so they're recomputed from the raw URL. The query list is fine.
function fixUrlParts(url: unknown) {
    if (!isRecord(url) || typeof url.raw !== 'string') return;

    const [withoutHash] = url.raw.split('#');
    const [withoutQuery] = withoutHash.split('?');
    const protocolMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(withoutQuery);
    const rest = protocolMatch ? withoutQuery.slice(protocolMatch[0].length) : withoutQuery;

    const slashIndex = rest.indexOf('/');
    const hostAndPort = slashIndex === -1 ? rest : rest.slice(0, slashIndex);
    const path = slashIndex === -1 ? '' : rest.slice(slashIndex + 1);
    const portMatch = /^(.*):(\d+)$/.exec(hostAndPort);

    url.protocol = protocolMatch ? protocolMatch[1] : undefined;
    url.host = (portMatch ? portMatch[1] : hostAndPort).split('.').filter(Boolean);
    url.port = portMatch ? portMatch[2] : undefined;
    url.path = path ? path.split('/') : [];
}
