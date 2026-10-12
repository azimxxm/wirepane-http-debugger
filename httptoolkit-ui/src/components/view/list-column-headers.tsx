import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { runInAction } from 'mobx';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { ArrowDown, ArrowUp, CaretDown, Check, FunnelSimple } from '@phosphor-icons/react';

import { styled } from '../../styles';
import { CollectedEvent } from '../../types';

import { UiStore } from '../../model/ui/ui-store';
import { DevicesStore } from '../../model/devices/devices-store';
import {
    LIST_COLUMN_DESCRIPTIONS,
    LIST_COLUMN_LABELS,
    ListColumn,
    ListColumnsStore,
    ListFilterMenuAnchor,
    SortColumn
} from '../../model/ui/list-columns-store';
import {
    ColumnFilterOption,
    FILTER_COLUMN_LABELS,
    FilterColumn,
    getColumnFilterOptions,
    getColumnFilters,
    getEventsForColumnMenu,
    getHostContainsFilterString,
    toggleColumnFilter
} from '../../model/filters/column-filters';

import { UnstyledButton } from '../common/inputs';
import { FixedColumn } from './event-rows/list-columns';
import { SORT_COLUMN_LABELS } from './list-sort';

/*
 * Wirepane: the list's column headers. Clicking a header sorts by it (ascending,
 * descending, then back to the time order). Method, Status, Type, Source & Host also have
 * a filter menu, from the small button on the header or a right-click on it. A pick there
 * is a normal filter, so it shows as a chip in the filter bar.
 */

const MENU_WIDTH = 260;
const VIEWPORT_MARGIN = 8;

const HeaderContent = styled.span`
    display: inline-flex;
    align-items: center;
    max-width: 100%;
    gap: 3px;
    vertical-align: middle;
`;

const HeaderLabel = styled.span`
    overflow: hidden;
    text-overflow: ellipsis;
`;

const SortArrow = styled.span`
    flex: 0 0 auto;
    display: inline-flex;
    color: ${p => p.theme.popColor};
`;

// Sits over the end of the header cell. Only shown while the header is hovered or has
// focus, or the column is filtered or its menu is open, so it doesn't crowd the labels.
const FilterButton = styled(UnstyledButton)`
    position: absolute;
    right: 0;
    top: 50%;
    transform: translateY(-50%);

    width: 15px;
    height: 22px;
    padding: 0;
    border-radius: 4px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    background-color: ${p => p.theme.mainLowlightBackground};
    color: ${p => p.theme.mainLowlightColor};

    opacity: 0;

    [role=columnheader]:hover > &,
    [role=columnheader]:focus-within > &,
    &[aria-expanded='true'],
    &[data-filtered='true'] {
        opacity: 1;
    }

    &:hover, &[aria-expanded='true'] {
        background-color: ${p => p.theme.rowHover};
        color: ${p => p.theme.mainColor};
    }

    &[data-filtered='true'] {
        color: ${p => p.theme.popColor};
    }

    &:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: -2px;
    }
`;

const ariaSort = (sortedBy: 'asc' | 'desc' | undefined) =>
    sortedBy === 'asc' ? 'ascending' : sortedBy === 'desc' ? 'descending' : 'none';

interface ColumnHeaderProps {
    // The styled cell that sets the column's width, like Method or FixedColumn
    Cell: React.ComponentType<any>;
    cellProps?: object;
    sortColumn: SortColumn;
    label: string;
    description?: string;
    filterColumn?: FilterColumn;

    listColumnsStore?: ListColumnsStore;
    uiStore?: UiStore;
}

