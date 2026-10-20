import * as fs from 'fs';
import * as path from 'path';
import * as _ from 'lodash';
import { Mutex } from 'async-mutex';
import { StatusError } from '@httptoolkit/util';

import { BrunoCollection, BrunoEnvironment, isRecord } from './bruno-types';
import {
    collectionToFiles,
    filesToCollection,
    limitExampleText,
    LoadedCollection,
    normalizeEnvironmentNames
} from './bruno-folder';
import { assertValidCollectionId, isValidUid, toCollection, validateCollection } from './collection-model';
import { asClientError } from './errors';
import { ExportFormat, ExportResult, exportCollection } from './export';
import { listFolderFiles, readFolderFiles, replaceFolder } from './folder-storage';
import { ImportFileInput, ImportResult, importCollectionFile } from './import';
import {
    ATTACHMENTS_DIR,
    collectionFileReferences,
    fileNameOf,
    planAttachments,
    readAttachment,
    rewriteFileReferences,
    storeAttachment,
    writeAttachments
} from './attachments';
import {
    deleteFromKeychain,
    readFromKeychain,
    storeInKeychain,
    StoredSecret
} from './keychain-store';

export interface CollectionSummary {
    id: string;
    name: string;
    requestCount: number;
    environmentCount: number;
    // When the collection was last saved (ISO 8601)
    updatedAt: string;
}

export interface ImportRequest extends ImportFileInput {
    // Required for environment files: the collection that receives the environment
    collectionId?: string;
}

export interface StoredFile {
    // Where the file is, relative to the collection folder: what requests refer to it by
    path: string;
    name: string;
    size: number;
}

export interface CollectionFile {
    path: string;
    name: string;
    bytes: Buffer;
}

const isEnoent = (error: unknown) => isRecord(error) && error.code === 'ENOENT';

const notFound = (id: string) => new StatusError(404, `Collection ${id} not found`);

/**
 * Stores API collections under <configPath>/collections/<id>/ in Bruno's folder format.
 * The files that requests send are kept in the same folder, under files/ (attachments.ts).
 *
 * .bru files never contain the values of secret environment variables, so those values
 * live in <configPath>/collection-secrets/<id>.json (readable only by the current user),
 * outside the collection folder: copying, zipping or committing the folder can't leak them.
 */
export class CollectionsService {

    private readonly collectionsDir: string;
    private readonly secretsDir: string;

    // A save swaps whole folders, so disk operations run one at a time
    private readonly diskLock = new Mutex();

    constructor(configPath: string) {
        this.collectionsDir = path.join(configPath, 'collections');
        this.secretsDir = path.join(configPath, 'collection-secrets');
    }

    async list(): Promise<CollectionSummary[]> {
        return this.diskLock.runExclusive(async () => {
            const entries = await fs.promises.readdir(this.collectionsDir, { withFileTypes: true })
                .catch((error) => {
                    if (isEnoent(error)) return [];
                    throw error;
                });

            const summaries = await Promise.all(entries
                .filter((entry) => entry.isDirectory() && isValidUid(entry.name))
                .map((entry) => this.readSummary(entry.name))
            );

            return _.sortBy(
                summaries.filter((summary): summary is CollectionSummary => !!summary),
                (summary) => summary.name.toLowerCase()
            );
        });
    }

    async get(id: string): Promise<LoadedCollection> {
        assertValidCollectionId(id);
        return this.diskLock.runExclusive(() => this.readCollection(id));
    }

    /**
     * Creates or replaces a collection. The input is Bruno collection JSON: it's checked
     * against Bruno's collection schema, and missing uids are generated. Returns the
     * collection as read back from disk, which is what later reads will return too.
     */
    async save(id: string, input: unknown): Promise<LoadedCollection> {
        return this.write(id, input, new Map());
    }

