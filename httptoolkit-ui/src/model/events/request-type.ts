/*
 * Wirepane: what kind of resource each request in View's list is, for its Type column.
 * The same groups as a browser's network panel: document, fetch/XHR, script, CSS, image,
 * font, media, WebSocket and other.
 *
 * Browsers say how they'll use a response (the sec-fetch-dest header), so that wins. Other
 * clients don't, so the response's content type decides, then the request's own hints.
 */
import { ExchangeMessage, HtkRequest, ViewableEvent } from '../../types';
import { getHeaderValue } from '../http/headers';

import { getBaseContentType, getContentType } from './content-types';
import { getMessageBaseAcceptTypes } from './categorization';

export const RequestTypes = [
    'document',
    'fetch',
    'script',
    'stylesheet',
    'image',
    'font',
    'media',
    'websocket',
    'webrtc',
    'other'
] as const;

export type RequestType = typeof RequestTypes[number];

export const REQUEST_TYPE_LABELS: { readonly [type in RequestType]: string } = {
    document: 'Document',
    fetch: 'Fetch/XHR',
    script: 'Script',
    stylesheet: 'CSS',
    image: 'Image',
    font: 'Font',
    media: 'Media',
    websocket: 'WebSocket',
    webrtc: 'WebRTC',
    other: 'Other'
};

export const REQUEST_TYPE_DESCRIPTIONS: { readonly [type in RequestType]: string } = {
    document: 'a web page',
    fetch: 'an API or data request, like JSON, XML, form data or text',
    script: 'JavaScript',
    stylesheet: 'a stylesheet',
    image: 'an image',
    font: 'a font file',
    media: 'audio or video',
    websocket: 'a two-way WebSocket connection',
    webrtc: 'a peer-to-peer WebRTC connection or stream',
    other: 'anything else, like a download or binary data'
};

// https://fetch.spec.whatwg.org/#concept-request-destination
const DESTINATION_TYPES: { readonly [destination: string]: RequestType | undefined } = {
    document: 'document',
    iframe: 'document',
    frame: 'document',
    fencedframe: 'document',

    empty: 'fetch', // fetch() & XMLHttpRequest
    json: 'fetch',
    report: 'fetch',
    webidentity: 'fetch',

    script: 'script',
    worker: 'script',
    sharedworker: 'script',
    serviceworker: 'script',
    audioworklet: 'script',
    paintworklet: 'script',
    sharedstorageworklet: 'script',

    style: 'stylesheet',
    image: 'image',
    font: 'font',

    audio: 'media',
    video: 'media',
    track: 'media'
};

// Streaming playlists are media, even though some are XML
const MEDIA_MANIFEST_TYPES = [
    'application/vnd.apple.mpegurl',
    'application/x-mpegurl',
    'application/dash+xml'
];

const FONT_TYPES = [
    'application/font-woff',
    'application/x-font-woff',
    'application/font-woff2',
    'application/font-otf',
    'application/font-sfnt',
    'application/font',
    'application/vnd.ms-fontobject',
    'application/x-font-ttf',
    'application/x-font-truetype',
    'application/x-font-opentype'
];

// Data formats that aren't in the content types the body viewer knows
const OTHER_DATA_TYPES = [
    'multipart/form-data',
    'text/event-stream',
    'application/graphql',
    'application/graphql-response',
    'application/x-ndjson'
];

const DATA_VIEWER_TYPES = [
    'json',
    'json-records',
    'xml',
    'text',
    'url-encoded',
    'yaml',
    'markdown',
    'protobuf',
    'grpc-proto'
];

/**
 * The type a content-type header points to. Undefined when it doesn't say, e.g. for
 * application/octet-stream or a missing header.
 */
export function getRequestTypeForContentType(mimeType: string | undefined): RequestType | undefined {
    if (!mimeType) return undefined;

    const exactType = mimeType.split(';')[0].trim().toLowerCase();
    if (!exactType) return undefined;
    if (MEDIA_MANIFEST_TYPES.includes(exactType)) return 'media';

    const baseType = getBaseContentType(exactType);
    const viewerType = getContentType(exactType);

    if (viewerType === 'html') return 'document';
    if (viewerType === 'javascript' || baseType === 'text/ecmascript') return 'script';
    if (viewerType === 'css') return 'stylesheet';
    if (baseType.startsWith('image/')) return 'image';
    if (baseType.startsWith('font/') || FONT_TYPES.includes(baseType)) return 'font';
    if (baseType.startsWith('audio/') || baseType.startsWith('video/')) return 'media';
    if (
        (viewerType && DATA_VIEWER_TYPES.includes(viewerType)) ||
        OTHER_DATA_TYPES.includes(baseType)
    ) return 'fetch';

    return undefined;
}

const getMessageContentType = (message: ExchangeMessage) =>
    getHeaderValue(message.headers, 'content-type');

// For requests that have no (useful) response yet: what they asked for, and what they sent
function getRequestTypeFromRequest(request: HtkRequest): RequestType {
    const acceptTypes = getMessageBaseAcceptTypes(request)
        .map((type) => type.trim())
        .filter((type) => type && type !== '*/*');

    if (acceptTypes.length > 0) {
        if (acceptTypes.every((type) => type.startsWith('image/'))) return 'image';

        const preferredType = getRequestTypeForContentType(acceptTypes[0]);
        if (preferredType) return preferredType;
    }

    if (getHeaderValue(request.headers, 'x-requested-with')?.toLowerCase() === 'xmlhttprequest') {
        return 'fetch';
    }

    // A request sending JSON, a form or similar is almost always an API call
    return getRequestTypeForContentType(getMessageContentType(request)) === 'fetch'
        ? 'fetch'
        : 'other';
}

export function getRequestType(event: ViewableEvent): RequestType {
    if (event.isRTC()) return 'webrtc';
    if (!event.isHttp()) return 'other'; // TLS & non-HTTP connections
    if (event.isWebSocket()) return 'websocket';

    const destination = getHeaderValue(event.request.headers, 'sec-fetch-dest')?.trim().toLowerCase();
    const destinationType = destination ? DESTINATION_TYPES[destination] : undefined;
    if (destinationType) return destinationType;

    if (event.isSuccessfulExchange()) {
        const responseType = getRequestTypeForContentType(getMessageContentType(event.response));
        if (responseType) return responseType;
    }

    return getRequestTypeFromRequest(event.request);
}

/**
 * The tooltip for a Type cell: the type, what it means, and the content type behind it.
 */
export function describeRequestType(event: ViewableEvent): string {
    const type = getRequestType(event);
    const summary = `${REQUEST_TYPE_LABELS[type]}: ${REQUEST_TYPE_DESCRIPTIONS[type]}`;

    if (!event.isHttp() || event.isWebSocket()) return summary;

    const contentType = event.isSuccessfulExchange()
        ? getMessageContentType(event.response)?.split(';')[0].trim()
        : undefined;
    return contentType ? `${summary} (${contentType})` : summary;
}
