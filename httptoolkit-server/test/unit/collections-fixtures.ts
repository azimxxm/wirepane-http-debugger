import * as fs from 'fs';
import * as path from 'path';

// Shared helpers for the collections-*.spec.ts tests

export const readCollectionFixture = (name: string) =>
    fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'collections', name), 'utf8');

// fflate's typings need TypeScript 5.7+, so it's loaded untyped like in the source
const { unzipSync }: {
    unzipSync(data: Uint8Array): Record<string, Uint8Array>
} = require('fflate');

// Every entry of a zip (given as base64), decompressed to text
export function unzipToText(base64: string): Map<string, string> {
    const entries = unzipSync(Buffer.from(base64, 'base64'));
    return new Map(Object.entries(entries).map(([name, data]) => [name, Buffer.from(data).toString('utf8')]));
}

export interface PostmanItem {
    name: string;
    description?: string;
    item?: PostmanItem[];
    request?: {
        method: string;
        description?: string;
        url: { raw: string, host?: string[], path?: string[], query?: Array<{ key: string, value: string }> };
    };
    response?: Array<{ name: string, code: number, body: string }>;
}

export const flattenPostmanRequests = (items: PostmanItem[]): PostmanItem[] =>
    items.flatMap((item) => item.item ? flattenPostmanRequests(item.item) : [item]);
