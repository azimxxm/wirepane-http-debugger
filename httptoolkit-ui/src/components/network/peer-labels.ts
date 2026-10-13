import * as React from 'react';

import { UNKNOWN_VPN_PEER_NAME, VpnPeerNames } from '../../model/devices/vpn-peer-names';

/*
 * What the Network page's tabs call a VPN device. The server names the devices it has. One it
 * doesn't know any more was removed, but its queries and flows are still in the lists, and every
 * tab calls it the same thing, with its id to tell several of them apart.
 */

export const removedDeviceLabel = (peer: string) => `Removed device (${peer})`;

/**
 * Asks the server for the names of these devices (once each, see VpnPeerNames) and returns the
 * ones it has answered about. A device that is still being asked about isn't called removed yet:
 * it keeps the fallback name, so a device that is just being looked up doesn't flash as removed.
 */
export function useAskedPeers(names: VpnPeerNames, peerIds: readonly string[]): ReadonlySet<string> {
    const [asked, setAsked] = React.useState<ReadonlySet<string>>(() => new Set());
    const key = peerIds.join(',');

    React.useEffect(() => {
        if (!key) return;

        const ids = key.split(',');
        let current = true;
        names.ensureNamed(ids).then(() => {
            if (current) setAsked((before) => new Set(Array.from(before).concat(ids)));
        });
        return () => { current = false; };
    }, [names, key]);

    return asked;
}

/** The name the server has for the device, "Removed device (p42)" if it was asked and has none. */
export function peerLabel(names: VpnPeerNames, asked: ReadonlySet<string>, peer: string): string {
    const name = names.nameOf(peer);
    return name === UNKNOWN_VPN_PEER_NAME && asked.has(peer) ? removedDeviceLabel(peer) : name;
}
