import * as _ from 'lodash';
import { StatusError } from '@httptoolkit/util';

import { brunoFilestore, brunoLang, BrunoFileFormat } from './bruno-libs';
import {
    BrunoCollection,
    BrunoEnvironment,
    BrunoEnvironmentVariable,
    BrunoExample,
    BrunoFolderRoot,
    BrunoItem,
    REQUEST_ITEM_TYPES,
    isFolder,
    isRecord
} from './bruno-types';
import { hydrateUids, normalizeRequestShapes, stableUid } from './collection-model';
import { ATTACHMENTS_DIR } from './attachments';
import { errorMessage } from './errors';
import { uniqueFileName } from './file-names';

/**
 * Bruno's folder format, which is also how collections are stored on disk:
 *
 *   bruno.json                 collection config: name, ignore list, ...
 *   collection.bru             collection-level auth, headers, variables, scripts and docs
 *   environments/<name>.bru    one file per environment; secret values are never written
 *   <folder>/folder.bru        folder name, order, auth, headers, variables, scripts and docs
 *   <folder>/<request>.bru     one file per request, with its docs and saved examples
 *   files/<name>               files that requests send (see attachments.ts), stored separately
 *
 * Newer Bruno versions may use OpenCollection YAML instead (opencollection.yml plus .yml
 * files). Both are read, but collections are always written as .bru.
 *
 * Here collections map to and from a file map (POSIX relative path -> file text), so the
 * same code serves disk storage and zip files.
 */
export type CollectionFiles = Map<string, string>;

export interface LoadedCollection {
    collection: BrunoCollection;
    warnings: string[];
}

// Item types stored as their own file. Bruno's 'js' items (script modules) aren't supported.
const FILE_ITEM_TYPES: ReadonlySet<string> = new Set([...REQUEST_ITEM_TYPES, 'app']);

// Request and folder files never take these names, which Bruno uses for itself
const RESERVED_NAMES = ['bruno.json', 'collection.bru', 'folder.bru', 'environments', 'node_modules', '.git'];
// ...and top-level folders don't take the name of the attached files' folder
const RESERVED_TOP_LEVEL_NAMES = [...RESERVED_NAMES, ATTACHMENTS_DIR];

const METADATA_FILES: ReadonlySet<string> = new Set([
    'bruno.json', 'collection.bru', 'folder.bru', 'opencollection.yml', 'folder.yml'
]);

const DEFAULT_IGNORE = ['node_modules', '.git'];

/**
 * Bruno's .bru parser (an ohm grammar) uses about 2 KB of memory for every character it
 * walks, so a few MB of text in one file is enough to exhaust the heap. Like Bruno's app,
 * files from LARGE_FILE_BYTES up have their big text blocks (bodies, docs, scripts) cut
 * out before parsing and put back afterwards. Saved examples aren't covered by that, so
 * their body text is limited when saving, and files that would still be too big to parse
 * safely are skipped with a warning.
 */
const LARGE_FILE_BYTES = 64 * 1024;
const MAX_PARSED_LENGTH = 256 * 1024;
const MAX_EXAMPLE_TEXT_PER_REQUEST = 64 * 1024;
// Example texts this short are always kept: they cost next to nothing to parse
const ALWAYS_KEPT_EXAMPLE_TEXT = 1024;

const joinPath = (dir: string, name: string) => dir ? `${dir}/${name}` : name;

const formatSize = (length: number) => length >= 1024 * 1024
    ? `${(length / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.ceil(length / 1024)} KB`;

async function parseBru(content: string, parse: (text: string) => unknown): Promise<unknown> {
    if (Buffer.byteLength(content) < LARGE_FILE_BYTES) return parse(content);

    const filestore = brunoFilestore();
    const { skeleton, blocks } = filestore.redactLargeBruTextBlocks(content);
    if (skeleton.length > MAX_PARSED_LENGTH) {
        throw new Error(`it has ${formatSize(skeleton.length)} of text outside bodies and docs, too much to read safely`);
    }
    return filestore.restoreRedactedBlocks(await parse(skeleton), blocks);
}

interface ExampleText {
    read(): unknown;
    write(text: string): void;
}

const exampleTexts = (example: BrunoExample): ExampleText[] => {
    const texts: ExampleText[] = [];

    const responseBody = example.response?.body;
    if (responseBody) {
        texts.push({ read: () => responseBody.content, write: (text) => { responseBody.content = text; } });
    }

    const requestBody = example.request?.body;
    if (requestBody) {
        for (const field of ['json', 'text', 'xml', 'sparql'] as const) {
            texts.push({ read: () => requestBody[field], write: (text) => { requestBody[field] = text; } });
        }
    }

    return texts;
};

