import * as React from 'react';
import * as polished from 'polished';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { FileArrowDown, GlobeSimple, Sliders, Warning } from '@phosphor-icons/react';

import { styled } from '../../styles';
import { useHotkeys } from '../../util/ui';

import { SendStore } from '../../model/send/send-store';
import { SendRequest } from '../../model/send/send-request-model';
import { CollectionsStore } from '../../model/collections/collections-store';
import { UnsetValues } from '../../model/collections/variables';

import { ActionButton } from '../common/action-button';
import { UnstyledButton } from '../common/inputs';
import { CollectionsPanel } from './collections-panel';
import { openEnvironments } from './collection-actions';

// --- Layout & drop target ----------------------------------------------------------------

const WorkspaceRoot = styled.div`
    position: relative;
    flex: 1 1 auto;
    min-height: 0;

    display: flex;
    flex-direction: row;
`;

const WorkspaceMain = styled.div`
    flex: 1 1 auto;
    min-width: 0;

    display: flex;
    flex-direction: column;
`;

const DropOverlay = styled.div`
    position: absolute;
    inset: 8px;
    z-index: 50;
    pointer-events: none;
    border-radius: 12px;
    border: 2px dashed ${p => p.theme.popColor};
    background-color: ${p => polished.rgba(p.theme.mainBackground, 0.9)};

    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;

    color: ${p => p.theme.mainColor};
    font-size: ${p => p.theme.textSize};
    font-weight: 600;

    > svg {
        color: ${p => p.theme.popColor};
    }

    > span {
        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 400;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const hasFiles = (event: React.DragEvent) => Array.from(event.dataTransfer.types).includes('Files');

/**
 * Send's tabs and request/response panes, with the Collections panel on their left.
 * Dropping files anywhere here imports them.
 */
export const CollectionsWorkspace = inject('collectionsStore')(observer((props: {
    collectionsStore?: CollectionsStore,
    children: React.ReactNode
}) => {
    const collectionsStore = props.collectionsStore!;
    const [isDragging, setDragging] = React.useState(false);
    // dragenter/dragleave fire for every child element, so nesting is counted
    const dragDepth = React.useRef(0);

    const selectedCollection = collectionsStore.summaries.find((summary) => summary.id === collectionsStore.selectedCollectionId);

    const onDragEnter = (event: React.DragEvent) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
    };

    const onDragOver = (event: React.DragEvent) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
    };

    const onDragLeave = (event: React.DragEvent) => {
        if (!hasFiles(event)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
    };

    const onDrop = (event: React.DragEvent) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDragging(false);

        const files = Array.from(event.dataTransfer.files);
        if (files.length) collectionsStore.importFiles(files, collectionsStore.selectedCollectionId);
    };

    return <WorkspaceRoot onDragEnter={onDragEnter} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <CollectionsPanel />
        <WorkspaceMain>{ props.children }</WorkspaceMain>
        { isDragging && <DropOverlay aria-hidden={true}>
            <FileArrowDown size={36} />
            Drop to import
            <span>
                Postman, Bruno, Insomnia, OpenAPI, WSDL or HAR files.
                { selectedCollection && ` Environment files go to “${selectedCollection.name}”.` }
            </span>
        </DropOverlay> }
    </WorkspaceRoot>;
}));

// --- Send header: environment, unset variables & save ------------------------------------

const EnvironmentControl = styled.div`
    flex-shrink: 1;
    min-width: 0;
    height: 28px;
    padding-left: 8px;
    border-radius: 6px;

    display: flex;
    align-items: center;
    gap: 4px;

    color: ${p => p.theme.mainLowlightColor};
    border: 1px solid ${p => p.theme.inputBorder};
    background-color: ${p => p.theme.mainBackground};

    > svg {
        flex-shrink: 0;
    }

    select {
        min-width: 0;
        max-width: 200px;
        height: 100%;
        padding: 0 4px;
        border: none;
        background: transparent;

        font-family: ${p => p.theme.fontFamily};
        font-size: ${p => p.theme.textInputFontSize};
        color: ${p => p.theme.mainColor};
        text-overflow: ellipsis;
        cursor: pointer;

        &:focus-visible {
            outline-offset: 0;
        }
    }
