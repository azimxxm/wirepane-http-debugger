import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import {
    CheckCircle,
    FileArrowDown,
    MagnifyingGlass,
    Plus,
    SidebarSimple,
    Stack,
    Warning,
    WarningCircle,
    X
} from '@phosphor-icons/react';

import { styled, css } from '../../styles';
import { formatShortcut } from '../../util/shortcuts';
import { useHotkeys } from '../../util/ui';

import { UiStore } from '../../model/ui/ui-store';
import { SendStore } from '../../model/send/send-store';
import {
    CollectionsNotice,
    CollectionsStore,
    DEFAULT_PANEL_WIDTH,
    itemNodeId,
    MAX_PANEL_WIDTH,
    MIN_PANEL_WIDTH
} from '../../model/collections/collections-store';

import { searchItems } from '../../model/collections/collection-tree';

import { ActionButton } from '../common/action-button';
import { UnstyledButton } from '../common/inputs';
import { CollectionTreeView } from './collection-tree-view';
import { pickFilesToImport, promptNewCollection } from './collection-actions';

export const TOGGLE_PANEL_SHORTCUT = 'Cmd+Alt+S';

const PanelRoot = styled.aside`
    position: relative;
    flex-shrink: 0;
    height: 100%;
    min-height: 0;
    box-sizing: border-box;

    display: flex;
    flex-direction: column;

    background-color: ${p => p.theme.mainLowlightBackground};
    border-right: 1px solid ${p => p.theme.containerBorder};
`;

const PanelHeader = styled.header`
    flex-shrink: 0;
    height: 38px;
    padding: 0 6px 0 14px;

    display: flex;
    align-items: center;
    gap: 2px;

    h2 {
        flex: 1 1 auto;
        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }
`;

const ToolButton = styled(UnstyledButton)`
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 6px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.theme.mainLowlightColor};

    &:hover {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

const SearchBox = styled.label`
    flex-shrink: 0;
    margin: 0 8px 6px;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;

    display: flex;
    align-items: center;
    gap: 6px;

    color: ${p => p.theme.mainLowlightColor};
    background-color: ${p => p.theme.inputBackground};
    border: 1px solid ${p => p.theme.containerBorder};

    &:focus-within {
        border-color: ${p => p.theme.inputBorder};
    }

    input {
        flex: 1 1 auto;
        min-width: 0;
        border: none;
        outline: none;
        background: transparent;

        font-family: ${p => p.theme.fontFamily};
        font-size: ${p => p.theme.textInputFontSize};
        color: ${p => p.theme.inputColor};

        &::placeholder {
            color: ${p => p.theme.inputPlaceholderColor};
        }
    }
`;

const TreeScroller = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
`;

const NoticeBox = styled.div<{ tone: CollectionsNotice['tone'] }>`
    flex-shrink: 0;
    margin: 0 8px 8px;
    padding: 8px 8px 8px 10px;
    border-radius: 8px;

    display: flex;
    align-items: flex-start;
    gap: 8px;

    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.45;
    color: ${p => p.theme.mainColor};

    ${p => p.tone === 'info'
        ? css`
            background-color: ${p => p.theme.mainBackground};
            border: 1px solid ${p => p.theme.containerBorder};
        `
        : css`
            background-color: ${p => p.theme.warningBackground};
            border: 1px solid ${p => p.theme.warningColor};
        `
    }

    > svg {
        flex-shrink: 0;
        margin-top: 1px;
        color: ${p => p.tone === 'info' ? p.theme.popColor : p.theme.warningColor};
    }

    > div {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
    }

    strong {
        font-weight: 600;
    }

    ul {
        margin-top: 4px;
        padding-left: 14px;
        list-style: disc;
        max-height: 120px;
        overflow-y: auto;
    }
`;

const NoticeClose = styled(ToolButton)`
    width: 20px;
    height: 20px;
`;

const EmptyPanel = styled.div`
    padding: 24px 18px;

    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 10px;

    > svg {
        color: ${p => p.theme.mainLowlightColor};
    }

    h3 {
        font-size: ${p => p.theme.textSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }

    p {
        font-size: ${p => p.theme.textInputFontSize};
        line-height: 1.5;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const EmptyActions = styled.div`
    margin-top: 4px;
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
`;

const DropHint = styled.p`
    font-size: ${p => p.theme.smallPrintSize} !important;
`;

const ListMessage = styled.p`
    padding: 16px 18px;
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.5;
    color: ${p => p.theme.mainLowlightColor};
