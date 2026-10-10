import * as _ from 'lodash';
import { createHash, randomBytes } from 'crypto';
import { StatusError } from '@httptoolkit/util';

import { brunoSchema } from './bruno-libs';
import { BrunoCollection, isRecord } from './bruno-types';

// Bruno's uid format (see @usebruno/schema): exactly 21 alphanumeric characters.
// Collection ids use the same format, as they double as the collection's uid.
const UID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UID_LENGTH = 21;
const UID_PATTERN = /^[A-Za-z0-9]{21}$/;

const bytesToUid = (bytes: Buffer) =>
    Array.from(bytes.subarray(0, UID_LENGTH), (byte) => UID_ALPHABET[byte % UID_ALPHABET.length]).join('');

export const newUid = () => bytesToUid(randomBytes(UID_LENGTH));

// The same seed always gives the same uid, so re-reading unchanged files gives unchanged uids
export const stableUid = (seed: string) => bytesToUid(createHash('sha256').update(seed).digest());

export const isValidUid = (value: unknown): value is string =>
    typeof value === 'string' && UID_PATTERN.test(value);

export function assertValidCollectionId(id: string) {
    if (!isValidUid(id)) {
        throw new StatusError(400, `Invalid collection id "${id}": expected 21 letters and digits`);
    }
}

// Fields some converters add that aren't part of the collection schema
const NON_SCHEMA_FIELDS = ['packageReport'];

/**
 * Turns untrusted collection JSON (an API request body or a converter's output) into a
 * BrunoCollection with the given id: required top-level fields are filled in and every
 * missing uid is generated. Run validateCollection afterwards for the full schema check.
 */
export function toCollection(input: unknown, id: string): BrunoCollection {
    if (!isRecord(input)) throw new StatusError(400, 'A collection must be a JSON object');

    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new StatusError(400, 'A collection needs a name');

    const copy: Record<string, unknown> = _.omit(_.cloneDeep(input), NON_SCHEMA_FIELDS);
    const collection = {
        ...copy,
        version: '1' as const,
        uid: id,
        name,
        items: Array.isArray(copy.items) ? copy.items : [],
        environments: Array.isArray(copy.environments) ? copy.environments : []
    };

    normalizeRequestShapes(collection.items);
    hydrateUids(collection);
    return collection as BrunoCollection;
}

/**
 * Bruno's .bru parser gives WebSocket requests an empty `method`, which their schema
 * doesn't allow, so they couldn't be saved again. Bruno's app drops it (and params) when
 * saving, in transformRequestToSaveToFilesystem; this does the same for every item.
 */
export function normalizeRequestShapes(items: unknown) {
    if (!Array.isArray(items)) return;

    for (const item of items) {
        if (!isRecord(item)) continue;
        if (item.type === 'ws-request' && isRecord(item.request)) {
            delete item.request.method;
            delete item.request.methodType;
            delete item.request.params;
        }
        normalizeRequestShapes(item.items);
    }
}

export async function validateCollection(collection: BrunoCollection): Promise<void> {
    try {
        await brunoSchema().collectionSchema.validate(collection);
    } catch (error) {
        const path = isRecord(error) && typeof error.path === 'string' && error.path
            ? `${error.path}: `
            : '';
        const message = error instanceof Error ? error.message : String(error);
        throw new StatusError(400, `Invalid collection: ${path}${message}`);
    }
}

const ensureUid = (owner: Record<string, unknown>, seed: string): string => {
    if (!isValidUid(owner.uid)) owner.uid = stableUid(seed);
    return owner.uid as string;
};

const ensureListUids = (list: unknown, seed: string) => {
    if (!Array.isArray(list)) return;
    list.forEach((entry, index) => {
        if (isRecord(entry)) ensureUid(entry, `${seed}/${index}`);
    });
};

const ensureVarsUids = (vars: unknown, seed: string) => {
    if (!isRecord(vars)) return;
    ensureListUids(vars.req, `${seed}/vars/req`);
    ensureListUids(vars.res, `${seed}/vars/res`);
};

const ensureRequestUids = (request: unknown, seed: string) => {
    if (!isRecord(request)) return;
    ensureListUids(request.headers, `${seed}/headers`);
    ensureListUids(request.params, `${seed}/params`);
    ensureListUids(request.assertions, `${seed}/assertions`);
    ensureVarsUids(request.vars, seed);

    if (isRecord(request.body)) {
        ensureListUids(request.body.formUrlEncoded, `${seed}/body/form`);
        ensureListUids(request.body.multipartForm, `${seed}/body/multipart`);
        ensureListUids(request.body.file, `${seed}/body/file`);
    }
};

const ensureExampleUids = (examples: unknown, itemUid: string) => {
    if (!Array.isArray(examples)) return;
    examples.forEach((example, index) => {
        if (!isRecord(example)) return;
        const exampleUid = ensureUid(example, `${itemUid}/examples/${index}`);
        example.itemUid = itemUid;
        ensureRequestUids(example.request, exampleUid);
        if (isRecord(example.response)) ensureListUids(example.response.headers, `${exampleUid}/response`);
    });
};

const ensureItemUids = (items: unknown, seed: string) => {
    if (!Array.isArray(items)) return;
    items.forEach((item, index) => {
        if (!isRecord(item)) return;
        const itemUid = ensureUid(item, `${seed}/${index}`);
        ensureRequestUids(item.request, itemUid);
        ensureExampleUids(item.examples, itemUid);
        if (isRecord(item.root)) ensureRequestUids(item.root.request, `${itemUid}/root`);
        ensureItemUids(item.items, itemUid);
    });
};

/**
 * Bruno's schema requires a uid on every item, header, param, variable, example and
 * environment, but .bru files don't store them. Missing or malformed uids are derived
 * from the owner's uid and position, so loading the same files twice gives the same uids.
 */
export function hydrateUids(collection: { uid: string, items: unknown, environments: unknown, root?: unknown }) {
    ensureItemUids(collection.items, collection.uid);

    if (isRecord(collection.root)) {
        ensureRequestUids(collection.root.request, `${collection.uid}/root`);
    }

    if (Array.isArray(collection.environments)) {
        collection.environments.forEach((environment, index) => {
            if (!isRecord(environment)) return;
            const environmentUid = ensureUid(environment, `${collection.uid}/environments/${index}`);
            ensureListUids(environment.variables, environmentUid);
        });
    }
}