`;

const ManageButton = styled(UnstyledButton)`
    flex-shrink: 0;
    width: 28px;
    height: 26px;
    border-left: 1px solid ${p => p.theme.containerBorder};
    border-radius: 0 6px 6px 0;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.theme.mainLowlightColor};

    &:hover {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

const UnsetButton = styled(UnstyledButton)`
    flex-shrink: 0;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;

    display: inline-flex;
    align-items: center;
    gap: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
    white-space: nowrap;
    color: ${p => p.theme.warning};
    background-color: ${p => p.theme.warningBackground};

    &:hover:not([disabled]) {
        box-shadow: inset 0 0 0 1px ${p => p.theme.warningColor};
    }
`;

const NO_ENVIRONMENT = '';

const listNames = (names: string[]) => names.length <= 1
    ? names.join('')
    : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

function describeUnset(unset: UnsetValues): string {
    const missing = [...unset.variables.map((name) => `{{${name}}}`), ...unset.pathParams.map((name) => `:${name}`)];
    const empty = unset.emptyVariables.map((name) => `{{${name}}}`);

    return [
        missing.length && `${listNames(missing)} ${missing.length === 1 ? 'isn\'t' : 'aren\'t'} set, so ${missing.length === 1 ? 'it\'s' : 'they\'re'} sent as written.`,
        empty.length && `${listNames(empty)} ${empty.length === 1 ? 'is' : 'are'} empty.`
    ].filter(Boolean).join(' ');
}

// The tab's title in Send's tab bar, for requests from a collection: its name, and a • when changed
export function collectionTabTitle(collectionsStore: CollectionsStore, sendRequest: SendRequest): string | undefined {
    const title = collectionsStore.tabTitle(sendRequest);
    if (!title) return undefined;
    return collectionsStore.isTabDirty(sendRequest) ? `${title} •` : title;
}

const SaveShortcut = (props: { onSave: () => void }) => {
    useHotkeys('Ctrl+s, Cmd+s', (event) => {
        event.preventDefault();
        props.onSave();
    }, [props.onSave]);
    return null;
};

/**
 * The collection controls in Send's page header: the active environment (with its
 * editor), a warning for {{variables}} without a value, and Save (⌘S).
 */
export const CollectionsHeaderActions = inject('collectionsStore', 'sendStore')(observer((props: {
    collectionsStore?: CollectionsStore,
    sendStore?: SendStore
}) => {
    const collectionsStore = props.collectionsStore!;
    const sendRequest = props.sendStore!.selectedRequest;
    const collection = collectionsStore.activeCollection;
    const environment = collection ? collectionsStore.activeEnvironment(collection) : undefined;

    const link = collectionsStore.linkFor(sendRequest.id);
    const isLinked = !!link?.itemUid;
    const isDirty = collectionsStore.isTabDirty(sendRequest);
    const unset = collectionsStore.unsetValuesFor(sendRequest);
    const unsetCount = unset.variables.length + unset.emptyVariables.length + unset.pathParams.length;

    const save = React.useCallback(() => {
        collectionsStore.saveTab(sendRequest).catch((error: unknown) => {
            collectionsStore.showNotice('error', 'Couldn\'t save the request', [error instanceof Error ? error.message : String(error)]);
        });
    }, [collectionsStore, sendRequest]);

    return <>
        <SaveShortcut onSave={save} />

        { collection && <EnvironmentControl title={`The environment for ${collection.name}: it fills in {{variables}} when sending`}>
            <GlobeSimple size={16} aria-hidden={true} />
            <select
                aria-label={`Environment for ${collection.name}`}
                value={environment?.name ?? NO_ENVIRONMENT}
                onChange={(event) => collectionsStore.setActiveEnvironment(
                    collection.uid,
                    event.target.value === NO_ENVIRONMENT ? undefined : event.target.value
                )}
            >
                <option value={NO_ENVIRONMENT}>No environment</option>
                { collection.environments.map((candidate) =>
                    <option key={candidate.name} value={candidate.name}>{ candidate.name }</option>
                ) }
            </select>
            <ManageButton
                title='Edit environments and variables'
                aria-label='Edit environments'
                onClick={() => openEnvironments(collectionsStore, collection.uid)}
            >
                <Sliders size={16} />
            </ManageButton>
        </EnvironmentControl> }

        { unsetCount > 0 && <UnsetButton
            title={describeUnset(unset) + (!collection
                ? ' Select a collection to use its environments.'
                : unsetCount === 1 ? ' Click to fill it in.' : ' Click to fill them in.')}
            disabled={!collection}
            onClick={() => collection && openEnvironments(collectionsStore, collection.uid, [...unset.variables, ...unset.emptyVariables])}
        >
            <Warning size={16} weight='fill' aria-hidden={true} />
            <span className='action-label'>{ unsetCount } unset</span>
        </UnsetButton> }

        <ActionButton
            icon='FloppyDisk'
            shortcut='Cmd+S'
            title={isLinked
                ? (isDirty ? 'Save changes to the collection' : 'No changes to save')
                : 'Save this request to a collection'}
            disabled={isLinked && !isDirty}
            onClick={save}
        >
            { isLinked ? (isDirty ? 'Save' : 'Saved') : 'Save…' }
        </ActionButton>
    </>;
}));
