import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { distanceInWordsToNow } from 'date-fns';
import { CaretRight, GlobeSimple } from '@phosphor-icons/react';

import { styled, css } from '../../styles';
import { Icon } from '../../icons';
import { copyToClipboard } from '../../util/ui';
import { logError } from '../../errors';

import { UiStore } from '../../model/ui/ui-store';
import { ContextMenuItem } from '../../model/ui/context-menu';
import { AppCount } from '../../model/devices/device-tracker';
import { DevicesStore, DeviceSummary } from '../../model/devices/devices-store';
import { MAX_DEVICE_NAME_LENGTH } from '../../model/devices/device-names';

import { DeviceIcon } from './device-icon';
import { VpnBadge } from './vpn-badge';
import { VpnNetworkLink } from './vpn-network-link'; // wirepane
import {
    DeviceTreeRow,
    SelectableRow,
    buildDeviceTreeRows,
    isSelectableRow,
    parentRowIndex,
    rowSelection,
    selectionRowId
} from './device-tree-rows';

const INDENT = 22; // Lines child rows up with their device's name

const TreeRoot = styled.div`
    padding: 2px 6px 8px;
    outline: none;

    &:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: -2px;
    }
`;

const Row = styled.div<{ depth: number, isSelected: boolean, isTall: boolean }>`
    position: relative;
    min-height: ${p => p.isTall ? 40 : 28}px;
    padding-left: ${p => 2 + p.depth * INDENT}px;
    padding-right: 6px;
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
            top: 6px;
            bottom: 6px;
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

            .row-secondary, .row-icon, .row-chevron {
                color: ${p => p.theme.selectionColor};
            }

            .row-dot {
                background-color: ${p => p.theme.selectionColor};
            }
        }
    `}
`;

const Chevron = styled.span<{ isExpanded: boolean, isHidden: boolean }>`
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    border-radius: 4px;

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

const RowText = styled.span`
    flex: 1 1 auto;
    min-width: 0;
    padding-left: 2px;

    display: flex;
    flex-direction: column;
    gap: 1px;
`;

const RowLabel = styled.span<{ isMuted?: boolean }>`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    ${p => p.isMuted && css`
        color: ${p => p.theme.mainLowlightColor};
    `}
`;

// wirepane: next to a device's name, so the narrow panel doesn't cut it off with the address
const RowNameLine = styled.span`
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 5px;
`;

const RowAddress = styled.span`
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.tinyTextSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const ActiveDot = styled.span`
    flex-shrink: 0;
    width: 7px;
    height: 7px;
    margin: 0 2px;
    border-radius: 50%;
    background-color: ${p => p.theme.popColor};
`;

const RowCount = styled.span`
    flex-shrink: 0;
    min-width: 20px;
    padding-left: 4px;
    text-align: right;

    font-size: ${p => p.theme.smallPrintSize};
    font-variant-numeric: tabular-nums;
    color: ${p => p.theme.mainLowlightColor};
`;

const GroupHeading = styled.div`
    padding: 6px 6px 2px ${2 + INDENT + 4}px;

    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const MoreText = styled.div`
    padding: 2px 6px 4px ${2 + INDENT + 4}px;

    font-size: ${p => p.theme.tinyTextSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};
`;

const RenameInput = styled.input`
    width: 100%;
    height: 22px;
    padding: 0 5px;
    box-sizing: border-box;

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.inputColor};
    background-color: ${p => p.theme.inputBackground};
    border: 1px solid ${p => p.theme.inputBorder};
    border-radius: 4px;

    &:focus-visible {
        outline-offset: 0;
    }
`;

const requestCount = (count: number) => `${count.toLocaleString()} request${count === 1 ? '' : 's'}`;

