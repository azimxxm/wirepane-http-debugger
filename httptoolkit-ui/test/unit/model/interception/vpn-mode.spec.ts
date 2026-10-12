import { expect } from '../../../test-setup';

import {
    FRESH_HANDSHAKE_MS,
    VpnActivateOptions,
    VpnModeStore,
    VpnServerApi,
    formatHandshakeAge,
    nextPeerName,
    parsePeerConfig,
    parseVpnMetadata
} from '../../../../src/model/interception/vpn-mode';

const WG_CONFIG = [
    '[Interface]',
    'PrivateKey = c2ltdWxhdGVkLXByaXZhdGUta2V5LW5vdC1yZWFsISE=',
    'Address = 10.73.0.2/32',
    'DNS = 10.73.0.53',
    '',
    '[Peer]',
    'PublicKey = c2ltdWxhdGVkLXB1YmxpYy1rZXktbm90LXJlYWwhISE=',
    'AllowedIPs = 0.0.0.0/0, ::/0',
    'Endpoint = 192.168.0.10:51873',
    'PersistentKeepalive = 25'
].join('\n');

type FakePeer = { peer: string, name: string, tunnelIp: string, endpoint?: string, lastHandshake?: number };

// Answers like the server's wireguard-vpn interceptor does (see the plan's "Server interceptor" contract)
class FakeVpnServer implements VpnServerApi {

    calls: VpnActivateOptions[] = [];
    metadataCalls = 0;

    available = true;
    running = false;
    peers: FakePeer[] = [];
    metadataFails = false;
    // Like a server that only lists its peers while the tunnel runs
    hidePeersUntilRunning = false;
    metadataDelayMs = 0;
    activateError: Error | undefined;
    error: string | undefined;

