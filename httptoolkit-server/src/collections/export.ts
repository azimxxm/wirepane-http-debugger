import * as _ from 'lodash';

import { brunoConverters } from './bruno-libs';
import { BrunoCollection, isRecord } from './bruno-types';
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
    return postman;
}
