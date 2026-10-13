import { expect } from '../../../test-setup';

import {
    ANDROID_MODE_STORAGE_KEY,
    createAndroidVpnApi,
    isAndroidPeer,
    nextAndroidPeerName,
    parseAndroidMode,
    pickAndroidPeer,
    readAndroidMode,
    saveAndroidMode,
    startAndroidVpn
} from '../../../../src/model/interception/android-vpn';
import {
    ModeStorage,
    VpnActivateOptions,
    VpnModeStore,
    VpnPeer,
    VpnServerApi
} from '../../../../src/model/interception/vpn-mode';

const WG_CONFIG = [
    '[Interface]',
    'PrivateKey = c2ltdWxhdGVkLXByaXZhdGUta2V5LW5vdC1yZWFsISE=',
    'Address = 10.73.0.3/32',
    '',
    '[Peer]',
    'PublicKey = c2ltdWxhdGVkLXB1YmxpYy1rZXktbm90LXJlYWwhISE=',
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'Endpoint = 192.168.0.10:51873'
].join('\n');

type FakePeer = { peer: string, name: string, tunnelIp: string, lastHandshake?: number };

// Answers like the server's wireguard-vpn interceptor does
class FakeVpnServer implements VpnServerApi {

    calls: VpnActivateOptions[] = [];
    running = false;
    peers: FakePeer[] = [];
    startError: Error | undefined;

    async activate(options: VpnActivateOptions) {
        this.calls.push(options);

        switch (options.action) {
            case 'start':
                if (this.startError) throw this.startError;
                this.running = true;
                return {};
            case 'stop':
                this.running = false;
                return {};
            case 'add-peer': {
                const peer = {
                    peer: `p${this.peers.length + 1}`,
                    name: options.name,
                    tunnelIp: `10.73.0.${this.peers.length + 2}`
                };
                this.peers.push(peer);
                return { ...peer, config: WG_CONFIG };
            }
            case 'remove-peer':
                this.peers = this.peers.filter((peer) => peer.peer !== options.peer);
                return { removed: true };
        }
    }

    async getMetadata() {
        return {
            available: true,
            running: this.running,
            listen: '0.0.0.0:51873',
            endpointHost: '192.168.0.10',
            peers: this.peers
        };
    }

    // The names of the devices the page asked the server to add, in order
    get addedNames() {
        const names: string[] = [];
        this.calls.forEach((call) => {
            if (call.action === 'add-peer') names.push(call.name);
        });
        return names;
    }
}

// An in-memory stand-in for localStorage
class MemoryStorage implements ModeStorage {

    items = new Map<string, string>();

    getItem(key: string) {
        return this.items.get(key) ?? null;
    }

    setItem(key: string, value: string) {
        this.items.set(key, value);
    }
}

const peer = (id: string, name: string, lastHandshake?: number): VpnPeer => ({ peer: id, name, lastHandshake });

