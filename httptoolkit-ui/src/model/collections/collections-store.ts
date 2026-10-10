import * as _ from 'lodash';
import { action, computed, observable, reaction, runInAction } from 'mobx';

import { HttpExchangeView } from '../../types';
import { lazyObservablePromise } from '../../util/observable';
import { persist, hydrate } from '../../util/mobx-persist/persist';
import * as CollectionsApi from '../../services/collections-api';

import { SendStore } from '../send/send-store';
import { RequestInput, SendRequest } from '../send/send-request-model';
import { buildRequestForSend, SendBuildError } from '../send/build-request';

import {
    BrunoCollection,
    BrunoEnvironment,
    BrunoItem,
    BrunoVariable,
    CollectionSummary,
    ExportFormat,
    ExportResult,
    ImportResult
} from './collection-types';
import {
    buildUidRemap,
    childrenOf,
    countRequests,
    emptyCollection,
    emptyFolder,
    emptyRequestItem,
    findItem,
    isFolder,
    isSendableItem,
    ItemLocation,
    newUid,
    uniqueName,
    walkItems
} from './collection-tree';
import {
    itemToRequestParts,
    partsToRequestInput,
    RequestParts,
    requestInputToParts,
    requestPartsToItem
} from './request-mapping';
import {
    buildVariableScope,
    effectiveAuth,
    findUnsetValues,
    inheritedHeaders,
    resolveVariables,
    SendContext,
    UnsendableRequestError,
    UnsetValues
} from './variables';
import { addCapturedRequests, capturedRequestFromExchange } from './traffic-items';
import { isSameSnapshot, snapshotOf, TabSnapshot } from './tab-snapshots';
import { isEnvironmentFile, readImportFile } from './collection-files';

export const DEFAULT_PANEL_WIDTH = 280;
export const MIN_PANEL_WIDTH = 200;
export const MAX_PANEL_WIDTH = 520;

// Tree rows: a collection, its README, or an item (folder or request) in it
export const collectionNodeId = (collectionId: string) => `collection:${collectionId}`;
export const readmeNodeId = (collectionId: string) => `readme:${collectionId}`;
export const itemNodeId = (collectionId: string, uid: string) => `item:${collectionId}:${uid}`;
const isNodeOf = (nodeId: string, collectionId: string) =>
    nodeId === collectionNodeId(collectionId) ||
    nodeId === readmeNodeId(collectionId) ||
    nodeId.startsWith(`item:${collectionId}:`);

const FORMAT_NAMES: { [format in ImportResult['format']]: string } = {
    'postman': 'Postman',
    'postman-environment': 'Postman environment',
    'insomnia': 'Insomnia',
    'openapi': 'OpenAPI',
    'wsdl': 'WSDL',
    'har': 'HAR',
    'bruno-zip': 'Bruno',
    'bruno-request': 'Bruno request',
    'bruno-environment': 'Bruno environment'
};

export interface TabLink {
    // The item the tab was opened from or saved to. Unset for unsaved tabs with draft docs.
    collectionId?: string;
    itemUid?: string;
    // Shown while the collection is still loading
    itemName?: string;
    // The tab's docs, saved together with its request
    docs: string;
    saved?: TabSnapshot;
}

export interface CollectionsNotice {
    tone: 'info' | 'warning' | 'error';
    title: string;
    details: string[];
}

export type CollectionsDialog =
    | { kind: 'name', title: string, label: string, initialValue: string, submitLabel: string,
        onSubmit: (name: string) => Promise<unknown> }
    | { kind: 'confirm', title: string, message: string, confirmLabel: string, onConfirm: () => Promise<unknown> }
    | { kind: 'save-request', sendRequestId: string }
    | { kind: 'save-traffic', exchanges: HttpExchangeView[] }
    | { kind: 'share', collectionId: string }
    | { kind: 'environments', collectionId: string, highlightVariables?: string[] }
    | { kind: 'docs', collectionId: string, folderUid?: string };

// Why a tab's last Send didn't go out, and what it was sent with
interface SendProblem {
    message: string;
    url: string;
    environmentName: string | undefined;
}

export interface SaveTarget {
    // An existing collection, or the name of a new one
    collectionId?: string;
    newCollectionName?: string;
    folderUid?: string;
}

interface CommitResult {
    collection: BrunoCollection;
    warnings: string[];
    // Maps the uids of the edited collection to the uids the server gave them
    remap: (uid: string) => string | undefined;
}

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error);

const toSummary = (collection: BrunoCollection, updatedAt: string): CollectionSummary => ({
    id: collection.uid,
    name: collection.name,
    requestCount: countRequests(collection.items),
    environmentCount: collection.environments.length,
    updatedAt
});

