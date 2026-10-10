import * as fs from 'fs';
import * as path from 'path';
import { StatusError } from '@httptoolkit/util';

import type { CollectionFiles } from './bruno-folder';

/**
 * Moves collection file maps (see bruno-folder.ts) between memory, folders on disk
 * and zip archives.
 */

// fflate's bundled typings need TypeScript 5.7+, so the two functions used are described here
interface ZipLibrary {
    zipSync(files: Record<string, Uint8Array>, options?: { level?: number }): Uint8Array;
    unzipSync(data: Uint8Array, options?: {
        filter?: (file: { name: string, size: number, originalSize: number }) => boolean
    }): Record<string, Uint8Array>;
}
const { zipSync, unzipSync }: ZipLibrary = require('fflate');

const isCollectionFileName = (fileName: string) =>
    fileName === 'bruno.json' || fileName.endsWith('.bru') || fileName.endsWith('.yml');

const pathExists = (target: string) =>
    fs.promises.access(target).then(() => true, () => false);

/**
 * Lists a collection folder's files as POSIX relative paths. Hidden entries, node_modules
 * and symlinks are skipped, so nothing outside the folder is ever followed.
 */
export async function listFolderFiles(dir: string): Promise<string[]> {
    const filePaths: string[] = [];

    const walk = async (absoluteDir: string, relativeDir: string): Promise<void> => {
        const entries = await fs.promises.readdir(absoluteDir, { withFileTypes: true });

        for (const entry of entries) {
            if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;

            const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
            if (entry.isDirectory()) {
                await walk(path.join(absoluteDir, entry.name), relativePath);
            } else if (entry.isFile() && isCollectionFileName(entry.name)) {
                filePaths.push(relativePath);
            }
        }
    };

    await walk(dir, '');
    return filePaths;
}

export async function readFolderFiles(dir: string): Promise<CollectionFiles> {
    const files: CollectionFiles = new Map();

    for (const relativePath of await listFolderFiles(dir)) {
        const absolutePath = path.join(dir, ...relativePath.split('/'));
        files.set(relativePath, await fs.promises.readFile(absolutePath, 'utf8'));
    }
    return files;
}

async function writeFiles(dir: string, files: CollectionFiles) {
    await fs.promises.mkdir(dir, { recursive: true });

    for (const [relativePath, content] of files) {
        const absolutePath = path.join(dir, ...relativePath.split('/'));
        // File names are sanitized when the file map is built; this is a last line of defence
        if (!absolutePath.startsWith(dir + path.sep)) {
            throw new Error(`Refusing to write outside the collection folder: ${relativePath}`);
        }

        await fs.promises.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.promises.writeFile(absolutePath, content, 'utf8');
    }
}

/**
 * Replaces a folder's contents with a file map. The files are written to a new folder
 * first, which is then swapped in, so a failed save never leaves a half-written collection.
 * Callers must not run two replacements of the same folder at once.
 */
export async function replaceFolder(targetDir: string, files: CollectionFiles): Promise<void> {
    const parentDir = path.dirname(targetDir);
    const suffix = `${path.basename(targetDir)}-${process.pid}-${Date.now()}`;
    const tempDir = path.join(parentDir, `.tmp-${suffix}`);
    const backupDir = path.join(parentDir, `.old-${suffix}`);

    try {
        await writeFiles(tempDir, files);
    } catch (error) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        throw error;
    }

    const hadPrevious = await pathExists(targetDir);
    if (hadPrevious) await fs.promises.rename(targetDir, backupDir);

    try {
        await fs.promises.rename(tempDir, targetDir);
    } catch (error) {
        if (hadPrevious) await fs.promises.rename(backupDir, targetDir);
        await fs.promises.rm(tempDir, { recursive: true, force: true });
        throw error;
    }

    if (hadPrevious) await fs.promises.rm(backupDir, { recursive: true, force: true });
}

export function filesToZip(files: CollectionFiles): Buffer {
    const entries = Object.fromEntries(
        [...files].map(([filePath, content]) => [filePath, Buffer.from(content, 'utf8')])
    );
    return Buffer.from(zipSync(entries, { level: 9 }));
}

export const isZip = (bytes: Uint8Array) =>
    bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;

// Limits for imported zips, so a hostile archive can't exhaust memory
const MAX_ZIP_ENTRIES = 5000;
const MAX_ZIP_UNCOMPRESSED_BYTES = 100 * 1024 * 1024;

// Zip entry names are untrusted: no parent references, no hidden or macOS metadata entries
function normalizeZipPath(name: string): string | undefined {
    const segments = name.replace(/\\/g, '/').split('/').filter((segment) => segment && segment !== '.');
    const isUnsafe = segments.some((segment) =>
        segment === '..' || segment.startsWith('.') || segment === '__MACOSX'
    );
    return segments.length && !isUnsafe ? segments.join('/') : undefined;
}

export interface UnzippedCollection {
    files: CollectionFiles;
    skippedFiles: number;
}

export function zipToFiles(bytes: Uint8Array): UnzippedCollection {
    let entryCount = 0;
    let totalBytes = 0;
    let skippedFiles = 0;

    const unzipped = unzipSync(bytes, {
        filter: (entry) => {
            const filePath = normalizeZipPath(entry.name);
            const isDirectory = entry.name.endsWith('/');
            if (!filePath || isDirectory || !isCollectionFileName(filePath.split('/').pop() ?? '')) {
                if (!isDirectory) skippedFiles += 1;
                return false;
            }

            entryCount += 1;
            totalBytes += entry.originalSize;
            if (entryCount > MAX_ZIP_ENTRIES || totalBytes > MAX_ZIP_UNCOMPRESSED_BYTES) {
                throw new StatusError(400, 'The zip file is too large to import');
            }
            return true;
        }
    });

    const files: CollectionFiles = new Map();
    for (const [entryName, data] of Object.entries(unzipped)) {
        const filePath = normalizeZipPath(entryName);
        if (filePath) files.set(filePath, Buffer.from(data).toString('utf8').replace(/^\uFEFF/, ''));
    }

    return { files, skippedFiles };
}
