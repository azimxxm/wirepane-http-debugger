import { HttpExchange } from '../../../../src/types';
import { MANUALLY_SENT_SOURCE, parseSource } from '../../../../src/model/http/sources';

import { getExchangeData, getFailedTls } from '../../unit-test-helpers';

export const UA = {
    iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
    ipadApp: 'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
    iosApp: 'Bookshelf/2.4 CFNetwork/1498.700.2 Darwin/24.0.0',
    iosAppWithModel: 'Bookshelf/2.4 (iPhone15,2; iOS 17.5)',
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
    startTime?: number
} = {}): HttpExchange {
    const exchange = getExchangeData({
        hostname: options.host ?? 'example.com',
        path: options.path ?? '/',
        requestHeaders: options.ua ? { 'user-agent': options.ua } : {},
        requestTags: options.sentFromSendPage ? [SEND_PAGE_TAG] : []
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

export const failedTls = (ip: string, host = 'example.com') =>
    getFailedTls({ remoteIpAddress: ip, upstreamHostname: host });

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