/**
 * API collections (see docs/collections-plan.md): the list from the server, the
 * collections opened so far, the active environment of each, and which Send tabs were
 * opened from which requests. Collections live on disk, behind the server's REST API:
 * every change is saved straight away, and the server's answer replaces the local copy.
 */
export class CollectionsStore {

    constructor(
        private sendStore: SendStore
    ) {
        // The one hook into Send: fill in {{variables}} just before a request goes out
        sendStore.prepareRequestInput = (sendRequest) => this.resolveSendRequest(sendRequest);
    }

    readonly initialized = lazyObservablePromise(async () => {
        await hydrate({ key: 'collections-store', store: this });

        // Collections come from the server, so they load in the background: the app
        // doesn't wait for them to start up.
        this.refreshList();
        this.sendStore.initialized.then(() => this.followSendTabs());

        console.log('Collections store initialized');
    });

    // --- UI state, kept across restarts -------------------------------------------------

    @persist @observable
    panelOpen = true;

    @persist @observable
    panelWidth = DEFAULT_PANEL_WIDTH;

    @persist @observable
    docsCardCollapsed = false;

    // The collection whose environment applies to tabs that aren't from a collection
    @persist @observable
    selectedCollectionId: string | undefined = undefined;

    @persist @observable
    selectedNodeId: string | undefined = undefined;

    @persist('list') @observable
    expandedNodeIds: string[] = [];

    // Collection id -> the name of its active environment
    @persist('object') @observable
    activeEnvironmentNames: { [collectionId: string]: string } = {};

    // Send tab id -> the collection request it shows
    @persist('object') @observable
    tabLinks: { [sendRequestId: string]: TabLink } = {};

    // --- Server state -------------------------------------------------------------------

    @observable
    summaries: CollectionSummary[] = [];

    @observable
    listState: 'loading' | 'ready' | 'failed' = 'loading';

    @observable
    listError: string | undefined = undefined;

    // Collections are replaced as a whole whenever they change, never mutated in place
    @observable.shallow
    collections = new Map<string, BrunoCollection>();

    @observable.shallow
    loadErrors = new Map<string, string>();

    @observable
    searchQuery = '';

    @observable.ref
    notice: CollectionsNotice | undefined = undefined;

    @observable.ref
    dialog: CollectionsDialog | undefined = undefined;

    @observable.ref
    private sendProblems: { [sendRequestId: string]: SendProblem } = {};

    private pendingLoads = new Map<string, Promise<BrunoCollection | undefined>>();
    // Saves replace whole collections, so each collection's saves run one at a time
    private commitQueues = new Map<string, Promise<unknown>>();

    // --- Loading ------------------------------------------------------------------------

    async refreshList(): Promise<void> {
        try {
            const summaries = await CollectionsApi.listCollections();
            runInAction(() => {
                this.summaries = summaries;
                this.listState = 'ready';
                this.listError = undefined;
                this.forgetMissingCollections(new Set(summaries.map((summary) => summary.id)));
            });

            await Promise.all(this.collectionIdsInUse().map((id) => this.ensureLoaded(id)));
        } catch (error) {
            runInAction(() => {
                this.listState = 'failed';
                this.listError = errorMessage(error);
            });
        }
    }

    // The collections that tabs, the tree or the environment selector need straight away
    private collectionIdsInUse(): string[] {
        const ids = new Set<string>();
        Object.values(this.tabLinks).forEach((link) => link.collectionId && ids.add(link.collectionId));
        if (this.selectedCollectionId) ids.add(this.selectedCollectionId);
        this.summaries
            .filter((summary) => this.expandedNodeIds.includes(collectionNodeId(summary.id)))
            .forEach((summary) => ids.add(summary.id));

        return [...ids].filter((id) => this.summaries.some((summary) => summary.id === id));
    }

    ensureLoaded(id: string): Promise<BrunoCollection | undefined> {
        const loaded = this.collections.get(id);
        if (loaded) return Promise.resolve(loaded);
        return this.loadCollection(id);
    }

    loadCollection(id: string): Promise<BrunoCollection | undefined> {
        const pending = this.pendingLoads.get(id);
        if (pending) return pending;

        const load = CollectionsApi.getCollection(id).then(action(({ collection, warnings }) => {
            this.collections.set(id, collection);
            this.loadErrors.delete(id);
            if (warnings.length) {
                this.showNotice('warning', `Some files of “${collection.name}” couldn't be read`, warnings);
            }
            return collection;
        }), action((error: unknown) => {
            this.loadErrors.set(id, errorMessage(error));
            return undefined;
        }));

        this.pendingLoads.set(id, load);
        load.then(() => this.pendingLoads.delete(id));
        return load;
    }