describe('Android VPN mode', () => {

    describe('which devices are Android phones', () => {

        it('knows the names the Android page gives', () => {
            expect(isAndroidPeer({ name: 'Android' })).to.equal(true);
            expect(isAndroidPeer({ name: 'Android 2' })).to.equal(true);
            expect(isAndroidPeer({ name: 'Android 12' })).to.equal(true);
        });

        it('does not take other devices for Android phones', () => {
            expect(isAndroidPeer({ name: 'iPhone' })).to.equal(false);
            expect(isAndroidPeer({ name: 'iPhone 2' })).to.equal(false);
            expect(isAndroidPeer({ name: 'p1' })).to.equal(false);
            expect(isAndroidPeer({ name: 'My Android tablet' })).to.equal(false);
        });

        it('names the second phone differently from the first', () => {
            expect(nextAndroidPeerName([])).to.equal('Android');
            expect(nextAndroidPeerName([{ name: 'iPhone' }])).to.equal('Android');
            expect(nextAndroidPeerName([{ name: 'Android' }])).to.equal('Android 2');
            expect(nextAndroidPeerName([{ name: 'Android' }, { name: 'Android 2' }])).to.equal('Android 3');
        });

        it('follows the Android phone that was just added', () => {
            const peers = [peer('p1', 'Android', 5), peer('p2', 'Android 2')];

            expect(pickAndroidPeer(peers, 'p2')?.peer).to.equal('p2');
        });

        it('follows the Android phone seen most recently', () => {
            const peers = [peer('p1', 'Android', 5), peer('p2', 'Android 2', 9), peer('p3', 'Android 3')];

            expect(pickAndroidPeer(peers, undefined)?.peer).to.equal('p2');
        });

        it('never follows the iPhone, even when it was seen last', () => {
            const peers = [peer('p1', 'iPhone', 99), peer('p2', 'Android', 5)];

            expect(pickAndroidPeer(peers, undefined)?.peer).to.equal('p2');
            expect(pickAndroidPeer([peer('p1', 'iPhone', 99)], undefined)).to.equal(undefined);
        });

        it('ignores a QR code that is no longer in the list', () => {
            expect(pickAndroidPeer([peer('p2', 'Android', 5)], 'p9')?.peer).to.equal('p2');
        });
    });

    describe('setting up the tunnel', () => {

        let server: FakeVpnServer;
        let store: VpnModeStore;

        beforeEach(() => {
            server = new FakeVpnServer();
            store = new VpnModeStore(createAndroidVpnApi(server), Date.now, 5);
        });

        it('names the device it adds after Android, not the iPhone', async () => {
            await createAndroidVpnApi(server).activate({ action: 'add-peer', name: 'iPhone' });

            expect(server.addedNames).to.deep.equal(['Android']);
        });

        it('picks a free name from what the server has, not from what the store thinks', async () => {
            server.peers = [
                { peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2' },
                { peer: 'p2', name: 'Android', tunnelIp: '10.73.0.3' }
            ];

            await createAndroidVpnApi(server).activate({ action: 'add-peer', name: 'iPhone 2' });

            expect(server.addedNames).to.deep.equal(['Android 2']);
        });

        it('passes every other call on as it is', async () => {
            const api = createAndroidVpnApi(server);

            await api.activate({ action: 'start' });
            await api.activate({ action: 'remove-peer', peer: 'p1' });
            await api.activate({ action: 'stop' });

            expect(server.calls).to.deep.equal([
                { action: 'start' },
                { action: 'remove-peer', peer: 'p1' },
                { action: 'stop' }
            ]);
        });

        it('starts the tunnel and shows the QR code of a new Android phone', async () => {
            await startAndroidVpn(store);

            expect(server.calls.map((call) => call.action)).to.deep.equal(['start', 'add-peer']);
            expect(store.running).to.equal(true);
            expect(store.peerConfig?.name).to.equal('Android');
            expect(store.peerConfig?.config).to.equal(WG_CONFIG);
        });

        it('adds an Android phone next to an iPhone that was set up before', async () => {
            server.peers = [{ peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2' }];

            await startAndroidVpn(store);

            expect(server.addedNames).to.deep.equal(['Android']);
            expect(store.peerConfig?.peer).to.equal('p2');
            // The iPhone is still there, untouched
            expect(server.peers.map((p) => p.name)).to.deep.equal(['iPhone', 'Android']);
        });

        it('does not add another phone when an Android phone was set up before', async () => {
            server.peers = [{ peer: 'p1', name: 'Android', tunnelIp: '10.73.0.2' }];

            await startAndroidVpn(store);

            expect(server.addedNames).to.deep.equal([]);
            expect(store.running).to.equal(true);
            expect(store.peerConfig).to.equal(undefined);
        });

        it('stops there and shows the error when the tunnel does not start', async () => {
            server.startError = new Error('Address already in use');

            await startAndroidVpn(store);

            expect(server.addedNames).to.deep.equal([]);
            expect(store.running).to.equal(false);
            expect(store.setupError).to.equal('Address already in use');
        });
    });

    describe('remembering how the Android phone connects', () => {

        it('only knows the two kinds of ways', () => {
            expect(parseAndroidMode('vpn')).to.equal('vpn');
            expect(parseAndroidMode('apps')).to.equal('apps');
            expect(parseAndroidMode('proxy')).to.equal(undefined);
            expect(parseAndroidMode(undefined)).to.equal(undefined);
        });

        it('has no choice until one is made', () => {
            expect(readAndroidMode(new MemoryStorage())).to.equal(undefined);
        });

        it('saves the choice, and the latest choice wins', () => {
            const storage = new MemoryStorage();

            saveAndroidMode('apps', storage);
            expect(readAndroidMode(storage)).to.equal('apps');

            saveAndroidMode('vpn', storage);
            expect(readAndroidMode(storage)).to.equal('vpn');
            expect(storage.getItem(ANDROID_MODE_STORAGE_KEY)).to.equal('vpn');
        });

        it('has its own key, apart from the iPhone page', () => {
            expect(ANDROID_MODE_STORAGE_KEY).to.not.equal('wirepane:iphone-connection-mode');
        });

        it('ignores a saved value that is not one of the two kinds', () => {
            const storage = new MemoryStorage();
            storage.setItem(ANDROID_MODE_STORAGE_KEY, 'carrier-pigeon');

            expect(readAndroidMode(storage)).to.equal(undefined);
        });

        it('copes with a blocked storage', () => {
            const blocked: ModeStorage = {
                getItem: () => { throw new Error('Blocked'); },
                setItem: () => { throw new Error('Blocked'); }
            };

            expect(readAndroidMode(blocked)).to.equal(undefined);
            expect(() => saveAndroidMode('vpn', blocked)).to.not.throw();
        });
    });
});
