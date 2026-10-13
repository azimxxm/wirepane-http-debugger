import * as _ from 'lodash';

import type { VpnTlsHello } from './vpn-network';

/*
 * JA4 TLS fingerprints (docs/plans/2026-10-13-rust-network-tools.md, tool 5).
 *
 * The VPN sidecar reads the TLS ClientHello that every app sends before any certificate is
 * checked, so it can fingerprint pinned apps too. It reports each one as a `tls-hello` event
 * (the Network page's TLS tab groups those) and tags the connection, so its requests carry
 * it: `wirepane-vpn-ja4:t13d1516h2_8daaf6152771_02713d6af862`. A failed TLS row doesn't get the
 * tag (Mockttp leaves it off those events), so findJa4ForFailure looks the hello up instead.
 */

// Mockttp puts this in front of every tag a SOCKS client sends as metadata when it connects, so
// the tunnel's `wirepane-vpn-ja4:...` reaches the UI as `socket-metadata:wirepane-vpn-ja4:...`
const SOCKET_METADATA_PREFIX = 'socket-metadata:';
const JA4_TAG_PREFIX = 'wirepane-vpn-ja4:';

/*
 * t13d1516h2_8daaf6152771_02713d6af862
 * 1: t (TCP), q (QUIC) or d (DTLS)
 * 2-3: the TLS version, 4: d (a domain in the SNI) or i (no SNI)
 * 5-6: how many cipher suites, 7-8: how many extensions
 * 9-10: the first and last character of the first ALPN value (00 = none)
 * then 12 hex characters hashing the cipher suites, and 12 hashing the extensions.
 */
const JA4_PATTERN = /^([tqd])([a-z0-9]{2})([di])(\d{2})(\d{2})([a-z0-9]{2})_([0-9a-f]{12})_([0-9a-f]{12})$/;

export interface Ja4Parts {
    transport: 'TCP' | 'QUIC' | 'DTLS';
    tlsVersion: string; // "TLS 1.3"
    hasSni: boolean;
    cipherCount: number;
    extensionCount: number;
    alpn: string | undefined; // "HTTP/2"; undefined when the hello offered none
}

const TRANSPORTS = { t: 'TCP', q: 'QUIC', d: 'DTLS' } as const;

const TLS_VERSIONS: { [code: string]: string } = {
    '13': 'TLS 1.3',
    '12': 'TLS 1.2',
    '11': 'TLS 1.1',
    '10': 'TLS 1.0',
    's3': 'SSL 3.0',
    's2': 'SSL 2.0',
    'd1': 'DTLS 1.0',
    'd2': 'DTLS 1.2',
    'd3': 'DTLS 1.3'
};

const ALPN_NAMES: { [code: string]: string } = {
    'h2': 'HTTP/2',
    'h3': 'HTTP/3',
    'h1': 'HTTP/1.1' // http/1.1 and http/1.0 both end up as "h1"
};

/** Reads the readable parts out of a JA4 string. Undefined when it isn't one. */
export function parseJa4(ja4: string): Ja4Parts | undefined {
    const match = JA4_PATTERN.exec(ja4);
    if (!match) return undefined;

    const [, transport, version, sni, ciphers, extensions, alpn] = match;
    return {
        transport: TRANSPORTS[transport as keyof typeof TRANSPORTS],
        tlsVersion: TLS_VERSIONS[version] ?? 'unknown TLS version',
        hasSni: sni === 'd',
        cipherCount: Number(ciphers),
        extensionCount: Number(extensions),
        alpn: alpn === '00' ? undefined : (ALPN_NAMES[alpn] ?? `ALPN ${alpn}`)
    };
}

/** "TLS 1.3 · 15 cipher suites · 16 extensions · HTTP/2", or undefined for a string that isn't a JA4. */
export function describeJa4(ja4: string): string | undefined {
    const parts = parseJa4(ja4);
    if (!parts) return undefined;

    return [
        parts.tlsVersion,
        `${parts.cipherCount} cipher ${parts.cipherCount === 1 ? 'suite' : 'suites'}`,
        `${parts.extensionCount} ${parts.extensionCount === 1 ? 'extension' : 'extensions'}`,
        parts.alpn
    ].filter((part): part is string => !!part).join(' · ');
}

/**
 * The JA4 the tunnel put in a connection's tags, if it did. Anything in the tag that isn't
 * a JA4 string is ignored, so a request never shows a made-up value.
 */