/**
 * Shortens the body text of saved examples to MAX_EXAMPLE_TEXT_PER_REQUEST per request
 * (see above), marking where text was cut. Returns a warning for each shortened example.
 */
export function limitExampleText(items: BrunoItem[], parents: string[] = []): string[] {
    const warnings: string[] = [];

    for (const item of items) {
        const itemPath = [...parents, item.name];
        if (isFolder(item)) {
            warnings.push(...limitExampleText(item.items ?? [], itemPath));
            continue;
        }

        const budget = { remaining: MAX_EXAMPLE_TEXT_PER_REQUEST };
        for (const example of item.examples ?? []) {
            if (!shortenExampleTexts(example, budget)) continue;
            warnings.push(
                `The saved example "${example.name}" of ${itemPath.join(' / ')} was shortened: ` +
                `examples keep up to ${formatSize(MAX_EXAMPLE_TEXT_PER_REQUEST)} of body text per request`
            );
        }
    }

    return warnings;
}

// Returns whether any of the example's texts had to be shortened
function shortenExampleTexts(example: BrunoExample, budget: { remaining: number }): boolean {
    let shortened = false;

    for (const exampleText of exampleTexts(example)) {
        const value = exampleText.read();
        if (value === undefined || value === null) continue;

        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (text.length <= Math.max(budget.remaining, ALWAYS_KEPT_EXAMPLE_TEXT)) {
            budget.remaining = Math.max(0, budget.remaining - text.length);
            continue;
        }

        const kept = text.slice(0, budget.remaining).replace(/[\uD800-\uDBFF]$/, ''); // No half surrogate pairs
        exampleText.write(`${kept}\n… shortened by Wirepane, the full text was ${formatSize(text.length)}`);
        budget.remaining = 0;
        shortened = true;
    }

    return shortened;
}

export function collectionToFiles(collection: BrunoCollection): CollectionFiles {
    const files: CollectionFiles = new Map();
    const brunoConfig = toBrunoJson(collection);

    files.set('bruno.json', `${JSON.stringify(brunoConfig, null, 2)}\n`);
    files.set('collection.bru', brunoFilestore().stringifyCollection(
        collection.root ?? {},
        brunoConfig,
        { format: 'bru' }
    ));
    addItemFiles(collection.items, '', files);
    addEnvironmentFiles(collection.environments, files);

    return files;
}

function toBrunoJson(collection: BrunoCollection): Record<string, unknown> {
    // size & filesCount are stats Bruno adds at runtime; opencollection marks the YAML format
    const config = _.omit(collection.brunoConfig ?? {}, ['size', 'filesCount', 'opencollection']);

    return {
        ...config,
        version: '1',
        name: collection.name,
        type: 'collection',
        ignore: Array.isArray(config.ignore) ? config.ignore : DEFAULT_IGNORE
    };
}

// Like Bruno, folders and requests are numbered separately: within a parent, folders are
// listed first, then requests, each in their own `seq` order.
function addItemFiles(items: BrunoItem[], dir: string, files: CollectionFiles) {
    const filestore = brunoFilestore();
    const usedNames = new Set(dir ? RESERVED_NAMES : RESERVED_TOP_LEVEL_NAMES);
    let folderSeq = 0;
    let requestSeq = 0;

    for (const item of items) {
        if (isFolder(item)) {
            folderSeq += 1;
            const folderDir = joinPath(dir, uniqueFileName(item.name, usedNames));
            files.set(
                joinPath(folderDir, 'folder.bru'),
                filestore.stringifyFolder(toFolderRoot(item, folderSeq), { format: 'bru' })
            );
            addItemFiles(item.items ?? [], folderDir, files);
        } else if (FILE_ITEM_TYPES.has(item.type)) {
            requestSeq += 1;
            files.set(
                joinPath(dir, uniqueFileName(item.name, usedNames, '.bru')),
                filestore.stringifyRequest({ ...item, seq: requestSeq }, { format: 'bru' })
            );
        }
    }
}

const toFolderRoot = (folder: BrunoItem, seq: number): BrunoFolderRoot => ({
    ...folder.root,
    meta: { ...folder.root?.meta, name: folder.name, seq }
});

/**
 * A .bru environment is named after its file, so environment names are made file-safe
 * and unique exactly as their files will be named. Run before saving, so the names in
 * memory (and anything keyed by them) match what's read back from disk.
 */
export function normalizeEnvironmentNames(environments: BrunoEnvironment[]) {
    const usedNames = new Set<string>();
    for (const environment of environments) {
        environment.name = uniqueFileName(environment.name, usedNames, '.bru').slice(0, -'.bru'.length);
    }
}