// The device row's tooltip: its full name, its default name if renamed, its IP & when it was last heard from
function deviceTooltip(device: DeviceSummary, isActive: boolean) {
    return [
        device.name,
        device.hasCustomName ? device.defaultName : undefined,
        device.address,
        device.eventCount === 0
            ? 'no requests yet'
            : isActive
                ? 'active in the last minute'
                : `last request ${distanceInWordsToNow(device.lastSeen, { addSuffix: true })}`
    ].filter(Boolean).join(' · ');
}

// Types the new name right in the row: Enter saves, Escape cancels, clicking away saves
const RenameField = (props: {
    initialValue: string,
    label: string,
    onFinish: (newName: string | undefined, byKeyboard: boolean) => void
}) => {
    const inputRef = React.useRef<HTMLInputElement>(null);
    const isFinished = React.useRef(false);

    React.useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    const finish = (save: boolean, byKeyboard: boolean) => {
        if (isFinished.current) return;
        isFinished.current = true;
        props.onFinish(save ? (inputRef.current?.value ?? '') : undefined, byKeyboard);
    };

    // The row's own click & key handlers would select or move instead
    const stop = (event: React.SyntheticEvent) => event.stopPropagation();

    return <RenameInput
        ref={inputRef}
        defaultValue={props.initialValue}
        aria-label={props.label}
        maxLength={MAX_DEVICE_NAME_LENGTH}
        spellCheck={false}
        onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
                event.preventDefault();
                finish(true, true);
            } else if (event.key === 'Escape') {
                event.preventDefault();
                finish(false, true);
            }
        }}
        onBlur={() => finish(true, false)}
        onMouseDown={stop}
        onClick={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
    />;
};

// The app's Source column icon, in the row's colour so it reads on any background
const AppIcon = (props: { app: AppCount }) => {
    const { icon } = props.app.icon;
    const isFontAwesome = Array.isArray(icon);
    return <Icon
        icon={icon}
        color='currentColor'
        size={isFontAwesome ? undefined : '1.15em'}
        fixedWidth={isFontAwesome}
    />;
};

function describeRow(row: SelectableRow, isActive: boolean): string {
    switch (row.kind) {
        case 'all':
            return `All devices, ${requestCount(row.count)}`;
        case 'device': {
            const { device } = row;
            return [
                device.name,
                device.address,
                device.viaVpn ? 'through the VPN' : undefined,
                requestCount(device.eventCount),
                isActive ? 'active in the last minute' : undefined
            ].filter(Boolean).join(', ');
        }
        case 'app':
            return `App ${row.app.name}, ${requestCount(row.app.count)}`;
        case 'host':
            return `Domain ${row.host.host}, ${requestCount(row.host.count)}`;
    }
}

/**
 * The devices as a tree: All devices, this machine, then each phone or computer, which
 * opens to show its apps and busiest domains. Selecting a row filters View's list.
 * It's one focusable tree, like the collections tree: arrow keys move the selection,
 * Enter opens & closes a device, F2 renames it, and every row has a right-click menu.
 */
