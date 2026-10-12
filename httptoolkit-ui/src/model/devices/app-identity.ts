import type { HtkRequest } from '../../types';
import { getHeaderValue, getHeaderValues } from '../http/headers';
import { MANUALLY_SENT_SOURCE } from '../http/sources';

import type { DeviceType } from './device-model';

/**
 * Which app sent a request. The user agent often names an SDK inside the app instead
 * ("FBiOSSDK.18.1.0", "io.appmetrica.analytics/5.8") or one of the OS's own services, so
 * the app's own headers count too: Google's SDKs send the app's bundle ID, and apps using
 * Sentry tag every request with their release, like "uz.multibroker.jett.mobile@1.2.24+175".
 */

export type AppKind =
    | 'app' // An app, browser or tool, by its name or its bundle ID
    | 'library' // An SDK, a web view or a media player inside some app that the request doesn't name
    | 'system' // The OS's own services, named after the device: "iOS system"
    | 'unknown' // No user agent
    | 'send'; // Wirepane's own Send page

export interface AppIdentity {
    // The app's own name: "Jett Invest App" (from CFNetwork), "Safari", "curl"
    name?: string;
    // Its bundle ID or package name: "uz.multibroker.jett.mobile"
    bundleId?: string;
    // What sent it, when that isn't the app itself
    client?: { kind: Exclude<AppKind, 'app'>, label: string };
}

type AppRequest = Pick<HtkRequest, 'source'> & Partial<Pick<HtkRequest, 'headers'>>;

// "uz.kashapp.road24": three or more parts, so version numbers & hostnames don't count
const BUNDLE_ID = /^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+){2,}$/i;
export const isBundleId = (value: string) => BUNDLE_ID.test(value);

