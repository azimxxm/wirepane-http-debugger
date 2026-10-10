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

// A secret environment value, kept only on this machine
interface StoredSecret {
    environment: string;
    variable: string;
    value: unknown;
}

const isEnoent = (error: unknown) => isRecord(error) && error.code === 'ENOENT';

const notFound = (id: string) => new StatusError(404, `Collection ${id} not found`);

/**
 * Stores API collections under <configPath>/collections/<id>/ in Bruno's folder format.
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
        assertValidCollectionId(id);

        const collection = toCollection(input, id);
        await validateCollection(collection);
        normalizeEnvironmentNames(collection.environments);
        const warnings = limitExampleText(collection.items);

        return this.diskLock.runExclusive(async () => {
            await fs.promises.mkdir(this.collectionsDir, { recursive: true });
            await replaceFolder(this.collectionDir(id), collectionToFiles(collection));
            await this.storeSecrets(collection);

            const saved = await this.readCollection(id);
            return { ...saved, warnings: [...warnings, ...saved.warnings] };
        });
    }

    async delete(id: string): Promise<void> {
        assertValidCollectionId(id);

        await this.diskLock.runExclusive(async () => {
            const dir = this.collectionDir(id);
            const exists = await fs.promises.access(path.join(dir, 'bruno.json')).then(() => true, () => false);
            if (!exists) throw notFound(id);

            await fs.promises.rm(dir, { recursive: true, force: true });
            await fs.promises.rm(this.secretsFile(id), { force: true });
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

        const saved = await this.save(result.collection.uid, result.collection);
        return {
            format: result.format,
            collection: saved.collection,
            warnings: [...result.warnings, ...saved.warnings]
        };
    }

    async exportCollection(id: string, format: ExportFormat): Promise<ExportResult> {
        const { collection } = await this.get(id);
        return exportCollection(collection, format);
    }

    private collectionDir(id: string) {
        return path.join(this.collectionsDir, id);
    }

    private secretsFile(id: string) {
        return path.join(this.secretsDir, `${id}.json`);
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
            return;
        }

        await fs.promises.mkdir(this.secretsDir, { recursive: true, mode: 0o700 });
        await fs.promises.writeFile(file, JSON.stringify(secrets), { mode: 0o600 });
    }

    private async restoreSecrets(collection: BrunoCollection) {
        const content = await fs.promises.readFile(this.secretsFile(collection.uid), 'utf8').catch((error) => {
            if (isEnoent(error)) return undefined;
            throw error;
        });
        if (content === undefined) return;

        let stored: unknown;
        try {
            stored = JSON.parse(content);
        } catch {
            // The values are lost, but the collection still opens and they can be entered again
            console.warn(`Ignoring unreadable secrets file for collection ${collection.uid}`);
            return;
        }
        const secrets = Array.isArray(stored) ? stored.filter(isRecord) : [];

        for (const environment of collection.environments) {
            restoreEnvironmentSecrets(environment, secrets);
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
