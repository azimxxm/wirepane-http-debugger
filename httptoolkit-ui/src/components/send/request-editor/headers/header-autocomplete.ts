export const COMMON_HTTP_HEADERS: readonly string[] = [
    'Accept',
    'Accept-CH',
    'Accept-Charset',
    'Accept-Encoding',
    'Accept-Language',
    'Access-Control-Allow-Credentials',
    'Access-Control-Allow-Headers',
    'Access-Control-Allow-Methods',
    'Access-Control-Allow-Origin',
    'Access-Control-Expose-Headers',
    'Access-Control-Max-Age',
    'Access-Control-Request-Headers',
    'Access-Control-Request-Method',
    'Age',
    'Allow',
    'Authorization',
    'Baggage',
    'Cache-Control',
    'Clear-Site-Data',
    'Connection',
    'Content-Disposition',
    'Content-Encoding',
    'Content-Language',
    'Content-Length',
    'Content-Location',
    'Content-Range',
    'Content-Security-Policy',
    'Content-Type',
    'Cookie',
    'Cross-Origin-Embedder-Policy',
    'Cross-Origin-Opener-Policy',
    'Cross-Origin-Resource-Policy',
    'Date',
    'Device-Memory',
    'DNT',
    'Downlink',
    'Early-Data',
    'ECT',
    'ETag',
    'Expect',
    'Expires',
    'Forwarded',
    'From',
    'Host',
    'Idempotency-Key',
    'If-Match',
    'If-Modified-Since',
    'If-None-Match',
    'If-Range',
    'If-Unmodified-Since',
    'Keep-Alive',
    'Last-Modified',
    'Link',
    'Location',
    'Max-Forwards',
    'Origin',
    'Permissions-Policy',
    'Pragma',
    'Proxy-Authenticate',
    'Proxy-Authorization',
    'Range',
    'Referer',
    'Referrer-Policy',
    'Retry-After',
    'RTT',
    'Save-Data',
    'Sec-CH-Prefers-Color-Scheme',
    'Sec-CH-UA',
    'Sec-CH-UA-Arch',
    'Sec-CH-UA-Bitness',
    'Sec-CH-UA-Mobile',
    'Sec-CH-UA-Model',
    'Sec-CH-UA-Platform',
    'Sec-CH-UA-Platform-Version',
    'Sec-Fetch-Dest',
    'Sec-Fetch-Mode',
    'Sec-Fetch-Site',
    'Sec-Fetch-User',
    'Sec-GPC',
    'Sec-WebSocket-Accept',
    'Sec-WebSocket-Extensions',
    'Sec-WebSocket-Key',
    'Sec-WebSocket-Protocol',
    'Sec-WebSocket-Version',
    'Server',
    'Server-Timing',
    'Service-Worker-Navigation-Preload',
    'Set-Cookie',
    'SourceMap',
    'Strict-Transport-Security',
    'TE',
    'Timing-Allow-Origin',
    'Traceparent',
    'Tracestate',
    'Trailer',
    'Transfer-Encoding',
    'Upgrade',
    'Upgrade-Insecure-Requests',
    'User-Agent',
    'Vary',
    'Via',
    'Viewport-Width',
    'Warning',
    'Width',
    'WWW-Authenticate',
    'X-Api-Key',
    'X-Auth-Token',
    'X-Content-Type-Options',
    'X-Correlation-Id',
    'X-DNS-Prefetch-Control',
    'X-Forwarded-For',
    'X-Forwarded-Host',
    'X-Forwarded-Proto',
    'X-Frame-Options',
    'X-Mock-Match-Request-Body',
    'X-Mock-Match-Request-Headers',
    'X-Mock-Response-Code',
    'X-Mock-Response-Delay',
    'X-Mock-Response-Id',
    'X-Mock-Response-Name',
    'X-Request-Id',
    'X-Requested-With',
    'X-XSS-Protection'
];

export const COMMON_HEADER_VALUES: { [header: string]: readonly string[] } = {
    'content-type': [
        'application/json',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
        'text/plain',
        'text/html',
        'application/xml',
        'text/xml',
        'application/octet-stream',
        'application/graphql+json',
        'application/javascript',
        'text/css'
    ],
    'accept': [
        'application/json',
        '*/*',
        'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'application/xml',
        'text/plain'
    ],
    'accept-encoding': [
        'gzip, deflate, br',
        'gzip, deflate',
        'identity'
    ],
    'accept-language': [
        'en-US,en;q=0.9',
        '*'
    ],
    'cache-control': [
        'no-cache',
        'no-store',
        'max-age=0',
        'must-revalidate',
        'public, max-age=31536000',
        'no-transform'
    ],
    'connection': [
        'keep-alive',
        'close'
    ],
    'sec-fetch-mode': [
        'cors',
        'no-cors',
        'navigate',
        'same-origin',
        'websocket'
    ],
    'sec-fetch-dest': [
        'empty',
        'document',
        'image',
        'script',
        'style',
        'font'
    ],
    'sec-fetch-site': [
        'same-origin',
        'same-site',
        'cross-site',
        'none'
    ]
};

export const DEFAULT_POPULAR_HEADERS: readonly string[] = [
    'Content-Type',
    'Accept',
    'Authorization',
    'User-Agent',
    'Cache-Control',
    'Cookie',
    'Host',
    'Origin',
    'Referer',
    'Connection',
    'X-Api-Key',
    'Accept-Encoding',
    'Accept-Language',
    'Content-Length',
    'If-None-Match',
    'If-Modified-Since',
    'X-Requested-With',
    'X-Request-Id',
    'Idempotency-Key',
    'Access-Control-Allow-Origin'
];

export function getHeaderSuggestions(input: string): string[] {
    const query = input.trim().toLowerCase();
    if (!query) return [...DEFAULT_POPULAR_HEADERS];

    const exact: string[] = [];
    const prefix: string[] = [];
    const substring: string[] = [];

    for (const h of COMMON_HTTP_HEADERS) {
        const lower = h.toLowerCase();
        if (lower === query) {
            exact.push(h);
        } else if (lower.startsWith(query)) {
            prefix.push(h);
        } else if (lower.includes(query)) {
            substring.push(h);
        }
    }

    return [...exact, ...prefix, ...substring].slice(0, 25);
}

export function getValueSuggestions(headerKey: string, input: string): string[] {
    const key = headerKey.trim().toLowerCase();
    const common = COMMON_HEADER_VALUES[key] || [];
    const query = input.trim().toLowerCase();
    if (!query) return [...common];

    const exact: string[] = [];
    const prefix: string[] = [];
    const substring: string[] = [];

    for (const val of common) {
        const lower = val.toLowerCase();
        if (lower === query) {
            exact.push(val);
        } else if (lower.startsWith(query)) {
            prefix.push(val);
        } else if (lower.includes(query)) {
            substring.push(val);
        }
    }

    return [...exact, ...prefix, ...substring];
}
