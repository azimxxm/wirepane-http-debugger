import { toAccelerator } from '../../util/shortcuts';

import { CollectionsStore } from '../../model/collections/collections-store';
import { BrunoItem } from '../../model/collections/collection-types';
import { countRequests, isFolder, isSendableItem } from '../../model/collections/collection-tree';
import { IMPORT_FILE_TYPES } from '../../model/collections/collection-files';
import { ContextMenuItem } from '../../model/ui/context-menu';

/**
 * The actions behind the collections panel's buttons and right-click menus. Most of them
 * just open the dialog that asks for the details.
 */

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

export function promptNewCollection(store: CollectionsStore) {
    store.openDialog({
        kind: 'name',
        title: 'New collection',
        label: 'Name',
        initialValue: 'My API',
        submitLabel: 'Create',
        onSubmit: (name) => store.createCollection(name)
    });
}

export function promptNewFolder(store: CollectionsStore, collectionId: string, parentUid?: string) {
    store.openDialog({
        kind: 'name',
        title: 'New folder',
        label: 'Name',
        initialValue: 'New folder',
        submitLabel: 'Create',
        onSubmit: (name) => store.createFolder(collectionId, parentUid, name)
    });
}

export function promptNewRequest(store: CollectionsStore, collectionId: string, parentUid?: string) {
    store.openDialog({
        kind: 'name',
        title: 'New request',
        label: 'Name',
        initialValue: 'New request',
        submitLabel: 'Create',
        onSubmit: (name) => store.createRequest(collectionId, parentUid, name)
    });
}

export function promptRename(store: CollectionsStore, collectionId: string, item?: BrunoItem) {
    const currentName = item?.name ?? store.summaries.find((summary) => summary.id === collectionId)?.name ?? '';
    store.openDialog({
        kind: 'name',
        title: item ? (isFolder(item) ? 'Rename folder' : 'Rename request') : 'Rename collection',
        label: 'Name',
        initialValue: currentName,
        submitLabel: 'Rename',
        onSubmit: (name) => item
            ? store.renameItem(collectionId, item.uid, name)
            : store.renameCollection(collectionId, name)
    });
}

export function confirmDelete(store: CollectionsStore, collectionId: string, item?: BrunoItem) {
    if (!item) {
        const summary = store.summaries.find((candidate) => candidate.id === collectionId);
        store.openDialog({
            kind: 'confirm',
            title: `Delete “${summary?.name ?? 'this collection'}”?`,
            message: `Its ${plural(summary?.requestCount ?? 0, 'request')}, docs and ${plural(summary?.environmentCount ?? 0, 'environment')} ` +
                'are removed from this Mac. Files you already shared aren\'t affected.',
            confirmLabel: 'Delete collection',
            onConfirm: () => store.deleteCollection(collectionId)
        });
        return;
    }

    const contents = isFolder(item) ? ` and the ${plural(countRequests(item.items ?? []), 'request')} in it` : '';
    store.openDialog({
        kind: 'confirm',
        title: `Delete “${item.name}”?`,
        message: `This removes the ${isFolder(item) ? 'folder' : 'request'}${contents}, with ${isFolder(item) ? 'their' : 'its'} docs and examples.`,
        confirmLabel: 'Delete',
        onConfirm: () => store.deleteItem(collectionId, item.uid)
    });
}

export async function openEnvironments(store: CollectionsStore, collectionId: string, highlightVariables?: string[]) {
    if (!await store.ensureLoaded(collectionId)) return;
    store.openDialog({ kind: 'environments', collectionId, highlightVariables });
}

export async function openDocs(store: CollectionsStore, collectionId: string, folderUid?: string) {
    if (!await store.ensureLoaded(collectionId)) return;
    store.openDialog({ kind: 'docs', collectionId, folderUid });
}

export function openShare(store: CollectionsStore, collectionId: string) {
    store.openDialog({ kind: 'share', collectionId });
}

/**
 * Asks for files to import. Environment files go into the selected collection.
 */
export function pickFilesToImport(store: CollectionsStore) {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = IMPORT_FILE_TYPES.join(',');
    input.addEventListener('change', () => {
        const files = Array.from(input.files ?? []);
        if (files.length) store.importFiles(files, store.selectedCollectionId);
        input.remove();
    });
    input.click();
}

export function collectionMenu(store: CollectionsStore, collectionId: string): ContextMenuItem<void>[] {
    return [
        { type: 'option', label: 'New Request…', callback: () => promptNewRequest(store, collectionId) },
        { type: 'option', label: 'New Folder…', callback: () => promptNewFolder(store, collectionId) },
        { type: 'separator' },
        { type: 'option', label: 'Edit README…', callback: () => openDocs(store, collectionId) },
        { type: 'option', label: 'Environments…', callback: () => openEnvironments(store, collectionId) },
        { type: 'option', label: 'Share…', callback: () => openShare(store, collectionId) },
        { type: 'separator' },
        { type: 'option', label: 'Rename…', accelerator: 'F2', callback: () => promptRename(store, collectionId) },
        {
            type: 'option',
            label: 'Delete…',
            accelerator: toAccelerator('Cmd+Backspace'),
            callback: () => confirmDelete(store, collectionId)
        }
    ];
}

export function itemMenu(store: CollectionsStore, collectionId: string, item: BrunoItem): ContextMenuItem<void>[] {
    const editItems: ContextMenuItem<void>[] = [
        { type: 'option', label: 'Rename…', accelerator: 'F2', callback: () => promptRename(store, collectionId, item) },
        { type: 'option', label: 'Duplicate', callback: () => store.duplicateItem(collectionId, item.uid) },
        {
            type: 'option',
            label: 'Delete…',
            accelerator: toAccelerator('Cmd+Backspace'),
            callback: () => confirmDelete(store, collectionId, item)
        }
    ];

    if (isFolder(item)) {
        return [
            { type: 'option', label: 'New Request…', callback: () => promptNewRequest(store, collectionId, item.uid) },
            { type: 'option', label: 'New Folder…', callback: () => promptNewFolder(store, collectionId, item.uid) },
            { type: 'option', label: 'Edit Folder Docs…', callback: () => openDocs(store, collectionId, item.uid) },
            { type: 'separator' },
            ...editItems
        ];
    }

    const canOpen = isSendableItem(item);
    return [
        { type: 'option', label: 'Open', enabled: canOpen, callback: () => store.openItem(collectionId, item.uid) },
        {
            type: 'option',
            label: 'Open in New Tab',
            enabled: canOpen,
            callback: () => store.openItem(collectionId, item.uid, { newTab: true })
        },
        { type: 'separator' },
        ...editItems
    ];
}
