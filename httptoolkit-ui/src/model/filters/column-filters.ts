import type { ViewableEvent } from '../../types';
import { getDeviceDirectory } from '../devices/device-directory';
import {
    REQUEST_TYPE_LABELS,
    RequestType,
    getRequestType
} from '../events/request-type';

import { matchFilters } from './filter-matching';
import {
    Filter,
    FilterSet,
    SelectableSearchFilterClasses,
    StringFilter
} from './search-filters';

/**
 * Wirepane: what View's column header menus offer, and how picking a value changes the
 * filter set. Every pick is a normal filter (method=GET, status=4xx, hostname=odtv.uz…),
 * so it shows as a chip in the filter bar and can be removed there.
 *
 * Each column holds one filter at a time: picking another value replaces it, picking the
 * same value again (or Clear) removes it. Shift or Cmd/Ctrl adds a value to the picks
 * instead, and several values are one or() filter (or(method=GET,method=POST)).
 */

export const FILTER_COLUMNS = ['method', 'status', 'type', 'source', 'host'] as const;
export type FilterColumn = typeof FILTER_COLUMNS[number];

export const FILTER_COLUMN_LABELS: { readonly [column in FilterColumn]: string } = {
    method: 'Method',
    status: 'Status',
    type: 'Type',
    source: 'Source',
    host: 'Host'
};

export interface ColumnFilterOption {
    // The text the filter is made from, as typed in the filter box
    filterString: string;
    label: string;
    // What the option is, for a tooltip
    description?: string;
    // How many of the events it would keep
    count: number;
}

const MAX_HOST_OPTIONS = 12;
const MAX_SOURCE_OPTIONS = 20;

// What the hostname filter's syntax accepts
const HOSTNAME_PATTERN = /^[a-z0-9.-]+$/;
const METHOD_PATTERN = /^[A-Z]+$/;
// App names that the app= syntax takes without []
const PLAIN_APP_NAME_PATTERN = /^[\w.+@:-]+$/;

// Anything on the Status menu that isn't a single status class. They use the existing
// pending & aborted filters, and are counted with them, so a count is what picking shows.
const STATUS_OPTIONS: ReadonlyArray<{ filterString: string, label: string, description: string }> = [
    { filterString: 'status=1xx', label: '1xx', description: 'Informational, like a WebSocket upgrade (101)' },
    { filterString: 'status=2xx', label: '2xx', description: 'Successful' },
    { filterString: 'status=3xx', label: '3xx', description: 'Redirect' },
    { filterString: 'status=4xx', label: '4xx', description: 'Client error' },
    { filterString: 'status=5xx', label: '5xx', description: 'Server error' },
    { filterString: 'status>=400', label: '400 and above', description: 'Every client and server error' },
    { filterString: 'aborted', label: 'Failed or aborted', description: 'No response: the connection failed or was cut off' },
    { filterString: 'pending', label: 'Pending', description: 'Still waiting for the response' }
];

/**
 * Turns the text of a filter into the filter, or undefined if it isn't exactly one filter.
 */
export function createColumnFilter(filterString: string): Filter | undefined {
    const [leftover, ...filters] = matchFilters(SelectableSearchFilterClasses, filterString);
    if (leftover.filter !== '' || filters.length !== 1) return undefined;
    return filters[0];
}

function getTextColumn(text: string): FilterColumn | undefined {
    // Typed text can be in any case: the filter syntax doesn't mind
    if (/^method(=|!=)/i.test(text)) return 'method';
    if (/^status/i.test(text) || /^(pending|aborted)$/i.test(text)) return 'status';
    if (/^type(=|!=)/i.test(text)) return 'type';
    if (/^app(=|!=|\*=|\^=|\$=)/i.test(text)) return 'source';
    if (/^hostname(=|!=|\*=|\^=|\$=)/i.test(text)) return 'host';
    return undefined;
}

// Several values of one column are one or() filter, like or(method=GET,method=POST)
const OR_PATTERN = /^or\((.*)\)$/i;