    // Search covers every collection, so the first search loads them all
    loadAll(): Promise<unknown> {
        return Promise.all(this.summaries.map((summary) => this.ensureLoaded(summary.id)));
    }

    // --- Saving -------------------------------------------------------------------------

    private commit(collectionId: string, change: (draft: BrunoCollection) => void): Promise<CommitResult> {
        const previous = this.commitQueues.get(collectionId) ?? Promise.resolve();
        const next = previous
            .catch(() => {}) // A failed save doesn't block the next one
            .then(() => this.runCommit(collectionId, change));

        this.commitQueues.set(collectionId, next);
        return next;
    }

    private async runCommit(collectionId: string, change: (draft: BrunoCollection) => void): Promise<CommitResult> {
        const current = await this.ensureLoaded(collectionId);
        if (!current) {
            throw new Error(this.loadErrors.get(collectionId) ?? 'The collection couldn\'t be loaded');
        }

        const draft = _.cloneDeep(current);
        change(draft);

        const { collection, warnings } = await CollectionsApi.saveCollection(collectionId, draft);
        const remap = buildUidRemap(draft, collection);
        runInAction(() => this.applySaved(collection, remap));

        if (warnings.length) this.showNotice('warning', `Saved “${collection.name}” with warnings`, warnings);
        return { collection, warnings, remap };
    }

    @action
    private applySaved(collection: BrunoCollection, remap?: (uid: string) => string | undefined) {
        const id = collection.uid;
        this.collections.set(id, collection);

        const summary = toSummary(collection, new Date().toISOString());
        const others = this.summaries.filter((existing) => existing.id !== id);
        this.summaries = _.sortBy([...others, summary], (entry) => entry.name.toLowerCase());

        if (!remap) return;

        // Uids derive from file paths on the server, so they move when items do
        const nodePrefix = `item:${id}:`;
        const remapNode = (nodeId: string) => {
            if (!nodeId.startsWith(nodePrefix)) return nodeId;
            const uid = remap(nodeId.slice(nodePrefix.length));
            return uid ? itemNodeId(id, uid) : undefined;
        };

        this.expandedNodeIds = this.expandedNodeIds
            .map(remapNode)
            .filter((nodeId): nodeId is string => nodeId !== undefined);
        if (this.selectedNodeId) this.selectedNodeId = remapNode(this.selectedNodeId) ?? collectionNodeId(id);

        this.tabLinks = _.mapValues(this.tabLinks, (link) => {
            if (link.collectionId !== id || !link.itemUid) return link;
            const itemUid = remap(link.itemUid);
            // The item is gone: the tab stays open as an unsaved request
            return itemUid ? { ...link, itemUid } : { docs: link.docs };
        });
    }

    @action
    private forgetMissingCollections(existingIds: Set<string>) {
        const isGone = (id: string | undefined) => !!id && !existingIds.has(id);

        this.tabLinks = _.mapValues(this.tabLinks, (link) => isGone(link.collectionId) ? { docs: link.docs } : link);
        this.activeEnvironmentNames = _.pickBy(this.activeEnvironmentNames, (_name, id) => !isGone(id));
        if (isGone(this.selectedCollectionId)) this.selectedCollectionId = undefined;
        for (const id of [...this.collections.keys()]) {
            if (isGone(id)) this.collections.delete(id);
        }
    }

    // --- Collections --------------------------------------------------------------------

    async createCollection(name: string): Promise<string> {
        const id = newUid();
        const { collection, warnings } = await CollectionsApi.saveCollection(id, emptyCollection(id, name.trim()));

        runInAction(() => {
            this.applySaved(collection);
            this.selectedCollectionId = id;
            this.selectedNodeId = collectionNodeId(id);
            this.setExpanded(collectionNodeId(id), true);
        });
        if (warnings.length) this.showNotice('warning', `Created “${collection.name}” with warnings`, warnings);
        return id;
    }

    renameCollection(id: string, name: string) {
        return this.commit(id, (draft) => { draft.name = name.trim(); });
    }

    async deleteCollection(id: string): Promise<void> {
        await CollectionsApi.deleteCollection(id);
        runInAction(() => {
            this.summaries = this.summaries.filter((summary) => summary.id !== id);
            this.forgetMissingCollections(new Set(this.summaries.map((summary) => summary.id)));
            this.expandedNodeIds = this.expandedNodeIds.filter((nodeId) => !isNodeOf(nodeId, id));
            if (this.selectedNodeId && isNodeOf(this.selectedNodeId, id)) this.selectedNodeId = undefined;
        });
    }

