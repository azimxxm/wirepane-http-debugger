import * as crypto from 'crypto';
import * as http from 'http';
import * as net from 'net';

// IKEv2 mode for iPhones (wirepane-tunnel/docs/ikev2.md): iOS's built-in VPN client,
// so the phone needs no extra app. This file builds the .mobileconfig profile that
// sets it up (the Wirepane CA plus the VPN) and serves it once over the LAN, for the
// phone to open in Safari before any VPN exists. Nothing here talks to the sidecar;
// the wireguard-vpn interceptor passes in what the sidecar returned for the peer.

// The identities and pinned proposals must match the sidecar's responder
// (wirepane-tunnel/src/frontend/ikev2/mod.rs and docs/ikev2.md section 1)
export const IKEV2_SERVER_IDENTITY = 'vpn.wirepane';
const PHONE_IDENTITY_SUFFIX = '.wirepane';
const PEER_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const IPV4_PATTERN = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
const MAX_NAME_LENGTH = 64;

export const PROFILE_MIME_TYPE = 'application/x-apple-aspen-config';
export const PROFILE_FILENAME = 'Wirepane-VPN.mobileconfig';
// How long the one-time download link stays open
export const PROFILE_LINK_TTL_MS = 10 * 60 * 1000;

export interface Ikev2ProfileOptions {
    peer: string; // the sidecar's peer id, e.g. "p3"
    deviceName: string; // shown in the profile's name, e.g. "iPhone"
    serverAddress: string; // the Mac's LAN IPv4, what the phone dials
    sharedSecret: string; // the sidecar's per-device secret (base64 text)
    caCertificatePem: string; // the Wirepane CA, public part only
}

export function phoneIdentity(peer: string): string {
    return `${peer}${PHONE_IDENTITY_SUFFIX}`;
}

// --- A minimal XML plist writer (only the types a profile needs) ---

type PlistValue = string | number | boolean | Buffer | PlistValue[] | { [key: string]: PlistValue };

function escapeXml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function plistValue(value: PlistValue, indent: string): string {
    const inner = indent + '\t';
    if (typeof value === 'string') return `${indent}<string>${escapeXml(value)}</string>`;
    if (typeof value === 'boolean') return `${indent}<${value}/>`;
    if (typeof value === 'number') {
        if (!Number.isInteger(value)) throw new Error('Only whole numbers go into the profile');
        return `${indent}<integer>${value}</integer>`;
    }
    if (Buffer.isBuffer(value)) {
        // Base64 in 52-character lines, like Apple's own tools write it
        const lines = value.toString('base64').match(/.{1,52}/g) ?? [];
        return `${indent}<data>\n${lines.map((line) => inner + line).join('\n')}\n${indent}</data>`;
    }
    if (Array.isArray(value)) {
        return `${indent}<array>\n${value.map((item) => plistValue(item, inner)).join('\n')}\n${indent}</array>`;
    }
    const entries = Object.entries(value).map(([key, item]) =>
        `${inner}<key>${escapeXml(key)}</key>\n${plistValue(item, inner)}`
    );
    return `${indent}<dict>\n${entries.join('\n')}\n${indent}</dict>`;
}

function toPlist(root: PlistValue): string {
    return '<?xml version="1.0" encoding="UTF-8"?>\n' +
        '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n' +
        '<plist version="1.0">\n' +
        plistValue(root, '') + '\n' +
        '</plist>\n';
}

// --- The profile ---

function pemToDer(pem: string): Buffer {
    const match = /-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/.exec(pem);
    if (!match) throw new Error('The CA certificate is not a PEM certificate');
    const der = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
    // A DER certificate always starts with a SEQUENCE
    if (der.length < 100 || der[0] !== 0x30) throw new Error('The CA certificate is not valid');
    return der;
}

function cleanName(name: string): string {
    const cleaned = name.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, MAX_NAME_LENGTH);
    return cleaned || 'iPhone';
}

// The proposal the sidecar accepts: AES-256-GCM, SHA2-256 as the PRF, P-256, a day per SA
const SECURITY_ASSOCIATION_PARAMETERS = {
    EncryptionAlgorithm: 'AES-256-GCM',
    IntegrityAlgorithm: 'SHA2-256',
    DiffieHellmanGroup: 19,
    LifeTimeInMinutes: 1440
};

/**
 * One .mobileconfig with the Wirepane CA and an IKEv2 VPN for one device. It holds the
 * device's secret, so it must not be logged or kept on disk.
 */