export const DeviceTree = observer((props: {
    devicesStore: DevicesStore,
    uiStore: UiStore
}) => {
    const { devicesStore: store, uiStore } = props;
    const treeRef = React.useRef<HTMLDivElement>(null);
    const treeId = React.useId();
    const [renamingKey, setRenamingKey] = React.useState<string | undefined>();

    const rows = buildDeviceTreeRows({
        totalCount: store.totalEventCount,
        thisMachine: store.thisMachine,
        otherDevices: store.otherDevices,
        selection: store.selection,
        isExpanded: (deviceKey) => store.isExpanded(deviceKey)
    });
    const selectableRows = rows.filter(isSelectableRow);
    const selectedId = selectionRowId(store.selection);
    const selectedIndex = selectableRows.findIndex((row) => row.id === selectedId);
    const domId = (row: DeviceTreeRow) => `${treeId}-row-${rows.indexOf(row)}`;

    // Keyboard selection keeps the selected row in view
    React.useEffect(() => {
        const selected = selectableRows[selectedIndex];
        if (selected) document.getElementById(domId(selected))?.scrollIntoView({ block: 'nearest' });
    }, [selectedId]);

    // A device that's gone (e.g. after Clear) can't be renamed any more
    const isRenamingVisible = !!renamingKey && rows.some((row) => row.kind === 'device' && row.device.key === renamingKey);
    React.useEffect(() => {
        if (renamingKey && !isRenamingVisible) setRenamingKey(undefined);
    }, [renamingKey, isRenamingVisible]);

    const select = (row: SelectableRow) => store.select(rowSelection(row));

    const setExpanded = (device: DeviceSummary, expanded: boolean) => {
        // Closing a device moves a selection inside it up to the device itself
        const { selection } = store;
        if (!expanded && selection?.deviceKey === device.key && (selection.app !== undefined || selection.host !== undefined)) {
            store.select({ deviceKey: device.key });
        }
        store.setExpanded(device.key, expanded);
    };

    const toggle = (row: Extract<DeviceTreeRow, { kind: 'device' }>) => {
        if (row.isExpandable) setExpanded(row.device, !row.isExpanded);
    };

    const finishRename = (deviceKey: string, newName: string | undefined, byKeyboard: boolean) => {
        if (newName !== undefined) store.rename(deviceKey, newName);
        setRenamingKey(undefined);
        // Clicking away goes wherever was clicked. Enter & Escape come back to the tree.
        if (byKeyboard) treeRef.current?.focus();
    };

    const menuFor = (row: SelectableRow): ContextMenuItem<void>[] => {
        if (row.kind === 'device') {
            const { device } = row;
            return [
                { type: 'option', label: 'Rename', accelerator: 'F2', callback: () => setRenamingKey(device.key) },
                { type: 'option', label: 'Show only this device', callback: () => store.select({ deviceKey: device.key }) },
                { type: 'option', label: 'Forget name', enabled: device.hasCustomName, callback: () => store.forgetName(device.key) },
                ...(device.address
                    ? [
                        { type: 'separator' } as const,
                        {
                            type: 'option',
                            label: 'Copy IP address',
                            callback: () => { copyToClipboard(device.address!).catch(logError); }
                        } as const
                    ]
                    : []
                )
            ];
        } else if (row.kind === 'app' || row.kind === 'host') {
            return [
                { type: 'option', label: row.kind === 'app' ? 'Show only this app' : 'Show only this domain', callback: () => select(row) },
                { type: 'option', label: 'Show only this device', callback: () => store.select({ deviceKey: row.deviceKey }) }
            ];
        }
        return [];
    };

    const showMenu = (event: React.MouseEvent, row: SelectableRow) => {
        const items = menuFor(row);
        if (items.length) uiStore.handleContextMenuEvent(event, items);
        else event.preventDefault();
    };

    const moveTo = (index: number) => {
        const row = selectableRows[Math.max(0, Math.min(selectableRows.length - 1, index))];
        if (row) select(row);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.target !== event.currentTarget) return; // E.g. typing a new name

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
                    if (row.kind === 'device' && row.isExpandable && !row.isExpanded) setExpanded(row.device, true);
                    else if (row.kind === 'device' && row.isExpanded) moveTo(selectedIndex + 1);
                    return true;
                case 'ArrowLeft':
                    if (row.kind === 'device' && row.isExpanded) setExpanded(row.device, false);
                    else {
                        const parent = rows[parentRowIndex(rows, rows.indexOf(row))];
                        if (parent) moveTo(selectableRows.findIndex((candidate) => candidate.id === parent.id));
                    }
                    return true;
                case 'Enter':
                case ' ':
                    if (row.kind === 'device') toggle(row);
                    return true;
                case 'F2':
                    if (row.kind === 'device') setRenamingKey(row.device.key);
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
        aria-label='Devices'
        tabIndex={0}
        aria-activedescendant={selectedRow ? domId(selectedRow) : undefined}
        onKeyDown={onKeyDown}
        onContextMenu={(event) => {
            // The keyboard's menu key (or Shift+F10) opens the selected row's menu
            if (event.target === event.currentTarget && selectedRow) showMenu(event, selectedRow);
        }}
    >
        { rows.map((row) => {
            if (row.kind === 'heading') {
                return <GroupHeading key={row.id} role='none' aria-hidden={true}>{ row.label }</GroupHeading>;
            }
            if (row.kind === 'more') {
                return <MoreText key={row.id} role='none'>{ row.text }</MoreText>;
            }

            const isSelected = row.id === selectedId;
            const isActive = row.kind === 'device' && store.isActive(row.device);
            const isRenaming = row.kind === 'device' && row.device.key === renamingKey;

            return <Row
                key={row.id}
                id={domId(row)}
                role='treeitem'
                aria-level={row.depth + 1}
                aria-selected={isSelected}
                aria-expanded={row.kind === 'device' && row.isExpandable ? row.isExpanded : undefined}
                aria-label={describeRow(row, isActive)}
                depth={row.depth}
                isSelected={isSelected}
                isTall={row.kind === 'device'}
                title={row.kind === 'device' ? deviceTooltip(row.device, isActive) : undefined}
                onMouseDown={() => treeRef.current?.focus()}
                onClick={() => select(row)}
                onDoubleClick={() => { if (row.kind === 'device') toggle(row); }}
                onContextMenu={(event) => {
                    event.stopPropagation();
                    showMenu(event, row);
                }}
            >
                { row.depth === 0 && <Chevron
                    className='row-chevron'
                    isExpanded={row.kind === 'device' && row.isExpanded}
                    isHidden={row.kind !== 'device' || !row.isExpandable}
                    onClick={(event) => {
                        if (row.kind !== 'device') return;
                        event.stopPropagation(); // Opens & closes without changing the selection
                        toggle(row);
                    }}
                >
                    <CaretRight size={12} weight='bold' />
                </Chevron> }

                <RowIcon className='row-icon'>
                    { row.kind === 'all' && <DeviceIcon type='all' /> }
                    { row.kind === 'device' && <DeviceIcon type={row.device.type} /> }
                    { row.kind === 'app' && <AppIcon app={row.app} /> }
                    { row.kind === 'host' && <GlobeSimple size={15} aria-hidden={true} /> }
                </RowIcon>

                <RowText>
                    { row.kind === 'all' && <RowLabel>All devices</RowLabel> }
                    { row.kind === 'device' && <>
                        { isRenaming
                            ? <RenameField
                                initialValue={row.device.name}
                                label={`New name for ${row.device.name}`}
                                onFinish={(newName, byKeyboard) => finishRename(row.device.key, newName, byKeyboard)}
                            />
                            : <RowNameLine>
                                <RowLabel isMuted={row.device.eventCount === 0}>{ row.device.name }</RowLabel>
                                { row.device.viaVpn && <VpnBadge title={`Connected ${store.describeDeviceVpn(row.device)}`}>VPN</VpnBadge> }
                                { row.device.viaVpn && <VpnNetworkLink deviceName={row.device.name} /> /* wirepane */ }
                            </RowNameLine>
                        }
                        <RowAddress className='row-secondary'>{ row.device.address ?? 'localhost' }</RowAddress>
                    </> }
                    { row.kind === 'app' && <RowLabel title={row.app.detail ? `${row.app.name}\n${row.app.detail}` : row.app.name}>{ row.app.name }</RowLabel> }
                    { row.kind === 'host' && <RowLabel title={row.host.host}>{ row.host.host }</RowLabel> }
                </RowText>

                { isActive && <ActiveDot className='row-dot' title='Sent a request in the last minute' /> }

                <RowCount className='row-secondary'>
                    { (row.kind === 'all'
                        ? row.count
                        : row.kind === 'device'
                            ? row.device.eventCount
                            : row.kind === 'app'
                                ? row.app.count
                                : row.host.count
                    ).toLocaleString() }
                </RowCount>
            </Row>;
        }) }
    </TreeRoot>;
});