    // --- Items --------------------------------------------------------------------------

    async createFolder(collectionId: string, parentUid: string | undefined, name: string): Promise<void> {
        const uid = newUid();
        const { remap } = await this.commit(collectionId, (draft) => {
            const siblings = this.requireChildren(draft, parentUid);
            const folderNames = siblings.filter(isFolder).map((sibling) => sibling.name);
            siblings.push(emptyFolder(uid, uniqueName(name, folderNames)));
        });

        runInAction(() => {
            this.revealInTree(collectionId, parentUid ? remap(parentUid) : undefined);
            const savedUid = remap(uid);
            if (savedUid) this.selectedNodeId = itemNodeId(collectionId, savedUid);
        });
    }

    async createRequest(collectionId: string, parentUid: string | undefined, name: string): Promise<void> {
        const uid = newUid();
        const { remap } = await this.commit(collectionId, (draft) => {
            const siblings = this.requireChildren(draft, parentUid);
            const requestNames = siblings.filter((sibling) => !isFolder(sibling)).map((sibling) => sibling.name);
            siblings.push(emptyRequestItem(uid, uniqueName(name, requestNames)));
        });

        const savedUid = remap(uid);
        if (savedUid) await this.openItem(collectionId, savedUid);
    }

    renameItem(collectionId: string, uid: string, name: string) {
        return this.commit(collectionId, (draft) => {
            const location = this.requireItem(draft, uid);
            const takenNames = location.siblings
                .filter((sibling) => sibling !== location.item && isFolder(sibling) === isFolder(location.item))
                .map((sibling) => sibling.name);
            location.item.name = uniqueName(name, takenNames);
        });
    }

    async duplicateItem(collectionId: string, uid: string): Promise<void> {
        const copyUid = newUid();
        const { remap } = await this.commit(collectionId, (draft) => {
            const { item, siblings } = this.requireItem(draft, uid);
            const takenNames = siblings.filter((sibling) => isFolder(sibling) === isFolder(item)).map((sibling) => sibling.name);
            const copy: BrunoItem = { ..._.cloneDeep(item), uid: copyUid, name: uniqueName(`${item.name} copy`, takenNames) };
            // Nested items keep their place but need their own uids
            walkItems(copy.items ?? [], (child) => { child.uid = newUid(); });
            siblings.splice(siblings.indexOf(item) + 1, 0, copy);
        });

        const savedUid = remap(copyUid);
        if (savedUid) runInAction(() => { this.selectedNodeId = itemNodeId(collectionId, savedUid); });
    }

    deleteItem(collectionId: string, uid: string) {
        return this.commit(collectionId, (draft) => {
            const { item, siblings } = this.requireItem(draft, uid);
            siblings.splice(siblings.indexOf(item), 1);
        });
    }

    private requireItem(collection: BrunoCollection, uid: string): ItemLocation {
        const location = findItem(collection, uid);
        if (!location) throw new Error('That item no longer exists. It may have been changed elsewhere.');
        return location;
    }

    private requireChildren(collection: BrunoCollection, folderUid: string | undefined): BrunoItem[] {
        const children = childrenOf(collection, folderUid);
        if (!children) throw new Error('That folder no longer exists. It may have been changed elsewhere.');
        return children;
    }

    // --- Docs ---------------------------------------------------------------------------

    saveDocs(collectionId: string, folderUid: string | undefined, docs: string) {
        return this.commit(collectionId, (draft) => {
            if (folderUid) {
                const { item } = this.requireItem(draft, folderUid);
                item.root = { ...item.root, docs };
            } else {
                draft.root = { ...draft.root, docs };
            }
        });
    }

    // --- Environments & variables -------------------------------------------------------

    activeEnvironment(collection: BrunoCollection): BrunoEnvironment | undefined {
        const name = this.activeEnvironmentNames[collection.uid];
        if (name === undefined) return undefined;
        return collection.environments.find((environment) => environment.name === name) ??
            collection.environments.find((environment) => environment.name.toLowerCase() === name.toLowerCase());
    }

    @action.bound
    setActiveEnvironment(collectionId: string, name: string | undefined) {
        this.activeEnvironmentNames = name === undefined
            ? _.omit(this.activeEnvironmentNames, collectionId)
            : { ...this.activeEnvironmentNames, [collectionId]: name };
    }

