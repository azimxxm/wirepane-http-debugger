import {
    ModeStorage,
    VpnModeStore,
    VpnPeer,
    VpnServerApi,
    createServerVpnApi,
    getBrowserModeStorage,
    parseVpnMetadata
} from './vpn-mode';

/**
 * VPN mode on the Android page. It's the same WireGuard tunnel as the iPhone's (one sidecar,
 * one UDP port), with its own device name and its own idea of "the phone this page is about",
 * so the iPhone connected next door never shows up as the Android phone.
 */

const ANDROID_PEER_NAME = 'Android';
const ANDROID_PEER_NAME_PATTERN = /^Android( \d+)?$/;

// --- Which way the Android page connects: the VPN or the existing ways ---

// 'apps' is everything the page offered before VPN mode: the HTTP Toolkit app, ADB, a manual proxy
export type AndroidConnectionMode = 'vpn' | 'apps';

// localStorage, like the iPhone page's choice (its own key, so the two pages stay independent)
export const ANDROID_MODE_STORAGE_KEY = 'wirepane:android-connection-mode';

export const parseAndroidMode = (value: unknown): AndroidConnectionMode | undefined =>
    value === 'vpn' || value === 'apps' ? value : undefined;

export function readAndroidMode(storage: ModeStorage | undefined = getBrowserModeStorage()) {
    try {
        return parseAndroidMode(storage?.getItem(ANDROID_MODE_STORAGE_KEY));
    } catch (e) {
        return undefined;
    }
}

export function saveAndroidMode(
    mode: AndroidConnectionMode,
    storage: ModeStorage | undefined = getBrowserModeStorage()
) {
    try {
        storage?.setItem(ANDROID_MODE_STORAGE_KEY, mode);
    } catch (e) {
        // A full or blocked storage only means the choice isn't there next time
        console.warn("Couldn't remember how the Android phone connects", e);
    }
}

// --- Android devices among the tunnel's devices ---

export const isAndroidPeer = (peer: Pick<VpnPeer, 'name'>) =>
    ANDROID_PEER_NAME_PATTERN.test(peer.name);

// "Android", then "Android 2" and so on, so a second phone doesn't clash with the first one
export function nextAndroidPeerName(existing: ReadonlyArray<Pick<VpnPeer, 'name'>>): string {
    const taken = new Set(existing.map((peer) => peer.name));
    if (!taken.has(ANDROID_PEER_NAME)) return ANDROID_PEER_NAME;

    let number = 2;
    while (taken.has(`${ANDROID_PEER_NAME} ${number}`)) number += 1;
    return `${ANDROID_PEER_NAME} ${number}`;
}

/**
 * The Android phone the page is about: the one just added (its QR code is on show), else the
 * Android phone seen most recently. Never an iPhone, whatever its handshake says.
 */
export function pickAndroidPeer(
    peers: ReadonlyArray<VpnPeer>,
    justAddedPeerId: string | undefined
): VpnPeer | undefined {
    const justAdded = peers.find((peer) => peer.peer === justAddedPeerId);
    if (justAdded) return justAdded;

    return peers
        .filter(isAndroidPeer)
        .sort((a, b) => (b.lastHandshake ?? 0) - (a.lastHandshake ?? 0))[0];
}

// --- The store ---

/**
 * The server calls of the shared VPN store, but with new devices named "Android". The store
 * names them after the iPhone, so this asks the server who is there and picks the name itself.
 */
export const createAndroidVpnApi = (server: VpnServerApi): VpnServerApi => ({
    getMetadata: () => server.getMetadata(),
    activate: async (options) => {
        if (options.action !== 'add-peer') return server.activate(options);

        const peers = parseVpnMetadata(await server.getMetadata())?.peers ?? [];
        return server.activate({ ...options, name: nextAndroidPeerName(peers) });
    }
});

/**
 * Starts the tunnel and, when no Android phone is set up yet, makes the QR code for one. The
 * store's own start only adds a device to an empty tunnel, and the iPhone may be in it already.
 */
export async function startAndroidVpn(store: VpnModeStore) {
    await store.start();
    if (!store.running || store.setupError) return;

    if (!store.peers.some(isAndroidPeer) && !store.peerConfig) await store.addDevice();
}

// One store for the whole app, so the QR code and the tunnel's state survive leaving the page
let sharedStore: VpnModeStore | undefined;

export function getAndroidVpnStore(getProxyPort: () => number): VpnModeStore {
    // No mode storage: the iPhone page's choice isn't this page's
    return sharedStore ??= new VpnModeStore(createAndroidVpnApi(createServerVpnApi(getProxyPort)));
}
