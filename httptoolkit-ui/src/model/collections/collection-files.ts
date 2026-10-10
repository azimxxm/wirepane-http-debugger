import { ImportFileInput } from './collection-types';

// The server takes JSON bodies up to 64 MB, and base64 makes a zip a third bigger
const MAX_IMPORT_BYTES = 45 * 1024 * 1024;

// The file types the import picker offers
export const IMPORT_FILE_TYPES = ['.json', '.yaml', '.yml', '.zip', '.bru', '.har', '.wsdl', '.xml'];

const isZipData = (bytes: Uint8Array) =>
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4B && bytes[2] === 0x03 && bytes[3] === 0x04;

/**
 * Reads a file for /collections/import: text as is, zips (Bruno folders) as base64.
 */
export async function readImportFile(file: File): Promise<ImportFileInput> {
    if (file.size > MAX_IMPORT_BYTES) {
        throw new Error(`${file.name} is ${Math.ceil(file.size / (1024 * 1024))} MB, more than the 45 MB that can be imported.`);
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    if (/\.zip$/i.test(file.name) || isZipData(bytes)) {
        return { fileName: file.name, content: Buffer.from(bytes).toString('base64'), encoding: 'base64' };
    }

    return { fileName: file.name, content: new TextDecoder('utf8').decode(bytes), encoding: 'utf8' };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Environment files (Postman environments, Bruno environment .bru files) are added to an
 * existing collection rather than imported as a new one. This mirrors the server's format
 * detection (detectFormat in httptoolkit-server/src/collections/import.ts), so the UI
 * knows which collection to send along before importing.
 */
export function isEnvironmentFile(file: ImportFileInput): boolean {
    if (file.encoding === 'base64') return false;

    const text = file.content.replace(/^﻿/, '').trim();
    if (text.startsWith('{')) {
        let json: unknown;
        try {
            json = JSON.parse(text);
        } catch {
            return false;
        }
        if (!isRecord(json)) return false;

        const postman = isRecord(json.collection) && isRecord(json.collection.info) ? json.collection : json;
        if (isRecord(postman.info)) return false; // A Postman collection

        return json._postman_variable_scope === 'environment' ||
            (Array.isArray(json.values) && typeof json.name === 'string' && !('item' in json));
    }

    return /\.bru$/i.test(file.fileName) &&
        !/^\s*meta\s*\{/m.test(text) &&
        /^\s*vars(?::secret)?\s*[{[]/m.test(text);
}
