import { expect } from '../../../test-setup';

import {
    UNKNOWN_VPN_PEER_NAME,
    VpnPeerNames,
    describeVpn
} from '../../../../src/model/devices/vpn-peer-names';

// What the server's VPN interceptor answers: its peers with the names the UI gave them
const vpnMetadata = (...peers: Array<[id: string, name?: string]>) => ({
    available: true,
    running: true,
    listen: '0.0.0.0:51873',
    endpointHost: '192.168.0.156',
    peers: peers.map(([peer, name]) => ({ peer, ...(name ? { name } : {}), tunnelIp: '10.73.0.2' }))
});

describe('VPN peer names', () => {

    let reads: number;
    let answer: () => Promise<unknown>;
    let names: VpnPeerNames;

    beforeEach(() => {
        reads = 0;
        answer = async () => vpnMetadata(['p1', 'iPhone'], ['p2', 'iPhone 2']);
        names = new VpnPeerNames(async () => {
            reads += 1;
            return answer();
        });
    });

    it("says what the server calls a peer, once it has been asked", async () => {
        expect(names.nameOf('p1')).to.equal(UNKNOWN_VPN_PEER_NAME);

        await names.ensureNamed(['p1']);

        expect(names.nameOf('p1')).to.equal('iPhone');
        expect(names.nameOf('p2')).to.equal('iPhone 2'); // The same answer named it as well
        expect(reads).to.equal(1);
    });

    it('falls back to "VPN device" until it knows, and for peers the server does not have', async () => {
        expect(UNKNOWN_VPN_PEER_NAME).to.equal('VPN device');
        expect(names.nameOf('p1')).to.equal('VPN device');

        await names.ensureNamed(['p9']);

        expect(names.nameOf('p9')).to.equal('VPN device');
        expect(names.namesOf(['p1', 'p9'])).to.deep.equal(['iPhone', 'VPN device']);
    });

    it('does not take the id for a name when the server sent none', async () => {
        answer = async () => vpnMetadata(['p1'], ['p3', 'iPhone']);

        await names.ensureNamed(['p1', 'p3']);

        expect(names.nameOf('p1')).to.equal('VPN device');
        expect(names.nameOf('p3')).to.equal('iPhone');
    });

    it('lists each name once', async () => {
        answer = async () => vpnMetadata(['p1', 'iPhone'], ['p2', 'iPhone'], ['p3', 'Pixel']);
        await names.ensureNamed(['p1']);

        expect(names.namesOf(['p1', 'p2', 'p3'])).to.deep.equal(['iPhone', 'Pixel']);
        expect(names.namesOf([])).to.deep.equal([]);
    });

    it('asks once, not every time the same peers show up', async () => {
        await names.ensureNamed(['p1']);
        await names.ensureNamed(['p1']);
        await names.ensureNamed(['p1', 'p2']);
        expect(reads).to.equal(1);

        // A peer the server did not know is not asked about again either
        await names.ensureNamed(['p9']);
        await names.ensureNamed(['p9']);
        expect(reads).to.equal(2);
    });

    it('asks again when a peer shows up that the first answer did not have', async () => {
        answer = async () => vpnMetadata(['p1', 'iPhone']);
        await names.ensureNamed(['p1']);

        // A second phone is added while the first one is already known
        answer = async () => vpnMetadata(['p1', 'iPhone'], ['p2', 'iPad']);
        await names.ensureNamed(['p1', 'p2']);

        expect(reads).to.equal(2);
        expect(names.namesOf(['p1', 'p2'])).to.deep.equal(['iPhone', 'iPad']);
    });

    it('keeps the names it has when a later answer has no peers (the tunnel was stopped)', async () => {
        await names.ensureNamed(['p1']);

        answer = async () => ({ ...vpnMetadata(), running: false });
        await names.ensureNamed(['p5']);

        expect(names.nameOf('p1')).to.equal('iPhone');
    });

    it('reads one after another, and skips a read that an earlier one made pointless', async () => {
        let finishFirstRead!: () => void;
        const firstRead = new Promise<void>((resolve) => { finishFirstRead = resolve; });
        answer = async () => {
            if (reads === 1) await firstRead;
            return vpnMetadata(['p1', 'iPhone'], ['p2', 'iPhone 2']);
        };

        const first = names.ensureNamed(['p1']);
        const second = names.ensureNamed(['p2']); // p2 is asked about while the first read runs
        finishFirstRead();
        await Promise.all([first, second]);

        expect(reads).to.equal(1); // The first answer named p2 as well
        expect(names.nameOf('p2')).to.equal('iPhone 2');
    });

    it('never rejects, and tries a peer again after a failed read', async () => {
        answer = async () => { throw new Error('The server is busy'); };
        await names.ensureNamed(['p1']); // Does not throw

        expect(names.nameOf('p1')).to.equal('VPN device');

        answer = async () => vpnMetadata(['p1', 'iPhone']);
        await names.ensureNamed(['p1']);

        expect(reads).to.equal(2);
        expect(names.nameOf('p1')).to.equal('iPhone');
    });

    it('copes with a server that has no VPN mode', async () => {
        answer = async () => undefined;
        await names.ensureNamed(['p1']);
        answer = async () => ({ error: 'Not found' });
        await names.ensureNamed(['p2']);

        expect(names.namesOf(['p1', 'p2'])).to.deep.equal(['VPN device']);
    });

    describe('describing the VPN', () => {
        it('names the devices when it knows them', () => {
            expect(describeVpn(['iPhone'])).to.equal('through the VPN (iPhone)');
            expect(describeVpn(['iPhone', 'iPhone 2'])).to.equal('through the VPN (iPhone, iPhone 2)');
            expect(describeVpn(['iPhone', UNKNOWN_VPN_PEER_NAME])).to.equal('through the VPN (iPhone, VPN device)');
        });

        it('says nothing more when it only has the fallback or nothing', () => {
            expect(describeVpn([])).to.equal('through the VPN');
            expect(describeVpn([UNKNOWN_VPN_PEER_NAME])).to.equal('through the VPN');
        });
    });
});
