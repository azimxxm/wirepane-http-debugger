import * as fs from 'fs';
import * as path from 'path';
import * as _ from 'lodash';
import { StatusError } from '@httptoolkit/util';

import { BrunoBody, BrunoCollection, BrunoItem, isFolder, isRecord } from './bruno-types';
import { sanitizeFileName } from './file-names';

/**
 * Files that requests send (multipart file fields and binary bodies) live in the
 * collection folder, under files/. Items refer to them by their path relative to the
 * folder, as Bruno does: multipart `value: ['files/photo.png']` and body
 * `file: [{ filePath: 'files/photo.png' }]`. Bruno resolves relative paths against the
 * collection folder, so the folder (or its zip) works in Bruno as it is.
 */

export const ATTACHMENTS_DIR = 'files';

// Attached files are held in memory, here and in the UI's file store
export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const isEnoent = (error: unknown) => isRecord(error) && error.code === 'ENOENT';

/**
 * A file path from an item, as a POSIX path relative to the collection folder. Undefined
 * for paths that leave the folder (absolute paths, '..'), and for hidden files.
 */
export function toCollectionRelativePath(filePath: string): string | undefined {
    const isAbsolute = /^[\\/]/.test(filePath) || /^[a-z]:/i.test(filePath);
    if (!filePath || isAbsolute) return undefined;

    const segments = filePath.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.');
    const isUnsafe = segments.some((segment) => segment === '..' || segment.startsWith('.'));
    return segments.length && !isUnsafe ? segments.join('/') : undefined;
}

export const fileNameOf = (filePath: string) => filePath.split(/[\\/]/).pop() || filePath;