function addEnvironmentFiles(environments: BrunoEnvironment[], files: CollectionFiles) {
    const lang = brunoLang();
    const usedNames = new Set<string>();

    for (const environment of environments) {
        const variables = environment.variables
            .filter((variable) => typeof variable.name === 'string' && variable.name)
            .map((variable) => ({
                ...variable,
                enabled: variable.enabled !== false,
                secret: variable.secret === true
            }));

        files.set(
            `environments/${uniqueFileName(environment.name, usedNames, '.bru')}`,
            lang.envJsonToBruV2({ ...environment, variables })
        );
    }
}

interface DirectoryNode {
    files: Map<string, string>;
    directories: Map<string, DirectoryNode>;
}

interface ReadContext {
    format: BrunoFileFormat;
    uid: string;
    warnings: string[];
}

/**
 * Reads a collection from a file map. Files that fail to parse are skipped with a
 * warning instead of failing the whole collection. Item uids derive from file paths.
 */
export async function filesToCollection(files: CollectionFiles, uid: string): Promise<LoadedCollection> {
    const rootPrefix = findCollectionRoot(files);
    if (rootPrefix === undefined) {
        throw new StatusError(400, 'Not a Bruno collection: no bruno.json or opencollection.yml found');
    }

    const tree = buildTree(files, rootPrefix);
    const format: BrunoFileFormat = tree.files.has('opencollection.yml') ? 'yml' : 'bru';
    const context: ReadContext = { format, uid, warnings: [] };

    const { brunoConfig, root } = await readCollectionRoot(tree, context);
    const name = typeof brunoConfig.name === 'string' && brunoConfig.name.trim()
        ? brunoConfig.name.trim()
        : 'Untitled collection';

    const collection: BrunoCollection = {
        version: '1',
        uid,
        name,
        items: await readItems(tree, '', context),
        environments: await readEnvironments(tree.directories.get('environments'), context),
        root: { ...root, meta: { ...root.meta, name } },
        brunoConfig: _.omit(brunoConfig, ['size', 'filesCount'])
    };

    normalizeRequestShapes(collection.items);
    hydrateUids(collection);
    return { collection, warnings: context.warnings };
}

// The shallowest bruno.json / opencollection.yml marks the collection root, which may be
// inside a top-level folder (common in zips)
export function findCollectionRoot(files: CollectionFiles): string | undefined {
    const configPaths = [...files.keys()].filter((filePath) => {
        const fileName = filePath.split('/').pop();
        return fileName === 'bruno.json' || fileName === 'opencollection.yml';
    });

    const shallowest = _.minBy(configPaths, (filePath) => filePath.split('/').length);
    if (shallowest === undefined) return undefined;

    const lastSlash = shallowest.lastIndexOf('/');
    return lastSlash === -1 ? '' : shallowest.slice(0, lastSlash + 1);
}

function buildTree(files: CollectionFiles, prefix: string): DirectoryNode {
    const root: DirectoryNode = { files: new Map(), directories: new Map() };

    for (const [filePath, content] of files) {
        if (!filePath.startsWith(prefix)) continue;

        const segments = filePath.slice(prefix.length).split('/');
        const fileName = segments.pop();
        if (!fileName) continue;

        let node = root;
        for (const segment of segments) {
            const child = node.directories.get(segment) ?? { files: new Map(), directories: new Map() };
            node.directories.set(segment, child);
            node = child;
        }
        node.files.set(fileName, content);
    }

    return root;
}

async function readSafely(context: ReadContext, filePath: string, read: () => unknown): Promise<unknown> {
    try {
        return await read();
    } catch (error) {
        context.warnings.push(`Skipped ${filePath}: ${errorMessage(error)}`);
        return undefined;
    }
}

const toFolderRootShape = (parsed: unknown): BrunoFolderRoot =>
    isRecord(parsed) ? _.pick(parsed, ['request', 'docs', 'meta']) as BrunoFolderRoot : {};

async function readCollectionRoot(tree: DirectoryNode, context: ReadContext) {
    const filestore = brunoFilestore();

    if (context.format === 'yml') {
        const content = tree.files.get('opencollection.yml') ?? '';
        const parsed = await readSafely(context, 'opencollection.yml', () =>
            filestore.parseCollection(content, { format: 'yml' })
        );
        return {
            brunoConfig: isRecord(parsed) && isRecord(parsed.brunoConfig) ? parsed.brunoConfig : {},
            root: toFolderRootShape(isRecord(parsed) ? parsed.collectionRoot : undefined)
        };
    }

    const collectionBru = tree.files.get('collection.bru');
    const parsedRoot = collectionBru === undefined
        ? undefined
        : await readSafely(context, 'collection.bru', () =>
            parseBru(collectionBru, (text) => filestore.parseCollection(text, { format: 'bru' }))
        );

    return {
        brunoConfig: readBrunoJson(tree.files.get('bruno.json'), context),
        root: toFolderRootShape(parsedRoot)
    };
}

