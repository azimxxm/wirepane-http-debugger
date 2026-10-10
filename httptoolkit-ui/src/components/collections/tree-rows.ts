import { BrunoCollection, BrunoItem, CollectionSummary } from '../../model/collections/collection-types';
import { isFolder, searchItems } from '../../model/collections/collection-tree';
import { collectionNodeId, itemNodeId, readmeNodeId } from '../../model/collections/collections-store';

/**
 * The collections tree as a flat list of visible rows, which is what keyboard
 * navigation walks through: collection → README, folders → requests.
 */

interface RowBase {
    id: string;
    collectionId: string;
    depth: number;
}

export type TreeRow =
    | RowBase & { kind: 'collection', name: string, requestCount: number, isExpanded: boolean }
    | RowBase & { kind: 'readme', hasDocs: boolean }
    | RowBase & { kind: 'folder', item: BrunoItem, isExpanded: boolean }
    | RowBase & { kind: 'request', item: BrunoItem }
    | RowBase & { kind: 'status', text: string, tone: 'info' | 'error' };

export interface TreeInputs {
    summaries: readonly CollectionSummary[];
    collections: ReadonlyMap<string, BrunoCollection>;
    loadErrors: ReadonlyMap<string, string>;
    isExpanded: (nodeId: string) => boolean;
    searchQuery: string;
}

export const isExpandableRow = (row: TreeRow): row is Extract<TreeRow, { isExpanded: boolean }> =>
    row.kind === 'collection' || row.kind === 'folder';

function itemRows(
    collectionId: string,
    items: BrunoItem[],
    depth: number,
    inputs: TreeInputs,
    visible: Set<string> | undefined
): TreeRow[] {
    const rows: TreeRow[] = [];

    for (const item of items) {
        if (visible && !visible.has(item.uid)) continue;
        const id = itemNodeId(collectionId, item.uid);

        if (isFolder(item)) {
            // While searching, every folder on a match's path is shown open
            const isExpanded = !!visible || inputs.isExpanded(id);
            rows.push({ kind: 'folder', id, collectionId, depth, item, isExpanded });
            if (isExpanded) rows.push(...itemRows(collectionId, item.items ?? [], depth + 1, inputs, visible));
        } else {
            rows.push({ kind: 'request', id, collectionId, depth, item });
        }
    }

    return rows;
}

function collectionContentRows(summary: CollectionSummary, inputs: TreeInputs): TreeRow[] {
    const collectionId = summary.id;
    const collection = inputs.collections.get(collectionId);
    const status = (text: string, tone: 'info' | 'error' = 'info'): TreeRow =>
        ({ kind: 'status', id: `status:${collectionId}`, collectionId, depth: 1, text, tone });

    if (!collection) {
        const error = inputs.loadErrors.get(collectionId);
        return [error ? status(`Couldn't open: ${error}`, 'error') : status('Loading…')];
    }

    const readme: TreeRow = {
        kind: 'readme',
        id: readmeNodeId(collectionId),
        collectionId,
        depth: 1,
        hasDocs: !!collection.root?.docs?.trim()
    };

    const items = itemRows(collectionId, collection.items, 1, inputs, undefined);
    return items.length
        ? [readme, ...items]
        : [readme, status('No requests yet. Right-click the collection to add one.')];
}

export function buildTreeRows(inputs: TreeInputs): TreeRow[] {
    const query = inputs.searchQuery.trim();
    const rows: TreeRow[] = [];

    for (const summary of inputs.summaries) {
        const id = collectionNodeId(summary.id);
        const collectionRow = (isExpanded: boolean): TreeRow => ({
            kind: 'collection',
            id,
            collectionId: summary.id,
            depth: 0,
            name: summary.name,
            requestCount: summary.requestCount,
            isExpanded
        });

        if (!query) {
            const isExpanded = inputs.isExpanded(id);
            rows.push(collectionRow(isExpanded));
            if (isExpanded) rows.push(...collectionContentRows(summary, inputs));
            continue;
        }

        const collection = inputs.collections.get(summary.id);
        if (!collection) continue; // Still loading for the search

        const visible = searchItems(collection, query);
        if (!visible?.size) continue;

        rows.push(collectionRow(true));
        rows.push(...itemRows(summary.id, collection.items, 1, inputs, visible));
    }

    return rows;
}

// The row a Left arrow goes up to: the nearest row above with a smaller depth
export function parentRowIndex(rows: TreeRow[], index: number): number {
    const depth = rows[index]?.depth ?? 0;
    for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth < depth) return i;
    }
    return -1;
}
