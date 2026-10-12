import * as _ from 'lodash';
import * as ipaddr from 'ipaddr.js';
import { action, observable, reaction, IReactionDisposer } from 'mobx';

import type { NetworkInterfaces } from '../../services/server-api-types';
import type { HttpExchange, HtkRequest } from '../../types';
import { getHeaderValue } from '../http/headers';
import { AppTallies } from '../devices/app-groups';
import { getSystemLabel, identifyApp } from '../devices/app-identity';
import { getVpnAttribution } from '../devices/vpn-tags';

// Served by Wirepane itself (see the default rules), so they only open through the proxy:
// wirepane.cert isn't a real domain: the proxy answers it, so it only works through Wirepane
export const CERTIFICATE_PAGE_URL = 'http://wirepane.cert/certificate';
export const CHECK_PAGE_URL = 'https://wirepane.cert';

// Traffic from before the UI started (e.g. imported HAR files) doesn't mean a phone is connected now
export const UI_STARTED_AT = Date.now();

// --- This machine's addresses on the local network ---

export interface LanAddress {
    address: string;
    interfaceName: string;
}

// Docker's bridges & per-container interfaces only face this machine's containers
const CONTAINER_INTERFACE = /^(docker\d|br-|veth)/;
// Wired & Wi-Fi interfaces: en0/en1 (macOS), eth0/enp3s0/wlan0/wlp2s0 (Linux), Wi-Fi/Ethernet (Windows)
const PHYSICAL_INTERFACE = /^(en|eth|wl|wi-?fi|ethernet)/i;

// Higher is a better guess for "the address a phone on the same Wi-Fi can reach"
function rankAddress(address: string, interfaceName: string): number | undefined {
    let range: string;
    try {
        range = ipaddr.parse(address).range();
    } catch (e) {
        return undefined;
    }

    // Not reachable from other devices (link-local means there's no working network):
    if (['loopback', 'linkLocal', 'unspecified', 'broadcast', 'multicast'].includes(range)) {
        return undefined;
    }

    return (range === 'private' ? 2 : 0) + (PHYSICAL_INTERFACE.test(interfaceName) ? 1 : 0);
}

const isIPv4 = (family: string | number) =>
    family === 'IPv4' || family === 4; // Node 18.0 - 18.3 used numbers

/**
 * The IPv4 addresses that phones on the same network could use to reach this machine,
 * best guess first: private (LAN) addresses on Wi-Fi & Ethernet, then anything else.
 */
export function getLanAddresses(interfaces: NetworkInterfaces): LanAddress[] {
    const candidates = _.flatMap(interfaces, (addresses, interfaceName) => {
        if (!addresses || CONTAINER_INTERFACE.test(interfaceName)) return [];

        return addresses
            .filter((info) => !info.internal && isIPv4(info.family))
            .map((info) => ({
                address: info.address,
                interfaceName,
                rank: rankAddress(info.address, interfaceName)
            }))
            .filter((candidate) => candidate.rank !== undefined);
    });

    // A stable sort, so equally good addresses keep the system's order (en0 before en1)
    return _.uniqBy(_.sortBy(candidates, (candidate) => -candidate.rank!), 'address')
        .map(({ address, interfaceName }) => ({ address, interfaceName }));
}

// --- Recognising phones in captured traffic ---

export type PhonePlatform = 'ios' | 'android';

// Safari & apps on iOS say iPhone/iPad. Apps using Apple's networking (CFNetwork) send
// "AppName/1.0 CFNetwork/1498 Darwin/24.0", like macOS apps do, so those only count when
// they come from another device.
const IOS_USER_AGENT = /\b(iPhone|iPad|iPod|iOS)\b|\bCFNetwork\/|\bDarwin\//;
const ANDROID_USER_AGENT = /\bAndroid\b|\bDalvik\//;
// OkHttp is Android's most common HTTP client, but desktop JVM apps use it too:
const OKHTTP_USER_AGENT = /\bokhttp\//i;

export const isIOSUserAgent = (userAgent: string | undefined) =>
    !!userAgent && IOS_USER_AGENT.test(userAgent);

