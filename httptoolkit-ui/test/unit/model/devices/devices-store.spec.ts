import { IObservableArray, observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { CollectedEvent } from '../../../../src/types';
import { THIS_MACHINE_KEY } from '../../../../src/model/devices/device-model';
import { DEVICE_NAMES_KEY } from '../../../../src/model/devices/device-names';
import { getDeviceDirectory } from '../../../../src/model/devices/device-directory';
import { ACTIVE_WINDOW_MS, DevicesStore } from '../../../../src/model/devices/devices-store';

import { MemoryStorage, UA, deviceExchange, failedTls } from './device-test-helpers';

describe('Devices store', () => {

    let events: IObservableArray<CollectedEvent>;
    let storage: MemoryStorage;
    let store: DevicesStore;

    const add = (...newEvents: CollectedEvent[]) => runInAction(() => { events.push(...newEvents); });

    async function createStore() {
        store = new DevicesStore({ events }, { nameStorage: storage, thisMachineType: 'mac' });
        await store.initialized;
        return store;
    }

    beforeEach(async () => {
        events = observable.array<CollectedEvent>([], { deep: false });
        storage = new MemoryStorage();
        await createStore();
    });

    afterEach(() => store.dispose());

    const deviceKeys = () => store.devices.map((device) => device.key);

    describe('telling devices apart', () => {
        it('groups traffic by client IP', () => {
            add(
                deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }),
                deviceExchange({ ip: '::ffff:192.168.0.23', ua: UA.iosApp }), // The same phone, over IPv6
                deviceExchange({ ip: '192.168.0.42', ua: UA.androidChrome }),
                failedTls('192.168.0.42')
            );

            expect(deviceKeys()).to.deep.equal(['192.168.0.23', '192.168.0.42']);
            expect(store.devices.map((device) => device.eventCount)).to.deep.equal([2, 2]);
        });

        it('puts loopback traffic & the Send page under this machine', () => {
            add(
                deviceExchange({ ip: '127.0.0.1', ua: UA.curl }),
                deviceExchange({ ip: '::1', ua: UA.macSafari }),
                deviceExchange({ ip: '::ffff:127.0.0.1', ua: UA.okhttp }),
                deviceExchange({ sentFromSendPage: true })
            );

            expect(deviceKeys()).to.deep.equal([THIS_MACHINE_KEY]);
            const [thisMac] = store.devices;
            expect(thisMac.name).to.equal('This Mac');
            expect(thisMac.type).to.equal('mac');
            expect(thisMac.address).to.equal(undefined);
            expect(thisMac.addresses).to.deep.equal(['127.0.0.1', '::1']);
            expect(thisMac.eventCount).to.equal(4);
        });

        it("shows this machine's LAN address as a device of its own", () => {
            // A simulator or a test tool using the Wi-Fi address, not this Mac's own apps
            add(
                deviceExchange({ ip: '127.0.0.1', ua: UA.curl }),
                deviceExchange({ ip: '192.168.0.156', ua: UA.iphoneSafari })
            );

            expect(deviceKeys()).to.deep.equal([THIS_MACHINE_KEY, '192.168.0.156']);
            expect(store.getDevice('192.168.0.156')!.type).to.equal('iphone');
        });

        it('lists this machine first, then devices in the order they appeared', () => {
            add(
                deviceExchange({ ip: '192.168.0.50', startTime: 1000 }),
                deviceExchange({ ip: '192.168.0.10', startTime: 2000 }),
                deviceExchange({ ip: '127.0.0.1', startTime: 3000 }),
                deviceExchange({ ip: '192.168.0.50', startTime: 4000 })
            );

            expect(deviceKeys()).to.deep.equal([THIS_MACHINE_KEY, '192.168.0.50', '192.168.0.10']);
        });

        it('always has this machine for the panel, even with no local traffic', () => {
            expect(store.devices).to.deep.equal([]);
            expect(store.thisMachine.name).to.equal('This Mac');
            expect(store.thisMachine.eventCount).to.equal(0);
        });
    });

    describe('device types & names', () => {
        it('names devices from their user agents', () => {
            add(
                deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }),
                deviceExchange({ ip: '192.168.0.24', ua: UA.ipadApp }),
                deviceExchange({ ip: '192.168.0.42', ua: UA.androidChrome }),
                deviceExchange({ ip: '192.168.0.43', ua: UA.okhttp }),
                deviceExchange({ ip: '192.168.0.60', ua: UA.windowsChrome }),
                deviceExchange({ ip: '192.168.0.70', ua: UA.curl })
            );

            expect(store.devices.map((device) => [device.name, device.type])).to.deep.equal([
                ['iPhone', 'iphone'],
                ['iPad', 'ipad'],
                ['Pixel 8', 'android'],
                ['Android', 'android'],
                ['Windows PC', 'windows'],
                ['Device', 'other']
            ]);
        });

        it("doesn't forget a phone's type for an app request that's less sure", () => {
            add(deviceExchange({ ip: '192.168.0.23', ua: UA.iosApp }));
            expect(store.getDevice('192.168.0.23')!.type).to.equal('ios');

            add(deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }));
            expect(store.getDevice('192.168.0.23')!.type).to.equal('iphone');

            add(deviceExchange({ ip: '192.168.0.23', ua: UA.iosApp }));
            expect(store.getDevice('192.168.0.23')!.type).to.equal('iphone');
        });

        it('renames devices and keeps the names in storage', async () => {
            add(deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }));
            store.rename('192.168.0.23', "  Azim's   iPhone ");

            const device = store.getDevice('192.168.0.23')!;
            expect(device.name).to.equal("Azim's iPhone");
            expect(device.defaultName).to.equal('iPhone');
            expect(device.hasCustomName).to.equal(true);
            expect(JSON.parse(storage.items.get(DEVICE_NAMES_KEY)!)).to.deep.equal({ '192.168.0.23': "Azim's iPhone" });

            // A new store (e.g. after a restart) reads the saved names
            store.dispose();
            await createStore();
            add(deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }));
            expect(store.getDevice('192.168.0.23')!.name).to.equal("Azim's iPhone");
        });

        it('forgets a name when asked, or when renamed back to its default', () => {
            add(deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }));

            store.rename('192.168.0.23', 'Test phone');
            store.forgetName('192.168.0.23');
            expect(store.getDevice('192.168.0.23')!.name).to.equal('iPhone');
            expect(store.getDevice('192.168.0.23')!.hasCustomName).to.equal(false);

            store.rename('192.168.0.23', 'Test phone');
            store.rename('192.168.0.23', 'iPhone');
            expect(store.getDevice('192.168.0.23')!.hasCustomName).to.equal(false);

            store.rename('192.168.0.23', '   ');
            expect(store.getDevice('192.168.0.23')!.hasCustomName).to.equal(false);
            expect(JSON.parse(storage.items.get(DEVICE_NAMES_KEY)!)).to.deep.equal({});
        });

        it('can rename this machine', () => {
            store.rename(THIS_MACHINE_KEY, 'Work Mac');
            expect(store.thisMachine.name).to.equal('Work Mac');

            add(deviceExchange({ ip: '127.0.0.1' }));
            expect(store.devices[0].name).to.equal('Work Mac');
        });

        it('adds the end of the IP to devices with the same name', () => {
            add(
                deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }),
                deviceExchange({ ip: '192.168.0.24', ua: UA.iphoneSafari }),
                deviceExchange({ ip: '192.168.0.42', ua: UA.androidChrome })
            );

            expect(store.devices.map((device) => device.shortName)).to.deep.equal([
                'iPhone · .23',
                'iPhone · .24',
                'Pixel 8'
            ]);

            store.rename('192.168.0.24', 'Test iPhone');
            expect(store.devices.map((device) => device.shortName)).to.deep.equal([
                'iPhone',
                'Test iPhone',
                'Pixel 8'
            ]);
        });
    });

    describe('what each device sent', () => {
        it('counts apps and domains, busiest first', () => {
            add(
                deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari, host: 'example.com' }),
                deviceExchange({ ip: '192.168.0.23', ua: UA.iosApp, host: 'api.example.com' }),
                deviceExchange({ ip: '192.168.0.23', ua: UA.iosApp, host: 'api.example.com' }),
                failedTls('192.168.0.23', 'cdn.example.com')
            );

            const device = store.getDevice('192.168.0.23')!;
            expect(device.apps.map((app) => [app.name, app.count])).to.deep.equal([
                ['Bookshelf', 2],
                ['Safari', 1]
            ]);
            expect(device.hosts).to.deep.equal([
                { host: 'api.example.com', count: 2 },
                { host: 'cdn.example.com', count: 1 },
                { host: 'example.com', count: 1 }
            ]);
            expect(device.apps[0].icon).to.equal(events[1].isHttp() && events[1].request.source.icon);
        });

        it('takes deleted requests back off the counts', () => {
            const first = deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari, host: 'example.com' });
            const second = deviceExchange({ ip: '192.168.0.23', ua: UA.iosApp, host: 'api.example.com' });
            add(first, second, deviceExchange({ ip: '127.0.0.1' }));

            runInAction(() => { events.remove(second); });

            const device = store.getDevice('192.168.0.23')!;
            expect(device.eventCount).to.equal(1);
            expect(device.apps.map((app) => app.name)).to.deep.equal(['Safari']);
            expect(device.hosts.map((host) => host.host)).to.deep.equal(['example.com']);

            runInAction(() => { events.remove(first); });
            expect(deviceKeys()).to.deep.equal([THIS_MACHINE_KEY]);
        });

        it('counts traffic that was there before the store started', async () => {
            store.dispose();
            add(deviceExchange({ ip: '192.168.0.23' }), deviceExchange({ ip: '127.0.0.1' }));

            await createStore();
            expect(deviceKeys()).to.deep.equal([THIS_MACHINE_KEY, '192.168.0.23']);
        });

        it('shows a device as active for a minute after its last request', () => {
            add(
                deviceExchange({ ip: '192.168.0.23', startTime: Date.now() - 1000 }),
                deviceExchange({ ip: '192.168.0.42', startTime: Date.now() - ACTIVE_WINDOW_MS - 1000 })
            );

            expect(store.isActive(store.getDevice('192.168.0.23')!)).to.equal(true);
            expect(store.isActive(store.getDevice('192.168.0.42')!)).to.equal(false);
            expect(store.isActive(store.thisMachine)).to.equal(false);
        });
    });

    describe('selection', () => {
        let iphoneSafari: CollectedEvent;
        let iphoneApp: CollectedEvent;
        let android: CollectedEvent;
        let local: CollectedEvent;

        beforeEach(() => {
            iphoneSafari = deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari, host: 'example.com' });
            iphoneApp = deviceExchange({ ip: '192.168.0.23', ua: UA.iosApp, host: 'api.example.com' });
            android = deviceExchange({ ip: '192.168.0.42', ua: UA.androidChrome, host: 'example.com' });
            local = deviceExchange({ ip: '127.0.0.1', ua: UA.curl, host: 'example.com' });
            add(iphoneSafari, iphoneApp, android, local);
        });

        const shownEvents = () => events.filter((event) => !store.selectionFilter || store.selectionFilter.matches(event));

        it('shows everything with nothing selected', () => {
            expect(store.selectionFilter).to.equal(undefined);
            expect(shownEvents()).to.have.length(4);
        });

        it("filters to a device's requests", () => {
            store.select({ deviceKey: '192.168.0.23' });
            expect(shownEvents()).to.deep.equal([iphoneSafari, iphoneApp]);

            store.select({ deviceKey: THIS_MACHINE_KEY });
            expect(shownEvents()).to.deep.equal([local]);
        });

        it("filters to one of a device's apps or domains", () => {
            store.select({ deviceKey: '192.168.0.23', app: 'Bookshelf' });
            expect(shownEvents()).to.deep.equal([iphoneApp]);

            store.select({ deviceKey: '192.168.0.23', host: 'example.com' });
            expect(shownEvents()).to.deep.equal([iphoneSafari]);
        });

        it('describes the selection with the names shown in the panel', () => {
            store.rename('192.168.0.23', 'Test iPhone');
            store.select({ deviceKey: '192.168.0.23', app: 'Safari' });

            expect(store.selectionFilter!.toString()).to.equal('Test iPhone › Safari');
            expect(store.describeSelection({ deviceKey: THIS_MACHINE_KEY })).to.equal('This Mac');
        });

        it('drops a selection whose device is gone, e.g. after Clear', async () => {
            store.select({ deviceKey: '192.168.0.23', app: 'Bookshelf' });
            runInAction(() => { events.remove(iphoneApp); });
            expect(store.selection).to.deep.equal({ deviceKey: '192.168.0.23' });

            runInAction(() => { events.clear(); });
            expect(store.selection).to.equal(undefined);
        });

        it('keeps this machine selected without traffic, as it stays listed', () => {
            store.select({ deviceKey: THIS_MACHINE_KEY });
            runInAction(() => { events.clear(); });
            expect(store.selection).to.deep.equal({ deviceKey: THIS_MACHINE_KEY });
        });

        it('marks each request with its device only while all devices are shown', () => {
            expect(store.showDeviceMarkers).to.equal(true);
            expect(store.getDeviceMarker(android)).to.deep.equal({
                name: 'Pixel 8',
                title: 'Pixel 8 (192.168.0.42)',
                type: 'android'
            });
            expect(store.getDeviceMarker(local)!.name).to.equal('This Mac');

            store.select({ deviceKey: '192.168.0.42' });
            expect(store.showDeviceMarkers).to.equal(false);
        });

        it("doesn't mark requests when only one device has traffic", () => {
            runInAction(() => { events.replace([local]); });
            expect(store.showDeviceMarkers).to.equal(false);
        });
    });

    describe('as the device directory', () => {
        it('gives text filters the device-level type', () => {
            const app = deviceExchange({ ip: '192.168.0.23', ua: UA.iosApp });
            add(deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari }), app);

            // The app's own user agent only says iOS, but the device is an iPhone
            expect(getDeviceDirectory()).to.equal(store);
            expect(store.getEventDevice(app)).to.deep.equal({ key: '192.168.0.23', type: 'iphone' });
            expect(store.getEventDevice(deviceExchange({ ip: '127.0.0.1' })))
                .to.deep.equal({ key: THIS_MACHINE_KEY, type: 'mac' });
        });

        it('stops being the directory when disposed', () => {
            store.dispose();
            expect(getDeviceDirectory()).not.to.equal(store);
        });
    });

    describe('panel', () => {
        it('keeps its width within limits', () => {
            store.setPanelWidth(10);
            expect(store.panelWidth).to.equal(180);
            store.setPanelWidth(2000);
            expect(store.panelWidth).to.equal(440);
            store.setPanelWidth(260.4);
            expect(store.panelWidth).to.equal(260);
        });

        it('opens and closes', () => {
            const wasOpen = store.panelOpen;
            store.togglePanel();
            expect(store.panelOpen).to.equal(!wasOpen);
            store.showPanel();
            expect(store.panelOpen).to.equal(true);
        });
    });
});
