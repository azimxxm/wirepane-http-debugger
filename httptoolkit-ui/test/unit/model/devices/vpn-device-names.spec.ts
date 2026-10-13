import { IObservableArray, observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { CollectedEvent } from '../../../../src/types';
import { DevicesStore } from '../../../../src/model/devices/devices-store';
import { VpnPeerNames } from '../../../../src/model/devices/vpn-peer-names';

import { MemoryStorage, UA, deviceExchange, failedTls } from './device-test-helpers';

const PHONE = '192.168.0.199';
const SECOND_PHONE = '192.168.0.205';

const tagsFor = (peer: string | undefined, endpoint: string) => [
    'wirepane-vpn',
    ...(peer ? [`wirepane-vpn-peer:${peer}`] : []),
    `wirepane-vpn-endpoint:${endpoint}`
].map((tag) => `socket-metadata:${tag}`);

// The traffic of a phone: its tunnel connects to the proxy from loopback
const vpnExchange = (peer: string | undefined, endpoint = PHONE, ua = UA.iphoneSafari) =>
    deviceExchange({ ip: '127.0.0.1', ua, tags: tagsFor(peer, endpoint) });

// Lets the store's reaction and the (fake) server read run
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('VPN devices in the Devices store', () => {

    let events: IObservableArray<CollectedEvent>;
    let store: DevicesStore;
    let reads: number;
    let peers: Array<[string, string]>;

    const add = (...newEvents: CollectedEvent[]) => runInAction(() => { events.push(...newEvents); });

    beforeEach(async () => {
        events = observable.array<CollectedEvent>([], { deep: false });
        reads = 0;
        peers = [['p1', 'iPhone'], ['p2', 'iPhone 2']];

        const vpnPeerNames = new VpnPeerNames(async () => {
            reads += 1;
            return {
                available: true,
                running: true,
                peers: peers.map(([peer, name]) => ({ peer, name }))
            };
        });
        store = new DevicesStore({ events }, {
            nameStorage: new MemoryStorage(),
            thisMachineType: 'mac',
            vpnPeerNames
        });
        await store.initialized;
    });

    afterEach(() => store.dispose());

    describe('asking the server for the names', () => {
        it('does nothing until there is VPN traffic', async () => {
            add(deviceExchange({ ip: PHONE, ua: UA.iphoneSafari }), deviceExchange({ ip: '127.0.0.1', ua: UA.curl }));
            await flush();

            expect(reads).to.equal(0);
        });

        it('reads the names once, when the first VPN request shows up', async () => {
            add(vpnExchange('p1'));
            await flush();
            expect(reads).to.equal(1);

            // More traffic, from the same phone, does not ask again
            add(vpnExchange('p1'), vpnExchange('p1', PHONE, UA.iosApp), failedTls('127.0.0.1', 'api.example.com', tagsFor('p1', PHONE)));
            await flush();
            expect(reads).to.equal(1);
        });

        it('asks again for a second phone, as it was added after the first read', async () => {
            peers = [['p1', 'iPhone']];
            add(vpnExchange('p1'));
            await flush();

            peers.push(['p2', 'iPhone 2']);
            add(vpnExchange('p2', SECOND_PHONE));
            await flush();

            expect(reads).to.equal(2);
            expect(store.describeDeviceVpn(store.getDevice(SECOND_PHONE)!)).to.equal('through the VPN (iPhone 2)');
        });

        it('reads names that are already in the list when the store starts', async () => {
            const loadedEvents = observable.array<CollectedEvent>([vpnExchange('p1')], { deep: false });
            const earlyStore = new DevicesStore({ events: loadedEvents }, {
                nameStorage: new MemoryStorage(),
                thisMachineType: 'mac',
                vpnPeerNames: new VpnPeerNames(async () => {
                    reads += 1;
                    return { available: true, peers: [{ peer: 'p1', name: 'iPhone' }] };
                })
            });
            await earlyStore.initialized;
            await flush();

            expect(reads).to.equal(1);
            expect(earlyStore.describeDeviceVpn(earlyStore.getDevice(PHONE)!)).to.equal('through the VPN (iPhone)');
            earlyStore.dispose();
        });

        it('stops watching when the store is disposed', async () => {
            store.dispose();
            add(vpnExchange('p1'));
            await flush();

            expect(reads).to.equal(0);
        });
    });

    describe('the Devices panel', () => {
        it('says "iPhone" instead of the peer id once the server has named it', async () => {
            add(vpnExchange('p1'));
            const phone = store.getDevice(PHONE)!;
            expect(phone.vpnPeers).to.deep.equal(['p1']);

            // Before the server answers, only "through the VPN" is known
            expect(store.describeDeviceVpn(phone)).to.equal('through the VPN');

            await flush();
            expect(store.describeDeviceVpn(phone)).to.equal('through the VPN (iPhone)');
            expect(store.describeDeviceVpn(phone)).not.to.contain('p1');
        });

        it('names every peer a device used', async () => {
            add(vpnExchange('p1'), vpnExchange('p2'));
            await flush();

            expect(store.describeDeviceVpn(store.getDevice(PHONE)!)).to.equal('through the VPN (iPhone, iPhone 2)');
        });

        it('keeps the fallback when the server does not know the peer', async () => {
            add(vpnExchange('p7'));
            await flush();

            expect(store.describeDeviceVpn(store.getDevice(PHONE)!)).to.equal('through the VPN');
        });

        it('says only "through the VPN" for traffic with no peer', async () => {
            add(vpnExchange(undefined));
            await flush();

            expect(reads).to.equal(0);
            expect(store.describeDeviceVpn(store.getDevice(PHONE)!)).to.equal('through the VPN');
        });
    });

    describe('the request rows', () => {
        it('marks a request that came through the VPN with its peer name', async () => {
            const viaVpn = vpnExchange('p1');
            add(viaVpn);
            expect(store.describeEventVpn(viaVpn)).to.equal('through the VPN');

            await flush();
            expect(store.describeEventVpn(viaVpn)).to.equal('through the VPN (iPhone)');
        });

        it("marks only the requests that came through the VPN, not the same phone's direct ones", async () => {
            const viaVpn = vpnExchange('p1');
            const direct = deviceExchange({ ip: PHONE, ua: UA.iosApp });
            add(viaVpn, direct);
            await flush();

            expect(store.getDevice(PHONE)!.viaVpn).to.equal(true);
            expect(store.getDeviceMarker(direct)!.viaVpn).to.equal(true); // The device used it...
            expect(store.describeEventVpn(direct)).to.equal(undefined); // ...but this request did not
            expect(store.describeEventVpn(viaVpn)).to.equal('through the VPN (iPhone)');
        });

        it('marks a failed TLS connection of the phone too', async () => {
            const failed = failedTls('127.0.0.1', 'api.example.com', tagsFor('p1', PHONE));
            add(failed);
            await flush();

            expect(store.describeEventVpn(failed)).to.equal('through the VPN (iPhone)');
        });

        it('has nothing to say about requests that did not use the VPN', () => {
            const local = deviceExchange({ ip: '127.0.0.1', ua: UA.curl });
            add(local);

            expect(store.describeEventVpn(local)).to.equal(undefined);
        });

        it('leaves the VPN out of the device marker, as a device can have requests of both kinds', async () => {
            const viaVpn = vpnExchange('p1');
            add(viaVpn);
            await flush();

            expect(store.getDeviceMarker(viaVpn)).to.deep.equal({
                name: 'iPhone',
                title: `iPhone (${PHONE})`,
                type: 'iphone',
                viaVpn: true
            });
        });
    });
});