function readBrunoJson(content: string | undefined, context: ReadContext): Record<string, unknown> {
    if (content === undefined) return {};

    try {
        const config: unknown = JSON.parse(content);
        if (isRecord(config)) return config;
    } catch {}

    context.warnings.push('bruno.json is not a valid JSON object, so default settings are used');
    return {};
}

async function readItems(node: DirectoryNode, dirPath: string, context: ReadContext): Promise<BrunoItem[]> {
    const folders: BrunoItem[] = [];
    const requests: BrunoItem[] = [];

    for (const [dirName, child] of node.directories) {
        const isIgnored = dirName.startsWith('.') ||
            dirName === 'node_modules' ||
            (dirPath === '' && (dirName === 'environments' || dirName === ATTACHMENTS_DIR));
        if (isIgnored) continue;

        folders.push(await readFolder(child, joinPath(dirPath, dirName), dirName, context));
    }

    for (const [fileName, content] of node.files) {
        if (!fileName.endsWith(`.${context.format}`) || METADATA_FILES.has(fileName)) continue;

        const item = await readRequestFile(content, joinPath(dirPath, fileName), context);
        if (item) requests.push(item);
    }

    return [...sortBySeq(folders), ...sortBySeq(requests)];
}

const sortBySeq = (items: BrunoItem[]) => _.sortBy(items, [
    (item) => item.seq ?? Number.MAX_SAFE_INTEGER,
    (item) => item.name.toLowerCase()
]);

async function readRequestFile(content: string, filePath: string, context: ReadContext): Promise<BrunoItem | undefined> {
    const parse = (text: string) => brunoFilestore().parseRequest(text, { format: context.format });
    const parsed = await readSafely(context, filePath, () =>
        context.format === 'bru' ? parseBru(content, parse) : parse(content)
    );
    if (parsed === undefined) return undefined;

    if (!isRecord(parsed) || typeof parsed.type !== 'string') {
        context.warnings.push(`Skipped ${filePath}: not a request file`);
        return undefined;
    }

    const fileName = filePath.split('/').pop() ?? filePath;
    const name = typeof parsed.name === 'string' && parsed.name
        ? parsed.name
        : fileName.replace(/\.[^.]+$/, '');

    return { ...parsed, type: parsed.type, name, uid: stableUid(`${context.uid}:${filePath}`) };
}

async function readFolder(
    node: DirectoryNode,
    folderPath: string,
    dirName: string,
    context: ReadContext
): Promise<BrunoItem> {
    const folderFileName = `folder.${context.format}`;
    const folderFile = node.files.get(folderFileName);
    const parse = (text: string) => brunoFilestore().parseFolder(text, { format: context.format });
    const parsed = folderFile === undefined
        ? undefined
        : await readSafely(context, joinPath(folderPath, folderFileName), () =>
            context.format === 'bru' ? parseBru(folderFile, parse) : parse(folderFile)
        );

    const root = toFolderRootShape(parsed);
    const name = typeof root.meta?.name === 'string' && root.meta.name ? root.meta.name : dirName;
    const seq = typeof root.meta?.seq === 'number' ? root.meta.seq : undefined;

    return {
        uid: stableUid(`${context.uid}:${folderPath}/`),
        type: 'folder',
        name,
        ...(seq !== undefined ? { seq } : {}),
        root: { ...root, meta: { ...root.meta, name } },
        items: await readItems(node, folderPath, context)
    };
}

async function readEnvironments(node: DirectoryNode | undefined, context: ReadContext): Promise<BrunoEnvironment[]> {
    if (!node) return [];

    const environments: BrunoEnvironment[] = [];
    for (const [fileName, content] of node.files) {
        const extension = `.${context.format}`;
        if (!fileName.endsWith(extension)) continue;

        const filePath = `environments/${fileName}`;
        const parsed = await readSafely(context, filePath, () => context.format === 'yml'
            ? brunoFilestore().parseEnvironment(content, { format: 'yml' })
            : brunoLang().bruToEnvJsonV2(content)
        );

        // .bru environments are named after their file; YAML ones carry their own name
        const environment = toEnvironment(parsed, fileName.slice(0, -extension.length));
        if (environment) environments.push({ ...environment, uid: stableUid(`${context.uid}:${filePath}`) });
    }

    return _.sortBy(environments, (environment) => environment.name.toLowerCase());
}

export function toEnvironment(parsed: unknown, fallbackName: string): BrunoEnvironment | undefined {
    if (!isRecord(parsed)) return undefined;

    const variables: BrunoEnvironmentVariable[] = Array.isArray(parsed.variables)
        ? parsed.variables.filter(isRecord).map((variable) => ({ ...variable, type: 'text' }))
        : [];

    return {
        ...parsed,
        name: typeof parsed.name === 'string' && parsed.name ? parsed.name : fallbackName,
        variables
    };
}
