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
    TableHeaderRow,
    MarkerHeader,
    Method,
    Status,
    Source,
    Host,
    PathAndQuery,
    RowMarker,
    RowPin
} from './event-rows/event-row-components';
import { EventRow, EventRowProps } from './event-rows/event-row';

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

    /* The selection fill shows focus, so the list only gets an outline when no row is active */
    & > div > div[tabindex="0"]:focus:not(:focus-visible),
    & > div > div[tabindex="0"]:focus-visible:has(.active) {
        outline: none;
    }

    /* When focused via keyboard and no active row is visible, ring the list (inside, so it isn't clipped) */
    & > div > div[tabindex="0"]:focus-visible:not(:has(.active)) {
        outline-offset: -2px;
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
            <TableHeaderRow role="row">
                <MarkerHeader role="columnheader" aria-label="Category" />
                <Method role="columnheader">Method</Method>
                <Status role="columnheader">Status</Status>
                <Source role="columnheader">Source</Source>
                <Host role="columnheader">Host</Host>
                <PathAndQuery role="columnheader">Path and query</PathAndQuery>
            </TableHeaderRow>

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
                        No requests match this search filter{
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

    componentDidUpdate() {
        const eventCount = this.props.events.length;
        const eventsAdded = eventCount > this.lastEventCount;
        this.lastEventCount = eventCount;

        // If new events arrived while we were at the bottom, stay at the bottom.
        // Only check when events were actually added — not on selection changes,
        // which would fight with moveSelection's scroll.
        if (eventsAdded && this.wasListAtBottom && !this.isListAtBottom()) {
            this.listRef.current?.scrollToItem(eventCount - 1);
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

    public scrollToCenterEvent(event: CollectedEvent) {
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
        listWindow.focus();
    }

    public scrollToEnd() {
        this.listRef.current?.scrollToItem(this.props.filteredEvents.length, 'start');
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
