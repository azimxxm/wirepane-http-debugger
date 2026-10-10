import { FileRef } from './send-extras';

/**
 * The bytes of files attached in Send: multipart file fields and binary bodies.
 *
 * Send tabs are persisted in localStorage, which only holds a few MB, so a tab keeps a
 * FileRef and the bytes live here: in memory, and in IndexedDB so they survive a reload.
 * Files are keyed by their SHA-256, so attaching the same file twice stores it once.
 */

// Bigger files work, but they're held in memory and sent to the server as base64 JSON
export const MAX_SEND_FILE_SIZE = 100 * 1024 * 1024;

const DB_NAME = 'wirepane-send-files';
const STORE_NAME = 'files';

interface StoredFile {
    bytes: Uint8Array;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
    // A copy, as digest() only takes bytes backed by a plain ArrayBuffer
    const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export class SendFileStore {

    private memory = new Map<string, Buffer>();
    private db: Promise<IDBDatabase | undefined> | undefined;

    private openDb(): Promise<IDBDatabase | undefined> {
        if (!this.db) {
            this.db = new Promise<IDBDatabase | undefined>((resolve) => {
                try {
                    const request = indexedDB.open(DB_NAME, 1);
                    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => {
                        console.warn('Send file store: IndexedDB is unavailable, files last until reload', request.error);
                        resolve(undefined);
                    };
                } catch (error) {
                    console.warn('Send file store: IndexedDB is unavailable, files last until reload', error);
                    resolve(undefined);
                }
            });
        }
        return this.db;
    }

    private async withStore<T>(
        mode: IDBTransactionMode,
        run: (store: IDBObjectStore) => IDBRequest<T>
    ): Promise<T | undefined> {
        const db = await this.openDb();
        if (!db) return undefined;
        return requestToPromise(run(db.transaction(STORE_NAME, mode).objectStore(STORE_NAME)));
    }

    async put(bytes: Buffer, meta: { name: string, contentType: string }): Promise<FileRef> {
        const fileId = await sha256Hex(bytes);
        this.memory.set(fileId, bytes);

        try {
            const stored: StoredFile = { bytes: new Uint8Array(bytes) };
            await this.withStore('readwrite', (store) => store.put(stored, fileId));
        } catch (error) {
            // Still usable until reload, from memory
            console.warn(`Send file store: couldn't persist ${meta.name}`, error);
        }

        return { fileId, name: meta.name, size: bytes.byteLength, contentType: meta.contentType };
    }

    // The file's bytes, or undefined if they're gone (e.g. site data was cleared)
    async get(fileId: string): Promise<Buffer | undefined> {
        const inMemory = this.memory.get(fileId);
        if (inMemory) return inMemory;

        try {
            const stored = await this.withStore<StoredFile | undefined>('readonly', (store) => store.get(fileId));
            if (!stored) return undefined;

            const bytes = Buffer.from(stored.bytes);
            this.memory.set(fileId, bytes);
            return bytes;
        } catch (error) {
            console.warn(`Send file store: couldn't read file ${fileId}`, error);
            return undefined;
        }
    }

    // Drops every file no Send tab refers to any more
    async retainOnly(fileIds: ReadonlySet<string>): Promise<void> {
        for (const fileId of Array.from(this.memory.keys())) {
            if (!fileIds.has(fileId)) this.memory.delete(fileId);
        }

        try {
            const storedIds = await this.withStore('readonly', (store) => store.getAllKeys()) ?? [];
            for (const fileId of storedIds) {
                // A file put while this runs is in memory again: it's new, so it stays
                if (!fileIds.has(String(fileId)) && !this.memory.has(String(fileId))) {
                    await this.withStore('readwrite', (store) => store.delete(fileId));
                }
            }
        } catch (error) {
            console.warn('Send file store: cleanup failed', error);
        }
    }

}

export const sendFileStore = new SendFileStore();