    // Saves a collection, plus new attached files (relative path -> bytes) for its folder
    private async write(id: string, input: unknown, attachments: ReadonlyMap<string, Buffer>): Promise<LoadedCollection> {
        assertValidCollectionId(id);

        const collection = toCollection(input, id);
        await validateCollection(collection);
        normalizeEnvironmentNames(collection.environments);
        const warnings = limitExampleText(collection.items);

        return this.diskLock.runExclusive(async () => {
            await fs.promises.mkdir(this.collectionsDir, { recursive: true });
            // The attached files were stored separately, so they move into the new folder
            await replaceFolder(this.collectionDir(id), collectionToFiles(collection), [ATTACHMENTS_DIR]);
            await writeAttachments(this.collectionDir(id), attachments);
            await this.storeSecrets(collection);

            const saved = await this.readCollection(id);
            return { ...saved, warnings: [...warnings, ...saved.warnings] };
        });
    }

    /**
     * Adds a file for requests to send to a collection's files/ folder, and returns the
     * path that requests refer to it by. The same file under the same name gets the same
     * path every time, so saving a request again doesn't make copies.
     */
    async addFile(id: string, name: string, bytes: Buffer): Promise<StoredFile> {
        assertValidCollectionId(id);

        return this.diskLock.runExclusive(async () => {
            await this.assertExists(id);
            const filePath = await storeAttachment(this.collectionDir(id), name, bytes);
            return { path: filePath, name: fileNameOf(filePath), size: bytes.byteLength };
        });
    }

    // Reads a file that the collection's requests send, by the path they refer to it by
    async readFile(id: string, filePath: string): Promise<CollectionFile> {
        assertValidCollectionId(id);

        return this.diskLock.runExclusive(async () => {
            await this.assertExists(id);
            const { relativePath, bytes } = await readAttachment(this.collectionDir(id), filePath);
            return { path: relativePath, name: fileNameOf(relativePath), bytes };
        });
    }

    async delete(id: string): Promise<void> {
        assertValidCollectionId(id);

        await this.diskLock.runExclusive(async () => {
            const dir = this.collectionDir(id);
            await this.assertExists(id);

            await fs.promises.rm(dir, { recursive: true, force: true });
            await fs.promises.rm(this.secretsFile(id), { force: true });
            await deleteFromKeychain(id).catch(() => {});
        });
    }

    /**
     * Imports a file as a new collection, or adds an environment file to the collection
     * given by collectionId, then saves the result.
     */
    async importFile(request: ImportRequest): Promise<ImportResult> {
        const target = request.collectionId
            ? (await this.get(request.collectionId)).collection
            : undefined;

        let result: ImportResult;
        try {
            result = await importCollectionFile(request, { into: target });
        } catch (error) {
            throw asClientError(error, `Couldn't import ${request.fileName}`);
        }

        // Imported files move to files/, and the requests follow them there
        const { newPaths, contents } = planAttachments(result.attachments ?? new Map());
        rewriteFileReferences(result.collection, (filePath) => newPaths.get(filePath));

        const saved = await this.write(result.collection.uid, result.collection, contents);
        return {
            format: result.format,
            collection: saved.collection,
            warnings: [...result.warnings, ...saved.warnings]
        };
    }

    async exportCollection(id: string, format: ExportFormat): Promise<ExportResult> {
        const { collection } = await this.get(id);
        if (format !== 'bruno') return exportCollection(collection, format);

        // Bruno zips include the files that requests send. Files that can't be read are
        // left out, and the export says so.
        const attachments = new Map<string, Buffer>();
        for (const filePath of collectionFileReferences(collection)) {
            const file = await this.readFile(id, filePath).catch(() => undefined);
            if (file) attachments.set(file.path, file.bytes);
        }
        return exportCollection(collection, format, { attachments });
    }

    private collectionDir(id: string) {
        return path.join(this.collectionsDir, id);
    }

    private secretsFile(id: string) {
        return path.join(this.secretsDir, `${id}.json`);
    }

    private async assertExists(id: string) {
        const exists = await fs.promises.access(path.join(this.collectionDir(id), 'bruno.json')).then(() => true, () => false);
        if (!exists) throw notFound(id);
    }

