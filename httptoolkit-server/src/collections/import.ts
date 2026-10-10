import * as path from 'path';
import * as _ from 'lodash';
import { StatusError } from '@httptoolkit/util';

import { brunoConverters, brunoFilestore, brunoLang } from './bruno-libs';
import { BrunoCollection, BrunoEnvironment, isRecord } from './bruno-types';
import { filesToCollection, toEnvironment } from './bruno-folder';
import { newUid, toCollection } from './collection-model';
import { isZip, zipToFiles } from './folder-storage';
import { harToCollection } from './har-import';

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
    // The file's text, or base64 for binary files (zips)
    content: string;
    encoding?: 'utf8' | 'base64';
}

export interface ImportResult {
    format: ImportFormat;
    collection: BrunoCollection;
    warnings: string[];
}

interface DecodedFile {
    name: string;
    text: string;
    // Set for zip archives
    bytes?: Buffer;
    // Set when the text is JSON
    json?: unknown;
}

type Converted =
    | { collection: unknown, warnings: string[] }
    | { environment: BrunoEnvironment, warnings: string[] };

const POSTMAN_COLLECTION_SCHEMA = /schema\.(?:get)?postman\.com\/json\/collection\//i;
const POSTMAN_V21_SCHEMA = 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json';

/**
 * Detects a file's format from its content (and name), then converts it into a Bruno
 * collection. Environment files (Postman environments, Bruno environment .bru files)
 * aren't collections of their own: they're added to `into`, an existing collection.
 */
export async function importCollectionFile(
    input: ImportFileInput,
    options: { into?: BrunoCollection } = {}
): Promise<ImportResult> {
    const file = decodeFile(input);
    const format = detectFormat(file);
    const converted = await convert(format, file);

    if ('environment' in converted) {
        if (!options.into) {
            throw new StatusError(400,
                `${input.fileName} is an environment, not a collection. Import it into an existing collection instead.`
            );
        }
        return { format, collection: withEnvironment(options.into, converted.environment), warnings: converted.warnings };
    }

    if (options.into) {
        throw new StatusError(400,
            `${input.fileName} is a collection. Only environment files can be imported into an existing collection.`
        );
    }

    // Some sources have no name (e.g. an OpenAPI spec without a title): use the file's
    const imported = converted.collection;
    const named = isRecord(imported) && !(typeof imported.name === 'string' && imported.name.trim())
        ? { ...imported, name: collectionNameFromFile(input.fileName) }
        : imported;
    return { format, collection: toCollection(named, newUid()), warnings: converted.warnings };
}

function decodeFile(input: ImportFileInput): DecodedFile {
    const isZipName = /\.zip$/i.test(input.fileName);
    // "UEsDB" is base64 for the "PK\x03\x04" signature every zip starts with
    if (input.encoding === 'base64' || isZipName || input.content.startsWith('UEsDB')) {
        const bytes = Buffer.from(input.content, 'base64');
        if (isZip(bytes)) return { name: input.fileName, text: '', bytes };
        if (isZipName) throw new StatusError(400, `${input.fileName} is not a valid zip file`);
        if (input.encoding === 'base64') return decodeText(input.fileName, bytes.toString('utf8'));
    }

    return decodeText(input.fileName, input.content);
}

function decodeText(name: string, content: string): DecodedFile {
    const text = content.replace(/^\uFEFF/, '');
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return { name, text };

    try {
        return { name, text, json: JSON.parse(trimmed) };
    } catch {
        return { name, text };
    }
}

const unsupportedFormat = (fileName: string) => new StatusError(400,
    `Couldn't recognise the format of ${fileName}. Supported: Postman collections (v2.0, v2.1) and ` +
    `environments, Insomnia, OpenAPI 3 and Swagger 2 (JSON or YAML), WSDL, HAR, zipped Bruno ` +
    `collections, and Bruno .bru request or environment files.`
);

function detectFormat(file: DecodedFile): ImportFormat {
    if (file.bytes) return 'bruno-zip';
    if (isRecord(file.json)) return detectJsonFormat(file.json, file.name);
    if (file.json !== undefined) throw unsupportedFormat(file.name);
    return detectTextFormat(file);
}

function detectJsonFormat(json: Record<string, unknown>, fileName: string): ImportFormat {
    // Newer Postman API exports wrap the collection in a { collection: ... } envelope
    const postman = isRecord(json.collection) && isRecord(json.collection.info) ? json.collection : json;
    if (isRecord(postman.info) && (
        Array.isArray(postman.item) || POSTMAN_COLLECTION_SCHEMA.test(String(postman.info.schema ?? ''))
    )) return 'postman';

    if (json._postman_variable_scope === 'environment' ||
        (Array.isArray(json.values) && typeof json.name === 'string' && !('item' in json))
    ) return 'postman-environment';

    const isInsomniaV5 = typeof json.type === 'string' && json.type.startsWith('collection.insomnia.rest/5');
    if ((json._type === 'export' && Array.isArray(json.resources)) || isInsomniaV5) return 'insomnia';

    if (typeof json.openapi === 'string' || typeof json.swagger === 'string') return 'openapi';
    if (isRecord(json.log) && Array.isArray(json.log.entries)) return 'har';

    if (Array.isArray(json.requests) && Array.isArray(json.order)) {
        throw new StatusError(400,
            `${fileName} is a Postman Collection v1, which isn't supported. Export it from Postman again as Collection v2.1.`
        );
    }

    throw unsupportedFormat(fileName);
}