    /**
     * Replaces a collection's environments and its collection-level variables. The
     * active environment follows a rename when its new name is given.
     */
    async saveVariables(
        collectionId: string,
        environments: BrunoEnvironment[],
        collectionVariables: BrunoVariable[],
        activeEnvironmentName: string | undefined
    ): Promise<void> {
        await this.commit(collectionId, (draft) => {
            draft.environments = environments;
            const rootRequest = draft.root?.request;
            draft.root = {
                ...draft.root,
                request: { ...rootRequest, vars: { ...rootRequest?.vars, req: collectionVariables } }
            };
        });

        this.setActiveEnvironment(collectionId, activeEnvironmentName);
    }

    // --- Send tabs ----------------------------------------------------------------------

    private followSendTabs() {
        // Closed tabs drop their links
        reaction(
            () => this.sendStore.sendRequests.map((sendRequest) => sendRequest.id),
            (ids) => this.forgetClosedTabs(ids),
            { fireImmediately: true }
        );

        // The visible tab's collection is needed for its name, variables & auth
        reaction(
            () => this.activeCollectionId(this.sendStore.selectedRequest?.id),
            (collectionId) => { if (collectionId) this.ensureLoaded(collectionId); },
            { fireImmediately: true }
        );
    }

    @action
    private forgetClosedTabs(openIds: string[]) {
        const open = new Set(openIds);
        if (Object.keys(this.tabLinks).every((id) => open.has(id))) return;
        this.tabLinks = _.pickBy(this.tabLinks, (_link, id) => open.has(id));
    }

    linkFor(sendRequestId: string | undefined): TabLink | undefined {
        return sendRequestId ? this.tabLinks[sendRequestId] : undefined;
    }

    // The collection item a tab shows, if it's from a collection that has loaded
    linkedItem(sendRequestId: string | undefined): { collection: BrunoCollection, location: ItemLocation } | undefined {
        const link = this.linkFor(sendRequestId);
        if (!link?.collectionId || !link.itemUid) return undefined;

        const collection = this.collections.get(link.collectionId);
        const location = collection && findItem(collection, link.itemUid);
        return collection && location ? { collection, location } : undefined;
    }

    // The collection whose environment applies to a tab: its own, or the one selected in the tree
    activeCollectionId(sendRequestId: string | undefined): string | undefined {
        const linkedId = this.linkFor(sendRequestId)?.collectionId;
        const id = linkedId ?? this.selectedCollectionId;
        return id && this.summaries.some((summary) => summary.id === id) ? id : undefined;
    }

    @computed
    get activeCollection(): BrunoCollection | undefined {
        const id = this.activeCollectionId(this.sendStore.selectedRequest?.id);
        return id ? this.collections.get(id) : undefined;
    }

    tabTitle(sendRequest: SendRequest): string | undefined {
        const link = this.linkFor(sendRequest.id);
        if (!link?.itemUid) return undefined;
        return this.linkedItem(sendRequest.id)?.location.item.name ?? link.itemName;
    }

    isTabDirty(sendRequest: SendRequest): boolean {
        const link = this.linkFor(sendRequest.id);
        if (!link?.itemUid || !link.saved) return false;
        return !isSameSnapshot(snapshotOf(requestInputToParts(sendRequest.request), link.docs), link.saved);
    }

    // A tab nobody has typed into yet, which can be reused instead of adding another
    private isBlankTab(sendRequest: SendRequest): boolean {
        const { request } = sendRequest;
        return !this.linkFor(sendRequest.id) &&
            !sendRequest.sentExchange &&
            !sendRequest.pendingSend &&
            request.url === '' &&
            request.headers.length === 0 &&
            request.rawBody.decoded.length === 0;
    }

    async openItem(collectionId: string, uid: string, options: { newTab?: boolean } = {}): Promise<void> {
        const collection = await this.ensureLoaded(collectionId);
        const location = collection && findItem(collection, uid);
        if (!location) return;

        if (!isSendableItem(location.item)) {
            this.showNotice('info', `“${location.item.name}” can't be opened in Send`, [
                'Send works with HTTP and GraphQL requests. gRPC and WebSocket requests stay saved in the collection.'
            ]);
            return;
        }

        const openTab = this.sendStore.sendRequests.find((sendRequest) => {
            const link = this.tabLinks[sendRequest.id];
            return link?.collectionId === collectionId && link.itemUid === uid;
        });
        if (openTab && !options.newTab) {
            runInAction(() => {
                this.sendStore.selectRequest(openTab);
                this.selectedNodeId = itemNodeId(collectionId, uid);
            });
            return;
        }

        const { parts, warnings } = itemToRequestParts(location.item);
        const docs = location.item.request?.docs ?? '';
        const requestInput = partsToRequestInput(parts);

        runInAction(() => {
            const sendRequest = this.showInTab(requestInput, !!options.newTab);
            this.tabLinks = {
                ...this.tabLinks,
                [sendRequest.id]: { collectionId, itemUid: uid, itemName: location.item.name, docs, saved: snapshotOf(parts, docs) }
            };
            this.selectedCollectionId = collectionId;
            this.selectedNodeId = itemNodeId(collectionId, uid);
        });

        if (warnings.length) this.showNotice('info', `Opened “${location.item.name}”`, warnings);
    }

