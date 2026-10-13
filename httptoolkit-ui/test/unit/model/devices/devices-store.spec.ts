import { IObservableArray, observable, observe, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { CollectedEvent } from '../../../../src/types';
import type { ProxyStore } from '../../../../src/model/proxy-store';
import type { ApiStore } from '../../../../src/model/api/api-store';
import type { RulesStore } from '../../../../src/model/rules/rules-store';
import { EventsStore } from '../../../../src/model/events/events-store';
import { THIS_MACHINE_KEY } from '../../../../src/model/devices/device-model';
import { DEVICE_NAMES_KEY } from '../../../../src/model/devices/device-names';
import { getDeviceDirectory } from '../../../../src/model/devices/device-directory';
import {
    ACTIVE_WINDOW_MS,
    DEVICES_STORE_KEY,
    DevicesStore,
    migrateSavedPanelState
} from '../../../../src/model/devices/devices-store';

import { MemoryStorage, UA, deviceExchange, failedTls, rawTunnel } from './device-test-helpers';

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

        it('counts non-HTTP connections (raw tunnels) under the device that opened them', () => {
            const tunnel = rawTunnel('192.168.0.23', 'mqtt.example.com');
            add(deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari, host: 'example.com' }), tunnel);

            const device = store.getDevice('192.168.0.23')!;
            expect(device.eventCount).to.equal(2);
            expect(device.hosts.map((host) => host.host)).to.deep.equal(['example.com', 'mqtt.example.com']);

            store.select({ deviceKey: '192.168.0.23', host: 'mqtt.example.com' });
            expect(events.filter((event) => store.selectionFilter!.matches(event))).to.deep.equal([tunnel]);
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
                type: 'android',
                viaVpn: false
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
        // A fresh start each time, with nothing saved by earlier tests
        beforeEach(async () => {
            store.dispose();
            localStorage.removeItem(DEVICES_STORE_KEY);
            await createStore();
        });

        const iphone = () => deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari });

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

        it('stays hidden while all the traffic is from this machine', () => {
            expect(store.panelOpen).to.equal(false);

            add(deviceExchange({ ip: '127.0.0.1', ua: UA.curl }), deviceExchange({ sentFromSendPage: true }));
            expect(store.panelOpen).to.equal(false);
        });

        it('opens by itself once another device sends traffic, and stays open after Clear', () => {
            add(deviceExchange({ ip: '127.0.0.1', ua: UA.curl }));
            add(iphone());
            expect(store.panelOpen).to.equal(true);

            runInAction(() => { events.clear(); });
            expect(store.panelOpen).to.equal(true);
        });

        it("opens for devices that were there before the store started", async () => {
            store.dispose();
            add(iphone());
            await createStore();
            expect(store.panelOpen).to.equal(true);
        });

        it("keeps the user's own choice, whatever the traffic", () => {
            store.showPanel();
            store.togglePanel(); // Hidden by hand
            add(iphone());
            expect(store.panelOpen).to.equal(false);

            store.togglePanel();
            runInAction(() => { events.clear(); });
            expect(store.panelOpen).to.equal(true);
        });

        it('remembers the choice after a restart', async () => {
            add(iphone());
            store.togglePanel(); // Hidden by hand
            store.dispose();
            runInAction(() => { events.clear(); });

            await createStore();
            add(iphone());
            expect(store.panelChoice).to.equal('closed');
            expect(store.panelOpen).to.equal(false);
        });

        it('opens for a pinned phone after a restart, before the phone sends anything', async () => {
            add(iphone());
            store.pin('192.168.0.23');
            store.dispose();
            runInAction(() => { events.clear(); });

            await createStore();
            expect(store.panelChoice).to.equal(undefined);
            expect(store.panelOpen).to.equal(true);

            // Hidden by hand, it stays hidden
            store.togglePanel();
            store.dispose();
            await createStore();
            expect(store.panelOpen).to.equal(false);
            localStorage.removeItem(DEVICES_STORE_KEY);
        });

        it("doesn't open just because this machine is pinned", async () => {
            store.pin(THIS_MACHINE_KEY);
            store.dispose();

            await createStore();
            expect(store.isPinned(THIS_MACHINE_KEY)).to.equal(true);
            expect(store.panelOpen).to.equal(false);
            localStorage.removeItem(DEVICES_STORE_KEY);
        });

        it('keeps a panel hidden in an older version hidden, and its width', async () => {
            store.dispose();
            localStorage.setItem(DEVICES_STORE_KEY, JSON.stringify({ panelOpen: false, panelWidth: 250 }));

            await createStore();
            add(iphone());
            expect(store.panelOpen).to.equal(false);
            expect(store.panelWidth).to.equal(250);
        });

        it("doesn't take an older version's default open panel as a choice", async () => {
            store.dispose();
            localStorage.setItem(DEVICES_STORE_KEY, JSON.stringify({ panelOpen: true, panelWidth: 216 }));

            await createStore();
            expect(store.panelChoice).to.equal(undefined);
            expect(store.panelOpen).to.equal(false);
        });

        it('only migrates a saved hidden panel', () => {
            expect(migrateSavedPanelState({ panelOpen: false })).to.deep.equal({ panelOpen: false, panelChoice: 'closed' });
            expect(migrateSavedPanelState({ panelOpen: true })).to.deep.equal({ panelOpen: true });
            expect(migrateSavedPanelState({ panelChoice: 'open', panelOpen: false }))
                .to.deep.equal({ panelChoice: 'open', panelOpen: false });
        });
    });

    const IPHONE = '192.168.0.23';
    const ANDROID = '192.168.0.42';

    describe('pinned devices', () => {
        // A fresh start each time, with nothing saved by earlier tests, and nothing left for later ones
        beforeEach(async () => {
            store.dispose();
            localStorage.removeItem(DEVICES_STORE_KEY);
            await createStore();
        });

        afterEach(() => localStorage.removeItem(DEVICES_STORE_KEY));

        const pinnedKeys = () => store.pinnedDevices.map((device) => device.key);

        it('keeps them in the order they were pinned', () => {
            add(
                deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari }),
                deviceExchange({ ip: ANDROID, ua: UA.androidChrome }),
                deviceExchange({ ip: '127.0.0.1', ua: UA.curl })
            );

            store.pin(ANDROID);
            store.pin(THIS_MACHINE_KEY);
            store.pin(IPHONE);
            store.pin(ANDROID); // Already pinned, so it keeps its place
            expect(pinnedKeys()).to.deep.equal([ANDROID, THIS_MACHINE_KEY, IPHONE]);
            expect(store.isPinned(IPHONE)).to.equal(true);

            store.unpin(THIS_MACHINE_KEY);
            expect(pinnedKeys()).to.deep.equal([ANDROID, IPHONE]);
            expect(store.isPinned(THIS_MACHINE_KEY)).to.equal(false);

            // The devices themselves keep their order
            expect(deviceKeys()).to.deep.equal([THIS_MACHINE_KEY, IPHONE, ANDROID]);
        });

        it('only pins a device the panel lists', () => {
            store.pin('192.168.0.99');
            expect(pinnedKeys()).to.deep.equal([]);

            store.pin(THIS_MACHINE_KEY); // Listed even without traffic
            expect(pinnedKeys()).to.deep.equal([THIS_MACHINE_KEY]);
        });

        it('lists a pinned device without traffic as a placeholder, with its name and type', () => {
            add(deviceExchange({ ip: ANDROID, ua: UA.androidChrome }));
            store.pin(ANDROID);

            runInAction(() => { events.clear(); });
            expect(store.devices).to.deep.equal([]);

            const [placeholder] = store.pinnedDevices;
            expect(placeholder).to.deep.include({
                key: ANDROID,
                isThisMachine: false,
                type: 'android',
                name: 'Pixel 8',
                address: ANDROID,
                eventCount: 0,
                apps: [],
                hosts: []
            });
            expect(store.getListedDevice(ANDROID)).to.deep.equal(placeholder);

            // Once it sends traffic again, that's counted as usual
            add(deviceExchange({ ip: ANDROID, ua: UA.androidChrome }));
            expect(store.pinnedDevices[0].eventCount).to.equal(1);
            expect(store.pinnedDevices[0]).to.deep.equal(store.getDevice(ANDROID));
        });

        it('stops listing a device without traffic once it is unpinned', () => {
            add(deviceExchange({ ip: ANDROID, ua: UA.androidChrome }));
            store.pin(ANDROID);
            runInAction(() => { events.clear(); });

            store.unpin(ANDROID);
            expect(store.pinnedDevices).to.deep.equal([]);
            expect(store.getListedDevice(ANDROID)).to.equal(undefined);
        });

        it('keeps a pinned device selected without traffic, until it is unpinned', () => {
            add(deviceExchange({ ip: ANDROID, ua: UA.androidChrome, host: 'example.com' }));
            store.pin(ANDROID);
            store.select({ deviceKey: ANDROID, host: 'example.com' });

            runInAction(() => { events.clear(); });
            // Its domains have gone, but the device is still listed, like this machine
            expect(store.selection).to.deep.equal({ deviceKey: ANDROID });
            expect(store.describeSelection(store.selection!)).to.equal('Pixel 8');

            store.unpin(ANDROID);
            expect(store.selection).to.equal(undefined);
        });

        it("updates a pinned device's name and type as it says more about itself", async () => {
            add(deviceExchange({ ip: IPHONE, ua: UA.iosApp }));
            store.pin(IPHONE);
            expect(store.pinnedDevices[0]).to.deep.include({ name: 'iOS device', type: 'ios' });

            add(deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari }));
            runInAction(() => { events.clear(); });
            expect(store.pinnedDevices[0]).to.deep.include({ name: 'iPhone', type: 'iphone' });

            // That's what's saved too
            store.dispose();
            await createStore();
            expect(store.pinnedDevices[0]).to.deep.include({ name: 'iPhone', type: 'iphone' });
        });

        it('keeps what a pinned device said about itself when it comes back saying less', async () => {
            add(
                deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari }),
                deviceExchange({ ip: ANDROID, ua: UA.androidChrome })
            );
            store.pin(IPHONE);
            store.pin(ANDROID);
            runInAction(() => { events.clear(); });

            // After Clear the counts start again: the iPhone's first event is a failed TLS connection
            // (so it's a "Device"), and the Pixel's an okhttp request (so it's an "Android" with no model)
            add(failedTls(IPHONE), deviceExchange({ ip: ANDROID, ua: UA.okhttp }));
            expect(store.getDevice(IPHONE)).to.deep.include({ name: 'Device', type: 'other' });
            expect(store.getDevice(ANDROID)).to.deep.include({ name: 'Android', type: 'android' });
            runInAction(() => { events.clear(); });

            const [iphone, android] = store.pinnedDevices;
            expect(iphone).to.deep.include({ name: 'iPhone', type: 'iphone' });
            expect(android).to.deep.include({ name: 'Pixel 8', type: 'android' });

            // That's what's saved too
            store.dispose();
            await createStore();
            expect(store.pinnedDevices[0]).to.deep.include({ name: 'iPhone', type: 'iphone' });
            expect(store.pinnedDevices[1]).to.deep.include({ name: 'Pixel 8', type: 'android' });

            // Another model at the pinned address still replaces it
            add(deviceExchange({ ip: ANDROID, ua: UA.androidChrome.replace('Pixel 8', 'Pixel 9') }));
            runInAction(() => { events.clear(); });
            expect(store.pinnedDevices[1]).to.deep.include({ name: 'Pixel 9', type: 'android' });
        });

        it('counts what Clear would delete from each pinned device', () => {
            const pinnedRequest = deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari });
            add(
                pinnedRequest,
                deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari }),
                deviceExchange({ ip: IPHONE, ua: UA.iosApp }),
                deviceExchange({ ip: ANDROID, ua: UA.androidChrome }),
                deviceExchange({ ip: '127.0.0.1', ua: UA.curl })
            );
            runInAction(() => { pinnedRequest.pinned = true; }); // Clear keeps it
            store.pin(IPHONE);
            store.pin(THIS_MACHINE_KEY);
            store.rename(IPHONE, 'Test phone');

            expect(store.pinnedDeviceTraffic()).to.deep.equal([
                { name: 'Test phone', count: 2 },
                { name: 'This Mac', count: 1 }
            ]);

            runInAction(() => { events.clear(); });
            expect(store.pinnedDeviceTraffic()).to.deep.equal([
                { name: 'Test phone', count: 0 },
                { name: 'This Mac', count: 0 }
            ]);
        });

        it("forgets a placeholder's custom name when it's renamed back to its default", () => {
            add(deviceExchange({ ip: ANDROID, ua: UA.androidChrome }));
            store.pin(ANDROID);
            store.rename(ANDROID, 'Test phone');
            runInAction(() => { events.clear(); });
            expect(store.pinnedDevices[0].name).to.equal('Test phone');

            store.rename(ANDROID, 'Pixel 8');
            expect(store.pinnedDevices[0].hasCustomName).to.equal(false);
            expect(JSON.parse(storage.items.get(DEVICE_NAMES_KEY)!)).to.deep.equal({});
        });

        it('keeps the pins after a restart', async () => {
            add(
                deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari }),
                deviceExchange({ ip: ANDROID, ua: UA.androidChrome })
            );
            store.pin(ANDROID);
            store.pin(THIS_MACHINE_KEY);
            store.rename(ANDROID, 'Test phone');

            store.dispose();
            runInAction(() => { events.clear(); });
            await createStore();

            expect(store.pinnedDevices.map((device) => [device.key, device.name, device.type, device.eventCount]))
                .to.deep.equal([
                    [ANDROID, 'Test phone', 'android', 0],
                    [THIS_MACHINE_KEY, 'This Mac', 'mac', 0]
                ]);
            expect(store.isPinned(IPHONE)).to.equal(false);
        });

        it('loads a save from before pins', async () => {
            store.dispose();
            localStorage.setItem(DEVICES_STORE_KEY, JSON.stringify({ panelChoice: 'open', panelWidth: 250 }));

            await createStore();
            expect(store.pinnedDevices).to.deep.equal([]);
            expect(store.panelOpen).to.equal(true);
            expect(store.panelWidth).to.equal(250);
        });

        it("leaves out saved pins it can't read, and loads the rest", async () => {
            store.dispose();
            localStorage.setItem(DEVICES_STORE_KEY, JSON.stringify({
                panelWidth: 260,
                pins: [
                    { key: ANDROID, type: 'android', defaultName: 'Pixel 8' },
                    'not a pin',
                    { type: 'iphone', defaultName: 'iPhone' },
                    { key: ANDROID, type: 'iphone', defaultName: 'iPhone' },
                    { key: IPHONE, type: 'toaster', defaultName: 42 }
                ]
            }));

            await createStore();
            expect(store.pinnedDevices.map((device) => [device.key, device.name, device.type])).to.deep.equal([
                [ANDROID, 'Pixel 8', 'android'],
                [IPHONE, 'Device', 'other']
            ]);
            expect(store.panelWidth).to.equal(260);

            store.dispose();
            localStorage.setItem(DEVICES_STORE_KEY, JSON.stringify({ panelWidth: 270, pins: 'not a list' }));

            await createStore();
            expect(store.pinnedDevices).to.deep.equal([]);
            expect(store.panelWidth).to.equal(270);
        });
    });

    describe("clearing one device's traffic", () => {
        let eventsStore: EventsStore;

        // The test exchanges can't run an exchange's own cleanup, which the events store calls
        const cleanable = <T extends CollectedEvent>(event: T): T => Object.assign(event, { cleanup: () => {} });

        const capture = (...newEvents: CollectedEvent[]) => runInAction(() => {
            eventsStore.eventsList.push(...newEvents.map(cleanable));
        });
        const eventIds = (list: ReadonlyArray<CollectedEvent>) => list.map((event) => event.id);

        beforeEach(async () => {
            store.dispose();
            localStorage.removeItem(DEVICES_STORE_KEY);
            eventsStore = new EventsStore({} as ProxyStore, {} as ApiStore, {} as RulesStore);
            store = new DevicesStore(eventsStore, { nameStorage: storage, thisMachineType: 'mac' });
            await store.initialized;
        });

        afterEach(() => localStorage.removeItem(DEVICES_STORE_KEY));

        it("deletes only that device's traffic, and keeps its pinned requests", () => {
            const iphoneSafari = deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari });
            const iphoneApp = deviceExchange({ ip: IPHONE, ua: UA.iosApp });
            const iphoneTls = failedTls(IPHONE);
            const iphoneTunnel = rawTunnel(IPHONE);
            const iphonePinned = deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari });
            const android = deviceExchange({ ip: ANDROID, ua: UA.androidChrome });
            const local = deviceExchange({ ip: '127.0.0.1', ua: UA.curl });
            capture(iphoneSafari, android, iphoneApp, iphoneTls, local, iphonePinned, iphoneTunnel);
            runInAction(() => { iphonePinned.pinned = true; });

            expect(store.canClearTraffic(IPHONE)).to.equal(true);
            const deleted = store.clearTraffic(IPHONE);

            expect(eventIds(deleted)).to.deep.equal(eventIds([iphoneSafari, iphoneApp, iphoneTls, iphoneTunnel]));
            expect(eventIds(eventsStore.events)).to.deep.equal(eventIds([android, local, iphonePinned]));

            // The pinned request keeps the device listed, and it's all there is left
            expect(store.getDevice(IPHONE)!.eventCount).to.equal(1);
            expect(store.canClearTraffic(IPHONE)).to.equal(false);
            expect(store.getDevice(ANDROID)!.eventCount).to.equal(1);
            expect(store.thisMachine.eventCount).to.equal(1);
        });

        it('deletes the traffic in one change to the list', () => {
            capture(
                deviceExchange({ ip: IPHONE }),
                deviceExchange({ ip: ANDROID }),
                deviceExchange({ ip: IPHONE }),
                deviceExchange({ ip: ANDROID }),
                deviceExchange({ ip: IPHONE })
            );

            let changes = 0;
            const stopObserving = observe(eventsStore.events as IObservableArray<CollectedEvent>, () => { changes += 1; });
            store.clearTraffic(IPHONE);
            stopObserving();

            expect(changes).to.equal(1);
            expect(deviceKeys()).to.deep.equal([ANDROID]);
            expect(store.getDevice(ANDROID)!.eventCount).to.equal(2);
        });

        it("drops a cleared device's selection like Clear does, unless the device is pinned", () => {
            capture(
                deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari }),
                deviceExchange({ ip: ANDROID, ua: UA.androidChrome })
            );

            store.select({ deviceKey: IPHONE });
            store.clearTraffic(IPHONE);
            expect(store.selection).to.equal(undefined);
            expect(deviceKeys()).to.deep.equal([ANDROID]);

            store.pin(ANDROID);
            store.select({ deviceKey: ANDROID });
            store.clearTraffic(ANDROID);
            expect(store.selection).to.deep.equal({ deviceKey: ANDROID });
            expect(store.pinnedDevices[0]).to.deep.include({ key: ANDROID, name: 'Pixel 8', eventCount: 0 });
        });

        it('has nothing to clear for a device without traffic', () => {
            capture(deviceExchange({ ip: ANDROID, ua: UA.androidChrome }));

            expect(store.canClearTraffic(IPHONE)).to.equal(false);
            expect(store.canClearTraffic(THIS_MACHINE_KEY)).to.equal(false);
            expect(store.clearTraffic(IPHONE)).to.deep.equal([]);
            expect(eventsStore.events).to.have.length(1);
        });

        it("can't clear traffic from a list it can't delete from", async () => {
            store.dispose();
            await createStore(); // Over a plain list
            add(deviceExchange({ ip: ANDROID, ua: UA.androidChrome }));

            expect(store.canClearTraffic(ANDROID)).to.equal(false);
            expect(store.clearTraffic(ANDROID)).to.deep.equal([]);
            expect(events).to.have.length(1);
        });
    });
});