export const isAndroidUserAgent = (userAgent: string | undefined) =>
    !!userAgent && ANDROID_USER_AGENT.test(userAgent);

const GENERIC_DEVICE_NAMES = ['iPhone or iPad', 'Android device'];

export function getAppleDeviceName(userAgent: string): string {
    if (/\biPad\b/.test(userAgent)) return 'iPad';
    if (/\b(iPhone|iPod)\b/.test(userAgent)) return 'iPhone';
    return 'iPhone or iPad'; // CFNetwork apps don't say which
}

type ClientRequest = Pick<HtkRequest, 'headers' | 'remoteIpAddress' | 'url'> & Partial<Pick<HtkRequest, 'tags'>>;

function parseAddress(address: string | undefined) {
    if (!address) return undefined;

    try {
        const parsed = ipaddr.parse(address);
        // Mockttp reports IPv4 clients as ::ffff:192.168.0.20 on dual-stack sockets
        return parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()
            ? (parsed as ipaddr.IPv6).toIPv4Address()
            : parsed;
    } catch (e) {
        return undefined;
    }
}

export const isLoopbackAddress = (address: string | undefined) =>
    parseAddress(address)?.range() === 'loopback';

// wirepane: the client's address, or undefined for loopback (this machine, or an ADB tunnel).
// Through the VPN tunnel everything arrives from loopback, so the phone's own address is
// in the request's tags.
function getClientAddress(request: ClientRequest): string | undefined {
    const parsedAddress = parseAddress(getVpnAttribution(request.tags)?.endpoint ?? request.remoteIpAddress);
    return parsedAddress && parsedAddress.range() !== 'loopback'
        ? parsedAddress.toString()
        : undefined;
}

export interface PhoneRequestMatch {
    deviceName: string;
    // The phone's IP, or undefined if its traffic is tunnelled through this machine (ADB)
    address: string | undefined;
    https: boolean;
}

/**
 * Whether a captured request came from a phone of the given platform, and which one.
 */
export function matchPhoneRequest(
    request: ClientRequest,
    platform: PhonePlatform
): PhoneRequestMatch | undefined {
    const userAgent = getHeaderValue(request.headers, 'user-agent');
    if (!userAgent) return undefined;

    const address = getClientAddress(request);
    const https = request.url.toLowerCase().startsWith('https://');

    if (platform === 'ios') {
        // From this Mac itself, CFNetwork & Darwin user agents are just Mac apps
        if (!address || !isIOSUserAgent(userAgent)) return undefined;
        return { deviceName: getAppleDeviceName(userAgent), address, https };
    } else {
        const isAndroid = isAndroidUserAgent(userAgent) ||
            // OkHttp alone could be a JVM app on this machine, so only from other devices
            (!!address && OKHTTP_USER_AGENT.test(userAgent));
        if (!isAndroid) return undefined;

        // Devices connected via ADB send their traffic through this machine's loopback address
        return { deviceName: 'Android device', address, https };
    }
}

export interface ConnectedPhone {
    deviceName: string;
    address: string | undefined;
    // wirepane: the apps seen from this device so far, most requests first: "Safari", "KursMate".
    // Not the latest user agent, which is often an SDK's ("io.appmetrica.analytics/5.8.2.0").
    apps: string[];
    // SDKs & OS services that no request tied to one of the apps: "Facebook SDK", "iOS system"
    otherClients: string[];
    // Whether its traffic comes through the VPN tunnel
    viaVpn: boolean;
    // Whether any HTTPS request came through from this device, i.e. it trusts the CA
    sawHttps: boolean;
}

const MAX_NAMED_APPS = 3;

// "Safari", "KursMate, road24", or "9 apps: Jett Invest App, KursMate, road24 and 6 more"
export function describeConnectedApps(phone: Pick<ConnectedPhone, 'apps' | 'otherClients'>): string {
    const { apps, otherClients } = phone;
    if (apps.length === 0) {
        return otherClients.length > 0
            ? `Only ${otherClients.join(', ')} so far`
            : 'No apps yet';
    }

    const named = apps.slice(0, MAX_NAMED_APPS).join(', ');
    if (apps.length <= MAX_NAMED_APPS) return named;
    return `${apps.length} apps: ${named} and ${apps.length - MAX_NAMED_APPS} more`;
}

