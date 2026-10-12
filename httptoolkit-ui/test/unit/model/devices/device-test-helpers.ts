import { HttpExchange } from '../../../../src/types';
import { MANUALLY_SENT_SOURCE, parseSource } from '../../../../src/model/http/sources';
import { RawTunnel } from '../../../../src/model/raw-tunnel';

import { getExchangeData, getFailedTls } from '../../unit-test-helpers';

export const UA = {
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ipadApp: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    iosApp: 'Bookshelf/2.4 CFNetwork/1498.700.2 Darwin/24.0.0',
    iosAppWithModel: 'Bookshelf/2.4 (iPhone15,2; iOS 17.5)',
    // What an iPhone's SDKs and system services send (as seen on a real phone)
    facebookSdk: 'FBiOSSDK.18.1.0',
    appMetrica: 'io.appmetrica.analytics/5.8.2.0 (Apple iPhone14,3; iOS 26.6.1)',
    videoPlayer: 'AppleCoreMedia/1.0.0.23G83 (iPhone; U; CPU OS 26_6_1 like Mac OS X; en_us)',
    serverBag: 'server-bag [iPhone OS,26.6.1,23G83,iPhone14,3]',
    webView: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    road24Sdk: 'uz.kashapp.road24/3.6.0 GMS-SDK/9.4.0.0 iPhone/26.6.1 hw/iPhone14_3 (gzip)',
    road24App: 'road24/3601380 CFNetwork/3860.700.1 Darwin/25.6.0',
    jettApp: 'Jett%20Invest%20App/175 CFNetwork/3860.700.1 Darwin/25.6.0',
    macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
    windowsChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
    linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    androidChrome: 'Mozilla/5.0 (Linux; Android 15; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    androidReducedChrome: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36',
    dalvik: 'Dalvik/2.1.0 (Linux; U; Android 13; en-us; SM-S918B Build/TP1A.220624.014)',
    okhttp: 'okhttp/4.12.0',
    curl: 'curl/8.7.1'
};

const SEND_PAGE_TAG = 'httptoolkit:manually-sent-request';

/**
 * A captured exchange from a client address, with its user agent parsed the same way
 * as for real traffic (the Source column's client detection).
 */
export function deviceExchange(options: {
    ip?: string,
    ua?: string,
    host?: string,
    path?: string,
    sentFromSendPage?: boolean,
    startTime?: number,
    // Other request headers: an app's bundle ID, Sentry's baggage...
    headers?: { [name: string]: string },
    tags?: string[]
} = {}): HttpExchange {
    const exchange = getExchangeData({
        hostname: options.host ?? 'example.com',
        path: options.path ?? '/',
        requestHeaders: {
            ...(options.ua ? { 'user-agent': options.ua } : {}),
            ...options.headers
        },
        requestTags: [...(options.sentFromSendPage ? [SEND_PAGE_TAG] : []), ...(options.tags ?? [])]
    });

    Object.assign(exchange.request, {
        remoteIpAddress: options.ip,
        source: options.sentFromSendPage ? MANUALLY_SENT_SOURCE : parseSource(options.ua)
    });
    if (options.startTime !== undefined) {
        Object.assign(exchange, { timingEvents: { startTime: options.startTime } });
    }

    // Real exchanges are their own downstream (the client's side of the exchange)
    return Object.assign(exchange, { downstream: exchange });
}

export const failedTls = (ip: string, host = 'example.com', tags: string[] = []) =>
    Object.assign(getFailedTls({ remoteIpAddress: ip, upstreamHostname: host }), { tags });

let nextTunnelId = 0;

// A non-HTTP connection the proxy tunnelled through, like an MQTT client's
export const rawTunnel = (ip: string, host = 'mqtt.example.com', port = 1883) => new RawTunnel({
    id: `raw-tunnel-${nextTunnelId++}`,
    remoteIpAddress: ip,
    remotePort: 50000,
    destination: { hostname: host, port },
    tags: [],
    timingEvents: { startTime: Date.now(), connectTimestamp: 0 }
});

// An in-memory stand-in for localStorage
export class MemoryStorage {
    readonly items = new Map<string, string>();

    getItem(key: string) {
        return this.items.get(key) ?? null;
    }

    setItem(key: string, value: string) {
        this.items.set(key, value);
    }
}
