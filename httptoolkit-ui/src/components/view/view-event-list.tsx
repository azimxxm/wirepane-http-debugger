import * as _ from 'lodash';
import * as React from 'react';
import { observer, Observer } from 'mobx-react';
import { action, computed } from 'mobx';

import AutoSizer from 'react-virtualized-auto-sizer';
import { FixedSizeList as List } from 'react-window';

import { styled } from '../../styles'

import { CollectedEvent } from '../../types';
import { UiStore } from '../../model/ui/ui-store';
import { isCmdCtrlPressed } from '../../util/ui';

import { EmptyState } from '../common/empty-state';

import { HEADER_FOOTER_HEIGHT } from './view-event-list-footer';
import { ViewEventContextMenuBuilder } from './view-context-menu-builder';

import {
    MarkerHeader,
    Method,
    Status,
    Source,
    Host,
    PathAndQuery,
    RowMarker,
    RowPin,
    TrafficEventListRow
} from './event-rows/event-row-components';
import { EventRow, EventRowProps } from './event-rows/event-row';
import { DeviceColumnHeader } from '../devices/device-marker'; // wirepane: device markers
import { // wirepane: list columns
    HOST_MIN_WIDTH,
    PATH_MIN_WIDTH
} from './event-rows/list-columns';
import { ListHeaderRow } from './list-options'; // wirepane: columns menu
import { // wirepane: sorting & filtering from the column headers
    ColumnFilterMenuLayer,
    ColumnHeader,
    SortableOptionalColumnHeaders,
    SortableTypeColumnHeader
} from './list-column-headers';
import { ListSort } from '../../model/ui/list-columns-store';

const SCROLL_BOTTOM_MARGIN = 5; // If you're in the last 5 pixels of the scroll area, we say you're at the bottom

const EmptyStateOverlay = styled(EmptyState)`
    position: absolute;
    top: ${HEADER_FOOTER_HEIGHT}px;
    bottom: 0;
    height: auto;

    line-height: 1.3;
`;

interface ViewEventListProps {
    className?: string;
    events: ReadonlyArray<CollectedEvent>;
    filteredEvents: ReadonlyArray<CollectedEvent>;

    // All selected events, if any
    selectedEventIds: ReadonlySet<string>;

    // The focused event - usually but not always one of the selected
    activeEventId: string | undefined;

    isPaused: boolean;
    // wirepane: what to say when the filters hide everything, e.g. for a device with no requests
    noMatchesMessage?: string;
    // wirepane: the column the (already sorted) filteredEvents are sorted by, if any
    sort?: ListSort;

    contextMenuBuilder: ViewEventContextMenuBuilder;
    uiStore: UiStore;

    moveSelection: (distance: number, extend?: boolean) => void;
    onSelected: (event: CollectedEvent | undefined) => void;
    onToggleSelected: (event: CollectedEvent) => void;
    onRangeSelected: (event: CollectedEvent) => void;
    onSelectAll: () => void;
    onClearSelection: () => void;
}

const ListContainer = styled.div<{ role: 'grid' }>`
    display: block;
    flex-grow: 1;
    position: relative;
    width: 100%;
    box-sizing: border-box;

    font-size: ${p => p.theme.textSize};

    /* wirepane: the host & path never shrink away. Past the width the visible columns need
       (set by the header, list-options.tsx), the list scrolls sideways instead. */
    ${TrafficEventListRow} {
        min-width: var(--wp-list-min-width, 0px);
    }

    [role=row] > ${Host} {
        min-width: ${HOST_MIN_WIDTH}px;
    }

    [role=row] > ${PathAndQuery} {
        min-width: ${PATH_MIN_WIDTH}px;
    }

    /* wirepane: the sortable column headers */
    [role=columnheader][aria-sort] {
        position: relative;
        cursor: pointer;
        border-radius: 4px;

        &:hover {
            background-color: ${p => p.theme.rowHover};
        }

        &:focus-visible {
            outline: 2px solid ${p => p.theme.focusRing};
            outline-offset: -2px;
        }
    }

    /* wirepane: the selection fill shows focus, so the list only gets a ring when no row is
       active. The rows would paint over the list's own outline, so the ring is an overlay. */
    & > div > div[tabindex="0"]:focus {
        outline: none;
    }

    &:has(> div > div[tabindex="0"]:focus-visible):not(:has(.active))::after {
        content: '';
        position: absolute;
        top: ${HEADER_FOOTER_HEIGHT}px;
        left: 0;
        right: 0;
        bottom: 0;
        z-index: 2;
        pointer-events: none;
        box-shadow: inset 0 0 0 2px ${p => p.theme.focusRing};
    }

    /* While the list has focus, selected rows take the accent fill with white text, like macOS */
    &:focus-within .selected {
        background-color: ${p => p.theme.selectionBackground};
        box-shadow: none;

        &, *:not(${RowMarker}) {
            color: ${p => p.theme.selectionColor};
            fill: ${p => p.theme.selectionColor};
        }

        ${RowPin} {
            background-color: transparent;
        }
    }

    /* Keyboard focus on an active row that isn't selected (e.g. after a Cmd/Ctrl-click) */
    & > div > div[tabindex="0"]:focus-visible .active:not(.selected) {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: -2px;
    }
`;