    @action
    private showInTab(requestInput: RequestInput, forceNewTab: boolean): SendRequest {
        const current = this.sendStore.selectedRequest;
        if (current && !forceNewTab && this.isBlankTab(current)) {
            current.request = requestInput;
            return current;
        }

        this.sendStore.addRequestInput(requestInput);
        return this.sendStore.selectedRequest;
    }

    @action.bound
    setTabDocs(sendRequestId: string, docs: string) {
        const link = this.tabLinks[sendRequestId] ?? { docs: '' };
        this.tabLinks = { ...this.tabLinks, [sendRequestId]: { ...link, docs } };
    }

    /**
     * Saves a tab back to the request it came from. Tabs that aren't from a collection
     * (or whose request is gone) ask where to save instead.
     */
    async saveTab(sendRequest: SendRequest): Promise<void> {
        const link = this.linkFor(sendRequest.id);
        if (link?.collectionId && link.itemUid) await this.ensureLoaded(link.collectionId);

        const linked = this.linkedItem(sendRequest.id);
        if (!linked) {
            this.openDialog({ kind: 'save-request', sendRequestId: sendRequest.id });
            return;
        }

        const parts = requestInputToParts(sendRequest.request);
        const docs = link!.docs;
        const uid = linked.location.item.uid;
        let warnings: string[] = [];

        await this.commit(linked.collection.uid, (draft) => {
            const location = this.requireItem(draft, uid);
            const result = requestPartsToItem(parts, docs, location.item, { name: location.item.name });
            location.siblings[location.siblings.indexOf(location.item)] = result.item;
            warnings = result.warnings;
        });

        runInAction(() => {
            const savedLink = this.tabLinks[sendRequest.id];
            if (savedLink?.itemUid) {
                this.tabLinks = { ...this.tabLinks, [sendRequest.id]: { ...savedLink, saved: snapshotOf(parts, docs) } };
            }
        });
        if (warnings.length) this.showNotice('warning', `Saved “${linked.location.item.name}”`, warnings);
    }

    // Saves a tab as a new request in a collection (a new one, if asked), and links them
    async saveTabAs(sendRequest: SendRequest, target: SaveTarget, name: string): Promise<void> {
        const collectionId = target.collectionId ?? await this.createCollection(target.newCollectionName ?? 'New collection');
        const parts = requestInputToParts(sendRequest.request);
        const docs = this.linkFor(sendRequest.id)?.docs ?? '';
        const uid = newUid();
        let savedName = name;
        let warnings: string[] = [];

        const { remap } = await this.commit(collectionId, (draft) => {
            const siblings = this.requireChildren(draft, target.folderUid);
            savedName = uniqueName(name, siblings.filter((sibling) => !isFolder(sibling)).map((sibling) => sibling.name));
            const result = requestPartsToItem(parts, docs, undefined, { name: savedName, uid, authMode: 'inherit' });
            siblings.push(result.item);
            warnings = result.warnings;
        });

        const savedUid = remap(uid);
        runInAction(() => {
            if (savedUid) {
                this.tabLinks = {
                    ...this.tabLinks,
                    [sendRequest.id]: { collectionId, itemUid: savedUid, itemName: savedName, docs, saved: snapshotOf(parts, docs) }
                };
                this.selectedNodeId = itemNodeId(collectionId, savedUid);
            }
            this.selectedCollectionId = collectionId;
            this.revealInTree(collectionId, target.folderUid ? remap(target.folderUid) : undefined);
        });
        if (warnings.length) this.showNotice('warning', `Saved “${savedName}”`, warnings);
    }

    // --- Variables when sending ---------------------------------------------------------

    sendContextFor(sendRequestId: string | undefined): SendContext | undefined {
        const collectionId = this.activeCollectionId(sendRequestId);
        const collection = collectionId ? this.collections.get(collectionId) : undefined;
        if (!collection) return undefined;

        const linked = this.linkedItem(sendRequestId);
        const location = linked?.collection === collection ? linked.location : undefined;
        const environment = this.activeEnvironment(collection);

        return {
            scope: buildVariableScope({ collection, environment, location }),
            environmentName: environment?.name,
            // Collection headers & auth only go to the collection's own requests
            ...(location ? {
                inheritedHeaders: inheritedHeaders(collection, location),
                auth: effectiveAuth(collection, location)
            } : {})
        };
    }