export function buildIkev2Profile(options: Ikev2ProfileOptions): string {
    const { peer, serverAddress, sharedSecret } = options;
    if (!PEER_ID_PATTERN.test(peer)) throw new Error(`Invalid VPN peer id: ${peer}`);
    if (!IPV4_PATTERN.test(serverAddress)) throw new Error(`Invalid VPN server address: ${serverAddress}`);
    if (!/^[A-Za-z0-9+/]{43}=$/.test(sharedSecret)) throw new Error('Invalid IKEv2 shared secret');

    const deviceName = cleanName(options.deviceName);
    const caDer = pemToDer(options.caCertificatePem);
    // The same identifier for the same device, so installing a new profile replaces the old one
    const baseIdentifier = `com.wirepane.vpn.${peer}`;

    const caPayload = {
        PayloadType: 'com.apple.security.root',
        PayloadVersion: 1,
        PayloadIdentifier: `${baseIdentifier}.ca`,
        PayloadUUID: crypto.randomUUID().toUpperCase(),
        PayloadDisplayName: 'Wirepane CA',
        PayloadDescription: 'Lets Wirepane show this device\'s HTTPS traffic. Turn on full trust for it in Settings › General › About › Certificate Trust Settings.',
        PayloadCertificateFileName: 'wirepane-ca.cer',
        PayloadContent: caDer
    };

    const vpnPayload = {
        PayloadType: 'com.apple.vpn.managed',
        PayloadVersion: 1,
        PayloadIdentifier: `${baseIdentifier}.ikev2`,
        PayloadUUID: crypto.randomUUID().toUpperCase(),
        PayloadDisplayName: 'Wirepane VPN',
        PayloadDescription: `Sends this device's traffic through Wirepane on ${serverAddress}.`,
        UserDefinedName: 'Wirepane',
        VPNType: 'IKEv2',
        IKEv2: {
            RemoteAddress: serverAddress,
            RemoteIdentifier: IKEV2_SERVER_IDENTITY,
            LocalIdentifier: phoneIdentity(peer),
            AuthenticationMethod: 'SharedSecret',
            SharedSecret: sharedSecret,
            ExtendedAuthEnabled: 0,
            IKESecurityAssociationParameters: SECURITY_ASSOCIATION_PARAMETERS,
            ChildSecurityAssociationParameters: SECURITY_ASSOCIATION_PARAMETERS,
            EnablePFS: 0,
            DeadPeerDetectionRate: 'Medium',
            // The sidecar does neither; without these iOS might try them
            DisableMOBIKE: 1,
            DisableRedirect: 1,
            NATKeepAliveOffloadEnable: 1,
            NATKeepAliveInterval: 20,
            UseConfigurationAttributeInternalIPSubnet: 0,
            EnableCertificateRevocationCheck: 0,
            OnDemandEnabled: 0
        }
    };

    return toPlist({
        PayloadType: 'Configuration',
        PayloadVersion: 1,
        PayloadIdentifier: baseIdentifier,
        PayloadUUID: crypto.randomUUID().toUpperCase(),
        PayloadDisplayName: `Wirepane VPN (${deviceName})`,
        PayloadDescription: `Captures every app on ${deviceName} with Wirepane, through the VPN built into iOS. Remove this profile when you're done.`,
        PayloadOrganization: 'Wirepane',
        PayloadRemovalDisallowed: false,
        PayloadContent: [caPayload, vpnPayload]
    });
}

// --- The one-time download link ---

export interface ProfileLink {
    url: string;
    // Resolves once the link is closed: after the download, the time limit, or close()
    closed: Promise<'downloaded' | 'expired' | 'closed'>;
    close(): void;
}

/**
 * Serves `profile` once at http://<host>:<random port>/<random token>.mobileconfig.
 * It's plain HTTP (the phone doesn't trust the CA yet), so the link closes after one
 * download or after `ttlMs`. `host` must be the LAN address the phone can reach.
 */