@observer
export class ViewEventList extends React.Component<ViewEventListProps> {

    @computed get listItemData(): EventRowProps['data'] {
        return {
            selectedEventIds: this.props.selectedEventIds,
            activeEventId: this.props.activeEventId,
            events: this.props.filteredEvents,
            contextMenuBuilder: this.props.contextMenuBuilder
        };
    }

    private listBodyRef = React.createRef<HTMLDivElement>();
    private listRef = React.createRef<List>();

    private setListBodyRef = (element: HTMLDivElement | null) => {
        // Update the ref
        (this.listBodyRef as any).current = element;

        // If the element is being mounted and we haven't restored state yet, do it now
        if (element && !this.hasRestoredScrollState) {
            this.restoreScrollPosition();
            this.hasRestoredScrollState = true;
        }
    };

    private get activeRowDomId(): string | undefined {
        const id = this.props.activeEventId;
        if (!id) return undefined;

        const listBody = this.listBodyRef.current;
        if (!listBody) return undefined;
        if (!listBody.querySelector(`[data-event-id='${id}']`)) return undefined;

        return `event-row-${id}`;
    }

    private KeyBoundListWindow = observer(
        React.forwardRef<HTMLDivElement>(
            (props: any, ref) => <div
                {...props}
                style={Object.assign({}, props.style, { 'overflowY': 'scroll' })}
                ref={ref}

                onKeyDown={this.onKeyDown}
                onMouseDown={this.onListMouseDown}
                aria-activedescendant={this.activeRowDomId}
                tabIndex={0}
            />
        )
    );

    render() {
        const { events, filteredEvents, isPaused } = this.props;

        return <ListContainer role="grid">
            <ListHeaderRow>{ /* wirepane: with the columns menu */ }
                <MarkerHeader role="columnheader" aria-label="Markers" />
                <ColumnHeader Cell={Method} sortColumn='method' filterColumn='method' label='Method' />
                <ColumnHeader Cell={Status} sortColumn='status' filterColumn='status' label='Status' />
                <SortableTypeColumnHeader />
                <ColumnHeader Cell={Source} sortColumn='source' filterColumn='source' label='Source' />
                <DeviceColumnHeader />
                <ColumnHeader Cell={Host} sortColumn='host' filterColumn='host' label='Host' />
                <ColumnHeader Cell={PathAndQuery} sortColumn='path' label='Path and query' />
                <SortableOptionalColumnHeaders />
            </ListHeaderRow>
            <ColumnFilterMenuLayer events={events} />

            {
                events.length === 0
                ? (isPaused
                    ? <EmptyStateOverlay icon='Pause'>
                        Interception is paused, resume it to collect intercepted requests
                    </EmptyStateOverlay>
                    : <EmptyStateOverlay icon='Plug'>
                        Connect a client and intercept some requests, and they'll appear here
                    </EmptyStateOverlay>
                )

                : filteredEvents.length === 0
                ? <EmptyStateOverlay icon='QuestionMark'>
                        { this.props.noMatchesMessage ?? 'No requests match this search filter' }{
                            isPaused ? ' and interception is paused' : ''
                        }
                </EmptyStateOverlay>

                : <AutoSizer>{({ height, width }) =>
                    <Observer>{() =>
                        <List
                            innerRef={this.setListBodyRef}
                            outerElementType={this.KeyBoundListWindow}
                            ref={this.listRef}

                            height={height - HEADER_FOOTER_HEIGHT}
                            width={width}
                            itemCount={filteredEvents.length}
                            itemSize={32}
                            itemData={this.listItemData}

                            onScroll={this.updateScrolledState}
                        >
                            { EventRow }
                        </List>
                    }</Observer>
                }</AutoSizer>
            }
        </ListContainer>;
    }

