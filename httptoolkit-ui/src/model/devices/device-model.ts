import * as _ from 'lodash';
import * as ipaddr from 'ipaddr.js';

import type { HtkRequest, ViewableEvent } from '../../types';
import { getHeaderValue } from '../http/headers';
import {
    getAppleDeviceName,
    isLoopbackAddress,
    matchPhoneRequest
} from '../interception/phone-setup';

/**
 * Which device sent each request. Devices are told apart by the client's IP address,
 * and named from what their user agents say (iPhone, Android, Mac...).
 */

export type DeviceType =
    | 'iphone'
    | 'ipad'
    | 'ios' // An iPhone or an iPad: apps using Apple's networking don't say which
    | 'android'
    | 'mac'
    | 'windows'
    | 'linux'
    | 'other';

// The key of the device Wirepane runs on: loopback & this machine's own addresses
export const THIS_MACHINE_KEY = 'this-machine';

// Requests made from the Send page
const MANUALLY_SENT_TAG = 'httptoolkit:manually-sent-request';

const TYPE_LABELS: { [type in DeviceType]: string } = {
    iphone: 'iPhone',
    ipad: 'iPad',
    ios: 'iOS device',
    android: 'Android',
    mac: 'Mac',
    windows: 'Windows PC',
    linux: 'Linux',
    other: 'Device'
};

export const getDeviceTypeLabel = (type: DeviceType) => TYPE_LABELS[type];

export function getThisMachineName(platformType: DeviceType) {
    return platformType === 'mac' ? 'This Mac' : 'This computer';
}

// --- Addresses ---

// Normalising is called for every event while filtering, so results are cached
const normalizedAddresses = new Map<string, string>();
const MAX_CACHED_ADDRESSES = 5000;

/**
 * The canonical form of a client address: IPv4 clients on dual-stack sockets show up
 * as ::ffff:192.168.0.20, which is the same device as 192.168.0.20.
 */
export function normalizeAddress(address: string | undefined): string | undefined {
    if (!address) return undefined;

    const cached = normalizedAddresses.get(address);
    if (cached !== undefined) return cached;

    let normalized: string;
    try {
        normalized = ipaddr.process(address).toString();
    } catch (e) {
        normalized = address; // Not an IP we can parse, but still a stable key
    }

    if (normalizedAddresses.size >= MAX_CACHED_ADDRESSES) normalizedAddresses.clear();
    normalizedAddresses.set(address, normalized);
    return normalized;
}

export const isSentFromSendPage = (event: ViewableEvent) =>
    event.isHttp() && event.request.tags.includes(MANUALLY_SENT_TAG);

/**
 * The address a captured event came from. Requests made from the Send page have no
 * client address, but they're sent by this machine, so they get its key.
 */
export function getEventAddress(event: ViewableEvent): string | undefined {
    if (event.isHttp()) {
        if (isSentFromSendPage(event)) return THIS_MACHINE_KEY;
        return normalizeAddress(event.request.remoteIpAddress);
    }
    if (event.isTlsFailure() || event.isTunnel()) {
        return normalizeAddress(event.remoteIpAddress);
    }
    return undefined; // WebRTC: the browser extension doesn't say which device
}

export function isThisMachineAddress(address: string, ownAddresses: ReadonlySet<string>) {
    return address === THIS_MACHINE_KEY ||
        ownAddresses.has(address) ||
        isLoopbackAddress(address);
}

// The device key for an address: this machine's key, or the address itself
export const getDeviceKey = (address: string, ownAddresses: ReadonlySet<string>) =>
    isThisMachineAddress(address, ownAddresses) ? THIS_MACHINE_KEY : address;

// --- Device types ---

// How sure a type is. A device's type only changes for a type that's at least as sure,
// so an iPhone stays an iPhone after an app request that only says "iOS".
const TYPE_RANKS: { [type in DeviceType]: number } = {
    iphone: 3,
    ipad: 3,
    android: 3,
    ios: 2,
    mac: 1,
    windows: 1,
    linux: 1,
    other: 0
};

export const getTypeRank = (type: DeviceType) => TYPE_RANKS[type];

const MAC_USER_AGENT = /\b(Macintosh|Mac OS X|macOS)\b/;
const WINDOWS_USER_AGENT = /\b(Windows|Win64|Win32|WOW64)\b/;
const LINUX_USER_AGENT = /\b(Linux|X11|Ubuntu|Fedora|CrOS)\b/;
// App user agents often name the model instead, like "Spotify/8.9 iOS/17.5 (iPhone15,2)"
const IPHONE_MODEL_ID = /\biPhone\d/;
const IPAD_MODEL_ID = /\biPad\d/;

/**
 * The type of device that sent a request from another machine. Phones are recognised
 * the same way as on the Connect iPhone & Android pages.
 */