export async function serveProfileOnce(
    profile: string,
    host: string,
    ttlMs: number = PROFILE_LINK_TTL_MS
): Promise<ProfileLink> {
    if (!net.isIPv4(host)) throw new Error(`The profile link needs an IPv4 address, got ${host}`);

    const token = crypto.randomBytes(16).toString('hex');
    const path = `/${token}.mobileconfig`;
    const body = Buffer.from(profile, 'utf8');

    let finish: (reason: 'downloaded' | 'expired' | 'closed') => void = () => {};
    const closed = new Promise<'downloaded' | 'expired' | 'closed'>((resolve) => { finish = resolve; });

    let done = false;
    const server = http.createServer((req, res) => {
        // Only one exact GET (or HEAD, which doesn't use it up) gets the profile
        const isProfile = !done && req.url === path && (req.method === 'GET' || req.method === 'HEAD');
        if (!isProfile) {
            res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
            res.end('Not found');
            return;
        }
        res.writeHead(200, {
            'content-type': PROFILE_MIME_TYPE,
            'content-length': String(body.length),
            'content-disposition': `attachment; filename="${PROFILE_FILENAME}"`,
            'cache-control': 'no-store'
        });
        if (req.method === 'HEAD') {
            res.end();
            return;
        }
        done = true;
        res.end(body, () => stop('downloaded'));
    });
    // A phone that opens the link and stalls mustn't hold it open
    server.headersTimeout = 10_000;
    server.requestTimeout = 30_000;

    const timer = setTimeout(() => stop('expired'), ttlMs);
    timer.unref?.();

    function stop(reason: 'downloaded' | 'expired' | 'closed') {
        clearTimeout(timer);
        done = true;
        server.close(() => finish(reason));
        server.closeAllConnections?.();
    }

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, host, () => {
            server.off('error', reject);
            resolve();
        });
    });
    const address = server.address() as net.AddressInfo;

    return {
        url: `http://${host}:${address.port}${path}`,
        closed,
        close: () => { if (server.listening) stop('closed'); }
    };
}

// --- From the sidecar's answer to the UI's answer ---

// What the sidecar answers to {"cmd":"add-peer","kind":"ikev2"} (wirepane-tunnel/docs/ikev2.md, section 7)
export interface Ikev2PeerAdded {
    peer: string;
    name: string;
    tunnelIp: string;
    ikev2: { localId: string, remoteId: string, psk: string };
}

export function parseIkev2PeerAdded(event: unknown): Ikev2PeerAdded | undefined {
    if (!event || typeof event !== 'object') return undefined;
    const { peer, name, tunnelIp, ikev2 } = event as Record<string, unknown>;
    if (typeof peer !== 'string' || !PEER_ID_PATTERN.test(peer)) return undefined;
    if (typeof name !== 'string' || typeof tunnelIp !== 'string' || !IPV4_PATTERN.test(tunnelIp)) return undefined;
    if (!ikev2 || typeof ikev2 !== 'object') return undefined;
    const { localId, remoteId, psk } = ikev2 as Record<string, unknown>;
    // The identities are fixed by the peer id, so anything else means the two sides disagree
    if (localId !== phoneIdentity(peer) || remoteId !== IKEV2_SERVER_IDENTITY) return undefined;
    if (typeof psk !== 'string') return undefined;
    return { peer, name, tunnelIp, ikev2: { localId, remoteId, psk } };
}

// What the UI gets for { action: 'ikev2-profile' } (vpn-ikev2-setup.tsx reads it)
export interface Ikev2ProfileAnswer {
    peer: string;
    name: string;
    profile: string;
    link?: string;
}

/**
 * The profile for a peer the sidecar just added, plus a one-time link for Safari when the
 * machine has a LAN address. Open links are tracked in `links`, so stopping the VPN closes them.
 */
export async function createIkev2ProfileAnswer(
    added: Ikev2PeerAdded,
    options: { caCertificatePem: string, serverAddress: string, links?: Set<ProfileLink> }
): Promise<Ikev2ProfileAnswer> {
    const profile = buildIkev2Profile({
        peer: added.peer,
        deviceName: added.name,
        serverAddress: options.serverAddress,
        sharedSecret: added.ikev2.psk,
        caCertificatePem: options.caCertificatePem
    });

    let link: ProfileLink | undefined;
    try {
        link = await serveProfileOnce(profile, options.serverAddress);
    } catch (e: any) {
        // AirDrop still works without the link
        console.warn(`wireguard-vpn: couldn't serve the IKEv2 profile link (${e?.message})`);
    }
    if (link && options.links) {
        const links = options.links;
        links.add(link);
        link.closed.then(() => links.delete(link!));
    }

    return { peer: added.peer, name: added.name, profile, ...(link ? { link: link.url } : {}) };
}
