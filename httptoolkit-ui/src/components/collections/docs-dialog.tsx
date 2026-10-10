import * as React from 'react';
import { observer } from 'mobx-react-lite';

import { styled } from '../../styles';

import { CollectionsStore } from '../../model/collections/collections-store';
import { findItem } from '../../model/collections/collection-tree';

import { ActionButton } from '../common/action-button';
import { CollectionDialog, ErrorText, useDialogAction } from './dialog-frame';
import { MarkdownTextArea, MarkdownView, SegmentedControl } from './markdown-docs';

const DocsToolbar = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    color: ${p => p.theme.mainLowlightColor};
    font-size: ${p => p.theme.smallPrintSize};
`;

const DocsArea = styled.div`
    min-height: 320px;
    max-height: 56vh;
    overflow-y: auto;
    padding: 14px 16px;
    border-radius: 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};
`;

const EmptyDocs = styled.p`
    color: ${p => p.theme.mainLowlightColor};
    font-style: italic;
`;

const DocsEditor = styled(MarkdownTextArea)`
    min-height: 320px;
    height: 56vh;
`;

const COLLECTION_PLACEHOLDER = `# What this API is for

Who uses it, and how to start: which environment variables to set (e.g. \`baseUrl\`, \`authToken\`), where to get a token, and anything else a new teammate needs.`;

/**
 * Views and edits the docs of a whole collection (its README, which travels with every
 * share) or of one folder.
 */
export const DocsDialog = observer((props: {
    collectionsStore: CollectionsStore,
    collectionId: string,
    folderUid?: string,
    onClose: () => void
}) => {
    const { collectionsStore, collectionId, folderUid } = props;
    const collection = collectionsStore.collections.get(collectionId);
    const folder = collection && folderUid ? findItem(collection, folderUid)?.item : undefined;
    const savedDocs = (folderUid ? folder?.root?.docs : collection?.root?.docs) ?? '';

    const [mode, setMode] = React.useState<'view' | 'edit'>(savedDocs.trim() ? 'view' : 'edit');
    const [docs, setDocs] = React.useState(savedDocs);
    const isChanged = docs !== savedDocs;

    const { start: save, isRunning, error } = useDialogAction(async () => {
        await collectionsStore.saveDocs(collectionId, folderUid, docs);
        props.onClose();
    });

    if (!collection) return null;

    const title = folderUid
        ? `Docs for ${folder?.name ?? 'folder'}`
        : `README for ${collection.name}`;

    return <CollectionDialog
        title={title}
        subtitle={folderUid
            ? 'Notes about the requests in this folder. They\'re shared along with the collection.'
            : 'The first thing people see when they import this collection. It\'s shared in every export.'}
        width={760}
        onClose={props.onClose}
        footer={<>
            <span className='footer-note'>Markdown: # headings, **bold**, `code`, lists and links.</span>
            <ActionButton onClick={props.onClose}>{ isChanged ? 'Discard' : 'Close' }</ActionButton>
            <ActionButton variant='primary' disabled={!isChanged || isRunning} onClick={save}>
                Save
            </ActionButton>
        </>}
    >
        <DocsToolbar>
            <span>{ mode === 'edit' ? 'Editing Markdown' : 'Preview' }</span>
            <SegmentedControl
                aria-label='Docs mode'
                value={mode}
                onChange={setMode}
                options={[
                    { value: 'view', label: 'Preview' },
                    { value: 'edit', label: 'Edit' }
                ]}
            />
        </DocsToolbar>

        { mode === 'edit'
            ? <DocsEditor
                autoFocus
                value={docs}
                placeholder={folderUid ? 'What these requests do, and in what order to call them.' : COLLECTION_PLACEHOLDER}
                onChange={(event) => setDocs(event.target.value)}
                spellCheck={true}
            />
            : <DocsArea>
                { docs.trim()
                    ? <MarkdownView docs={docs} />
                    : <EmptyDocs>No docs yet. Switch to Edit to write some.</EmptyDocs>
                }
            </DocsArea>
        }

        { error && <ErrorText role='alert'>{ error }</ErrorText> }
    </CollectionDialog>;
});