function getOrParts(text: string): string[] | undefined {
    const inner = OR_PATTERN.exec(text.trim())?.[1];
    return inner === undefined ? undefined : inner.split(',').map((part) => part.trim());
}

/**
 * Which column a filter belongs to, so a header can show it and its menu can replace it.
 * This includes filters typed in the filter box, like status>=500, and an or() of values
 * that are all in the same column.
 */
export function getFilterColumn(filter: Filter): FilterColumn | undefined {
    const text = filter.serialize();
    const orParts = getOrParts(text);
    if (!orParts) return getTextColumn(text);

    const columns = new Set(orParts.map(getTextColumn));
    return columns.size === 1 ? Array.from(columns)[0] : undefined;
}

export function getColumnFilters(filterSet: FilterSet, column: FilterColumn): Filter[] {
    return filterSet.slice(1).filter((filter) => getFilterColumn(filter) === column);
}

/**
 * The filter set after picking a value in a column's menu: the column's filter is
 * replaced, or removed if that value was already picked or there's no value (Clear).
 */
export function toggleColumnFilter(
    filterSet: FilterSet,
    column: FilterColumn,
    filterString: string | undefined
): FilterSet {
    const [textFilter, ...filters] = filterSet;
    const columnFilters = filters.filter((filter) => getFilterColumn(filter) === column);
    const otherFilters = filters.filter((filter) => getFilterColumn(filter) !== column);

    const isAlreadyPicked = columnFilters.length === 1 && columnFilters[0].serialize() === filterString;
    if (filterString === undefined || isAlreadyPicked) {
        return [textFilter, ...otherFilters];
    }

    const newFilter = createColumnFilter(filterString);
    if (!newFilter) return filterSet;

    return [textFilter, newFilter, ...otherFilters];
}

/**
 * The values picked in a column, as the text of each one: a single filter is one value,
 * and an or() filter holds several.
 */
export function getColumnFilterValues(filterSet: FilterSet, column: FilterColumn): string[] {
    return getColumnFilters(filterSet, column).reduce<string[]>((values, filter) => {
        const text = filter.serialize();
        return values.concat(getOrParts(text) ?? [text]);
    }, []);
}

// Values that are safe inside an or(): no brackets, parentheses, commas or spaces, which
// the or() syntax splits and ends on
const COMBINABLE_VALUE_PATTERN = /^[\w.!=*^$<>+@:-]+$/;

/**
 * The filter set after adding a value to what the column already has, or taking it out
 * if it's there. Several values become one or() filter, which keeps a request that
 * matches any of them. A value that can't go inside an or() replaces the picks instead.
 */
export function toggleColumnFilterValue(
    filterSet: FilterSet,
    column: FilterColumn,
    filterString: string
): FilterSet {
    const values = getColumnFilterValues(filterSet, column);
    const newValues = values.includes(filterString)
        ? values.filter((value) => value !== filterString)
        : [...values, filterString];

    const [textFilter, ...filters] = filterSet;
    const otherFilters = filters.filter((filter) => getFilterColumn(filter) !== column);
    if (newValues.length === 0) return [textFilter, ...otherFilters];

    const canCombine = newValues.every((value) => COMBINABLE_VALUE_PATTERN.test(value));
    const newFilter = newValues.length === 1
        ? createColumnFilter(newValues[0])
        : canCombine ? createColumnFilter(`or(${newValues.join(',')})`) : undefined;

    return newFilter
        ? [textFilter, newFilter, ...otherFilters]
        : toggleColumnFilter(filterSet, column, filterString);
}

export function removeAllColumnFilters(filterSet: FilterSet): FilterSet {
    const [textFilter, ...filters] = filterSet;
    return [textFilter, ...filters.filter((filter) => getFilterColumn(filter) === undefined)];
}

const methodOf = (event: ViewableEvent) =>
    event.isHttp() ? event.request.method.toUpperCase() : undefined;

const hostnameOf = (event: ViewableEvent) =>
    event.isHttp() ? event.request.parsedUrl.hostname.toLowerCase() : undefined;

