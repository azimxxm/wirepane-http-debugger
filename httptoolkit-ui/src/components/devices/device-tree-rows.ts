import type { AppCount } from '../../model/devices/device-tracker';
import type { DeviceHost, DeviceSummary } from '../../model/devices/devices-store';
import type { DeviceSelection } from '../../model/devices/device-selection-filter';

/**
 * The Devices panel as a flat list of visible rows, which is what keyboard navigation
 * walks through: All devices, the pinned devices, this machine, then each device with
 * (when it's open) its apps and its busiest domains.
 */

// Opened devices list their busiest apps & domains, so a chatty phone stays short
export const MAX_APP_ROWS = 8;
export const MAX_HOST_ROWS = 8;

export type DeviceTreeRow =
    | { kind: 'all', id: string, depth: 0, count: number }
    | { kind: 'device', id: string, depth: 0, device: DeviceSummary, isExpandable: boolean, isExpanded: boolean, isPinned: boolean }
    | { kind: 'divider', id: string, depth: 0 }
    | { kind: 'heading', id: string, depth: 1, label: string }
    | { kind: 'app', id: string, depth: 1, deviceKey: string, app: AppCount }
    | { kind: 'host', id: string, depth: 1, deviceKey: string, host: DeviceHost }
    | { kind: 'more', id: string, depth: 1, text: string };

export type SelectableRow = Extract<DeviceTreeRow, { kind: 'all' | 'device' | 'app' | 'host' }>;

export const isSelectableRow = (row: DeviceTreeRow): row is SelectableRow =>
    row.kind === 'all' || row.kind === 'device' || row.kind === 'app' || row.kind === 'host';

export const ALL_DEVICES_ROW_ID = 'all';
const deviceRowId = (deviceKey: string) => `device:${deviceKey}`;
const appRowId = (deviceKey: string, app: string) => `app:${deviceKey}:${app}`;
const hostRowId = (deviceKey: string, host: string) => `host:${deviceKey}:${host}`;

// The id of the row that shows a selection
export function selectionRowId(selection: DeviceSelection | undefined): string {
    if (!selection) return ALL_DEVICES_ROW_ID;
    if (selection.app !== undefined) return appRowId(selection.deviceKey, selection.app);
    if (selection.host !== undefined) return hostRowId(selection.deviceKey, selection.host);
    return deviceRowId(selection.deviceKey);
}

// What selecting a row shows: undefined means every device
export function rowSelection(row: SelectableRow): DeviceSelection | undefined {
    switch (row.kind) {
        case 'all': return undefined;
        case 'device': return { deviceKey: row.device.key };
        case 'app': return { deviceKey: row.deviceKey, app: row.app.name };
        case 'host': return { deviceKey: row.deviceKey, host: row.host.host };
    }
}

// The busiest items, plus the selected one if it's further down the list
function topItems<T>(items: readonly T[], limit: number, isSelected: (item: T) => boolean) {
    const shown = items.slice(0, limit);
    const selected = items.slice(limit).find(isSelected);
    return {
        shown: selected ? [...shown, selected] : shown,
        hiddenCount: items.length - shown.length - (selected ? 1 : 0)
    };
}

function deviceChildRows(device: DeviceSummary, selection: DeviceSelection | undefined): DeviceTreeRow[] {
    const { key } = device;
    const selected = selection?.deviceKey === key ? selection : undefined;
    const rows: DeviceTreeRow[] = [];

    if (device.apps.length) {
        const apps = topItems(device.apps, MAX_APP_ROWS, (app) => app.name === selected?.app);
        rows.push({ kind: 'heading', id: `apps:${key}`, depth: 1, label: 'Apps' });
        apps.shown.forEach((app) => rows.push({ kind: 'app', id: appRowId(key, app.name), depth: 1, deviceKey: key, app }));
        if (apps.hiddenCount > 0) {
            rows.push({ kind: 'more', id: `more-apps:${key}`, depth: 1, text: `and ${apps.hiddenCount} more` });
        }
    }

    if (device.hosts.length) {
        const hosts = topItems(device.hosts, MAX_HOST_ROWS, (host) => host.host === selected?.host);
        rows.push({ kind: 'heading', id: `hosts:${key}`, depth: 1, label: 'Domains' });
        hosts.shown.forEach((host) => rows.push({ kind: 'host', id: hostRowId(key, host.host), depth: 1, deviceKey: key, host }));
        if (hosts.hiddenCount > 0) {
            rows.push({
                kind: 'more',
                id: `more-hosts:${key}`,
                depth: 1,
                text: `and ${hosts.hiddenCount} more. Type hostname= to filter by any of them.`
            });
        }
    }

    return rows;
}

export function buildDeviceTreeRows(inputs: {
    totalCount: number,
    thisMachine: DeviceSummary,
    otherDevices: readonly DeviceSummary[],
    // In the order they were pinned, with or without traffic. They come first, this machine too
    // when it's pinned, and the rest keep their order.
    pinnedDevices?: readonly DeviceSummary[],
    selection: DeviceSelection | undefined,
    isExpanded: (deviceKey: string) => boolean
}): DeviceTreeRow[] {
    const rows: DeviceTreeRow[] = [{ kind: 'all', id: ALL_DEVICES_ROW_ID, depth: 0, count: inputs.totalCount }];

    const pinnedDevices = inputs.pinnedDevices ?? [];
    const pinnedKeys = new Set(pinnedDevices.map((device) => device.key));
    const unpinnedDevices = [inputs.thisMachine, ...inputs.otherDevices]
        .filter((device) => !pinnedKeys.has(device.key));

    for (const device of pinnedDevices) {
        const isExpandable = device.apps.length > 0 || device.hosts.length > 0;
        const isExpanded = isExpandable && inputs.isExpanded(device.key);
        rows.push({ kind: 'device', id: deviceRowId(device.key), depth: 0, device, isExpandable, isExpanded, isPinned: true });
        if (isExpanded) rows.push(...deviceChildRows(device, inputs.selection));
    }

    if (pinnedDevices.length > 0 && unpinnedDevices.length > 0) {
        rows.push({ kind: 'divider', id: 'pinned-divider', depth: 0 });
    }

    for (const device of unpinnedDevices) {
        const isExpandable = device.apps.length > 0 || device.hosts.length > 0;
        const isExpanded = isExpandable && inputs.isExpanded(device.key);
        rows.push({ kind: 'device', id: deviceRowId(device.key), depth: 0, device, isExpandable, isExpanded, isPinned: false });
        if (isExpanded) rows.push(...deviceChildRows(device, inputs.selection));
    }

    return rows;
}

// The row a Left arrow goes up to: the nearest row above with a smaller depth
export function parentRowIndex(rows: readonly DeviceTreeRow[], index: number): number {
    const depth = rows[index]?.depth ?? 0;
    for (let i = index - 1; i >= 0; i--) {
        if (rows[i].depth < depth) return i;
    }
    return -1;
}
