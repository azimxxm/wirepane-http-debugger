import { expect } from '../../../test-setup';

import { DeviceSummary } from '../../../../src/model/devices/devices-store';
import { SourceIcons } from '../../../../src/icons';
import {
    ALL_DEVICES_ROW_ID,
    MAX_HOST_ROWS,
    buildDeviceTreeRows,
    isSelectableRow,
    parentRowIndex,
    rowSelection,
    selectionRowId
} from '../../../../src/components/devices/device-tree-rows';

const device = (key: string, overrides: Partial<DeviceSummary> = {}): DeviceSummary => ({
    key,
    isThisMachine: key === 'this-machine',
    type: 'iphone',
    name: key,
    defaultName: key,
    hasCustomName: false,
    shortName: key,
    address: key === 'this-machine' ? undefined : key,
    addresses: [],
    eventCount: 1,
    firstSeen: 0,
    lastSeen: 0,
    apps: [],
    hosts: [],
    ...overrides
});

const app = (name: string, count = 1) => ({ name, count, icon: SourceIcons.Unknown });
const host = (name: string, count = 1) => ({ host: name, count });

describe('Device tree rows', () => {

    const thisMachine = device('this-machine', { type: 'mac', eventCount: 0 });
    const iphone = device('192.168.0.23', {
        apps: [app('Safari', 3), app('Bookshelf')],
        hosts: [host('example.com', 2), host('api.example.com')]
    });

    const rowIds = (rows: ReturnType<typeof buildDeviceTreeRows>) => rows.map((row) => row.id);

    it('lists all devices, this machine, then each device, closed', () => {
        const rows = buildDeviceTreeRows({
            totalCount: 5,
            thisMachine,
            otherDevices: [iphone],
            selection: undefined,
            isExpanded: () => false
        });

        expect(rowIds(rows)).to.deep.equal([ALL_DEVICES_ROW_ID, 'device:this-machine', 'device:192.168.0.23']);
        expect(rows.every(isSelectableRow)).to.equal(true);
        // This machine has no traffic here, so there's nothing to open
        expect(rows.map((row) => row.kind === 'device' && row.isExpandable)).to.deep.equal([false, false, true]);
    });

    it("shows an open device's apps and domains under headings", () => {
        const rows = buildDeviceTreeRows({
            totalCount: 5,
            thisMachine,
            otherDevices: [iphone],
            selection: undefined,
            isExpanded: (key) => key === '192.168.0.23'
        });

        expect(rows.slice(3).map((row) => row.kind)).to.deep.equal([
            'heading', 'app', 'app', 'heading', 'host', 'host'
        ]);
        expect(rows.filter(isSelectableRow).map((row) => rowSelection(row))).to.deep.equal([
            undefined,
            { deviceKey: 'this-machine' },
            { deviceKey: '192.168.0.23' },
            { deviceKey: '192.168.0.23', app: 'Safari' },
            { deviceKey: '192.168.0.23', app: 'Bookshelf' },
            { deviceKey: '192.168.0.23', host: 'example.com' },
            { deviceKey: '192.168.0.23', host: 'api.example.com' }
        ]);
    });

    it('shows only the busiest domains, plus the selected one', () => {
        const hosts = Array.from({ length: MAX_HOST_ROWS + 4 }, (_value, i) => host(`host${i}.example.com`, 100 - i));
        const busy = device('192.168.0.42', { hosts });

        const rows = buildDeviceTreeRows({
            totalCount: 100,
            thisMachine,
            otherDevices: [busy],
            selection: { deviceKey: '192.168.0.42', host: 'host10.example.com' },
            isExpanded: () => true
        });

        const hostRows = rows.filter((row) => row.kind === 'host');
        expect(hostRows).to.have.length(MAX_HOST_ROWS + 1);
        expect(hostRows[MAX_HOST_ROWS].id).to.equal(selectionRowId({ deviceKey: '192.168.0.42', host: 'host10.example.com' }));

        const more = rows[rows.length - 1];
        expect(more.kind).to.equal('more');
        expect(more.kind === 'more' && more.text).to.match(/^and 3 more/);
    });

    it('maps selections to the rows that show them', () => {
        expect(selectionRowId(undefined)).to.equal(ALL_DEVICES_ROW_ID);
        expect(selectionRowId({ deviceKey: '192.168.0.23' })).to.equal('device:192.168.0.23');
        expect(selectionRowId({ deviceKey: '192.168.0.23', app: 'Safari' })).to.equal('app:192.168.0.23:Safari');
    });

    it("goes up from an app or domain to its device", () => {
        const rows = buildDeviceTreeRows({
            totalCount: 5,
            thisMachine,
            otherDevices: [iphone],
            selection: undefined,
            isExpanded: () => true
        });

        const appIndex = rows.findIndex((row) => row.kind === 'app');
        expect(rows[parentRowIndex(rows, appIndex)].id).to.equal('device:192.168.0.23');
        expect(parentRowIndex(rows, 1)).to.equal(-1);
    });
});