export function getJa4FromTags(tags: readonly string[] | undefined): string | undefined {
    if (!tags) return undefined;

    for (const rawTag of tags) {
        if (typeof rawTag !== 'string') continue;

        const tag = rawTag.startsWith(SOCKET_METADATA_PREFIX)
            ? rawTag.slice(SOCKET_METADATA_PREFIX.length)
            : rawTag;
        if (!tag.startsWith(JA4_TAG_PREFIX)) continue;

        const value = tag.slice(JA4_TAG_PREFIX.length).trim();
        if (JA4_PATTERN.test(value)) return value;
    }
    return undefined;
}

// The tunnel reports a hello just before it connects to Mockttp, so a failed connection and its
// hello are normally well under a second apart
export const HELLO_MATCH_WINDOW_MS = 5_000;

/** The parts of a failed TLS connection (a FailedTlsConnection has them all) that point to its hello. */
export interface Ja4Failure {
    tags?: readonly string[];
    // The name the client asked for (its SNI), or the address it was connecting to
    upstreamHostname?: string;
    timingEvents?: { startTime?: number };
}

const isSameName = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

// "93.184.216.34:443" -> "93.184.216.34"
const hostOfAddress = (address: string) => address.replace(/:\d+$/, '');

// A hello with a name is for the connection that asked for that name. One without a name was sent
// to an address, so it is for a connection that only knows its address, or knows nothing.
function isHelloForName(hello: VpnTlsHello, name: string | undefined): boolean {
    if (hello.sni) return name !== undefined && isSameName(hello.sni, name);
    return name === undefined || isSameName(name, hostOfAddress(hello.dst));
}

/**
 * The JA4 of a failed TLS connection. Mockttp's failure events carry no SOCKS tags (its requests
 * do), so when the connection has none, the hello the tunnel reported for it is found by the name
 * it asked for and by time. A pinned app's connection fails before any request, so this is the
 * only way to see its fingerprint.
 */
export function findJa4ForFailure(failure: Ja4Failure, hellos: readonly VpnTlsHello[]): string | undefined {
    const tagged = getJa4FromTags(failure.tags);
    if (tagged) return tagged;

    const startTime = failure.timingEvents?.startTime;
    if (typeof startTime !== 'number' || !Number.isFinite(startTime)) return undefined;

    const name = failure.upstreamHostname?.trim() || undefined;

    let closest: VpnTlsHello | undefined;
    let closestGap = Infinity;
    for (const hello of hellos) {
        const gap = Math.abs(hello.at - startTime);
        // Written so that a hello with no usable time (NaN) is out too
        if (!(gap <= HELLO_MATCH_WINDOW_MS) || !JA4_PATTERN.test(hello.ja4) || !isHelloForName(hello, name)) continue;

        // The same app can try the same name again and again: take the hello closest in time, and
        // the later one if two are equally close
        if (!closest || gap < closestGap || (gap === closestGap && hello.at > closest.at)) {
            closest = hello;
            closestGap = gap;
        }
    }
    return closest?.ja4;
}

export interface Ja4Count {
    value: string;
    count: number;
}

/** Every TLS hello that had one JA4: the app or library it stands for, seen from these places. */
export interface Ja4Group {
    ja4: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
    // The names the hellos asked for, most often first
    snis: Ja4Count[];
    // How many hellos had no SNI (they were sent to an address)
    withoutSni: number;
    // The tunnel's peer ids, most hellos first
    peers: Ja4Count[];
}

function countValues(values: readonly string[]): Ja4Count[] {
    return _(values)
        .countBy()
        .map((count, value) => ({ value, count }))
        .orderBy(['count', 'value'], ['desc', 'asc'])
        .value();
}

/**
 * Groups TLS hellos by their JA4: biggest group first, then the one seen most recently.
 * Hellos without a JA4 are left out.
 */
export function groupTlsHellosByJa4(hellos: readonly VpnTlsHello[]): Ja4Group[] {
    const byJa4 = _.groupBy(hellos.filter((hello) => !!hello.ja4), (hello) => hello.ja4);

    return _.map(byJa4, (group, ja4): Ja4Group => ({
        ja4,
        count: group.length,
        firstSeen: group.reduce((first, hello) => Math.min(first, hello.at), Infinity),
        lastSeen: group.reduce((last, hello) => Math.max(last, hello.at), -Infinity),
        snis: countValues(group.map((hello) => hello.sni).filter((sni): sni is string => !!sni)),
        withoutSni: group.filter((hello) => !hello.sni).length,
        peers: countValues(group.map((hello) => hello.peer))
    })).sort((a, b) =>
        b.count - a.count ||
        b.lastSeen - a.lastSeen ||
        a.ja4.localeCompare(b.ja4)
    );
}