export const ColumnHeader = inject('listColumnsStore', 'uiStore')(observer((p: ColumnHeaderProps) => {
    const store = p.listColumnsStore!;
    const { filterColumn, sortColumn, label } = p;
    const { Cell } = p;

    const sort = store.sort?.column === sortColumn ? store.sort.direction : undefined;
    const activeFilter = filterColumn
        ? getColumnFilters(p.uiStore!.activeFilterSet, filterColumn)[0]
        : undefined;
    const isMenuOpen = !!filterColumn && store.filterMenu?.column === filterColumn;

    const openMenu = (x: number, y: number) => {
        if (filterColumn) store.openFilterMenu({ column: filterColumn, x, y });
    };

    const title = [
        p.description ?? label,
        sort ? `Sorted ${sort === 'asc' ? 'ascending' : 'descending'}` : undefined,
        activeFilter ? `Filtered: ${activeFilter.toString()}` : undefined,
        sort === 'desc'
            ? 'Click to go back to the time order'
            : `Click to sort by ${SORT_COLUMN_LABELS[sortColumn].toLowerCase()}`
    ].filter(Boolean).join('. ');

    return <Cell
        {...p.cellProps}
        role='columnheader'
        tabIndex={0}
        aria-sort={ariaSort(sort)}
        aria-label={activeFilter ? `${label}, filtered: ${activeFilter.toString()}` : undefined}
        data-column={sortColumn}
        title={title}
        onClick={() => store.cycleSort(sortColumn)}
        onKeyDown={(event: React.KeyboardEvent) => {
            if (event.target !== event.currentTarget) return; // Keys on the filter button are its own
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                store.cycleSort(sortColumn);
            } else if (filterColumn && event.key === 'ArrowDown' && event.altKey) {
                event.preventDefault();
                const bounds = event.currentTarget.getBoundingClientRect();
                openMenu(bounds.left, bounds.bottom);
            }
        }}
        onContextMenu={filterColumn && ((event: React.MouseEvent) => {
            // The other headers leave this to the row, which opens the columns menu
            event.preventDefault();
            event.stopPropagation();
            openMenu(event.clientX, event.clientY);
        })}
    >
        <HeaderContent>
            <HeaderLabel>{ label }</HeaderLabel>
            { sort && <SortArrow aria-hidden={true}>
                { sort === 'asc' ? <ArrowUp size={11} weight='bold' /> : <ArrowDown size={11} weight='bold' /> }
            </SortArrow> }
        </HeaderContent>
        { filterColumn && <FilterButton
            aria-label={activeFilter
                ? `Filter ${label}, now ${activeFilter.toString()}`
                : `Filter by ${label.toLowerCase()}`
            }
            title={activeFilter ? `Filtered: ${activeFilter.toString()}` : `Filter by ${label.toLowerCase()}`}
            aria-haspopup='menu'
            aria-expanded={isMenuOpen}
            data-filtered={!!activeFilter}
            onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
                event.stopPropagation(); // Not a click on the header, which sorts
                if (isMenuOpen) {
                    store.closeFilterMenu();
                } else {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    openMenu(bounds.left, bounds.bottom + 4);
                }
            }}
            onKeyDown={(event: React.KeyboardEvent) => event.stopPropagation()}
        >
            { activeFilter
                ? <FunnelSimple size={13} weight='fill' aria-hidden={true} />
                : <CaretDown size={12} weight='bold' aria-hidden={true} />
            }
        </FilterButton> }
    </Cell>;
}));

// --- The filter menu ---

const MenuPanel = styled.div`
    position: fixed;
    z-index: 1000;
    width: ${MENU_WIDTH}px;
    max-height: min(440px, calc(100vh - ${VIEWPORT_MARGIN * 2}px));
    overflow-y: auto;
    box-sizing: border-box;
    padding: 6px;

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

const MenuHeading = styled.h2`
    padding: 4px 8px 6px;
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const MenuNote = styled.p`
    padding: 4px 8px 6px;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const MenuItem = styled(UnstyledButton)`
    width: 100%;
    box-sizing: border-box;
    padding: 5px 8px;
    border-radius: 6px;

    display: grid;
    grid-template-columns: 16px minmax(0, 1fr) auto;
    column-gap: 6px;
    align-items: center;
    text-align: left;

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    &[aria-checked='true'] {
        font-weight: 600;
    }

    &:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: -2px;
    }
`;

const ItemCheck = styled.span`
    display: inline-flex;
    color: ${p => p.theme.popColor};
`;

const ItemLabel = styled.span`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
`;

const ItemCount = styled.span`
    font-size: ${p => p.theme.smallPrintSize};
    font-variant-numeric: tabular-nums;
    color: ${p => p.theme.mainLowlightColor};
`;

const MenuDivider = styled.hr`
    border: none;
    border-top: 1px solid ${p => p.theme.containerBorder};
    margin: 6px -6px;
`;

const ContainsInput = styled.input`
    width: 100%;
    box-sizing: border-box;
    margin: 0 0 2px;
    padding: 5px 8px;

    border: 1px solid ${p => p.theme.inputBorder};
    border-radius: 6px;
    background-color: ${p => p.theme.inputBackground};
    color: ${p => p.theme.highlightColor};
    font-family: inherit;
    font-size: inherit;

    &:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: -1px;
    }