/**
 * Watches the captured traffic for requests from a phone, and keeps the latest one. After
 * the first pass it only looks at new exchanges, so it stays cheap with lots of traffic.
 */
export class ConnectedPhoneTracker {

    @observable.ref
    phone: ConnectedPhone | undefined = undefined;

    private scannedCount = 0;
    private httpsDevices = new Set<string>();
    // Every request from an address counts towards its apps, not only the ones that look like a phone's
    private appsByDevice = new Map<string, AppTallies>();
    private vpnDevices = new Set<string>();
    // What each device was called when a request said which kind it is: a later app request that only
    // says "iPhone or iPad" doesn't make it forget
    private deviceNames = new Map<string, string>();
    private lastMatch: PhoneRequestMatch | undefined;
    private stopWatching: IReactionDisposer | undefined;

    constructor(
        private readonly getExchanges: () => ReadonlyArray<HttpExchange>,
        private readonly platform: PhonePlatform,
        private readonly since: number = UI_STARTED_AT
    ) {}

    start() {
        if (this.stopWatching) return;
        this.stopWatching = reaction(
            () => this.getExchanges().length,
            () => this.scan(),
            { fireImmediately: true }
        );
    }

    stop() {
        this.stopWatching?.();
        this.stopWatching = undefined;
    }

    @action.bound
    private scan() {
        const exchanges = this.getExchanges();

        if (exchanges.length < this.scannedCount) {
            // Traffic was cleared or deleted, so start again
            this.scannedCount = 0;
            this.httpsDevices.clear();
            this.appsByDevice.clear();
            this.vpnDevices.clear();
            this.deviceNames.clear();
            this.lastMatch = undefined;
            this.phone = undefined;
        }

        for (let i = this.scannedCount; i < exchanges.length; i++) {
            const { request } = exchanges[i];
            if (request.timingEvents.startTime < this.since) continue;

            const match = matchPhoneRequest(request, this.platform);
            const address = getClientAddress(request);
            // Loopback is this machine, or a device tunnelled through ADB: only a phone's own requests count there
            if (!match && !address) continue;

            const deviceKey = address ?? 'tunnelled';
            this.countApp(deviceKey, request);
            if (getVpnAttribution(request.tags)) this.vpnDevices.add(deviceKey);

            if (!match) continue;
            if (match.https) this.httpsDevices.add(deviceKey);
            this.rememberDeviceName(deviceKey, match.deviceName);
            this.lastMatch = match;
        }
        this.scannedCount = exchanges.length;

        const phone = this.lastMatch && this.describe(this.lastMatch);
        if (!_.isEqual(phone, this.phone)) this.phone = phone;
    }

    private countApp(deviceKey: string, request: HtkRequest) {
        let tallies = this.appsByDevice.get(deviceKey);
        if (!tallies) {
            tallies = new AppTallies();
            this.appsByDevice.set(deviceKey, tallies);
        }
        tallies.add(identifyApp(request), request.source.icon);
    }

    private rememberDeviceName(deviceKey: string, name: string) {
        const known = this.deviceNames.get(deviceKey);
        const isGeneric = GENERIC_DEVICE_NAMES.includes(name);
        if (!known || !isGeneric || GENERIC_DEVICE_NAMES.includes(known)) this.deviceNames.set(deviceKey, name);
    }

    private describe(match: PhoneRequestMatch): ConnectedPhone {
        const deviceKey = match.address ?? 'tunnelled';
        const grouped = this.appsByDevice.get(deviceKey)?.grouped(getSystemLabel(this.platform)) ?? [];

        return {
            deviceName: this.deviceNames.get(deviceKey) ?? match.deviceName,
            address: match.address,
            apps: grouped.filter((app) => app.kind === 'app').map((app) => app.name),
            otherClients: grouped.filter((app) => app.kind !== 'app').map((app) => app.name),
            viaVpn: this.vpnDevices.has(deviceKey),
            sawHttps: this.httpsDevices.has(deviceKey)
        };
    }
}
