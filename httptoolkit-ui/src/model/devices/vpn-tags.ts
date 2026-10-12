import * as ipaddr from 'ipaddr.js';

/**
 * What the VPN tunnel says about a connection. Its traffic reaches the proxy from this
 * machine's own loopback address, so these tags are the only thing that tells which phone
 * it came from: `wirepane-vpn-endpoint:<the phone's LAN IP>` and `wirepane-vpn-peer:<id>`
 * (see docs/plans/2026-10-12-iphone-fixes-and-vpn.md).
 *
 * No imports from the rest of the app, so both the device model and the phone setup
 * code can use it.
 */

const VPN_TAG = 'wirepane-vpn';
// Mockttp puts this in front of every tag that a SOCKS client sends as metadata when it connects,
// so the tunnel's `wirepane-vpn-peer:p1` reaches the UI as `socket-metadata:wirepane-vpn-peer:p1`
const SOCKET_METADATA_PREFIX = 'socket-metadata:';
const ENDPOINT_PREFIX = 'wirepane-vpn-endpoint:';
const PEER_PREFIX = 'wirepane-vpn-peer:';

export interface VpnAttribution {
    // The phone's address on the local network. Undefined until the tunnel knows it.
    endpoint: string | undefined;
    // The tunnel peer's id: "p1"
    peer: string | undefined;
}

function tagValue(tag: string, prefix: string): string | undefined {
    if (!tag.startsWith(prefix)) return undefined;
    const value = tag.slice(prefix.length).trim();
    return value || undefined;
}

/**
 * Whether a connection came through the VPN tunnel, and from which phone. A missing or
 * unreadable endpoint is left out rather than guessed, so the traffic keeps the address
 * it really came from.
 */
export function getVpnAttribution(tags: readonly string[] | undefined): VpnAttribution | undefined {
    if (!tags || tags.length === 0) return undefined;

    let isVpn = false;
    let endpoint: string | undefined;
    let peer: string | undefined;

    for (const rawTag of tags) {
        if (typeof rawTag !== 'string') continue;
        const tag = rawTag.startsWith(SOCKET_METADATA_PREFIX) ? rawTag.slice(SOCKET_METADATA_PREFIX.length) : rawTag;
        if (tag !== VPN_TAG && !tag.startsWith(`${VPN_TAG}-`)) continue;
        isVpn = true;

        const tagEndpoint = tagValue(tag, ENDPOINT_PREFIX);
        if (tagEndpoint && ipaddr.isValid(tagEndpoint)) endpoint = endpoint ?? tagEndpoint;

        peer = peer ?? tagValue(tag, PEER_PREFIX);
    }

    return isVpn ? { endpoint, peer } : undefined;
}
