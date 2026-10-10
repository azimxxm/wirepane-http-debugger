import type * as BrunoConverters from '@usebruno/converters';
import type * as BrunoLang from '@usebruno/lang';
import type * as BrunoSchema from '@usebruno/schema';

/**
 * Lazy access to Bruno's packages. Loading them costs ~200ms (mostly compiling the .bru
 * grammar), so they're only required the first time a collections endpoint needs them,
 * instead of slowing down every server startup.
 */

export type BrunoFileFormat = 'bru' | 'yml';

// Only the functions we call. @usebruno/filestore's .d.ts files come from Bruno's build and
// import its dev-only packages (@usebruno/schema-types, @opencollection/types), so it's
// described locally to keep the server's type check independent of them.
export interface BrunoFilestore {
    parseRequest(content: string, options: { format: BrunoFileFormat }): unknown;
    stringifyRequest(item: unknown, options: { format: 'bru' }): string;
    parseFolder(content: string, options: { format: BrunoFileFormat }): unknown;
    stringifyFolder(folderRoot: unknown, options: { format: 'bru' }): string;
    // The .bru parser reports some failures as a rejected promise rather than a throw
    parseCollection(content: string, options: { format: BrunoFileFormat }): unknown;
    stringifyCollection(root: unknown, brunoConfig: unknown, options: { format: 'bru' }): string;
    parseEnvironment(content: string, options: { format: 'yml' }): unknown;
    // Bruno's own way of parsing big .bru files quickly: text blocks are swapped for tokens
    redactLargeBruTextBlocks(content: string): { skeleton: string, blocks: unknown[] };
    restoreRedactedBlocks(parsed: unknown, blocks: unknown[]): unknown;
}

let converters: typeof BrunoConverters | undefined;
let lang: typeof BrunoLang | undefined;
let schema: typeof BrunoSchema | undefined;
let filestore: BrunoFilestore | undefined;

export const brunoConverters = (): typeof BrunoConverters =>
    converters ??= require('@usebruno/converters');

export const brunoLang = (): typeof BrunoLang =>
    lang ??= require('@usebruno/lang');

export const brunoSchema = (): typeof BrunoSchema =>
    schema ??= require('@usebruno/schema');

export const brunoFilestore = (): BrunoFilestore =>
    filestore ??= require('@usebruno/filestore');
