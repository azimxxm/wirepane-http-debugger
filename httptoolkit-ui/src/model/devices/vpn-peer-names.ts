import * as _ from 'lodash';
import { observable, runInAction } from 'mobx';

import { getDetailedInterceptorMetadata } from '../../services/server-api';
import { VPN_INTERCEPTOR_ID, parseVpnMetadata } from '../interception/vpn-mode';

/**
 * The names of the VPN tunnel's devices. A request that came through the tunnel only carries
 * its peer's id in the tags ("p1"): the server is the one that knows that peer is "iPhone".
 */

// What a peer is called while the server hasn't told us its name (or doesn't know it)
export const UNKNOWN_VPN_PEER_NAME = 'VPN device';

// Reads the VPN interceptor's detailed metadata, which lists its peers with their names
export type VpnMetadataLoader = () => Promise<unknown>;

const loadFromServer: VpnMetadataLoader = () => getDetailedInterceptorMetadata(VPN_INTERCEPTOR_ID);

export class VpnPeerNames {

    // Peer id -> the server's name for it: "p1" -> "iPhone"
    private readonly names = observable.map<string, string>();
    // The peers the server was asked about. It's asked once per peer, never on a timer, so a
    // peer it doesn't know (e.g. one that was removed) doesn't make us ask again and again.
    private readonly askedAbout = new Set<string>();
    // Reads run one after another: a peer that shows up while one is running may have been
    // added after that read started, and the next one then finds it.
    private queue: Promise<void> = Promise.resolve();

    constructor(private readonly loadMetadata: VpnMetadataLoader = loadFromServer) {}

    // The peer's name, or the fallback until the server has named it
    nameOf(peerId: string): string {
        return this.names.get(peerId) ?? UNKNOWN_VPN_PEER_NAME;
    }

    // The names of several peers, without repeats: ["iPhone", "iPhone 2"]
    namesOf(peerIds: readonly string[]): string[] {
        return _.uniq(peerIds.map((peerId) => this.nameOf(peerId)));
    }

    /**
     * Asks the server for the names of peers that aren't named yet. It never rejects: a server
     * without VPN mode, or one that is busy, just leaves the fallback name in place.
     */
    ensureNamed(peerIds: readonly string[]): Promise<void> {
        const wanted = peerIds.filter((peerId) => !this.names.has(peerId) && !this.askedAbout.has(peerId));
        if (wanted.length === 0) return this.queue;

        wanted.forEach((peerId) => this.askedAbout.add(peerId));

        this.queue = this.queue.then(async () => {
            // A read that was queued before this one may have named them already
            if (wanted.every((peerId) => this.names.has(peerId))) return;
            await this.readNames(wanted);
        });
        return this.queue;
    }

    private async readNames(wanted: readonly string[]) {
        try {
            const metadata = parseVpnMetadata(await this.loadMetadata());
            if (!metadata) return; // A server without VPN mode

            runInAction(() => {
                metadata.peers.forEach((peer) => {
                    // A peer without a name is parsed as named after its id
                    if (peer.name !== peer.peer) this.names.set(peer.peer, peer.name);
                });
            });
        } catch (e) {
            // The next time these peers show up, we try again
            wanted.forEach((peerId) => this.askedAbout.delete(peerId));
            console.warn("Couldn't read the names of the VPN devices", e);
        }
    }
}

/**
 * Says something came through the VPN, and (when the server named them) through which
 * devices: "through the VPN (iPhone)". The fallback name tells nothing more than the VPN
 * does, so it's left out when it's all there is.
 */
export function describeVpn(peerNames: readonly string[]): string {
    const hasRealName = peerNames.some((name) => name !== UNKNOWN_VPN_PEER_NAME);
    return hasRealName ? `through the VPN (${peerNames.join(', ')})` : 'through the VPN';
}
