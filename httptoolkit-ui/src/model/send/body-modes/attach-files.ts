import { getReadableSize } from '../../../util/buffer';

import { RequestInput } from '../send-request-model';
import { FileRef } from '../send-extras';
import { MAX_SEND_FILE_SIZE, sendFileStore } from '../send-files';
import { addMultipartFiles } from './body-fields';
import { setBinaryFile } from './body-mode-options';

/**
 * Reading files picked or dropped in Send into the Send file store.
 */

export const MAX_SEND_FILE_SIZE_LABEL = `${MAX_SEND_FILE_SIZE / (1024 * 1024)} MB`;

const DEFAULT_FILE_TYPE = 'application/octet-stream';

// For files the browser gives no type, by their extension
const TYPES_BY_EXTENSION: { [extension: string]: string } = {
    txt: 'text/plain',
    csv: 'text/csv',
    md: 'text/markdown',
    html: 'text/html',
    htm: 'text/html',
    css: 'text/css',
    js: 'text/javascript',
    mjs: 'text/javascript',
    json: 'application/json',
    xml: 'application/xml',
    yaml: 'application/yaml',
    yml: 'application/yaml',
    pdf: 'application/pdf',
    zip: 'application/zip',
    gz: 'application/gzip',
    tar: 'application/x-tar',
    wasm: 'application/wasm',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    avif: 'image/avif',
    svg: 'image/svg+xml',
    ico: 'image/x-icon',
    bmp: 'image/bmp',
    heic: 'image/heic',
    tif: 'image/tiff',
    tiff: 'image/tiff',
    mp3: 'audio/mpeg',
    m4a: 'audio/mp4',
    wav: 'audio/wav',
    ogg: 'audio/ogg',
    flac: 'audio/flac',
    mp4: 'video/mp4',
    mov: 'video/quicktime',
    webm: 'video/webm',
    mkv: 'video/x-matroska',
    avi: 'video/x-msvideo',
    woff: 'font/woff',
    woff2: 'font/woff2',
    ttf: 'font/ttf',
    otf: 'font/otf'
};

// The browser's type for the file, else a guess from its extension, else plain bytes
export function detectFileContentType(file: { name: string, type?: string }): string {
    if (file.type) return file.type;

    const extension = /\.([^./\\]+)$/.exec(file.name)?.[1].toLowerCase();
    return (extension && TYPES_BY_EXTENSION[extension]) || DEFAULT_FILE_TYPE;
}

export const isPreviewableImage = (contentType: string) => /^image\//i.test(contentType);

export interface StoredFiles {
    files: FileRef[];
    // Why some files weren't attached, for the user
    problems: string[];
}

export function fileTooLargeMessage(file: { name: string, size: number }) {
    return `"${file.name}" is ${getReadableSize(file.size)}. Files over ${MAX_SEND_FILE_SIZE_LABEL} can't be attached.`;
}

// Stores each file, unless it's too big or can't be read
export async function storeFilesForSend(files: readonly File[]): Promise<StoredFiles> {
    const result: StoredFiles = { files: [], problems: [] };

    for (const file of files) {
        if (file.size > MAX_SEND_FILE_SIZE) {
            result.problems.push(fileTooLargeMessage(file));
            continue;
        }

        try {
            const bytes = Buffer.from(await file.arrayBuffer());
            result.files.push(await sendFileStore.put(bytes, {
                name: file.name,
                contentType: detectFileContentType(file)
            }));
        } catch (error: any) {
            console.warn(`Couldn't attach ${file.name}`, error);
            result.problems.push(`"${file.name}" couldn't be read${error?.message ? `: ${error.message}` : '.'}`);
        }
    }

    return result;
}

// Adds files to a multipart body, on the given row or a new one. Returns any problems.
export async function attachMultipartFiles(
    input: RequestInput,
    files: readonly File[],
    fieldId?: string
): Promise<string[]> {
    const stored = await storeFilesForSend(files);
    addMultipartFiles(input.extras, stored.files, fieldId);
    return stored.problems;
}

// Makes the first of the files the binary body. Returns any problems.
export async function attachBinaryFile(input: RequestInput, files: readonly File[]): Promise<string[]> {
    if (!files.length) return [];

    const stored = await storeFilesForSend(files.slice(0, 1));
    const [file] = stored.files;
    if (!file) return stored.problems;

    setBinaryFile(input, file);
    return files.length > 1
        ? [`A binary body is one file, so only "${file.name}" was used.`]
        : [];
}
