import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import * as dateFns from 'date-fns';

import { styled, Theme } from '../../../styles';
import { ViewableEvent } from '../../../types';
import { PhosphorIcon } from '../../../icons';

import {
    LIST_COLUMNS,
    ListColumn,
    ListColumnsStore,
    LIST_COLUMN_DESCRIPTIONS,
    LIST_COLUMN_LABELS
} from '../../../model/ui/list-columns-store';
import { DEVICE_COLUMN_WIDTH } from '../../devices/device-marker';
import {
    describeRequestType,
    getRequestType,
    REQUEST_TYPE_LABELS
} from '../../../model/events/request-type';
import {
    describeRowAttention,
    getRowAttention,
    RowAttention,
    ROW_ATTENTION_LABELS
} from '../../../model/events/row-attention';

/*
 * Wirepane: View's extra list columns (Type, plus the opt-in Time, Duration & Size) and the
 * row marker. Header and row cells share their widths, so everything lines up.
 */

export const COLUMN_WIDTHS: { readonly [column in ListColumn]: number } = {
    type: 64,
    time: 64,
    duration: 64,
    size: 64
};

// The space at the end of the header for the columns button, kept free in every row too
export const LIST_OPTIONS_SLOT_WIDTH = 28;

// The host & path never shrink below these. Past that the list scrolls sideways instead,
// so turning on more columns never hides the URL. Most of the host's room comes from its
// flex-basis (event-row-components); a higher floor would make the list scroll sideways as
// soon as a phone adds the Device column at 1440px.
export const HOST_MIN_WIDTH = 72;
export const PATH_MIN_WIDTH = 72;

// Every cell's right margin (TrafficEventListRow & TableHeaderRow)
const CELL_MARGIN = 10;
// The marker, method, status & source columns (event-row-components)
const ALWAYS_SHOWN_WIDTHS = [10, 71, 62, 62]; // wirepane: status & source widened for the sort arrow

/**
 * How narrow the list's rows can get with these columns before it scrolls sideways.
 */
export function getListMinWidth(isColumnVisible: (column: ListColumn) => boolean, showsDevices: boolean) {
    const widths = [
        ...ALWAYS_SHOWN_WIDTHS,
        HOST_MIN_WIDTH,
        PATH_MIN_WIDTH,
        ...(showsDevices ? [DEVICE_COLUMN_WIDTH] : []),
        ...LIST_COLUMNS.filter(isColumnVisible).map((column) => COLUMN_WIDTHS[column])
    ];
    return widths.reduce((sum, width) => sum + width + CELL_MARGIN, 0) + LIST_OPTIONS_SLOT_WIDTH;
}

export const FixedColumn = styled.div<{
    role: 'gridcell' | 'columnheader',
    column: ListColumn
}>`
    flex: 0 0 ${p => COLUMN_WIDTHS[p.column]}px;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    padding: 3px 0;

    text-align: ${p => p.column === 'duration' || p.column === 'size' ? 'right' : 'left'};
`;

const TypeText = styled(FixedColumn)`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const NumberText = styled(FixedColumn)`
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
    font-variant-numeric: tabular-nums;
`;

const NO_VALUE = '—';

const isVisible = (store: ListColumnsStore | undefined, column: ListColumn) =>
    !!store && store.isVisible(column);

// --- Formatting ---

const SIZE_UNITS = ['B', 'kB', 'MB', 'GB', 'TB'];

// "512 B", "1.2 kB", "48 kB", "3.4 MB": short enough for a narrow column
export function formatCompactSize(bytes: number): string {
    let value = bytes;
    let unitIndex = 0;
    while (value >= 999.5 && unitIndex < SIZE_UNITS.length - 1) {
        value /= 1000;
        unitIndex++;
    }

    const decimals = unitIndex === 0 || value >= 9.95 ? 0 : 1;
    return `${value.toFixed(decimals)} ${SIZE_UNITS[unitIndex]}`;
}

// "<1 ms", "245 ms", "1.20 s", "12.5 s", "2.0 min"
export function formatCompactDuration(ms: number): string {
    if (ms < 1) return '<1 ms';
    if (ms < 999.5) return `${Math.round(ms)} ms`;
    if (ms < 9995) return `${(ms / 1000).toFixed(2)} s`;
    if (ms < 59_950) return `${(ms / 1000).toFixed(1)} s`;
    if (ms < 3_597_000) return `${(ms / 60_000).toFixed(1)} min`;
    return `${(ms / 3_600_000).toFixed(1)} h`;
}

function getStartTime(event: ViewableEvent): number | undefined {
    if (!event.isHttp()) return undefined;
    return event.timingEvents.startTime;
}

/**
 * How long the response took, or undefined while there's none. The same sum as the
 * Performance card's duration, without its live clock for pending requests: that would
 * re-render every visible row many times a second.
 */
export function getEventDuration(event: ViewableEvent): number | undefined {
    if (!event.isHttp()) return undefined;

    const { startTimestamp, responseSentTimestamp, abortedTimestamp, wsAcceptedTimestamp } = event.timingEvents;
    const doneTimestamp = responseSentTimestamp ?? abortedTimestamp ?? wsAcceptedTimestamp;
    if (startTimestamp === undefined || doneTimestamp === undefined) return undefined;

    return Math.max(0, doneTimestamp - startTimestamp);
}

export function getResponseBodySize(event: ViewableEvent): number | undefined {
    if (!event.isHttp() || event.isWebSocket() || !event.isSuccessfulExchange()) return undefined;
    return event.response.body.encodedByteLength;
}

// --- Header cells ---

export const TypeColumnHeader = inject('listColumnsStore')(observer((p: {
    listColumnsStore?: ListColumnsStore
}) => isVisible(p.listColumnsStore, 'type')
    ? <FixedColumn role='columnheader' column='type' title={LIST_COLUMN_DESCRIPTIONS.type}>
        { LIST_COLUMN_LABELS.type }
    </FixedColumn>
    : null
));

const TRAILING_COLUMNS = ['time', 'duration', 'size'] as const;

export const OptionalColumnHeaders = inject('listColumnsStore')(observer((p: {
    listColumnsStore?: ListColumnsStore
}) => <>
    { TRAILING_COLUMNS
        .filter((column) => isVisible(p.listColumnsStore, column))
        .map((column) =>
            <FixedColumn
                key={column}
                role='columnheader'
                column={column}
                title={LIST_COLUMN_DESCRIPTIONS[column]}
            >
                { LIST_COLUMN_LABELS[column] }
            </FixedColumn>
        )
    }
</>));

// --- Row cells ---

export const TypeCell = inject('listColumnsStore')(observer((p: {
    listColumnsStore?: ListColumnsStore,
    event: ViewableEvent
}) => {
    if (!isVisible(p.listColumnsStore, 'type')) return null;

    return <TypeText role='gridcell' column='type' title={describeRequestType(p.event)}>
        { REQUEST_TYPE_LABELS[getRequestType(p.event)] }
    </TypeText>;
}));

// Keeps the end of each row clear, under the header's columns button
const TrailingSpacer = styled.span`
    && {
        flex: 0 0 ${LIST_OPTIONS_SLOT_WIDTH}px;
        margin-right: 0;
    }