// Clients that send their own user agent from inside an app (or from the OS), checked
// before anything else, as some of them look like bundle IDs too
const KNOWN_CLIENTS: Array<{ pattern: RegExp, kind: 'library' | 'system', label: string }> = [
    { pattern: /^FB(iOS|Android)SDK\b/i, kind: 'library', label: 'Facebook SDK' },
    { pattern: /^(io\.appmetrica\.|com\.yandex\.mobile\.metrica|YandexMetrica|AppMetrica)/i, kind: 'library', label: 'AppMetrica SDK' },
    { pattern: /^sentry[./-]/i, kind: 'library', label: 'Sentry SDK' },
    { pattern: /^(datatransport|fllsupport)\/|^com\.google\.firebase\.|^Firebase/i, kind: 'library', label: 'Firebase SDK' },
    // Apple's player (AVPlayer) streams audio & video for whichever app is playing it
    { pattern: /^AppleCoreMedia\//, kind: 'library', label: 'Video player (AppleCoreMedia)' },
    // Apple's background services, e.g. "server-bag [iPhone OS,26.6.1,23G83,iPhone14,3]"
    {
        pattern: /^(server-bag\b|com\.apple\.|(trustd|nsurlsessiond|apsd|akd|geod|locationd|mobileassetd|cloudd|itunesstored|appstored|softwareupdateservicesd)\b)/,
        kind: 'system',
        label: ''
    },
    // An Apple OS build number on its own, like "23G83" (Apple's location service sends that)
    { pattern: /^\d{2}[A-Z]\d{1,5}[a-z]?$/, kind: 'system', label: '' }
];

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

// Built-in browsers of apps that the user agent doesn't name
const WEB_VIEWS = new Set(['Web view', 'Android WebView']);

function decodeAppName(name: string): string {
    try {
        return decodeURIComponent(name); // CFNetwork sends "My%20App"
    } catch (e) {
        return name;
    }
}

// Sentry's baggage header: "sentry-release=uz.multibroker.jett.mobile%401.2.24%2B175,…"
function getSentryReleaseApp(baggage: string): string | undefined {
    for (const entry of baggage.split(',')) {
        const [key, ...valueParts] = entry.split('=');
        if (key.trim() !== 'sentry-release') continue;

        const value = valueParts.join('=').split(';')[0].trim();
        return decodeAppName(value).split('@')[0];
    }
    return undefined;
}

// The bundle ID the request's headers name, if any
function getHeaderBundleId(headers: HtkRequest['headers']): string | undefined {
    const candidates = [
        getHeaderValue(headers, 'x-ios-bundle-identifier'),
        getHeaderValue(headers, 'x-android-package'),
        getHeaderValue(headers, 'x-requested-with'), // Android web views send their app's package
        getSentryReleaseApp(getHeaderValues(headers, 'baggage').join(','))
    ];
    return candidates
        .map((candidate) => candidate?.trim())
        .find((candidate): candidate is string => !!candidate && isBundleId(candidate));
}

// The client as the Source column describes it: a browser ("Safari"), an app or a tool ("curl")
function getSourceName(source: HtkRequest['source']): string {
    // Without a recognised browser, the summary is the user agent's first part (see
    // sources.ts), e.g. "curl/8.7.1". With one, it's like "Mobile Safari 18 (iOS 18)".
    const firstPart = source.ua.split(' ')[0];
    const name = source.summary.startsWith(firstPart)
        ? firstPart.split('/')[0]
        : source.summary
            .replace(/\s*\(.*\)$/, '') // The OS
            .replace(/\s+[\d.]+$/, ''); // The version

    const appName = decodeAppName(name) || source.summary;
    return APP_NAME_ALIASES[appName] ?? appName;
}

const isSendPageSource = (source: HtkRequest['source']) =>
    source.summary === MANUALLY_SENT_SOURCE.summary &&
    source.description === MANUALLY_SENT_SOURCE.description;

export function identifyApp(request: AppRequest): AppIdentity {
    const { source } = request;
    if (isSendPageSource(source)) return { client: { kind: 'send', label: source.summary } };

    const bundleId = request.headers ? getHeaderBundleId(request.headers) : undefined;
    const userAgent = source.ua;
    if (!userAgent) return { bundleId, client: { kind: 'unknown', label: source.summary } };

    const knownClient = KNOWN_CLIENTS.find((client) => client.pattern.test(userAgent));
    if (knownClient) return { bundleId, client: { kind: knownClient.kind, label: knownClient.label } };

    const cfnetworkApp = CFNETWORK_APP.exec(userAgent);
    if (cfnetworkApp) {
        const name = decodeAppName(cfnetworkApp[1]);
        return isBundleId(name) ? { bundleId: bundleId ?? name } : { name, bundleId };
    }

    // Google's SDKs start with the app's bundle ID: "uz.kashapp.road24/3.6.0 GMS-SDK/9.4.0.0 …"
    const product = userAgent.split(/[\s/]/)[0];
    if (isBundleId(product)) return { bundleId: bundleId ?? product };

    const name = getSourceName(source);
    return WEB_VIEWS.has(name)
        ? { bundleId, client: { kind: 'library', label: name } }
        : { name, bundleId };
}

// The OS services are one entry per device, named after its platform
export function getSystemLabel(type: DeviceType | undefined): string {
    switch (type) {
        case 'iphone':
        case 'ipad':
        case 'ios':
            return 'iOS system';
        case 'mac': return 'macOS system';
        case 'android': return 'Android system';
        case 'windows': return 'Windows system';
        case 'linux': return 'Linux system';
        default: return 'System services';
    }
}

// What a request says about its own platform, for naming the OS services of a single request
function guessPlatform(userAgent: string): DeviceType | undefined {
    if (/\b(iPhone|iPad|iPod|iOS)/.test(userAgent)) return 'ios';
    if (/\b(Macintosh|Mac OS X|macOS)\b/.test(userAgent)) return 'mac';
    if (/\bAndroid\b/.test(userAgent)) return 'android';
    return undefined;
}

// What the Devices panel calls the app (an SDK's own name, until it's known which app it's in)
export function getAppLabel(identity: AppIdentity, systemLabel: string): string {
    if (identity.name) return identity.name;
    if (identity.bundleId) return identity.bundleId;
    if (identity.client?.kind === 'system') return systemLabel;
    return identity.client?.label ?? 'Unknown client';
}

/**
 * The app that sent a request, from that request alone. The devices store goes further: it
 * groups what each device sent, so an SDK's requests appear under the app they came from.
 */
export function getRequestAppName(request: AppRequest): string {
    return getAppLabel(identifyApp(request), getSystemLabel(guessPlatform(request.source.ua)));
}

// The keys a request is counted under: its app's name and bundle ID, or what sent it
export function getAppKeys(identity: AppIdentity): string[] {
    const keys: string[] = [];
    if (identity.name) keys.push(`name:${identity.name.toLowerCase()}`);
    if (identity.bundleId) keys.push(`bundle:${identity.bundleId.toLowerCase()}`);
    if (keys.length === 0) {
        const kind = identity.client?.kind ?? 'unknown';
        // A device's OS services are one entry, whatever each request says
        const label = kind === 'system' ? '' : (identity.client?.label ?? '').toLowerCase();
        keys.push(`${kind}:${label}`);
    }
    return keys;
}