    async activate(options: VpnActivateOptions) {
        this.calls.push(options);
        if (this.activateError) throw this.activateError;

        switch (options.action) {
            case 'start':
                this.running = true;
                return this.currentMetadata();
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
        this.metadataCalls += 1;
        if (this.metadataFails) throw new Error('Not found');

        // The state is read when the call is made, so a slow call can show old state
        const metadata = this.currentMetadata();
        if (this.metadataDelayMs) await new Promise((resolve) => setTimeout(resolve, this.metadataDelayMs));
        return metadata;
    }

    private currentMetadata() {
        return {
            available: this.available,
            running: this.running,
            listen: '0.0.0.0:51873',
            endpointHost: '192.168.0.10',
            peers: this.running || !this.hidePeersUntilRunning ? this.peers : [],
            error: this.error
        };
    }
}

const NOW = 1_800_000_000_000;
const waitFor = async (condition: () => boolean) => {
    for (let i = 0; i < 200 && !condition(); i++) {
        await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(condition()).to.equal(true);
};

describe('VPN mode', () => {

    describe('reading what the server sends', () => {

        it('reads the detailed metadata', () => {
            expect(parseVpnMetadata({
                available: true,
                running: true,
                listen: '0.0.0.0:51873',
                endpointHost: '192.168.0.10',
                peers: [{
                    peer: 'p1',
                    name: 'iPhone',
                    tunnelIp: '10.73.0.2',
                    endpoint: '192.168.0.20:61234',
                    lastHandshake: NOW
                }]
            })).to.deep.equal({
                available: true,
                running: true,
                listen: '0.0.0.0:51873',
                endpointHost: '192.168.0.10',
                peers: [{
                    peer: 'p1',
                    name: 'iPhone',
                    tunnelIp: '10.73.0.2',
                    endpoint: '192.168.0.20:61234',
                    lastHandshake: NOW
                }],
                error: undefined
            });
        });

        it('treats anything that is not an object as no VPN interceptor', () => {
            expect(parseVpnMetadata(undefined)).to.equal(undefined);
            expect(parseVpnMetadata(null)).to.equal(undefined);
            expect(parseVpnMetadata('nope')).to.equal(undefined);
        });

        it('drops peers without an id and ignores a handshake of zero', () => {
            const metadata = parseVpnMetadata({
                available: true,
                running: true,
                peers: [{ name: 'no id' }, { peer: 'p2', lastHandshake: 0 }, 'junk']
            })!;

            expect(metadata.peers).to.deep.equal([{
                peer: 'p2',
                name: 'p2',
                tunnelIp: undefined,
                endpoint: undefined,
                lastHandshake: undefined
            }]);
        });

        it('only accepts a peer config that has a configuration', () => {
            expect(parsePeerConfig({ peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2', config: WG_CONFIG }))
                .to.deep.equal({ peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2', config: WG_CONFIG });
            expect(parsePeerConfig({ peer: 'p1', name: 'iPhone' })).to.equal(undefined);
            expect(parsePeerConfig({ config: WG_CONFIG })).to.equal(undefined);
        });

        it('names the second phone differently from the first', () => {
            expect(nextPeerName([])).to.equal('iPhone');
            expect(nextPeerName([{ name: 'iPhone' }])).to.equal('iPhone 2');
            expect(nextPeerName([{ name: 'iPhone' }, { name: 'iPhone 2' }])).to.equal('iPhone 3');
        });

        it('says how long ago a handshake was', () => {
            expect(formatHandshakeAge(3_000)).to.equal('3 s ago');
            expect(formatHandshakeAge(-5)).to.equal('0 s ago');
            expect(formatHandshakeAge(125_000)).to.equal('2 min ago');
            expect(formatHandshakeAge(2 * 60 * 60 * 1000)).to.equal('2 h ago');
        });
    });

    describe('store', () => {

        let server: FakeVpnServer;
        let now: number;
        let store: VpnModeStore;

        beforeEach(() => {
            server = new FakeVpnServer();
            now = NOW;
            store = new VpnModeStore(server, () => now, 5);
        });

        it('is checking until the server answers', () => {
            expect(store.availability).to.equal('checking');
        });

        it('is available when the interceptor answers', async () => {
            await store.refresh();

            expect(store.availability).to.equal('available');
            expect(store.running).to.equal(false);
        });

        it('is unavailable when the interceptor is missing', async () => {
            server.metadataFails = true;
            await store.refresh();

            expect(store.availability).to.equal('unavailable');
        });

        it('is unavailable when the interceptor says it is not available', async () => {
            server.available = false;
            await store.refresh();

            expect(store.availability).to.equal('unavailable');
        });

        it('keeps working after one failed poll', async () => {
            await store.refresh();
            server.metadataFails = true;
            await store.refresh();

            expect(store.availability).to.equal('available');
        });

        it('starts the tunnel and adds the iPhone, keeping its config for the QR code', async () => {
            await store.refresh();
            await store.start();

            expect(server.calls).to.deep.equal([
                { action: 'start' },
                { action: 'add-peer', name: 'iPhone' }
            ]);
            expect(store.running).to.equal(true);
            expect(store.peerConfig).to.deep.equal({
                peer: 'p1',
                name: 'iPhone',
                tunnelIp: '10.73.0.2',
                config: WG_CONFIG
            });
            expect(store.busy).to.equal(undefined);
            expect(store.errorMessage).to.equal(undefined);
        });

        it("doesn't add another device when one was set up before", async () => {
            server.peers = [{ peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2' }];
            await store.refresh();
            await store.start();

            expect(server.calls).to.deep.equal([{ action: 'start' }]);
            expect(store.running).to.equal(true);
            expect(store.peerConfig).to.equal(undefined);
        });

        it('reads the state again after starting, even if a poll was already in flight', async () => {
            server.peers = [{ peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2' }];
            server.hidePeersUntilRunning = true;
            server.metadataDelayMs = 30;

            // This poll sees the tunnel off and no peers, and answers only after the start
            const poll = store.refresh();
            await store.start();
            await poll;

            expect(server.calls).to.deep.equal([{ action: 'start' }]);
            expect(store.peers).to.have.lengthOf(1);
            expect(store.peerConfig).to.equal(undefined);
        });

        it('adds a second device under a new name on request', async () => {
            server.peers = [{ peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2' }];
            await store.refresh();
            await store.addDevice();

            expect(server.calls).to.deep.equal([{ action: 'add-peer', name: 'iPhone 2' }]);
            expect(store.peerConfig!.peer).to.equal('p2');
        });

        it('stops the tunnel and forgets the QR code', async () => {
            await store.refresh();
            await store.start();
            await store.stop();

            expect(server.calls[server.calls.length - 1]).to.deep.equal({ action: 'stop' });
            expect(store.running).to.equal(false);
            expect(store.peerConfig).to.equal(undefined);
        });

        it('shows the error when starting fails, and can be tried again', async () => {
            await store.refresh();
            server.activateError = new Error('UDP port 51873 is already in use');
            await store.start();

            expect(store.errorMessage).to.equal('UDP port 51873 is already in use');
            expect(store.busy).to.equal(undefined);

            server.activateError = undefined;
            await store.start();
            expect(store.errorMessage).to.equal(undefined);
            expect(store.running).to.equal(true);
        });

        it('reports a problem the server found', async () => {
            server.error = 'Could not bind the UDP port';
            await store.refresh();

            expect(store.serverProblem).to.equal('Could not bind the UDP port');
        });

        it('waits for the iPhone until it has done a handshake', async () => {
            server.running = true;
            server.peers = [{ peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2' }];
            await store.refresh();

            expect(store.phoneState).to.equal('waiting');
            expect(store.handshakeAgeMs).to.equal(undefined);
        });

        it('shows the iPhone as connected with the age of its last handshake', async () => {
            server.running = true;
            server.peers = [{
                peer: 'p1',
                name: 'iPhone',
                tunnelIp: '10.73.0.2',
                endpoint: '192.168.0.20:61234',
                lastHandshake: NOW - 3_000
            }];
            await store.refresh();

            expect(store.phoneState).to.equal('connected');
            expect(store.handshakeAgeMs).to.equal(3_000);
        });

        it('shows the iPhone as quiet when its handshake is old', async () => {
            server.running = true;
            server.peers = [{
                peer: 'p1',
                name: 'iPhone',
                tunnelIp: '10.73.0.2',
                lastHandshake: NOW - FRESH_HANDSHAKE_MS - 1_000
            }];
            await store.refresh();

            expect(store.phoneState).to.equal('quiet');
        });

        it('follows the device that was just added when there are several', async () => {
            server.running = true;
            server.peers = [{
                peer: 'p1',
                name: 'iPhone',
                tunnelIp: '10.73.0.2',
                lastHandshake: NOW - 1_000
            }];
            await store.refresh();
            await store.addDevice();

            expect(store.trackedPeer!.peer).to.equal('p2');
            expect(store.phoneState).to.equal('waiting');
        });

        it('polls until it is stopped', async () => {
            const stopPolling = store.startPolling();
            await waitFor(() => server.metadataCalls >= 3);
            stopPolling();

            const callsWhenStopped = server.metadataCalls;
            await new Promise((resolve) => setTimeout(resolve, 40));
            expect(server.metadataCalls).to.be.at.most(callsWhenStopped + 1);
            expect(store.availability).to.equal('available');
        });
    });
});