export function detectDeviceType(
    request: Pick<HtkRequest, 'headers' | 'remoteIpAddress' | 'url'>
): DeviceType | undefined {
    const userAgent = getHeaderValue(request.headers, 'user-agent');
    if (!userAgent) return undefined;

    const iosMatch = matchPhoneRequest(request, 'ios');
    if (iosMatch) {
        const deviceName = getAppleDeviceName(userAgent);
        if (deviceName === 'iPad' || IPAD_MODEL_ID.test(userAgent)) return 'ipad';
        if (deviceName === 'iPhone' || IPHONE_MODEL_ID.test(userAgent)) return 'iphone';
        return 'ios';
    }

    if (matchPhoneRequest(request, 'android')) return 'android';

    // Phones say "like Mac OS X" & "Linux; Android", so desktops are checked after them
    if (MAC_USER_AGENT.test(userAgent)) return 'mac';
    if (WINDOWS_USER_AGENT.test(userAgent)) return 'windows';
    if (LINUX_USER_AGENT.test(userAgent)) return 'linux';

    return undefined;
}

// "(Linux; Android 15; Pixel 8)" or "(Linux; U; Android 13; en-us; SM-S918B Build/TP1A)"
const ANDROID_MODEL = /\bAndroid [\d.]+;\s*(?:[a-z]{2}[-_][a-zA-Z]{2};\s*)?([^;)]+?)(?:\s+Build\/[^;)]*)?\s*[;)]/;
// Chrome's reduced user agent sends "K" as the model, and WebViews add "wv"
const NOT_A_MODEL = /^(K|wv|Mobile|Tablet)$/i;

// The phone's model, if its user agent says, like "Pixel 8"
export function getAndroidModel(userAgent: string | undefined): string | undefined {
    if (!userAgent) return undefined;
    const model = ANDROID_MODEL.exec(userAgent)?.[1]?.trim();
    if (!model || model.length < 2 || NOT_A_MODEL.test(model)) return undefined;
    return model;
}

// --- Apps ---

// "Instagram/1.0 CFNetwork/1498.700.2 Darwin/23.6.0": iOS & macOS apps using Apple's networking
const CFNETWORK_APP = /^([^\s/]+)\/\S*\s+CFNetwork\//;

// Friendlier names for some of the clients ua-parser-js recognises
const APP_NAME_ALIASES: { [name: string]: string } = {
    'Mobile Safari': 'Safari',
    'Mobile Firefox': 'Firefox',
    'Mobile Chrome': 'Chrome',
    'Chrome WebView': 'Android WebView',
    'WebKit': 'Web view', // An app's built-in browser, on iOS
    'okhttp': 'OkHttp'
};

function decodeAppName(name: string): string {
    try {
        return decodeURIComponent(name); // CFNetwork sends "My%20App"
    } catch (e) {
        return name;
    }
}

/**
 * The app that sent a request, from the same client detection as the Source column:
 * a browser ("Safari"), an app ("Instagram") or a tool ("curl").
 */
export function getAppName(request: Pick<HtkRequest, 'source'>): string {
    const { source } = request;
    // No user agent: 'Unknown client', or 'Wirepane (Send)' for the Send page
    if (!source.ua) return source.summary;

    const cfnetworkApp = CFNETWORK_APP.exec(source.ua);
    if (cfnetworkApp) return decodeAppName(cfnetworkApp[1]);

    // Without a recognised browser, the summary is the user agent's first part (see
    // sources.ts), e.g. "Curl/8.7.1". With one, it's like "Mobile Safari 18 (iOS 18)".
    const firstPart = source.ua.split(' ')[0];
    const name = source.summary.startsWith(_.upperFirst(firstPart))
        ? firstPart.split('/')[0]
        : source.summary
            .replace(/\s*\(.*\)$/, '') // The OS
            .replace(/\s+[\d.]+$/, ''); // The version

    const appName = decodeAppName(name) || source.summary;
    return APP_NAME_ALIASES[appName] ?? appName;
}

export function getEventAppName(event: ViewableEvent): string | undefined {
    return event.isHttp() ? getAppName(event.request) : undefined;
}

// The hostname a request or connection went to
export function getEventHost(event: ViewableEvent): string | undefined {
    if (event.isHttp()) {
        const { parsedUrl } = event.request;
        return parsedUrl.parseable ? parsedUrl.hostname.toLowerCase() : undefined;
    }
    if (event.isTlsFailure() || event.isTunnel()) {
        return event.upstreamHostname?.toLowerCase();
    }
    return undefined;
}

export function getEventTime(event: ViewableEvent): number {
    const timingEvents = (event as { timingEvents?: { startTime?: number } }).timingEvents;
    return timingEvents?.startTime ?? Date.now();
}