const stringValues = (value: unknown): string[] =>
    (Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string' && !!entry);

// The file paths of a body: its multipart file fields and binary body files
export function bodyFileReferences(body: BrunoBody | null | undefined): string[] {
    if (!body) return [];
    return [
        ...(body.multipartForm ?? []).flatMap((field) => field.type === 'file' ? stringValues(field.value) : []),
        ...(body.file ?? []).flatMap((entry) => stringValues(entry.filePath))
    ];
}

// The bodies of every request in a collection, including the requests saved with examples
function collectionBodies(items: BrunoItem[]): BrunoBody[] {
    return items.flatMap((item) => isFolder(item)
        ? collectionBodies(item.items ?? [])
        : [item.request?.body, ...(item.examples ?? []).map((example) => example.request?.body)]
            .filter((body): body is BrunoBody => !!body)
    );
}

// Every file path the collection's requests refer to, each once
export const collectionFileReferences = (collection: BrunoCollection): string[] =>
    [...new Set(collectionBodies(collection.items).flatMap(bodyFileReferences))];

/**
 * Changes the file paths a collection refers to, e.g. after files got new names. Paths
 * that `rename` gives no new path for stay as they are.
 */
export function rewriteFileReferences(collection: BrunoCollection, rename: (filePath: string) => string | undefined) {
    const renamed = (filePath: string) => rename(filePath) ?? filePath;

    for (const body of collectionBodies(collection.items)) {
        for (const field of body.multipartForm ?? []) {
            if (field.type !== 'file') continue;
            if (Array.isArray(field.value)) {
                field.value = field.value.map((value) => typeof value === 'string' ? renamed(value) : value);
            } else if (typeof field.value === 'string') {
                field.value = renamed(field.value);
            }
        }
        for (const entry of body.file ?? []) {
            if (typeof entry.filePath === 'string') entry.filePath = renamed(entry.filePath);
        }
    }
}

// "photo.png" -> "photo (2).png"
function numberedName(name: string, counter: number) {
    if (counter === 1) return name;
    const extension = path.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    return `${stem} (${counter})${extension}`;
}

/**
 * Stores a file in the collection's files/ folder and returns its relative path. A name
 * that's taken by a different file gets a number; storing the same file under the same
 * name again gives the existing path, so saving a request twice doesn't copy its files.
 */
export async function storeAttachment(collectionDir: string, requestedName: string, bytes: Buffer): Promise<string> {
    const dir = path.join(collectionDir, ATTACHMENTS_DIR);
    await fs.promises.mkdir(dir, { recursive: true });
    const name = sanitizeFileName(requestedName);

    for (let counter = 1; ; counter++) {
        const candidate = numberedName(name, counter);
        const target = path.join(dir, candidate);

        const existing = await fs.promises.lstat(target).catch((error) => {
            if (isEnoent(error)) return undefined;
            throw error;
        });

        if (!existing) {
            await fs.promises.writeFile(target, bytes, { flag: 'wx' });
            return `${ATTACHMENTS_DIR}/${candidate}`;
        }

        const isSameFile = existing.isFile() && existing.size === bytes.byteLength &&
            (await fs.promises.readFile(target)).equals(bytes);
        if (isSameFile) return `${ATTACHMENTS_DIR}/${candidate}`;
    }
}

/**
 * Gives imported files their places under files/, numbering names that different files
 * share. Files that are in files/ already keep their paths. Returns the new path of each
 * original path, and the files to write.
 */
export function planAttachments(files: ReadonlyMap<string, Buffer>) {
    const newPaths = new Map<string, string>();
    const contents = new Map<string, Buffer>();
    const usedNames = new Map<string, string>(); // Lower-cased path -> path, as file systems may ignore case

    const keepsItsPath = (filePath: string) =>
        filePath === `${ATTACHMENTS_DIR}/${sanitizeFileName(fileNameOf(filePath))}`;
    const ordered = _.sortBy([...files], ([filePath]) => keepsItsPath(filePath) ? 0 : 1);

    for (const [originalPath, bytes] of ordered) {
        const name = sanitizeFileName(fileNameOf(originalPath));

        for (let counter = 1; ; counter++) {
            const candidate = `${ATTACHMENTS_DIR}/${numberedName(name, counter)}`;
            const taken = usedNames.get(candidate.toLowerCase());

            if (!taken || contents.get(taken)!.equals(bytes)) {
                const finalPath = taken ?? candidate;
                usedNames.set(candidate.toLowerCase(), finalPath);
                contents.set(finalPath, bytes);
                newPaths.set(originalPath, finalPath);
                break;
            }
        }
    }

    return { newPaths, contents };
}

export async function writeAttachments(collectionDir: string, contents: ReadonlyMap<string, Buffer>) {
    for (const [relativePath, bytes] of contents) {
        const target = path.join(collectionDir, ...relativePath.split('/'));
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.writeFile(target, bytes);
    }
}

/**
 * Reads a file the collection refers to. Only files inside the collection folder are
 * read: absolute paths, '..' and symlinks that lead elsewhere are refused.
 */
export async function readAttachment(collectionDir: string, filePath: string): Promise<{ relativePath: string, bytes: Buffer }> {
    const relativePath = toCollectionRelativePath(filePath);
    if (!relativePath) throw new StatusError(400, `${filePath} isn't a file inside the collection folder`);

    const notFound = () => new StatusError(404, `${relativePath} isn't in the collection folder`);
    const target = path.join(collectionDir, ...relativePath.split('/'));

    let realTarget: string;
    let realDir: string;
    try {
        [realTarget, realDir] = await Promise.all([fs.promises.realpath(target), fs.promises.realpath(collectionDir)]);
    } catch (error) {
        if (isEnoent(error)) throw notFound();
        throw error;
    }
    if (!realTarget.startsWith(realDir + path.sep)) throw notFound();

    const stats = await fs.promises.stat(realTarget);
    if (!stats.isFile()) throw notFound();
    if (stats.size > MAX_ATTACHMENT_BYTES) {
        throw new StatusError(413, `${relativePath} is larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
    }

    return { relativePath, bytes: await fs.promises.readFile(realTarget) };
}
