import { BrunoCollection, BrunoItem } from './collection-types';

// Item types the server stores as request files. Other types (e.g. Bruno's 'js' script
// modules) aren't saved, so they never get a position on disk.
const REQUEST_ITEM_TYPES: ReadonlySet<string> = new Set([
    'http-request',
    'graphql-request',
    'grpc-request',
    'ws-request'
]);
const FILE_ITEM_TYPES: ReadonlySet<string> = new Set([...REQUEST_ITEM_TYPES, 'app']);

// Request types that Send can open: it sends plain HTTP requests only
const SENDABLE_ITEM_TYPES: ReadonlySet<string> = new Set(['http-request', 'graphql-request']);

export const isFolder = (item: BrunoItem) => item.type === 'folder';
export const isRequestItem = (item: BrunoItem) => REQUEST_ITEM_TYPES.has(item.type);
export const isSendableItem = (item: BrunoItem) => SENDABLE_ITEM_TYPES.has(item.type);

// Bruno's uid format (see @usebruno/schema): exactly 21 letters and digits
const UID_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const UID_LENGTH = 21;

export function newUid(): string {
    const bytes = crypto.getRandomValues(new Uint8Array(UID_LENGTH));
    return Array.from(bytes, (byte) => UID_ALPHABET[byte % UID_ALPHABET.length]).join('');
}

export function emptyCollection(uid: string, name: string): BrunoCollection {
    return {
        version: '1',
        uid,
        name,
        items: [],
        environments: [],
        root: { request: { headers: [], auth: { mode: 'none' }, vars: { req: [] } }, docs: '' }
    };
}

export const emptyFolder = (uid: string, name: string): BrunoItem => ({
    uid,
    type: 'folder',
    name,
    root: { request: { auth: { mode: 'inherit' } }, docs: '' },
    items: []
});

export const emptyRequestItem = (uid: string, name: string): BrunoItem => ({
    uid,
    type: 'http-request',
    name,
    request: {
        method: 'GET',
        url: '',
        headers: [],
        params: [],
        body: { mode: 'none' },
        auth: { mode: 'inherit' },
        script: {},
        vars: {},
        assertions: [],
        tests: '',
        docs: ''
    }
});

export interface ItemLocation {
    item: BrunoItem;
    // The folders containing the item, outermost first
    parents: BrunoItem[];
    // The list the item is in: a folder's items, or the collection's top level
    siblings: BrunoItem[];
}

export function walkItems(
    items: BrunoItem[],
    visit: (item: BrunoItem, parents: BrunoItem[], siblings: BrunoItem[]) => void,
    parents: BrunoItem[] = []
) {
    for (const item of items) {
        visit(item, parents, items);
        if (isFolder(item)) walkItems(item.items ?? [], visit, [...parents, item]);
    }
}

export function findItem(collection: BrunoCollection, uid: string): ItemLocation | undefined {
    let found: ItemLocation | undefined;
    walkItems(collection.items, (item, parents, siblings) => {
        if (!found && item.uid === uid) found = { item, parents, siblings };
    });
    return found;
}

// The list that holds a folder's children, or the top level when no folder is given
export function childrenOf(collection: BrunoCollection, folderUid: string | undefined): BrunoItem[] | undefined {
    if (!folderUid) return collection.items;

    const folder = findItem(collection, folderUid)?.item;
    if (!folder || !isFolder(folder)) return undefined;

    folder.items = folder.items ?? [];
    return folder.items;
}

export function countRequests(items: BrunoItem[]): number {
    let count = 0;
    walkItems(items, (item) => { if (isRequestItem(item)) count += 1; });
    return count;
}

export interface FolderOption {
    uid: string;
    // The folder's path, e.g. "Pets / Cats"
    label: string;
}

export function listFolders(collection: BrunoCollection): FolderOption[] {
    const folders: FolderOption[] = [];
    walkItems(collection.items, (item, parents) => {
        if (!isFolder(item)) return;
        folders.push({ uid: item.uid, label: [...parents, item].map((folder) => folder.name).join(' / ') });
    });
    return folders;
}

export const itemPath = (location: ItemLocation) =>
    [...location.parents, location.item].map((item) => item.name);

/**
 * Picks a name that isn't used yet, adding " (2)", " (3)"... when needed. Names are
 * compared case-insensitively, like the file names the server stores them as.
 */
export function uniqueName(baseName: string, takenNames: Iterable<string>): string {
    const taken = new Set(Array.from(takenNames, (name) => name.toLowerCase()));
    const base = baseName.trim() || 'Untitled';

    for (let counter = 1; ; counter++) {
        const candidate = counter === 1 ? base : `${base} (${counter})`;
        if (!taken.has(candidate.toLowerCase())) return candidate;
    }
}

/**
 * The server derives item uids from file paths, so a save that renames, adds or removes
 * items can change other items' uids too. What it keeps is each item's position: within
 * a folder, folders are stored in their list order and then requests in theirs. A
 * position key ("f0/r2": the third request of the first folder) finds the same item in
 * the collection the server returns.
 */
export function positionKeys(items: BrunoItem[], prefix = ''): Map<string, string> {
    const keys = new Map<string, string>();
    let folderIndex = 0;
    let fileIndex = 0;

    for (const item of items) {
        if (isFolder(item)) {
            const key = `${prefix}f${folderIndex++}`;
            keys.set(item.uid, key);
            positionKeys(item.items ?? [], `${key}/`).forEach((childKey, uid) => keys.set(uid, childKey));
        } else if (FILE_ITEM_TYPES.has(item.type)) {
            keys.set(item.uid, `${prefix}r${fileIndex++}`);
        }
    }

    return keys;
}

/**
 * Maps the uids of an edited collection (as sent to the server) to the uids of the
 * collection the server sent back. Uids of removed items map to undefined.
 */
export function buildUidRemap(sent: BrunoCollection, received: BrunoCollection): (uid: string) => string | undefined {
    const sentKeys = positionKeys(sent.items);
    const receivedUidsByKey = new Map<string, string>();
    positionKeys(received.items).forEach((key, uid) => receivedUidsByKey.set(key, uid));

    return (uid: string) => {
        const key = sentKeys.get(uid);
        return key === undefined ? undefined : receivedUidsByKey.get(key);
    };
}

/**
 * The uids to show for a search: matching requests, plus the folders on their path.
 * Requests match on their name, method or URL.
 */
export function searchItems(collection: BrunoCollection, query: string): Set<string> | undefined {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!terms.length) return undefined;

    const visible = new Set<string>();
    walkItems(collection.items, (item, parents) => {
        if (!isRequestItem(item)) return;

        const text = `${item.request?.method ?? ''} ${item.name} ${item.request?.url ?? ''}`.toLowerCase();
        if (!terms.every((term) => text.includes(term))) return;

        visible.add(item.uid);
        parents.forEach((folder) => visible.add(folder.uid));
    });
    return visible;
}