    private async readCollection(id: string): Promise<LoadedCollection> {
        const files = await readFolderFiles(this.collectionDir(id)).catch((error) => {
            if (isEnoent(error)) throw notFound(id);
            throw error;
        });
        if (!files.has('bruno.json')) throw notFound(id);

        const loaded = await filesToCollection(files, id);
        await this.restoreSecrets(loaded.collection);
        return loaded;
    }

    private async readSummary(id: string): Promise<CollectionSummary | undefined> {
        const dir = this.collectionDir(id);

        try {
            const brunoJsonPath = path.join(dir, 'bruno.json');
            const [config, stats, filePaths] = await Promise.all([
                fs.promises.readFile(brunoJsonPath, 'utf8').then((content): unknown => JSON.parse(content)),
                fs.promises.stat(brunoJsonPath),
                listFolderFiles(dir)
            ]);

            return {
                id,
                name: isRecord(config) && typeof config.name === 'string' ? config.name : id,
                requestCount: filePaths.filter((filePath) => {
                    const fileName = filePath.split('/').pop();
                    return filePath.endsWith('.bru') &&
                        !filePath.startsWith('environments/') &&
                        !filePath.startsWith(`${ATTACHMENTS_DIR}/`) &&
                        fileName !== 'folder.bru' &&
                        fileName !== 'collection.bru';
                }).length,
                environmentCount: filePaths.filter((filePath) => /^environments\/[^/]+\.bru$/.test(filePath)).length,
                updatedAt: stats.mtime.toISOString()
            };
        } catch (error) {
            // A folder without a readable bruno.json isn't a collection
            if (isEnoent(error) || error instanceof SyntaxError) return undefined;
            throw error;
        }
    }

    private async storeSecrets(collection: BrunoCollection) {
        const secrets: StoredSecret[] = collection.environments.flatMap((environment) =>
            environment.variables
                .filter((variable) => variable.secret === true && typeof variable.name === 'string' &&
                    variable.value !== undefined && variable.value !== null && variable.value !== '')
                .map((variable) => ({
                    environment: environment.name,
                    variable: variable.name as string,
                    value: variable.value
                }))
        );

        const file = this.secretsFile(collection.uid);
        if (!secrets.length) {
            await fs.promises.rm(file, { force: true });
            await deleteFromKeychain(collection.uid).catch(() => {});
            return;
        }

        await fs.promises.mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
        await storeInKeychain(collection.uid, secrets).catch(() => {});
    }

    private async restoreSecrets(collection: BrunoCollection) {
        let secrets: StoredSecret[] | undefined = await readFromKeychain(collection.uid).catch(() => undefined);

        if (!secrets || secrets.length === 0) {
            const content = await fs.promises.readFile(this.secretsFile(collection.uid), 'utf8').catch((error) => {
                if (isEnoent(error)) return undefined;
                throw error;
            });
            if (content !== undefined) {
                try {
                    const stored = JSON.parse(content);
                    secrets = Array.isArray(stored) ? stored.filter(isRecord) as unknown as StoredSecret[] : [];
                } catch {
                    // The values are lost, but the collection still opens and they can be entered again
                    console.warn(`Ignoring unreadable secrets file for collection ${collection.uid}`);
                }
            }
        }

        if (!secrets || secrets.length === 0) return;

        for (const environment of collection.environments) {
            restoreEnvironmentSecrets(environment, secrets as unknown as Record<string, unknown>[]);
        }
    }
}

function restoreEnvironmentSecrets(environment: BrunoEnvironment, secrets: Record<string, unknown>[]) {
    for (const variable of environment.variables) {
        if (variable.secret !== true || (variable.value !== undefined && variable.value !== '')) continue;

        const secret = secrets.find((candidate) =>
            candidate.environment === environment.name && candidate.variable === variable.name
        );
        if (secret) variable.value = secret.value;
    }
}