    unsetValuesFor(sendRequest: SendRequest): UnsetValues {
        return findUnsetValues(requestInputToParts(sendRequest.request), this.sendContextFor(sendRequest.id));
    }

    // Called on every Send (button or ⌘↵). A request that can't be sent isn't: the reason is
    // shown under the URL until the next attempt, or until the URL or environment changes.
    private async resolveSendRequest(sendRequest: SendRequest): Promise<RequestInput | undefined> {
        const context = this.sendContextFor(sendRequest.id);
        try {
            const resolved = await buildRequestForSend(resolveVariables(sendRequest.request, context));
            this.setSendProblem(sendRequest.id, undefined);
            return resolved;
        } catch (error) {
            if (!(error instanceof UnsendableRequestError) && !(error instanceof SendBuildError)) throw error;
            this.setSendProblem(sendRequest.id, {
                message: error.message,
                url: sendRequest.request.url,
                environmentName: context?.environmentName
            });
            return undefined;
        }
    }

    @action
    private setSendProblem(sendRequestId: string, problem: SendProblem | undefined) {
        this.sendProblems = problem
            ? { ...this.sendProblems, [sendRequestId]: problem }
            : _.omit(this.sendProblems, sendRequestId);
    }

    sendProblemFor(sendRequest: SendRequest): string | undefined {
        const problem = this.sendProblems[sendRequest.id];
        if (!problem || problem.url !== sendRequest.request.url) return undefined;
        if (problem.environmentName !== this.sendContextFor(sendRequest.id)?.environmentName) return undefined;
        return problem.message;
    }

    // --- Captured traffic ---------------------------------------------------------------

    // Asks where to save captured exchanges. WebSockets and other non-HTTP events are left out.
    @action.bound
    startSavingExchanges(exchanges: readonly HttpExchangeView[]) {
        const httpExchanges = exchanges.filter((exchange) => exchange.isHttp() && !exchange.isWebSocket());
        if (httpExchanges.length) this.openDialog({ kind: 'save-traffic', exchanges: httpExchanges });
    }

    /**
     * Saves captured exchanges as requests (one folder per host), with each captured
     * response kept as an example. Returns where they went, and any warnings.
     */
    async saveExchanges(
        exchanges: readonly HttpExchangeView[],
        target: SaveTarget
    ): Promise<{ collectionId: string, warnings: string[] }> {
        const captured = await Promise.all(exchanges.map((exchange) => capturedRequestFromExchange(exchange)));
        const collectionId = target.collectionId ?? await this.createCollection(target.newCollectionName ?? 'Captured traffic');

        const { warnings } = await this.commit(collectionId, (draft) => addCapturedRequests(draft, captured));

        runInAction(() => {
            this.selectedCollectionId = collectionId;
            this.setExpanded(collectionNodeId(collectionId), true);
            const collection = this.collections.get(collectionId);
            const hosts = new Set(captured.map((request) => request.host.toLowerCase()));
            collection?.items
                .filter((item) => isFolder(item) && hosts.has(item.name.toLowerCase()))
                .forEach((folder) => this.setExpanded(itemNodeId(collectionId, folder.uid), true));
        });

        return { collectionId, warnings: [..._.flatMap(captured, (request) => request.warnings), ...warnings] };
    }

    // --- Import & export ----------------------------------------------------------------

    /**
     * Imports files as new collections. Environment files are added to `intoCollectionId`
     * instead, which is required for them.
     */
    async importFiles(files: readonly File[], intoCollectionId?: string): Promise<void> {
        for (const file of files) {
            await this.importFile(file, intoCollectionId);
        }
    }

    private async importFile(file: File, intoCollectionId: string | undefined): Promise<void> {
        try {
            const input = await readImportFile(file);
            const isEnvironment = isEnvironmentFile(input);
            if (isEnvironment && !intoCollectionId) {
                throw new Error('This is an environment file. Select the collection it belongs to, then import it again.');
            }

            const target = isEnvironment ? await this.ensureLoaded(intoCollectionId!) : undefined;
            const previousEnvironments = target?.environments.map((environment) => environment.name) ?? [];
            const result = await CollectionsApi.importCollectionFile({
                ...input,
                ...(isEnvironment ? { collectionId: intoCollectionId } : {})
            });

            runInAction(() => this.showImported(result, previousEnvironments));
        } catch (error) {
            this.showNotice('error', `Couldn't import ${file.name}`, [errorMessage(error)]);
        }
    }

