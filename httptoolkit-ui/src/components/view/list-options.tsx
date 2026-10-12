import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { Columns, Pencil } from '@phosphor-icons/react';

import { styled } from '../../styles';
import { Icon, WarningIcon } from '../../icons';

import {
    LIST_COLUMNS,
    LIST_COLUMN_DESCRIPTIONS,
    LIST_COLUMN_LABELS,
    ListColumnsStore,
    ListOptionsMenuAnchor
} from '../../model/ui/list-columns-store';
import {
    RowAttention,
    RowAttentionKinds,
    ROW_ATTENTION_DESCRIPTIONS,
    ROW_ATTENTION_LABELS
} from '../../model/events/row-attention';

import { DevicesStore } from '../../model/devices/devices-store';

import { UnstyledButton } from '../common/inputs';
import { TableHeaderRow } from './event-rows/event-row-components';
import { getListMinWidth, getRowAttentionColor, LIST_OPTIONS_SLOT_WIDTH } from './event-rows/list-columns';

/*
 * Wirepane: the list header's columns menu. It opens from the button at the end of the
 * header, or by right-clicking anywhere on the header, and also explains the row markers.
 */

const PANEL_WIDTH = 320;
const VIEWPORT_MARGIN = 8;

// The header row, with the scrollbar's space kept free at its end by the browser itself,
// so columns line up with the rows whatever the scrollbar looks like (overlay or not).
const HeaderRow = styled(TableHeaderRow)`
    padding-right: 0;
    scrollbar-gutter: stable;
`;

// Sticks to the right edge, so it stays reachable when the columns are wider than the list
const OptionsButton = styled(UnstyledButton)`
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    margin-left: auto;
    margin-right: ${LIST_OPTIONS_SLOT_WIDTH - 28}px;
    border-radius: 6px;

    position: sticky;
    right: 0;
    background-color: ${p => p.theme.mainLowlightBackground};

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.theme.mainLowlightColor};

    &:hover, &[aria-expanded='true'] {
        background-color: ${p => p.theme.rowHover};
        color: ${p => p.theme.mainColor};
    }

    /* Inside the button: the header clips anything past its edge */
    &:focus-visible {
        outline-offset: -2px;
    }
`;

const Panel = styled.div`
    position: fixed;
    z-index: 1000;
    width: ${PANEL_WIDTH}px;
    max-height: calc(100vh - ${VIEWPORT_MARGIN * 2}px);
    overflow-y: auto;
    box-sizing: border-box;
    padding: 12px 14px 10px;

    background-color: ${p => p.theme.highlightBackground};
    color: ${p => p.theme.mainColor};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;
    box-shadow: ${p => p.theme.floatingShadow};

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: normal;
    line-height: 1.4;
    text-align: left;
`;

const PanelHeading = styled.h2`
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;
    margin-bottom: 6px;
`;

const PanelNote = styled.p`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
    margin-bottom: 8px;
`;

const Divider = styled.hr`
    border: none;
    border-top: 1px solid ${p => p.theme.containerBorder};
    margin: 10px -14px;
`;

const ColumnOption = styled.label`
    display: grid;
    grid-template-columns: 18px 1fr;
    column-gap: 8px;
    align-items: start;
    padding: 4px 0;
    cursor: pointer;

    input {
        margin: 2px 0 0;
        width: 14px;
        height: 14px;
        accent-color: ${p => p.theme.popColor};
        cursor: pointer;
    }
`;

const OptionText = styled.span`
    display: flex;
    flex-direction: column;
`;

const OptionDescription = styled.span`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const LegendList = styled.ul`
    display: flex;
    flex-direction: column;
    gap: 6px;
`;

const LegendItem = styled.li`
    display: grid;
    grid-template-columns: 18px 1fr;
    column-gap: 8px;
    align-items: start;
`;

const LegendSymbol = styled.span`
    display: inline-flex;
    justify-content: center;
    padding-top: 2px;
    color: ${p => p.theme.mainLowlightColor};

    > svg {
        margin: 0;
    }
`;

const MarkerSwatch = styled.span<{ attention: RowAttention }>`
    display: inline-block;
    width: 3px;
    height: 14px;
    margin-top: 1px;
    border-radius: 2px;
    background-color: ${p => getRowAttentionColor(p.attention, p.theme)};
