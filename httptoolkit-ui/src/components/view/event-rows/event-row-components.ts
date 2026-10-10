import { styled } from '../../../styles';
import { Icon } from '../../../icons';
import {
    getSummaryColor,
    getMethodThemeColor,
    EventCategory
} from '../../../model/events/categorization';

import { filterProps } from '../../component-utils';
import { StatusCode } from '../../common/status-code';

// --- Common row props passed from EventRow to each row type ---

export interface CommonRowProps {
    'aria-rowindex': number;
    'aria-selected': boolean;
    id: string;
    'data-event-id': string;
    className: string;
    style: {};
}

// --- Column components ---

export const Column = styled.div<{ role: 'gridcell' | 'columnheader' }>`
    display: block;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    padding: 3px 0;
`;

export const RowMarker = styled(Column)`
    transition: color 0.2s;
    color: ${(p: { category: EventCategory }) => getSummaryColor(p.category)};

    background-color: currentColor;
    background-clip: content-box; /* Keep the border gap clear of the marker colour */

    flex-basis: 5px;
    flex-shrink: 0;
    flex-grow: 0;
    height: 100%;
    padding: 0;

    border-left: 5px solid ${p => p.theme.containerBackground};
    box-sizing: content-box;
`;

// --- Base row containers ---

export const EventListRow = styled.div<{ role: 'row' }>`
    display: flex;
    flex-direction: row;
    align-items: center;

    user-select: none;
    cursor: pointer;

    &:hover:not(.selected) {
        background-color: ${p => p.theme.rowHover};
    }

    /* Selected while the list isn't focused: a grey fill and a leading bar, keeping the
       method & status colours. The focused look is set by the list (view-event-list). */
    &.selected {
        background-color: ${p => p.theme.selectionInactiveBackground};
        box-shadow: inset 3px 0 0 ${p => p.theme.selectionInactiveBar};
    }
`;

export const TrafficEventListRow = styled(EventListRow)`
    background-color: ${props => props.theme.mainBackground};

    border-width: 2px 0;
    border-style: solid;
    border-color: transparent;
    background-clip: padding-box;
    box-sizing: border-box;

    &:hover ${RowMarker} {
        border-color: currentColor;
    }

    /* Clear the marker's gap, so the selection's leading bar shows through it */
    &.selected ${RowMarker} {
        border-color: transparent;
    }

    > * {
        margin-right: 10px;
    }
`;

export const TlsListRow = styled(EventListRow)`
    height: 28px !important; /* Important required to override react-window's style attr */
    margin: 2px 0;

    font-style: italic;
    justify-content: center;
    text-align: center;

    opacity: 0.7;

    &:hover {
        opacity: 1;
    }

    &.selected {
        opacity: 1;
    }
`;

export const RowPin = styled(
    filterProps(Icon, 'pinned')
).attrs((p: { pinned: boolean }) => ({
    icon: ['fas', 'thumbtack'],
    title: p.pinned ? "This exchange is pinned, and won't be deleted by default" : ''
}))`
    font-size: 90%;
    box-sizing: content-box;
    background-color: ${p => p.theme.containerBackground};

    /* Without this, 0 width pins create a large & invisible but still clickable icon */
    overflow: hidden;

    transition: width 0.1s, padding 0.1s, margin 0.1s;

    ${(p: { pinned: boolean }) =>
        p.pinned
        ? `
            width: auto;
            padding: 8px 7px;
            && { margin-right: -3px; }
        `
        : `
            padding: 8px 0;
            width: 0 !important;
            margin: 0 !important;

            > path {
                display: none;
            }
        `
    }
`;

export const MarkerHeader = styled.div<{ role: 'columnheader' }>`
    flex-basis: 10px;
    flex-shrink: 0;
`;

export const Method = styled(Column)`
    transition: flex-basis 0.1s;
    ${(p: { pinned?: boolean }) =>
        p.pinned
        ? 'flex-basis: 50px;'
        : 'flex-basis: 71px;'
    }

    flex-shrink: 0;
    flex-grow: 0;
`;

// The coloured method name inside a row's Method cell:
export const MethodName = styled.span<{ httpMethod: string }>`
    color: ${p => getMethodThemeColor(p.httpMethod, p.theme)};
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
`;

export const Status = styled(Column)`
    flex-basis: 45px;
    flex-shrink: 0;
    flex-grow: 0;
`;

export const Source = styled(Column)`
    flex-basis: 49px;
    flex-shrink: 0;
    flex-grow: 0;

    display: flex;
    align-items: center;
    justify-content: center;
`;

export const Host = styled(Column)`
    flex-shrink: 1;
    flex-grow: 0;
    flex-basis: 500px;
`;

export const PathAndQuery = styled(Column)`
    flex-shrink: 1;
    flex-grow: 0;
    flex-basis: 1000px;
`;

// Match Method + Status, but shrink right margin slightly so that
// spinner + "WebRTC Media" fits OK.
export const EventTypeColumn = styled(Column)`
    transition: flex-basis 0.1s;
    ${(p: { pinned?: boolean }) =>
        p.pinned
        ? 'flex-basis: 109px;'
        : 'flex-basis: 130px;'
    }

    margin-right: 6px !important;

    flex-shrink: 0;
    flex-grow: 0;
`;

// Match Host column:
export const RTCEventLabel = styled(Column)`
    flex-shrink: 1;
    flex-grow: 0;
    flex-basis: 500px;

    > svg {
        padding-right: 0; /* Right, not left - it's rotated */
    }
`;

// Match PathAndQuery column:
export const RTCEventDetails = styled(Column)`
    flex-shrink: 1;
    flex-grow: 0;
    flex-basis: 1000px;
`;

export const RTCConnectionDetails = styled(RTCEventDetails)`
    text-align: center;
`;

// Host + Path + Query columns:
export const BuiltInApiRequestDetails = styled(Column)`
    flex-shrink: 1;
    flex-grow: 0;
    flex-basis: 1000px;
`;

export const ConnectedSpinnerIcon = styled(Icon).attrs(() => ({
    icon: ['fas', 'spinner'],
    spin: true,
    title: 'Connected'
}))`
    margin: 0 5px 0 0;
    box-sizing: content-box;
`;

export const TableHeaderRow = styled.div<{ role: 'row' }>`
    height: 38px;
    overflow: hidden;
    width: 100%;

    display: flex;
    flex-direction: row;
    align-items: center;

    background-color: ${props => props.theme.mainLowlightBackground};
    color: ${props => props.theme.mainColor};
    font-size: ${props => props.theme.smallPrintSize};
    font-weight: 600;

    border-bottom: 1px solid ${props => props.theme.containerBorder};

    padding-right: 18px;
    box-sizing: border-box;

    > div[role=columnheader] {
        padding: 5px 0;
        margin-right: 10px;
        min-width: 0px;

        &:first-of-type {
            margin-left: 0;
        }
    }
`;

// --- Preview row components (used by multi-selection summary) ---

export const SourceIcon = styled(Icon)`
    flex-shrink: 0;
`;

export const InlineStatus = styled(StatusCode)`
    flex-shrink: 0;
`;

export const RowDetail = styled.span`
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    min-width: 0;
`;