`;

const MENU_ITEM_SELECTOR = '[data-menu-item]';

function placeMenu(menu: ListFilterMenuAnchor, height: number): { left: number, top: number } {
    const maxLeft = window.innerWidth - MENU_WIDTH - VIEWPORT_MARGIN;
    const maxTop = window.innerHeight - height - VIEWPORT_MARGIN;
    return {
        left: Math.max(VIEWPORT_MARGIN, Math.min(menu.x, maxLeft)),
        top: Math.max(VIEWPORT_MARGIN, Math.min(menu.y, maxTop))
    };
}

// Hands focus back to the header the menu came from
function focusHeader(column: FilterColumn) {
    document.querySelector<HTMLElement>(`[role=columnheader][data-column='${column}']`)?.focus();
}

interface FilterMenuProps {
    menu: ListFilterMenuAnchor;
    events: ReadonlyArray<CollectedEvent>;
    listColumnsStore?: ListColumnsStore;
    uiStore?: UiStore;
    devicesStore?: DevicesStore;
}

const FilterMenu = inject('listColumnsStore', 'uiStore', 'devicesStore')(observer((p: FilterMenuProps) => {
    const store = p.listColumnsStore!;
    const uiStore = p.uiStore!;
    const { menu, events } = p;
    const { column } = menu;
    const label = FILTER_COLUMN_LABELS[column];

    const panelRef = React.useRef<HTMLDivElement>(null);
    const [position, setPosition] = React.useState<{ left: number, top: number } | undefined>();
    const [containsText, setContainsText] = React.useState('');
    const [containsInvalid, setContainsInvalid] = React.useState(false);

    const filterSet = uiStore.activeFilterSet;
    const activeFilter = getColumnFilters(filterSet, column)[0];
    const activeText = activeFilter?.serialize();

    // Counts are for what each pick would show, with the other filters kept
    const eventCount = events.length;
    const options = React.useMemo((): ColumnFilterOption[] => {
        const counted = getEventsForColumnMenu(events, filterSet, column, p.devicesStore!.selectionFilter);
        const found = getColumnFilterOptions(column, counted);

        // A picked value with no events left (or typed in the filter box) stays listed
        return activeFilter && !found.some((option) => option.filterString === activeText)
            ? [{ filterString: activeText!, label: activeFilter.toString(), count: 0 }, ...found]
            : found;
    }, [eventCount, filterSet, column]);

    // Placed once it has rendered, when its real height is known
    React.useLayoutEffect(() => {
        const panel = panelRef.current;
        if (!panel) return;
        setPosition(placeMenu(menu, panel.offsetHeight));
        const items = Array.from(panel.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR));
        (items.find((item) => item.getAttribute('aria-checked') === 'true') ?? items[0])?.focus();
    }, [menu]);

    React.useEffect(() => {
        const closeOnOutsidePointer = (event: MouseEvent) => {
            if (panelRef.current?.contains(event.target as Node)) return;
            // The filter button toggles it itself
            if ((event.target as Element).closest?.('[aria-haspopup=menu][aria-expanded=true]')) return;
            store.closeFilterMenu();
        };
        const close = () => store.closeFilterMenu();

        document.addEventListener('mousedown', closeOnOutsidePointer, true);
        window.addEventListener('resize', close);
        window.addEventListener('blur', close);
        return () => {
            document.removeEventListener('mousedown', closeOnOutsidePointer, true);
            window.removeEventListener('resize', close);
            window.removeEventListener('blur', close);
        };
    }, [store]);

    const applyFilter = (filterString: string | undefined) => {
        runInAction(() => {
            uiStore.activeFilterSet = toggleColumnFilter(uiStore.activeFilterSet, column, filterString);
        });
        store.closeFilterMenu();
        focusHeader(column);
    };

    const applyContains = () => {
        const filterString = getHostContainsFilterString(containsText);
        if (!filterString) {
            setContainsInvalid(containsText.trim() !== '');
            return;
        }
        // Typing the same text again keeps it, instead of toggling it off
        runInAction(() => {
            uiStore.activeFilterSet = toggleColumnFilter(
                toggleColumnFilter(uiStore.activeFilterSet, column, undefined),
                column,
                filterString
            );
        });
        store.closeFilterMenu();
        focusHeader(column);
    };

    const moveFocus = (step: number | 'first' | 'last') => {
        const items = Array.from(panelRef.current?.querySelectorAll<HTMLElement>(MENU_ITEM_SELECTOR) ?? []);
        if (items.length === 0) return;
        const current = items.indexOf(document.activeElement as HTMLElement);
        const next = step === 'first' ? 0
            : step === 'last' ? items.length - 1
            : (current + step + items.length) % items.length;
        items[next].focus();
    };

    return ReactDOM.createPortal(<MenuPanel
        ref={panelRef}
        role='menu'
        aria-label={`Filter by ${label.toLowerCase()}`}
        style={position ?? { left: -10000, top: 0 }}
        onKeyDown={(event: React.KeyboardEvent) => {
            switch (event.key) {
                case 'Escape':
                    event.preventDefault();
                    event.stopPropagation();
                    store.closeFilterMenu();
                    focusHeader(column);
                    break;
                case 'ArrowDown':
                    event.preventDefault();
                    moveFocus(1);
                    break;
                case 'ArrowUp':
                    event.preventDefault();
                    moveFocus(-1);
                    break;
                case 'Home':
                    if (event.target instanceof HTMLInputElement) return;
                    event.preventDefault();
                    moveFocus('first');
                    break;
                case 'End':
                    if (event.target instanceof HTMLInputElement) return;
                    event.preventDefault();
                    moveFocus('last');
                    break;
            }
        }}
        onBlur={(event: React.FocusEvent) => {
            // Tabbing out of the menu closes it
            const next = event.relatedTarget as Node | null;
            if (next && !panelRef.current?.contains(next)) store.closeFilterMenu();
        }}
    >
        <MenuHeading>{ `Filter by ${label.toLowerCase()}` }</MenuHeading>

        { options.length === 0 && <MenuNote>No { label.toLowerCase() } values in the requests yet.</MenuNote> }

        { options.map((option) => {
            const isPicked = option.filterString === activeText;
            return <MenuItem
                key={option.filterString}
                role='menuitemradio'
                aria-checked={isPicked}
                data-menu-item
                title={option.description}
                onClick={() => applyFilter(option.filterString)}
            >
                <ItemCheck>{ isPicked && <Check size={13} weight='bold' aria-hidden={true} /> }</ItemCheck>
                <ItemLabel>{ option.label }</ItemLabel>
                <ItemCount aria-label={`${option.count} requests`}>{ option.count }</ItemCount>
            </MenuItem>;
        }) }

        { column === 'host' && <>
            <MenuDivider />
            <ContainsInput
                type='text'
                data-menu-item
                aria-label='Host contains'
                aria-invalid={containsInvalid}
                placeholder='Host contains…'
                value={containsText}
                onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                    setContainsText(event.target.value);
                    setContainsInvalid(false);
                }}
                onKeyDown={(event: React.KeyboardEvent) => {
                    if (event.key === 'Enter') {
                        event.preventDefault();
                        applyContains();
                    }
                }}
            />
            { containsInvalid && <MenuNote role='alert'>
                Hostnames only have letters, numbers, - and .
            </MenuNote> }
        </> }

        { activeFilter && <>
            <MenuDivider />
            <MenuItem role='menuitem' data-menu-item onClick={() => applyFilter(undefined)}>
                <ItemCheck />
                <ItemLabel>Clear { label.toLowerCase() } filter</ItemLabel>
                <ItemCount />
            </MenuItem>
        </> }
    </MenuPanel>, document.body);
}));

/**
 * The open column filter menu, if any. Rendered once with the list's headers.
 */
export const ColumnFilterMenuLayer = inject('listColumnsStore')(observer((p: {
    events: ReadonlyArray<CollectedEvent>,
    listColumnsStore?: ListColumnsStore
}) => {
    const store = p.listColumnsStore!;
    const menu = store.filterMenu;

    // Leaving View closes it, so it doesn't pop up again on the way back
    React.useEffect(() => store.closeFilterMenu, [store]);

    return menu ? <FilterMenu menu={menu} events={p.events} /> : null;
}));

// --- The headers of the opt-in columns, which can be sorted but not filtered ---

const TRAILING_COLUMNS = ['time', 'duration', 'size'] as const;

export const SortableOptionalColumnHeaders = inject('listColumnsStore')(observer((p: {
    listColumnsStore?: ListColumnsStore
}) => <>
    { TRAILING_COLUMNS
        .filter((column: ListColumn) => p.listColumnsStore!.isVisible(column))
        .map((column) =>
            <ColumnHeader
                key={column}
                Cell={FixedColumn}
                cellProps={{ column }}
                sortColumn={column}
                label={LIST_COLUMN_LABELS[column]}
                description={LIST_COLUMN_DESCRIPTIONS[column]}
            />
        )
    }
</>));

export const SortableTypeColumnHeader = inject('listColumnsStore')(observer((p: {
    listColumnsStore?: ListColumnsStore
}) => p.listColumnsStore!.isVisible('type')
    ? <ColumnHeader
        Cell={FixedColumn}
        cellProps={{ column: 'type' }}
        sortColumn='type'
        filterColumn='type'
        label={LIST_COLUMN_LABELS.type}
        description={LIST_COLUMN_DESCRIPTIONS.type}
    />
    : null
));