`;

const ResizeHandle = styled.div`
    position: absolute;
    top: 0;
    right: -4px;
    bottom: 0;
    width: 8px;
    z-index: 5;
    cursor: col-resize;

    &:hover, &:focus-visible, &.dragging {
        background: linear-gradient(90deg, transparent 3px, ${p => p.theme.focusRing} 3px, ${p => p.theme.focusRing} 5px, transparent 5px);
    }

    &:focus-visible {
        outline: none;
    }
`;

const CollapsedStrip = styled.aside`
    flex-shrink: 0;
    width: 40px;
    height: 100%;
    box-sizing: border-box;
    padding-top: 5px;

    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;

    background-color: ${p => p.theme.mainLowlightBackground};
    border-right: 1px solid ${p => p.theme.containerBorder};
`;

const NoticeView = (props: { notice: CollectionsNotice, onDismiss: () => void }) => {
    const { notice } = props;
    const Icon = notice.tone === 'info' ? CheckCircle : notice.tone === 'warning' ? Warning : WarningCircle;

    return <NoticeBox tone={notice.tone} role={notice.tone === 'error' ? 'alert' : 'status'}>
        <Icon size={16} weight='fill' />
        <div>
            <strong>{ notice.title }</strong>
            { notice.details.length > 0 && <ul>
                { notice.details.map((detail, index) => <li key={index}>{ detail }</li>) }
            </ul> }
        </div>
        <NoticeClose title='Dismiss' aria-label='Dismiss' onClick={props.onDismiss}>
            <X size={12} weight='bold' />
        </NoticeClose>
    </NoticeBox>;
};

const EmptyCollections = (props: { collectionsStore: CollectionsStore }) => <EmptyPanel>
    <Stack size={32} />
    <h3>No collections yet</h3>
    <p>
        Save requests with their docs and share a whole API as one file.
        Import from Postman, Bruno, Insomnia or OpenAPI.
    </p>
    <EmptyActions>
        <ActionButton icon='DownloadSimple' onClick={() => pickFilesToImport(props.collectionsStore)}>
            Import…
        </ActionButton>
        <ActionButton icon='Plus' onClick={() => promptNewCollection(props.collectionsStore)}>
            New collection
        </ActionButton>
    </EmptyActions>
    <DropHint>Or drop a collection file anywhere on this page.</DropHint>
</EmptyPanel>;

// Drags the panel's right edge to resize it. The width is kept when the drag ends.
function usePanelResize(collectionsStore: CollectionsStore) {
    const [dragWidth, setDragWidth] = React.useState<number | undefined>();

    const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        event.preventDefault();
        const handle = event.currentTarget;
        const startX = event.clientX;
        const startWidth = collectionsStore.panelWidth;
        const clamp = (width: number) => Math.min(MAX_PANEL_WIDTH, Math.max(MIN_PANEL_WIDTH, width));

        handle.setPointerCapture(event.pointerId);
        handle.classList.add('dragging');

        const onMove = (moveEvent: PointerEvent) => setDragWidth(clamp(startWidth + moveEvent.clientX - startX));
        const onUp = (upEvent: PointerEvent) => {
            handle.removeEventListener('pointermove', onMove);
            handle.removeEventListener('pointerup', onUp);
            handle.classList.remove('dragging');
            collectionsStore.setPanelWidth(clamp(startWidth + upEvent.clientX - startX));
            setDragWidth(undefined);
        };

        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        const step = event.shiftKey ? 40 : 10;
        if (event.key === 'ArrowLeft') collectionsStore.setPanelWidth(collectionsStore.panelWidth - step);
        else if (event.key === 'ArrowRight') collectionsStore.setPanelWidth(collectionsStore.panelWidth + step);
        else return;
        event.preventDefault();
    };

    return {
        width: dragWidth ?? collectionsStore.panelWidth,
        handleProps: {
            onPointerDown,
            onKeyDown,
            onDoubleClick: () => collectionsStore.setPanelWidth(DEFAULT_PANEL_WIDTH)
        }
    };
}

const PanelShortcuts = (props: { onToggle: () => void }) => {
    useHotkeys('Ctrl+Alt+s, Cmd+Alt+s', (event) => {
        event.preventDefault();
        props.onToggle();
    }, [props.onToggle]);
    return null;
};

/**
 * The Collections panel on the left of Send: every collection as a tree, with search,
 * import and new collection. It collapses to a thin strip, and its width is kept.
 */
export const CollectionsPanel = inject('collectionsStore', 'uiStore', 'sendStore')(observer((props: {
    collectionsStore?: CollectionsStore,
    uiStore?: UiStore,
    sendStore?: SendStore
}) => {
    const collectionsStore = props.collectionsStore!;
    const { width, handleProps } = usePanelResize(collectionsStore);
    const toggleLabel = formatShortcut(TOGGLE_PANEL_SHORTCUT);

    if (!collectionsStore.panelOpen) {
        return <CollapsedStrip aria-label='Collections (hidden)'>
            <PanelShortcuts onToggle={collectionsStore.togglePanel} />
            <ToolButton
                title={`Show collections (${toggleLabel})`}
                aria-label='Show collections'
                aria-expanded={false}
                onClick={collectionsStore.togglePanel}
            >
                <SidebarSimple size={18} />
            </ToolButton>
            <ToolButton title='Import collection…' aria-label='Import collection' onClick={() => pickFilesToImport(collectionsStore)}>
                <FileArrowDown size={18} />
            </ToolButton>
        </CollapsedStrip>;
    }

    const linked = collectionsStore.linkedItem(props.sendStore!.selectedRequest?.id);
    const openTabNodeId = linked ? itemNodeId(linked.collection.uid, linked.location.item.uid) : undefined;
    const { summaries, listState, notice, searchQuery } = collectionsStore;
    const hasCollections = summaries.length > 0;

    return <PanelRoot aria-label='Collections' style={{ width }}>
        <PanelShortcuts onToggle={collectionsStore.togglePanel} />
        <PanelHeader>
            <h2>Collections</h2>
            <ToolButton title='New collection' aria-label='New collection' onClick={() => promptNewCollection(collectionsStore)}>
                <Plus size={16} />
            </ToolButton>
            <ToolButton
                title='Import a Postman, Bruno, Insomnia, OpenAPI or HAR file'
                aria-label='Import'
                onClick={() => pickFilesToImport(collectionsStore)}
            >
                <FileArrowDown size={16} />
            </ToolButton>
            <ToolButton
                title={`Hide collections (${toggleLabel})`}
                aria-label='Hide collections'
                aria-expanded={true}
                onClick={collectionsStore.togglePanel}
            >
                <SidebarSimple size={16} />
            </ToolButton>
        </PanelHeader>

        { hasCollections && <SearchBox>
            <MagnifyingGlass size={14} />
            <input
                type='search'
                value={searchQuery}
                placeholder='Search requests'
                aria-label='Search requests'
                spellCheck={false}
                onChange={(event) => collectionsStore.setSearchQuery(event.target.value)}
                onKeyDown={(event) => {
                    if (event.key === 'Escape' && searchQuery) {
                        event.stopPropagation();
                        collectionsStore.setSearchQuery('');
                    }
                }}
            />
        </SearchBox> }

        { notice && <NoticeView notice={notice} onDismiss={collectionsStore.dismissNotice} /> }

        <TreeScroller>
            { listState === 'loading' && !hasCollections && <ListMessage>Loading collections…</ListMessage> }
            { listState === 'failed' && !hasCollections && <ListMessage>
                Couldn't load collections: { collectionsStore.listError }{' '}
                <ActionButton variant='ghost' onClick={() => collectionsStore.refreshList()}>Try again</ActionButton>
            </ListMessage> }
            { listState === 'ready' && !hasCollections && <EmptyCollections collectionsStore={collectionsStore} /> }
            { hasCollections && <CollectionTreeView
                collectionsStore={collectionsStore}
                uiStore={props.uiStore!}
                openTabNodeId={openTabNodeId}
            /> }
            { hasCollections && searchQuery.trim() && <SearchSummary collectionsStore={collectionsStore} /> }
        </TreeScroller>

        <ResizeHandle
            role='separator'
            aria-orientation='vertical'
            aria-label='Resize collections'
            aria-valuenow={width}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={MAX_PANEL_WIDTH}
            tabIndex={0}
            title='Drag to resize. Double-click to reset.'
            {...handleProps}
        />
    </PanelRoot>;
}));

// Shown under the results while searching, so an empty result says why
const SearchSummary = observer((props: { collectionsStore: CollectionsStore }) => {
    const { collectionsStore } = props;
    const isLoading = collectionsStore.summaries.some((summary) => !collectionsStore.collections.has(summary.id));
    const hasMatches = collectionsStore.summaries.some((summary) => {
        const collection = collectionsStore.collections.get(summary.id);
        return !!collection && !!searchItems(collection, collectionsStore.searchQuery)?.size;
    });

    if (isLoading) return <ListMessage>Searching…</ListMessage>;
    if (!hasMatches) return <ListMessage>No requests match “{ collectionsStore.searchQuery.trim() }”.</ListMessage>;
    return null;
});
