import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { BookOpenText, CaretRight, DotsThree, Export, Folder, FolderOpen, Stack } from '@phosphor-icons/react';

import { styled, css } from '../../styles';
import { isCmdCtrlPressed } from '../../util/ui';

import { UiStore } from '../../model/ui/ui-store';
import { CollectionsStore } from '../../model/collections/collections-store';
import { isSendableItem } from '../../model/collections/collection-tree';
import { getMethodThemeColor } from '../../model/events/categorization';

import { buildTreeRows, isExpandableRow, parentRowIndex, TreeRow } from './tree-rows';
import { collectionMenu, confirmDelete, itemMenu, openDocs, openShare, promptRename } from './collection-actions';

const ROW_HEIGHT = 28;
const INDENT = 14;

const TreeRoot = styled.div`
    padding: 4px 6px 12px;
    outline: none;

    &:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: -2px;
    }
`;

const Row = styled.div<{ depth: number, isSelected: boolean, isOpenInTab: boolean }>`
    position: relative;
    height: ${ROW_HEIGHT}px;
    padding-left: ${p => 4 + p.depth * INDENT}px;
    padding-right: 4px;
    border-radius: 6px;

    display: flex;
    align-items: center;
    gap: 4px;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainColor};
    cursor: default;
    user-select: none;

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    /* The request open in the current Send tab */
    ${p => p.isOpenInTab && css`
        font-weight: 500;
    `}

    ${p => p.isSelected && css`
        background-color: ${p => p.theme.selectionInactiveBackground};

        &:hover {
            background-color: ${p => p.theme.selectionInactiveBackground};
        }

        /* The unfocused selection's 3px bar */
        &::before {
            content: '';
            position: absolute;
            left: 0;
            top: 5px;
            bottom: 5px;
            width: 3px;
            border-radius: 2px;
            background-color: ${p => p.theme.selectionInactiveBar};
        }

        ${TreeRoot}:focus-within & {
            color: ${p => p.theme.selectionColor};
            background-color: ${p => p.theme.selectionBackground};

            &::before {
                display: none;
            }

            .row-secondary, .row-method, .row-icon {
                color: ${p => p.theme.selectionColor};
            }
        }
    `}

    .row-more {
        visibility: hidden;
    }

    &:hover .row-more, .row-more:focus-visible {
        visibility: visible;
    }

    ${p => p.isSelected && css`
        .row-more {
            visibility: visible;
        }
    `}
`;

const Chevron = styled.span<{ isExpanded: boolean, isHidden: boolean }>`
    flex-shrink: 0;
    width: 16px;
    height: 16px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.theme.mainLowlightColor};
    visibility: ${p => p.isHidden ? 'hidden' : 'visible'};

    > svg {
        transition: transform 0.12s;
        ${p => p.isExpanded && css`transform: rotate(90deg);`}
    }
`;

const RowIcon = styled.span`
    flex-shrink: 0;
    width: 18px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: ${p => p.theme.mainLowlightColor};
`;

const MethodBadge = styled.span<{ method: string }>`
    flex-shrink: 0;
    width: 40px;
    margin-left: 2px;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 500;
    letter-spacing: 0.01em;
    color: ${p => getMethodThemeColor(p.method, p.theme)};
`;

const RowLabel = styled.span<{ isMuted?: boolean }>`
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    ${p => p.isMuted && css`
        color: ${p => p.theme.mainLowlightColor};
    `}
`;

const RowCount = styled.span`
    flex-shrink: 0;
    padding: 0 4px;
    font-size: ${p => p.theme.smallPrintSize};
    font-variant-numeric: tabular-nums;
    color: ${p => p.theme.mainLowlightColor};
`;

const MoreButton = styled.button.attrs(() => ({ type: 'button', tabIndex: -1 }))`
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    padding: 0;
    border: none;
    border-radius: 5px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: inherit;
    background: transparent;
    cursor: pointer;

    &:hover {
        background-color: ${p => p.theme.rowHover};
        color: ${p => p.theme.mainColor};
    }
`;