    @action
    private showImported({ format, collection, warnings }: ImportResult, previousEnvironments: string[]) {
        this.applySaved(collection);
        const id = collection.uid;

        this.selectedCollectionId = id;
        this.selectedNodeId = collectionNodeId(id);
        this.setExpanded(collectionNodeId(id), true);
        this.searchQuery = '';

        const isEnvironment = format === 'postman-environment' || format === 'bruno-environment';
        if (isEnvironment) {
            const added = collection.environments.find((environment) => !previousEnvironments.includes(environment.name));
            if (added && !this.activeEnvironment(collection)) this.setActiveEnvironment(id, added.name);
            this.showNotice(warnings.length ? 'warning' : 'info',
                `Added the environment “${added?.name ?? 'environment'}” to “${collection.name}”`,
                warnings
            );
        } else {
            // A new collection's first environment is ready to use straight away
            if (collection.environments.length && !this.activeEnvironment(collection)) {
                this.setActiveEnvironment(id, collection.environments[0].name);
            }
            const requestCount = countRequests(collection.items);
            this.showNotice(warnings.length ? 'warning' : 'info',
                `Imported “${collection.name}” from ${FORMAT_NAMES[format]}: ${requestCount} request${requestCount === 1 ? '' : 's'}`,
                warnings
            );
        }
    }

    exportCollection(id: string, format: ExportFormat): Promise<ExportResult> {
        return CollectionsApi.exportCollection(id, format);
    }

    // --- Tree & panel UI ----------------------------------------------------------------

    @action.bound
    togglePanel() {
        this.panelOpen = !this.panelOpen;
    }

    @action.bound
    setPanelWidth(width: number) {
        this.panelWidth = _.clamp(Math.round(width), MIN_PANEL_WIDTH, MAX_PANEL_WIDTH);
    }

    @action.bound
    toggleDocsCard() {
        this.docsCardCollapsed = !this.docsCardCollapsed;
    }

    isExpanded(nodeId: string) {
        return this.expandedNodeIds.includes(nodeId);
    }

    @action.bound
    setExpanded(nodeId: string, expanded: boolean) {
        const isExpanded = this.expandedNodeIds.includes(nodeId);
        if (expanded && !isExpanded) this.expandedNodeIds = [...this.expandedNodeIds, nodeId];
        if (!expanded && isExpanded) this.expandedNodeIds = this.expandedNodeIds.filter((id) => id !== nodeId);

        const collectionId = nodeId.startsWith('collection:') ? nodeId.slice('collection:'.length) : undefined;
        if (expanded && collectionId) this.ensureLoaded(collectionId);
    }

    @action.bound
    selectNode(nodeId: string | undefined, collectionId?: string) {
        this.selectedNodeId = nodeId;
        if (collectionId) this.selectedCollectionId = collectionId;
    }

    // Expands a collection and one of its folders (with its parents), e.g. after saving into it
    @action
    private revealInTree(collectionId: string, folderUid: string | undefined) {
        this.setExpanded(collectionNodeId(collectionId), true);

        const collection = this.collections.get(collectionId);
        const location = collection && folderUid ? findItem(collection, folderUid) : undefined;
        if (!location) return;

        [...location.parents, location.item].forEach((folder) =>
            this.setExpanded(itemNodeId(collectionId, folder.uid), true)
        );
    }

    // Shows a tab's request in the tree: opens the panel and its folders, and selects it
    @action.bound
    revealTab(sendRequestId: string) {
        const linked = this.linkedItem(sendRequestId);
        if (!linked) return;

        const collectionId = linked.collection.uid;
        this.setExpanded(collectionNodeId(collectionId), true);
        linked.location.parents.forEach((folder) => this.setExpanded(itemNodeId(collectionId, folder.uid), true));
        this.selectNode(itemNodeId(collectionId, linked.location.item.uid), collectionId);
        this.panelOpen = true;
    }

    @action.bound
    setSearchQuery(query: string) {
        if (query.trim() && !this.searchQuery.trim()) this.loadAll();
        this.searchQuery = query;
    }

    @action.bound
    showNotice(tone: CollectionsNotice['tone'], title: string, details: string[] = []) {
        this.notice = { tone, title, details };
    }

    @action.bound
    dismissNotice() {
        this.notice = undefined;
    }

    @action.bound
    openDialog(dialog: CollectionsDialog) {
        this.dialog = dialog;
    }

    @action.bound
    closeDialog() {
        this.dialog = undefined;
    }
}