`;

const TimeCell = observer((p: { event: ViewableEvent }) => {
    const startTime = getStartTime(p.event);
    if (startTime === undefined) return <NumberText role='gridcell' column='time'>{ NO_VALUE }</NumberText>;

    return <NumberText
        role='gridcell'
        column='time'
        title={`Started at ${dateFns.format(startTime, 'YYYY-MM-DD HH:mm:ss.SSS')}`}
    >
        { dateFns.format(startTime, 'HH:mm:ss') }
    </NumberText>;
});

const DurationCell = observer((p: { event: ViewableEvent }) => {
    const duration = getEventDuration(p.event);

    return <NumberText
        role='gridcell'
        column='duration'
        title={duration === undefined
            ? (p.event.isHttp() && !p.event.isCompletedExchange() ? 'Waiting for the response' : undefined)
            : `${duration.toFixed(1)} ms`
        }
    >
        { duration === undefined ? NO_VALUE : formatCompactDuration(duration) }
    </NumberText>;
});

const SizeCell = observer((p: { event: ViewableEvent }) => {
    const size = getResponseBodySize(p.event);

    return <NumberText
        role='gridcell'
        column='size'
        title={size === undefined
            ? (p.event.isWebSocket() ? 'Open the WebSocket to see its messages' : undefined)
            : `Response body: ${size.toLocaleString()} bytes, as sent`
        }
    >
        { size === undefined ? NO_VALUE : formatCompactSize(size) }
    </NumberText>;
});

/**
 * The opt-in cells at the end of a row: Time, Duration & Size, then the empty slot under
 * the header's columns button.
 */
export const OptionalColumnCells = inject('listColumnsStore')(observer((p: {
    listColumnsStore?: ListColumnsStore,
    event: ViewableEvent
}) => <>
    { isVisible(p.listColumnsStore, 'time') && <TimeCell event={p.event} /> }
    { isVisible(p.listColumnsStore, 'duration') && <DurationCell event={p.event} /> }
    { isVisible(p.listColumnsStore, 'size') && <SizeCell event={p.event} /> }
    <TrailingSpacer aria-hidden={true} />
</>));

// --- Row marker ---

export function getRowAttentionColor(kind: RowAttention, theme: Theme): string {
    switch (kind) {
        case 'failed': return theme.error;
        case 'modified': return theme.popColor;
        case 'breakpoint': return theme.warningColor;
    }
}

// The same 10px as the header's marker column. The bar sits clear of the selection's
// leading bar, which fills the first 3px of a selected row.
const MarkerCell = styled.div<{ role: 'gridcell' }>`
    flex: 0 0 10px;
    align-self: stretch;
    position: relative;
`;

export const AttentionBar = styled.span<{ attention: RowAttention }>`
    position: absolute;
    left: 4px;
    top: 4px;
    bottom: 4px;
    width: 3px;
    border-radius: 2px;

    background-color: ${p => getRowAttentionColor(p.attention, p.theme)};

    /* On the focused list's accent fill a coloured bar would vanish, so it goes white like the text */
    [role='grid']:focus-within .selected & {
        background-color: ${p => p.theme.selectionColor};
    }
`;

// The pencil next to the source of a request a rule changed: the same teal as its marker
export const RuleChangedIcon = styled((p: { alt: string, size: string, className?: string }) =>
    <PhosphorIcon icon='Pencil' alt={p.alt} size={p.size} className={p.className} />
)`
    color: ${p => p.theme.popColor};
`;

export const RowAttentionMarker = observer((p: { event: ViewableEvent }) => {
    const attention = getRowAttention(p.event);

    return <MarkerCell
        role='gridcell'
        aria-label={attention ? ROW_ATTENTION_LABELS[attention] : undefined}
        title={attention ? describeRowAttention(attention) : undefined}
    >
        { attention && <AttentionBar attention={attention} /> }
    </MarkerCell>;
});
