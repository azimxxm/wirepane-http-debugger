import { IObservableArray, observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { CollectedEvent } from '../../../../src/types';
import { MANUALLY_SENT_SOURCE } from '../../../../src/model/http/sources';
import { THIS_MACHINE_KEY } from '../../../../src/model/devices/device-model';
import { getDeviceDirectory } from '../../../../src/model/devices/device-directory';
import { DevicesStore } from '../../../../src/model/devices/devices-store';
import { identifyApp } from '../../../../src/model/devices/app-identity';
import { getVpnAttribution } from '../../../../src/model/devices/vpn-tags';
import { describeDevices } from '../../../../src/model/devices/devices-overview';

import { MemoryStorage, UA, deviceExchange, failedTls } from './device-test-helpers';

const PHONE = '192.168.0.199';

// Sentry puts the app's release in the baggage header, sometimes percent-encoded
const JETT_BAGGAGE = {
    baggage: 'sentry-environment=production,sentry-release=uz.multibroker.jett.mobile%401.2.24%2B175,sentry-trace_id=abc'
};
const ROAD24_BAGGAGE = { baggage: 'sentry-release=uz.kashapp.road24@3.6.0+3601380' };

const VPN_TAGS = ['wirepane-vpn', 'wirepane-vpn-peer:p1', `wirepane-vpn-endpoint:${PHONE}`];
// Mockttp adds a prefix to the tags a SOCKS client sends when it connects, so real events have these
const VPN_TAGS_AS_RECEIVED = VPN_TAGS.map((tag) => `socket-metadata:${tag}`);

describe('Device and app naming', () => {

    let events: IObservableArray<CollectedEvent>;
    let store: DevicesStore;

    const add = (...newEvents: CollectedEvent[]) => runInAction(() => { events.push(...newEvents); });

    beforeEach(async () => {
        events = observable.array<CollectedEvent>([], { deep: false });
        store = new DevicesStore({ events }, { nameStorage: new MemoryStorage(), thisMachineType: 'mac' });
        await store.initialized;
    });

    afterEach(() => store.dispose());

    const apps = (deviceKey = PHONE) =>
        store.getDevice(deviceKey)!.apps.map((app) => [app.name, app.kind, app.count]);

    // One iPhone with many apps, with the user agents and headers the owner's phone sent
    const addPhoneTraffic = () => add(
        deviceExchange({ ip: PHONE, ua: UA.appMetrica }),
        deviceExchange({ ip: PHONE, ua: UA.webView }),
        deviceExchange({ ip: PHONE, ua: UA.webView }),
        deviceExchange({ ip: PHONE, ua: UA.jettApp, headers: JETT_BAGGAGE }),
        deviceExchange({ ip: PHONE, ua: UA.facebookSdk, headers: JETT_BAGGAGE }),
        deviceExchange({ ip: PHONE, ua: UA.facebookSdk, headers: JETT_BAGGAGE }),
        deviceExchange({ ip: PHONE, ua: UA.road24Sdk, headers: { 'x-ios-bundle-identifier': 'uz.kashapp.road24' } }),
        deviceExchange({ ip: PHONE, ua: UA.road24App, headers: { 'x-ios-bundle-identifier': 'uz.kashapp.road24' } }),
        deviceExchange({ ip: PHONE, ua: UA.road24App }),
        deviceExchange({ ip: PHONE, ua: UA.videoPlayer }),
        deviceExchange({ ip: PHONE, ua: UA.serverBag }),
        deviceExchange({ ip: PHONE, ua: UA.iosApp })
    );

    describe('apps', () => {
        it('merges an app seen under its name and under its bundle ID', () => {
            add(
                deviceExchange({ ip: PHONE, ua: UA.road24Sdk }),
                deviceExchange({ ip: PHONE, ua: UA.road24App }),
                deviceExchange({ ip: PHONE, ua: UA.road24App })
            );

            // Even before one request names both, "road24" is the end of "uz.kashapp.road24"
            expect(apps()).to.deep.equal([['road24', 'app', 3]]);
            expect(store.getDevice(PHONE)!.apps[0].detail).to.equal('uz.kashapp.road24');
        });

        it('groups an SDK under the app its request names, and labels the rest as what they are', () => {
            addPhoneTraffic();

            // The apps first, busiest first; then what's not an app
            expect(apps()).to.deep.equal([
                ['Jett Invest App', 'app', 3], // Its own request & two from the Facebook SDK
                ['road24', 'app', 3],
                ['Bookshelf', 'app', 1],
                ['Web view', 'library', 2],
                ['AppMetrica SDK', 'library', 1],
                ['iOS system', 'system', 1],
                ['Video player (AppleCoreMedia)', 'library', 1]
            ]);
        });

        it('mentions the SDKs inside an app and its bundle ID', () => {
            addPhoneTraffic();

            const jett = store.getDevice(PHONE)!.apps.find((app) => app.name === 'Jett Invest App')!;
            expect(jett.detail).to.equal('uz.multibroker.jett.mobile · includes Facebook SDK');
        });

        it('never lists a raw SDK user agent as an app', () => {
            addPhoneTraffic();

            const names = store.getDevice(PHONE)!.apps.map((app) => app.name);
            names.forEach((name) => {
                expect(name).not.to.match(/FBiOSSDK|io\.appmetrica|server-bag|AppleCoreMedia\//);
            });
        });

        it("names the OS services after the device's platform", () => {
            add(
                deviceExchange({ ip: PHONE, ua: UA.iphoneSafari }),
                deviceExchange({ ip: PHONE, ua: UA.serverBag }),
                deviceExchange({ ip: '192.168.0.42', ua: UA.androidChrome }),
                deviceExchange({ ip: '192.168.0.42', ua: 'com.apple.WebKit.Networking/1' })
            );

            expect(apps(PHONE).map(([name]) => name)).to.include('iOS system');
        });

        it('takes deleted requests back off the groups', () => {
            const sdk = deviceExchange({ ip: PHONE, ua: UA.facebookSdk, headers: JETT_BAGGAGE });
            const app = deviceExchange({ ip: PHONE, ua: UA.jettApp, headers: JETT_BAGGAGE });
            add(sdk, app);
            expect(apps()).to.deep.equal([['Jett Invest App', 'app', 2]]);

            runInAction(() => { events.remove(app); });
            // The SDK's request still names the app, by its bundle ID
            expect(apps()).to.deep.equal([['uz.multibroker.jett.mobile', 'app', 1]]);

            runInAction(() => { events.remove(sdk); });
            expect(store.getDevice(PHONE)).to.equal(undefined);
        });
    });

    describe('selecting and filtering by app', () => {
        it('shows every variant of an app when it is selected in the panel', () => {
            addPhoneTraffic();
            store.select({ deviceKey: PHONE, app: 'road24' });

            const matching = events.filter((event) => store.selectionFilter!.matches(event));
            expect(matching.length).to.equal(3);
        });

        it('matches the same requests with app=', () => {
            addPhoneTraffic();
            const directory = getDeviceDirectory();

            const road24 = events.filter((event) => directory.getEventAppName(event) === 'road24');
            expect(road24.length).to.equal(3);
            expect(events.map((event) => store.getEventAppName(event))).to.include('Jett Invest App');
        });

        it('falls back to the request alone for events the store has not counted', () => {
            const stray = deviceExchange({ ip: PHONE, ua: UA.facebookSdk });
            expect(store.getEventAppName(stray)).to.equal('Facebook SDK');
        });
    });

    describe('requests that are broken', () => {
        const brokenRequest = () => {
            const exchange = deviceExchange({ ip: PHONE, tags: ['client-error:EPIPE'] });
            Object.assign(exchange.request, {
                method: '',
                url: 'http://',
                // As the UI models a URL it can't read (see http-exchange.ts)
                parsedUrl: Object.assign(new URL('unknown://unparseable.invalid/'), { parseable: false })
            });
            return exchange;
        };

        it('is counted without breaking the devices or the apps', () => {
            add(brokenRequest(), deviceExchange({ ip: PHONE, ua: UA.iphoneSafari }));

            const device = store.getDevice(PHONE)!;
            expect(device.eventCount).to.equal(2);
            expect(device.hosts.map((host) => host.host)).to.deep.equal(['example.com']);
            expect(apps()).to.deep.equal([['Safari', 'app', 1], ['Unknown client', 'unknown', 1]]);
        });

        it('is not described with nonsense in the status bar', () => {
            add(brokenRequest());

            const overview = describeDevices(store.devices)!;
            expect(overview.label).to.equal('Device');
            expect(overview.title).not.to.match(/undefined|NaN|null/);
        });
    });

    describe('the Send page', () => {
        it('is not a connected client', () => {
            add(deviceExchange({ sentFromSendPage: true }));

            expect(store.getDevice(THIS_MACHINE_KEY)!.apps[0].kind).to.equal('send');
            expect(describeDevices(store.devices)).to.equal(undefined);
            expect(identifyApp({ source: MANUALLY_SENT_SOURCE }).client?.kind).to.equal('send');
        });
    });

    describe('through the VPN', () => {
        const vpnExchange = (ua: string, tags = VPN_TAGS_AS_RECEIVED) =>
            deviceExchange({ ip: '127.0.0.1', ua, tags });

        it('belongs to the phone whose address is in the tags, not to this machine', () => {
            add(vpnExchange(UA.iphoneSafari), vpnExchange(UA.iosApp));

            expect(store.devices.map((device) => device.key)).to.deep.equal([PHONE]);

            const phone = store.getDevice(PHONE)!;
            expect(phone.eventCount).to.equal(2);
            expect(phone.type).to.equal('iphone'); // Recognised although it arrived from loopback
            expect(phone.name).to.equal('iPhone');
            expect(phone.address).to.equal(PHONE);
            expect(phone.viaVpn).to.equal(true);
            expect(phone.vpnPeers).to.deep.equal(['p1']);
        });

        it('is marked on the request rows', () => {
            const event = vpnExchange(UA.iphoneSafari);
            add(event, deviceExchange({ ip: '127.0.0.1', ua: UA.curl }));

            expect(store.getDeviceMarker(event)).to.deep.include({ name: 'iPhone', type: 'iphone', viaVpn: true });
            expect(store.describeEventVpn(event)).to.contain('through the VPN'); // Per request, not per device
            expect(getDeviceDirectory().getEventDevice(event)).to.deep.equal({ key: PHONE, type: 'iphone' });
        });

        it('joins the same phone when it also used the proxy directly', () => {
            add(vpnExchange(UA.iphoneSafari), deviceExchange({ ip: PHONE, ua: UA.iosApp }));

            expect(store.devices.map((device) => device.key)).to.deep.equal([PHONE]);
            expect(store.getDevice(PHONE)!.eventCount).to.equal(2);
            expect(store.getDevice(PHONE)!.viaVpn).to.equal(true);
        });

        it('also reads the tags without the prefix', () => {
            add(deviceExchange({ ip: '127.0.0.1', ua: UA.iphoneSafari, tags: VPN_TAGS }));

            expect(store.devices.map((device) => device.key)).to.deep.equal([PHONE]);
            expect(store.getDevice(PHONE)!.vpnPeers).to.deep.equal(['p1']);
        });

        it('counts failed TLS connections of the phone', () => {
            add(failedTls('127.0.0.1', 'api.example.com', VPN_TAGS_AS_RECEIVED));

            expect(store.devices.map((device) => device.key)).to.deep.equal([PHONE]);
            expect(store.getDevice(PHONE)!.viaVpn).to.equal(true);
        });

        it('stops saying VPN once its requests are deleted', () => {
            const viaVpn = vpnExchange(UA.iphoneSafari);
            add(viaVpn, deviceExchange({ ip: PHONE, ua: UA.iosApp }));

            runInAction(() => { events.remove(viaVpn); });
            expect(store.getDevice(PHONE)!.viaVpn).to.equal(false);
            expect(store.getDevice(PHONE)!.vpnPeers).to.deep.equal([]);
        });

        it('keeps the real address when the tag is not an address', () => {
            add(vpnExchange(UA.curl, ['wirepane-vpn', 'wirepane-vpn-endpoint:not-an-ip', 'wirepane-vpn-endpoint:']));

            expect(store.devices.map((device) => device.key)).to.deep.equal([THIS_MACHINE_KEY]);
            expect(store.getDevice(THIS_MACHINE_KEY)!.viaVpn).to.equal(true);
        });

        it('reads the tags', () => {
            expect(getVpnAttribution(undefined)).to.equal(undefined);
            expect(getVpnAttribution(['some-other-tag'])).to.equal(undefined);
            expect(getVpnAttribution(['wirepane-vpn'])).to.deep.equal({ endpoint: undefined, peer: undefined });
            expect(getVpnAttribution(['socket-metadata:other', 'wirepane-vpnish', 'wirepane-vpn-endpointless'])).to.deep.equal({ endpoint: undefined, peer: undefined });
            expect(getVpnAttribution(['socket-metadata:wirepane-vpn-endpoint:10.73.0.2'])).to.deep.equal({ endpoint: '10.73.0.2', peer: undefined });
            expect(getVpnAttribution(VPN_TAGS_AS_RECEIVED)).to.deep.equal({ endpoint: PHONE, peer: 'p1' });
            expect(getVpnAttribution([...VPN_TAGS, 'wirepane-vpn-name:example.com']))
                .to.deep.equal({ endpoint: PHONE, peer: 'p1' });
            expect(getVpnAttribution(['wirepane-vpn-endpoint:fe80::1'])).to.deep.equal({ endpoint: 'fe80::1', peer: undefined });
        });
    });

    describe('the status bar summary', () => {
        it('names one device and its apps in plain words', () => {
            addPhoneTraffic();

            const overview = describeDevices(store.devices)!;
            // Jett, road24 and Bookshelf are apps. The SDKs, web view and OS aren't.
            expect(overview.label).to.equal('iPhone · 3 apps');
            expect(overview.title).to.contain(`iPhone (${PHONE}) · 12 requests`);
            expect(overview.title).to.contain('Apps: Jett Invest App, road24, Bookshelf');
            expect(overview.title).to.contain('Also: Web view, AppMetrica SDK, iOS system, Video player (AppleCoreMedia)');
            expect(overview.label + overview.title).not.to.match(/FBiOSSDK|io\.appmetrica\.analytics\//);
        });

        it('names the app when it is the only one', () => {
            add(deviceExchange({ ip: '127.0.0.1', ua: UA.curl }));

            expect(describeDevices(store.devices)!.label).to.equal('This Mac · curl');
        });

        it('counts devices when there are several', () => {
            add(
                deviceExchange({ ip: '127.0.0.1', ua: UA.curl }),
                deviceExchange({ ip: PHONE, ua: UA.iphoneSafari })
            );

            const overview = describeDevices(store.devices)!;
            expect(overview.label).to.equal('2 devices');
            expect(overview.title).to.contain('This Mac · 1 request');
            expect(overview.title).to.contain(`iPhone (${PHONE}) · 1 request`);
        });

        it('marks a phone that connects through the VPN', () => {
            add(deviceExchange({ ip: '127.0.0.1', ua: UA.iphoneSafari, tags: VPN_TAGS }));

            expect(describeDevices(store.devices)!.title).to.contain(`iPhone (${PHONE}) · VPN · 1 request`);
        });

        it('has nothing to say without traffic', () => {
            expect(describeDevices(store.devices)).to.equal(undefined);
        });
    });
});