    focusListWindow() {
        const listWindow = this.listBodyRef.current?.parentElement;
        listWindow?.focus();
    }

    focusList() {
        this.focusListWindow();
        const { activeEventId } = this.props;
        if (activeEventId) {
            const activeEvent = this.props.filteredEvents.find(e => e.id === activeEventId);
            if (activeEvent) {
                this.scrollToEvent(activeEvent);
            }
        }
    }

    private isListAtBottom() {
        const listWindow = this.listBodyRef.current?.parentElement;
        if (!listWindow) return true; // This means no rows, so we are effectively at the bottom
        else return (listWindow.scrollTop + SCROLL_BOTTOM_MARGIN) >= (listWindow.scrollHeight - listWindow.offsetHeight);
    }

    private wasListAtBottom = true;

    private updateScrolledState = () => {
        requestAnimationFrame(() => { // Measure async, once the scroll has actually happened
            this.wasListAtBottom = this.isListAtBottom();

            // Only save scroll position after we've restored the initial state
            if (this.hasRestoredScrollState) {
                const listWindow = this.listBodyRef.current?.parentElement;

                const scrollPosition = this.wasListAtBottom
                    ? 'end'
                    : (listWindow?.scrollTop ?? 'end');
                if (listWindow) {
                    this.props.uiStore.setViewScrollPosition(scrollPosition);
                }
            }
        });
    }

    private hasRestoredScrollState = false;

    private lastEventCount = 0;

    componentDidUpdate(prevProps: ViewEventListProps) {
        const eventCount = this.props.events.length;
        const eventsAdded = eventCount > this.lastEventCount;
        this.lastEventCount = eventCount;

        // wirepane: the rows moved, so show the selected one, or the start of the new order.
        // The sorted events arrive a moment after the sort changes (the page debounces them).
        if (prevProps.sort !== this.props.sort) this.isWaitingForSortedRows = true;
        if (this.isWaitingForSortedRows && prevProps.filteredEvents !== this.props.filteredEvents) {
            this.isWaitingForSortedRows = false;
            this.showRowsAfterSortChange();
            return;
        }

        // If new events arrived while we were at the bottom, stay at the bottom.
        // Only check when events were actually added — not on selection changes,
        // which would fight with moveSelection's scroll.
        // wirepane: not in a sorted list, where the bottom isn't where the new rows go.
        if (eventsAdded && !this.props.sort && this.wasListAtBottom && !this.isListAtBottom()) {
            this.listRef.current?.scrollToItem(eventCount - 1);
        }
    }

    private isWaitingForSortedRows = false;

    // wirepane: after clicking a header the rows are in a new order. Keep the selected row in
    // view, else show the first rows, or back in time order the newest as before.
    private showRowsAfterSortChange() {
        const { activeEventId, filteredEvents, sort } = this.props;
        const activeEvent = activeEventId
            ? filteredEvents.find((event) => event.id === activeEventId)
            : undefined;

        if (activeEvent) {
            this.scrollToCenterEvent(activeEvent, false);
        } else if (sort) {
            this.wasListAtBottom = false;
            this.listRef.current?.scrollTo(0);
        } else {
            this.wasListAtBottom = true;
            this.listRef.current?.scrollToItem(filteredEvents.length - 1);
        }
    }

    private restoreScrollPosition = () => {
        const savedPosition = this.props.uiStore.viewScrollPosition;
        const listWindow = this.listBodyRef.current?.parentElement;
        if (listWindow) {
            if (savedPosition === 'end') {
                listWindow.scrollTop = listWindow.scrollHeight;
            } else {
                // Only restore if we're not close to the current position (avoid unnecessary scrolling)
                if (Math.abs(listWindow.scrollTop - savedPosition) > 10) {
                    listWindow.scrollTop = savedPosition;
                }
            }
        }
    }