`;

const ModifiedIcon = styled(Pencil)`
    color: ${p => p.theme.popColor};
`;

const ResetButton = styled(UnstyledButton)`
    margin-top: 10px;
    padding: 2px 0;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.linkColor};
    text-decoration: underline;
`;

function placePanel(
    anchor: ListOptionsMenuAnchor,
    button: HTMLElement | null,
    panelHeight: number
): { left: number, top: number } {
    const maxLeft = window.innerWidth - PANEL_WIDTH - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - panelHeight - VIEWPORT_MARGIN;

    let left: number;
    let top: number;
    if (anchor.anchor === 'pointer' || !button) {
        left = anchor.anchor === 'pointer' ? anchor.x : maxLeft;
        top = anchor.anchor === 'pointer' ? anchor.y : VIEWPORT_MARGIN;
    } else {
        // Under the button, lined up with its right edge
        const bounds = button.getBoundingClientRect();
        left = bounds.right - PANEL_WIDTH;
        top = bounds.bottom + 4;
    }

    return {
        left: Math.max(VIEWPORT_MARGIN, Math.min(left, maxLeft)),
        top: Math.max(VIEWPORT_MARGIN, Math.min(top, maxTop))
    };
}

const ListOptionsPanel = observer((p: {
    store: ListColumnsStore,
    anchor: ListOptionsMenuAnchor,
    buttonRef: React.RefObject<HTMLButtonElement>
}) => {
    const { store, anchor, buttonRef } = p;
    const panelRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState<{ left: number, top: number } | undefined>();

    // Placed once it has rendered, when its real height is known
    React.useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;
        setPosition(placePanel(anchor, buttonRef.current, panel.offsetHeight));
        panel.querySelector<HTMLInputElement>('input')?.focus();
    }, [anchor]);

    React.useEffect(() => {
        const closeOnOutsidePointer = (event: MouseEvent) => {
            const target = event.target as Node;
            if (panelRef.current?.contains(target)) return;
            if (buttonRef.current?.contains(target)) return; // The button toggles it itself
            store.closeOptionsMenu();
        };
        const close = () => store.closeOptionsMenu();

        document.addEventListener('mousedown', closeOnOutsidePointer, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        return () => {
            document.removeEventListener('mousedown', closeOnOutsidePointer, true);
            window.removeEventListener('resize', close);
            window.removeEventListener('blur', close);
        };
    }, [store]);

    const closeAndRefocus = () => {
        store.closeOptionsMenu();
        buttonRef.current?.focus();
    };

    return ReactDOM.createPortal(<Panel
        ref={panelRef}
        role='dialog'
        aria-label='List columns and markers'
        style={position ?? { left: -10000, top: 0 }}
        onKeyDown={(event: React.KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                closeAndRefocus();
            }
        }}
        onBlur={(event: React.FocusEvent) => {
            // Tabbing out of the menu closes it
            const next = event.relatedTarget as Node | null;
            if (next && !panelRef.current?.contains(next) && !buttonRef.current?.contains(next)) {
                store.closeOptionsMenu();
            }
        }}
    >
        <PanelHeading>Columns</PanelHeading>
        <PanelNote>Method, status, source, host and path are always shown.</PanelNote>
        { LIST_COLUMNS.map((column) =>
            <ColumnOption key={column}>
                <input
                    type='checkbox'
                    checked={store.isVisible(column)}
                    onChange={() => store.toggle(column)}
                />
                <OptionText>
                    { LIST_COLUMN_LABELS[column] }
                    <OptionDescription>{ LIST_COLUMN_DESCRIPTIONS[column] }</OptionDescription>
                </OptionText>
            </ColumnOption>
        ) }
        <ResetButton onClick={store.resetToDefaults}>Reset columns</ResetButton>

        <Divider />

        <PanelHeading>Row markers</PanelHeading>
        <PanelNote>A bar at the start of a row only shows when a request needs a look.</PanelNote>
        <LegendList>
            { RowAttentionKinds.map((kind) =>
                <LegendItem key={kind}>
                    <LegendSymbol><MarkerSwatch attention={kind} /></LegendSymbol>
                    <OptionText>
                        { ROW_ATTENTION_LABELS[kind] }
                        <OptionDescription>{ ROW_ATTENTION_DESCRIPTIONS[kind] }</OptionDescription>
                    </OptionText>
                </LegendItem>
            ) }
            <LegendItem>
                <LegendSymbol><ModifiedIcon size={14} aria-hidden={true} /></LegendSymbol>
                <OptionText>
                    Pencil, next to the source
                    <OptionDescription>a rule changed this request, see Modify</OptionDescription>
                </OptionText>
            </LegendItem>
            <LegendItem>
                <LegendSymbol><WarningIcon aria-hidden={true} /></LegendSymbol>
                <OptionText>
                    Warning, as the status
                    <OptionDescription>paused at a breakpoint, open it to resume</OptionDescription>
                </OptionText>
            </LegendItem>
            <LegendItem>
                <LegendSymbol><Icon icon={['fas', 'thumbtack']} /></LegendSymbol>
                <OptionText>
                    Pin
                    <OptionDescription>pinned, so clearing the list keeps it</OptionDescription>
                </OptionText>
            </LegendItem>
        </LegendList>
    </Panel>, document.body);
});

const ListOptionsButton = observer((p: { store: ListColumnsStore }) => {
    const { store } = p;
    const buttonRef = React.useRef<HTMLButtonElement>(null);
    const menu = store.optionsMenu;

    // Leaving View closes it, so it doesn't pop up again on the way back
    React.useEffect(() => store.closeOptionsMenu, [store]);

    return <>
        <OptionsButton
            ref={buttonRef}
            aria-label='Columns and markers'
            title='Choose columns, and see what the row markers mean. You can also right-click the header.'
            aria-haspopup='dialog'
            aria-expanded={!!menu}
            onClick={() => menu ? store.closeOptionsMenu() : store.openOptionsMenu()}
        >
            <Columns size={16} aria-hidden={true} />
        </OptionsButton>
        { menu && <ListOptionsPanel store={store} anchor={menu} buttonRef={buttonRef} /> }
    </>;
});

// When the columns don't fit, the rows scroll sideways inside the list, and the header
// (outside the list's scroll area) follows them.
function useHeaderFollowsListScroll(headerRef: React.RefObject<HTMLDivElement>) {
    React.useEffect(() => {
        const grid = headerRef.current?.parentElement;
        if (!grid) return;

        let listScrollLeft = 0;
        const followScroll = (event: Event) => {
            const header = headerRef.current;
            const target = event.target as HTMLElement;
            if (!header || !grid.contains(target)) return;

            // The list leads. The header only scrolls by itself when focus moves into it (the
            // sticky columns button), which would leave it out of line with the rows.
            if (target !== header) listScrollLeft = target.scrollLeft;
            if (header.scrollLeft !== listScrollLeft) header.scrollLeft = listScrollLeft;
        };

        // Scroll events don't bubble, but they can be caught on the way down
        grid.addEventListener('scroll', followScroll, true);
        return () => grid.removeEventListener('scroll', followScroll, true);
    }, []);
}

/**
 * The list's header row: the column headers, then the columns button. Right-clicking
 * anywhere on it opens the same menu at the pointer. It also tells the rows (through a CSS
 * variable on the list) how wide they need to be for the visible columns.
 */
export const ListHeaderRow = inject('listColumnsStore', 'devicesStore')(observer((p: {
    listColumnsStore?: ListColumnsStore,
    devicesStore?: DevicesStore,
    children: React.ReactNode
}) => {
    const store = p.listColumnsStore!;
    const headerRef = React.useRef<HTMLDivElement>(null);

    const minWidth = getListMinWidth(
        (column) => store.isVisible(column),
        p.devicesStore!.showDeviceMarkers
    );
    React.useLayoutEffect(() => {
        headerRef.current?.parentElement?.style.setProperty('--wp-list-min-width', `${minWidth}px`);
    }, [minWidth]);

    useHeaderFollowsListScroll(headerRef);

    return <HeaderRow
        ref={headerRef}
        role='row'
        onContextMenu={(event: React.MouseEvent) => {
            event.preventDefault();
            store.openOptionsMenu({ x: event.clientX, y: event.clientY });
        }}
    >
        { p.children }
        <ListOptionsButton store={store} />
    </HeaderRow>;
}));