const StatusRow = styled.div<{ depth: number, tone: 'info' | 'error' }>`
    padding: 4px 8px 6px ${p => 26 + p.depth * INDENT}px;

    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.45;
    color: ${p => p.tone === 'error' ? p.theme.error : p.theme.mainLowlightColor};
`;

const methodLabel = (row: Extract<TreeRow, { kind: 'request' }>) => {
    const { item } = row;
    if (item.type === 'grpc-request') return 'gRPC';
    if (item.type === 'ws-request') return 'WS';
    if (item.type === 'graphql-request') return 'GQL';
    return (item.request?.method || 'GET').toUpperCase();
};

const rowLabel = (row: TreeRow) =>
    row.kind === 'collection' ? row.name
    : row.kind === 'readme' ? 'README'
    : row.kind === 'status' ? row.text
    : row.item.name;

/**
 * The collections tree: collection → README, folders and requests. Clicking a request
 * opens it in a Send tab. It's one focusable tree with arrow-key navigation (Enter
 * opens, F2 renames, ⌘⌫ deletes) and native right-click menus on every row.
 */
export const CollectionTreeView = observer((props: {
    collectionsStore: CollectionsStore,
    uiStore: UiStore,
    openTabNodeId: string | undefined
}) => {
    const { collectionsStore: store, uiStore } = props;
    const treeRef = React.useRef<HTMLDivElement>(null);
    const treeId = React.useId();

    const rows = buildTreeRows({
        summaries: store.summaries,
        collections: store.collections,
        loadErrors: store.loadErrors,
        isExpanded: (nodeId) => store.isExpanded(nodeId),
        searchQuery: store.searchQuery
    });
    const selectableRows = rows.filter((row) => row.kind !== 'status');
    const selectedIndex = selectableRows.findIndex((row) => row.id === store.selectedNodeId);
    const domId = (row: TreeRow) => `${treeId}-${row.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;

    // Keyboard selection keeps the selected row in view
    React.useEffect(() => {
        const selected = selectableRows[selectedIndex];
        if (!selected) return;
        document.getElementById(domId(selected))?.scrollIntoView({ block: 'nearest' });
    }, [store.selectedNodeId]);

    const select = (row: TreeRow) => store.selectNode(row.id, row.collectionId);

    const activate = (row: TreeRow) => {
        select(row);
        if (isExpandableRow(row)) store.setExpanded(row.id, !row.isExpanded);
        else if (row.kind === 'readme') openDocs(store, row.collectionId);
        else if (row.kind === 'request') store.openItem(row.collectionId, row.item.uid);
    };

    const menuFor = (row: TreeRow) =>
        row.kind === 'collection' || row.kind === 'readme'
            ? collectionMenu(store, row.collectionId)
        : row.kind === 'folder' || row.kind === 'request'
            ? itemMenu(store, row.collectionId, row.item)
        : [];

    const showMenu = (event: React.MouseEvent, row: TreeRow) => {
        select(row);
        uiStore.handleContextMenuEvent(event, menuFor(row));
    };

    const moveTo = (index: number) => {
        const row = selectableRows[Math.max(0, Math.min(selectableRows.length - 1, index))];
        if (row) select(row);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        const row = selectableRows[selectedIndex];
        const handled = (() => {
            switch (event.key) {
                case 'ArrowDown': moveTo(selectedIndex + 1); return true;
                case 'ArrowUp': moveTo(selectedIndex === -1 ? selectableRows.length - 1 : selectedIndex - 1); return true;
                case 'Home': moveTo(0); return true;
                case 'End': moveTo(selectableRows.length - 1); return true;
            }
            if (!row) return false;

            switch (event.key) {
                case 'ArrowRight':
                    if (isExpandableRow(row) && !row.isExpanded) store.setExpanded(row.id, true);
                    else if (isExpandableRow(row)) moveTo(selectedIndex + 1);
                    return true;
                case 'ArrowLeft':
                    if (isExpandableRow(row) && row.isExpanded) store.setExpanded(row.id, false);
                    else {
                        const parent = rows[parentRowIndex(rows, rows.indexOf(row))];
                        if (parent) moveTo(selectableRows.findIndex((candidate) => candidate.id === parent.id));
                    }
                    return true;
                case 'Enter':
                case ' ':
                    activate(row);
                    return true;
                case 'F2':
                    if (row.kind === 'collection') promptRename(store, row.collectionId);
                    else if (row.kind === 'folder' || row.kind === 'request') promptRename(store, row.collectionId, row.item);
                    return true;
                case 'Delete':
                case 'Backspace':
                    if (event.key === 'Backspace' && !isCmdCtrlPressed(event)) return false;
                    if (row.kind === 'collection') confirmDelete(store, row.collectionId);
                    else if (row.kind === 'folder' || row.kind === 'request') confirmDelete(store, row.collectionId, row.item);
                    return true;
            }
            return false;
        })();

        if (handled) event.preventDefault();
    };

    const selectedRow = selectableRows[selectedIndex];

    return <TreeRoot
        ref={treeRef}
        role='tree'
        aria-label='Collections'
        tabIndex={0}
        aria-activedescendant={selectedRow ? domId(selectedRow) : undefined}
        onKeyDown={onKeyDown}
    >
        { rows.map((row) => {
            if (row.kind === 'status') {
                return <StatusRow key={row.id} depth={row.depth} tone={row.tone} role='none'>{ row.text }</StatusRow>;
            }

            const isSelected = row.id === store.selectedNodeId;
            const label = rowLabel(row);
            const canOpen = row.kind !== 'request' || isSendableItem(row.item);

            return <Row
                key={row.id}
                id={domId(row)}
                role='treeitem'
                aria-level={row.depth + 1}
                aria-selected={isSelected}
                aria-expanded={isExpandableRow(row) ? row.isExpanded : undefined}
                depth={row.depth}
                isSelected={isSelected}
                isOpenInTab={row.id === props.openTabNodeId}
                title={row.kind === 'request'
                    ? `${row.item.request?.url || 'No URL yet'}${canOpen ? '' : ' (can\'t be opened in Send)'}`
                    : label}
                onMouseDown={() => treeRef.current?.focus()}
                onClick={() => activate(row)}
                onContextMenu={(event) => showMenu(event, row)}
            >
                <Chevron isExpanded={isExpandableRow(row) && row.isExpanded} isHidden={!isExpandableRow(row)}>
                    <CaretRight size={12} weight='bold' />
                </Chevron>

                { row.kind === 'request'
                    ? <MethodBadge className='row-method' method={(row.item.request?.method || 'GET').toUpperCase()}>
                        { methodLabel(row) }
                    </MethodBadge>
                    : <RowIcon className='row-icon'>
                        { row.kind === 'collection' && <Stack size={16} /> }
                        { row.kind === 'readme' && <BookOpenText size={16} /> }
                        { row.kind === 'folder' && (row.isExpanded ? <FolderOpen size={16} /> : <Folder size={16} />) }
                    </RowIcon>
                }

                <RowLabel isMuted={row.kind === 'readme' && !row.hasDocs || !canOpen}>
                    { label }{ row.kind === 'readme' && !row.hasDocs ? ' (empty)' : '' }
                </RowLabel>

                { row.kind === 'collection' && <RowCount className='row-secondary' title={`${row.requestCount} requests`}>
                    { row.requestCount }
                </RowCount> }

                { row.kind === 'collection' && <MoreButton
                    className='row-more'
                    title='Share as one file…'
                    aria-label={`Share ${label}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        openShare(store, row.collectionId);
                    }}
                >
                    <Export size={15} />
                </MoreButton> }

                { (row.kind === 'collection' || row.kind === 'folder' || row.kind === 'request') && <MoreButton
                    className='row-more'
                    title='More actions'
                    aria-label={`More actions for ${label}`}
                    onClick={(event) => {
                        event.stopPropagation();
                        showMenu(event, row);
                    }}
                >
                    <DotsThree size={16} weight='bold' />
                </MoreButton> }
            </Row>;
        }) }
    </TreeRoot>;
});

