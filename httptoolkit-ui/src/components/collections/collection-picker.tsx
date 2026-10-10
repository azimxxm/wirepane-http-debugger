import * as React from 'react';
import { observer } from 'mobx-react-lite';

import { CollectionsStore, SaveTarget } from '../../model/collections/collections-store';
import { listFolders } from '../../model/collections/collection-tree';

import { DialogSelect, DialogTextInput, FieldRow } from './dialog-frame';

const NEW_COLLECTION = '__new__';
const TOP_LEVEL = '__top__';

export interface PickedTarget {
    target: SaveTarget;
    isValid: boolean;
}

/**
 * Picks where something gets saved: an existing collection (and optionally one of its
 * folders), or a new collection by name.
 */
export function usePickedTarget(collectionsStore: CollectionsStore, defaultNewName: string) {
    const initialId = collectionsStore.selectedCollectionId &&
        collectionsStore.summaries.some((summary) => summary.id === collectionsStore.selectedCollectionId)
        ? collectionsStore.selectedCollectionId
        : collectionsStore.summaries[0]?.id;

    const [collectionChoice, setCollectionChoice] = React.useState(initialId ?? NEW_COLLECTION);
    const [newName, setNewName] = React.useState(defaultNewName);
    const [folderChoice, setFolderChoice] = React.useState(TOP_LEVEL);

    React.useEffect(() => {
        setFolderChoice(TOP_LEVEL);
        if (collectionChoice !== NEW_COLLECTION) collectionsStore.ensureLoaded(collectionChoice);
    }, [collectionChoice]);

    const isNew = collectionChoice === NEW_COLLECTION;
    const target: SaveTarget = isNew
        ? { newCollectionName: newName.trim() }
        : { collectionId: collectionChoice, folderUid: folderChoice === TOP_LEVEL ? undefined : folderChoice };

    return {
        state: { collectionChoice, setCollectionChoice, newName, setNewName, folderChoice, setFolderChoice },
        picked: { target, isValid: !isNew || !!newName.trim() } as PickedTarget
    };
}

type PickerState = ReturnType<typeof usePickedTarget>['state'];

export const CollectionPickerFields = observer((props: {
    collectionsStore: CollectionsStore,
    state: PickerState,
    showFolders: boolean
}) => {
    const { collectionsStore, state } = props;
    const isNew = state.collectionChoice === NEW_COLLECTION;
    const collection = isNew ? undefined : collectionsStore.collections.get(state.collectionChoice);
    const folders = collection ? listFolders(collection) : [];

    return <>
        <FieldRow>
            <span>Collection</span>
            <DialogSelect
                value={state.collectionChoice}
                onChange={(event) => state.setCollectionChoice(event.target.value)}
            >
                { collectionsStore.summaries.map((summary) =>
                    <option key={summary.id} value={summary.id}>{ summary.name }</option>
                ) }
                <option value={NEW_COLLECTION}>New collection…</option>
            </DialogSelect>
        </FieldRow>

        { isNew && <FieldRow>
            <span>Name</span>
            <DialogTextInput
                value={state.newName}
                placeholder='e.g. Payments API'
                onChange={(event) => state.setNewName(event.target.value)}
                spellCheck={false}
            />
        </FieldRow> }

        { props.showFolders && !isNew && <FieldRow>
            <span>Folder</span>
            <DialogSelect
                value={state.folderChoice}
                disabled={!collection}
                onChange={(event) => state.setFolderChoice(event.target.value)}
            >
                <option value={TOP_LEVEL}>Top level of the collection</option>
                { folders.map((folder) =>
                    <option key={folder.uid} value={folder.uid}>{ folder.label }</option>
                ) }
            </DialogSelect>
        </FieldRow> }
    </>;
});
