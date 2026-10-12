import type { ViewableEvent } from '../../types';
import type { ListSort, SortColumn } from '../../model/ui/list-columns-store';
import { getDeviceDirectory } from '../../model/devices/device-directory';
import { REQUEST_TYPE_LABELS, getRequestType } from '../../model/events/request-type';

import { getEventDuration, getResponseBodySize } from './event-rows/list-columns';

/*
 * Wirepane: sorting View's list by a column. The default is no sort at all, which keeps
 * the events in the order they arrived, so live traffic just appends.
 */

type SortKey = string | number | undefined;

export const SORT_COLUMN_LABELS: { readonly [column in SortColumn]: string } = {
    method: 'Method',
    status: 'Status',
    type: 'Type',
    source: 'Source',
    host: 'Host',
    path: 'Path and query',
    time: 'Time',
    duration: 'Duration',
    size: 'Size'
};

/**
 * What a column sorts an event by: the same value the column shows, or undefined when it
 * has none (e.g. no response yet, or an event that isn't an HTTP request).
 */
export function getSortKey(event: ViewableEvent, column: SortColumn): SortKey {
    switch (column) {
        case 'type':
            return REQUEST_TYPE_LABELS[getRequestType(event)].toLowerCase();
        case 'time':
            return event.isHttp() ? event.timingEvents.startTime : undefined;
        case 'duration':
            return getEventDuration(event);
        case 'size':
            return getResponseBodySize(event);
    }

    if (!event.isHttp()) return undefined;
    const { request } = event;

    switch (column) {
        case 'method':
            return request.method.toUpperCase();
        case 'status':
            // Pending & aborted requests have no status, so they go last
            return event.isSuccessfulExchange() ? event.response.statusCode : undefined;
        case 'source':
            // The app or client, as the Devices panel names it
            return (getDeviceDirectory().getEventAppName(event) ?? request.source.summary).toLowerCase();
        case 'host':
            return request.parsedUrl.host.toLowerCase();
        case 'path':
            return (request.parsedUrl.pathname + request.parsedUrl.search).toLowerCase();
    }
}

function compareKeys(a: SortKey, b: SortKey, direction: ListSort['direction']): number {
    // No value goes last, whichever way the column is sorted
    if (a === undefined || b === undefined) {
        return a === b ? 0 : a === undefined ? 1 : -1;
    }
    if (a === b) return 0;

    const order = a < b ? -1 : 1;
    return direction === 'asc' ? order : -order;
}

/**
 * The events in the sorted order, as a new array. Events with the same value keep their
 * time order. Without a sort this is the same array.
 */
export function sortEvents<T extends ViewableEvent>(
    events: ReadonlyArray<T>,
    sort: ListSort | undefined
): ReadonlyArray<T> {
    if (!sort) return events;

    // Each event's key is worked out once, not on every comparison
    const entries = events.map((event, index) => ({
        event,
        index,
        key: getSortKey(event, sort.column)
    }));

    entries.sort((a, b) =>
        compareKeys(a.key, b.key, sort.direction) || a.index - b.index
    );

    return entries.map((entry) => entry.event);
}