    public scrollToEvent(event: CollectedEvent) {
        const targetIndex = this.props.filteredEvents.indexOf(event);
        if (targetIndex === -1) return;

        this.listRef.current?.scrollToItem(targetIndex);
    }

    public scrollToCenterEvent(event: CollectedEvent, focusList = true) {
        const list = this.listRef.current;
        const listBody = this.listBodyRef.current;
        if (!list || !listBody) return;
        const listWindow = listBody.parentElement!;

        const targetIndex = this.props.filteredEvents.indexOf(event);
        if (targetIndex === -1) return;

        // TODO: scrollToItem("center") doesn't work well, need to resolve
        // https://github.com/bvaughn/react-window/issues/441 to fix this.
        const rowCount = this.props.filteredEvents.length;
        const rowHeight = 32;
        const windowHeight = listWindow.clientHeight;
        const halfHeight = windowHeight / 2;
        const rowOffset = targetIndex * rowHeight;
        const maxOffset = Math.max(0, rowCount * rowHeight - windowHeight);
        const targetOffset = rowOffset - halfHeight + rowHeight / 2;
        list.scrollTo(_.clamp(targetOffset, 0, maxOffset));

        // Focus the list so keyboard navigation works from here
        if (focusList) listWindow.focus();
    }

    public scrollToEnd() {
        const { events, filteredEvents, sort } = this.props;

        if (sort) {
            // wirepane: the newest request isn't at the end of a sorted list: go to its row
            const shownEvents = new Set<CollectedEvent>(filteredEvents);
            const newestEvent = _.findLast(events, (event) => shownEvents.has(event));
            if (newestEvent) this.scrollToCenterEvent(newestEvent, false);
            return;
        }

        this.listRef.current?.scrollToItem(filteredEvents.length, 'start');
    }

    onListMouseDown = (mouseEvent: React.MouseEvent) => {
        if (mouseEvent.button !== 0) return; // Left clicks only

        let row: Element | null = mouseEvent.target as Element;
        let ariaRowIndex: string | null = null;

        // Climb up until we find the row, or the container
        while (ariaRowIndex === null && row && row !== this.listBodyRef.current) {
            // Be a little careful - React thinks event targets might not have getAttribute
            ariaRowIndex = row.getAttribute && row.getAttribute('aria-rowindex');
            row = row.parentElement;
        }

        if (!ariaRowIndex) return;

        const eventIndex = parseInt(ariaRowIndex, 10) - 1;
        const event = this.props.filteredEvents[eventIndex];
        if (!event) return;

        if (mouseEvent.shiftKey) {
            // Shift+Click: range select from anchor to clicked row
            mouseEvent.preventDefault(); // Prevent text selection
            this.props.onRangeSelected(event);
        } else if (isCmdCtrlPressed(mouseEvent)) {
            // Ctrl/Cmd+Click: toggle individual row
            this.props.onToggleSelected(event);
        } else {
            // Plain click: single select, or deselect if it's the only selected item
            if (
                this.props.selectedEventIds.size === 1 &&
                this.props.selectedEventIds.has(event.id)
            ) {
                this.props.onClearSelection();
            } else {
                this.props.onSelected(event);
            }
        }
    }

    @action.bound
    onKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
        const { moveSelection } = this.props;
        const isShift = event.shiftKey;

        switch (event.key) {
            case 'ArrowDown':
                moveSelection(1, isShift);
                break;
            case 'ArrowUp':
                moveSelection(-1, isShift);
                break;
            case 'PageUp':
                moveSelection(-10, isShift);
                break;
            case 'PageDown':
                moveSelection(10, isShift);
                break;
            case 'Home':
                moveSelection(-Infinity, isShift);
                break;
            case 'End':
                moveSelection(Infinity, isShift);
                break;
            case 'Escape':
                this.props.onClearSelection();
                break;
            case 'a':
                if (isCmdCtrlPressed(event)) {
                    this.props.onSelectAll();
                } else {
                    return;
                }
                break;
            default:
                return;
        }

        event.preventDefault();
    }
}
