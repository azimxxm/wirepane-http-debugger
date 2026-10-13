import { expect } from '../../../test-setup';

import { VpnPeerNames } from '../../../../src/model/devices/vpn-peer-names';
import { peerLabel, removedDeviceLabel } from '../../../../src/components/network/peer-labels';

describe('The names of devices on the Network page', () => {

    // A server that knows one device
    const names = () => new VpnPeerNames(async () => ({
        available: true,
        running: true,
        peers: [{ peer: 'p1', name: 'iPhone' }]
    }));

    it('says a device was removed, with its id to tell several apart', () => {
        expect(removedDeviceLabel('p42')).to.equal('Removed device (p42)');
        expect(removedDeviceLabel('p7')).to.equal('Removed device (p7)');
    });

    it('is the name the server has for the device', async () => {
        const serverNames = names();
        await serverNames.ensureNamed(['p1']);

        expect(peerLabel(serverNames, new Set(['p1']), 'p1')).to.equal('iPhone');
        // Even before the answer is known to be the whole answer
        expect(peerLabel(serverNames, new Set(), 'p1')).to.equal('iPhone');
    });

    it('is the plain fallback name while the server is being asked, so a device being looked up is not called removed', () => {
        expect(peerLabel(names(), new Set(), 'p9')).to.equal('VPN device');
    });

    it('is the removed device label once the server was asked and does not know the device', async () => {
        const serverNames = names();
        await serverNames.ensureNamed(['p1', 'p9']);

        expect(peerLabel(serverNames, new Set(['p1', 'p9']), 'p9')).to.equal('Removed device (p9)');
        // Another device that is still being asked about keeps the fallback
        expect(peerLabel(serverNames, new Set(['p1', 'p9']), 'p10')).to.equal('VPN device');
    });
});