const appNameOf = (event: ViewableEvent) => getDeviceDirectory().getEventAppName(event);

function countValues(
    events: ReadonlyArray<ViewableEvent>,
    getValue: (event: ViewableEvent) => string | undefined
): Map<string, number> {
    const counts = new Map<string, number>();
    for (const event of events) {
        const value = getValue(event);
        if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return counts;
}

// Most common first, then by name so equal counts don't jump around
const byCountThenLabel = (a: ColumnFilterOption, b: ColumnFilterOption) =>
    b.count - a.count || a.label.localeCompare(b.label);

export function getAppFilterString(appName: string): string | undefined {
    if (appName.includes(']')) return undefined; // The syntax can't hold it
    return PLAIN_APP_NAME_PATTERN.test(appName)
        ? `app=${appName}`
        : `app=[${appName}]`;
}

/**
 * The text for a "host contains…" filter, or undefined if it has characters hostnames
 * can't have.
 */
export function getHostContainsFilterString(text: string): string | undefined {
    const hostname = text.trim().toLowerCase();
    return HOSTNAME_PATTERN.test(hostname) ? `hostname*=${hostname}` : undefined;
}

function getStatusOptions(events: ReadonlyArray<ViewableEvent>): ColumnFilterOption[] {
    return STATUS_OPTIONS.map((option) => {
        const filter = createColumnFilter(option.filterString)!;
        return { ...option, count: events.reduce((sum, event) => sum + (filter.matches(event) ? 1 : 0), 0) };
    });
}

function getTypeOptions(events: ReadonlyArray<ViewableEvent>): ColumnFilterOption[] {
    const counts = countValues(events, (event) => getRequestType(event));
    return Array.from(counts, ([type, count]) => ({
        filterString: `type=${type}`,
        label: REQUEST_TYPE_LABELS[type as RequestType],
        count
    })).sort(byCountThenLabel);
}

/**
 * The values a column's menu lists for these events, with how many events each keeps.
 * Values the filter syntax can't hold are left out. The menu adds the picked value back
 * if it has no events any more.
 */
export function getColumnFilterOptions(
    column: FilterColumn,
    events: ReadonlyArray<ViewableEvent>
): ColumnFilterOption[] {
    switch (column) {
        case 'method':
            return Array.from(countValues(events, methodOf))
                .filter(([method]) => METHOD_PATTERN.test(method))
                .map(([method, count]) => ({ filterString: `method=${method}`, label: method, count }))
                .sort(byCountThenLabel);

        case 'status':
            return getStatusOptions(events).filter((option) => option.count > 0);

        case 'type':
            return getTypeOptions(events);

        case 'source':
            return Array.from(countValues(events, appNameOf))
                .map(([name, count]) => ({ filterString: getAppFilterString(name), label: name, count }))
                .filter((option): option is ColumnFilterOption => option.filterString !== undefined)
                .sort(byCountThenLabel)
                .slice(0, MAX_SOURCE_OPTIONS);

        case 'host':
            return Array.from(countValues(events, hostnameOf))
                .filter(([host]) => HOSTNAME_PATTERN.test(host))
                .map(([host, count]) => ({ filterString: `hostname=${host}`, label: host, count }))
                .sort(byCountThenLabel)
                .slice(0, MAX_HOST_OPTIONS);
    }
}

/**
 * The events a column's menu counts: what the other filters keep, so a count says how
 * many rows picking that value shows.
 */
export function getEventsForColumnMenu<T extends ViewableEvent>(
    events: ReadonlyArray<T>,
    filterSet: FilterSet,
    column: FilterColumn,
    extraFilter?: Filter
): T[] {
    const otherFilters = [
        ...filterSet.slice(1).filter((filter) => getFilterColumn(filter) !== column),
        ...(extraFilter ? [extraFilter] : [])
    ];
    const textFilter: StringFilter = filterSet[0];

    return events.filter((event) =>
        textFilter.matches(event) && otherFilters.every((filter) => filter.matches(event))
    );
}