function detectTextFormat(file: DecodedFile): ImportFormat {
    const { name, text } = file;

    if (/^\s*["']?(openapi|swagger)["']?\s*:/m.test(text)) return 'openapi';
    if (/^\s*type:\s*["']?collection\.insomnia\.rest\/5/m.test(text)) return 'insomnia';
    if (/\.wsdl$/i.test(name) || (/<(?:[\w-]+:)?definitions[\s>]/.test(text) && /wsdl/i.test(text))) return 'wsdl';
    if (/^\s*meta\s*\{/m.test(text)) return 'bruno-request';
    // Environment .bru files hold only `vars { ... }` and `vars:secret [ ... ]` blocks
    if (/\.bru$/i.test(name) && /^\s*vars(?::secret)?\s*[{[]/m.test(text)) return 'bruno-environment';

    throw unsupportedFormat(name);
}

async function convert(format: ImportFormat, file: DecodedFile): Promise<Converted> {
    const converters = brunoConverters();

    switch (format) {
        case 'postman':
            return convertPostman(file.json);
        case 'postman-environment':
            return { environment: requireEnvironment(converters.postmanToBrunoEnvironment(file.json), file), warnings: [] };
        case 'insomnia':
            return { collection: converters.insomniaToBruno(file.json ?? file.text), warnings: [] };
        case 'openapi':
            return { collection: converters.openApiToBruno(file.json ?? file.text), warnings: [] };
        case 'wsdl':
            return { collection: await converters.wsdlToBruno(file.text), warnings: [] };
        case 'har':
            return harToCollection(file.json, collectionNameFromFile(file.name));
        case 'bruno-zip':
            return convertBrunoZip(file);
        case 'bruno-request':
            return convertBrunoRequest(file);
        case 'bruno-environment':
            return { environment: requireEnvironment(brunoLang().bruToEnvJsonV2(file.text), file), warnings: [] };
    }
}

async function convertPostman(json: unknown): Promise<Converted> {
    const warnings: string[] = [];
    const postman = _.cloneDeep(json);
    const body = isRecord(postman) && isRecord(postman.collection) ? postman.collection : postman;

    // Some tools export v2 collections without a schema URL, which the converter requires
    if (isRecord(body) && isRecord(body.info) && typeof body.info.schema !== 'string') {
        body.info.schema = POSTMAN_V21_SCHEMA;
        warnings.push('The file has no Postman schema version, so it was read as Collection v2.1');
    }

    const { collection, issues } = await brunoConverters().postmanToBruno(postman);
    for (const issue of issues ?? []) {
        if (!isRecord(issue)) continue;
        warnings.push(issue.path ? `${issue.path}: ${issue.message}` : String(issue.message));
    }

    return { collection, warnings };
}

async function convertBrunoZip(file: DecodedFile): Promise<Converted> {
    const { files, skippedFiles } = zipToFiles(file.bytes ?? Buffer.alloc(0));
    const { collection, warnings } = await filesToCollection(files, newUid());

    if (skippedFiles > 0) {
        warnings.push(`Skipped ${skippedFiles} file(s) that aren't Bruno requests, folders or environments`);
    }
    return { collection, warnings };
}

function convertBrunoRequest(file: DecodedFile): Converted {
    const item = brunoFilestore().parseRequest(file.text, { format: 'bru' });
    if (!isRecord(item)) throw new StatusError(400, `${file.name} is not a Bruno request file`);

    const name = typeof item.name === 'string' && item.name ? item.name : collectionNameFromFile(file.name);
    return {
        collection: { name, items: [{ ...item, name }], environments: [] },
        warnings: []
    };
}

function requireEnvironment(parsed: unknown, file: DecodedFile): BrunoEnvironment {
    const environment = toEnvironment(parsed, collectionNameFromFile(file.name));
    if (!environment) throw new StatusError(400, `${file.name} is not a valid environment file`);
    return environment;
}

function withEnvironment(collection: BrunoCollection, environment: BrunoEnvironment): BrunoCollection {
    const takenNames = new Set(collection.environments.map((existing) => existing.name.toLowerCase()));

    let name = environment.name;
    for (let counter = 2; takenNames.has(name.toLowerCase()); counter++) {
        name = `${environment.name} (${counter})`;
    }

    return { ...collection, environments: [...collection.environments, { ...environment, name }] };
}

function collectionNameFromFile(fileName: string): string {
    const name = path.basename(fileName)
        .replace(/\.(json|ya?ml|har|bru|zip|wsdl|xml)$/i, '')
        .replace(/\.postman_(collection|environment)$/i, '')
        .trim();
    return name || 'Imported collection';
}
