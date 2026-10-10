import * as _ from 'lodash';
import { reaction, runInAction } from 'mobx';

import { RawHeaders } from '../../../types';
import { getHeaderValues } from '../../http/headers';
import type { SendExtras, SendRequestType } from '../send-extras';

/**
 * Wirepane: how a Send tab becomes a WebSocket request and back. A ws:// or wss:// URL makes
 * it a WebSocket, an http(s):// URL makes it HTTP, and the method picker can switch it too.
 */

// The value of the "WebSocket" entry in the method picker
export const WEBSOCKET_OPTION = 'websocket';

const URL_SCHEME = /^\s*([a-z][a-z0-9+.-]*):\/\//i;

// The request type a URL asks for. Undefined when it doesn't say: an unfinished URL, or one
// that starts with a {{variable}}.
export function requestTypeForUrl(url: string): SendRequestType | undefined {
    const scheme = URL_SCHEME.exec(url)?.[1].toLowerCase();

    if (scheme === 'ws' || scheme === 'wss') return 'websocket';
    if (scheme === 'http' || scheme === 'https') return 'http';
    return undefined;
}

// https:// <-> wss:// and http:// <-> ws://. Other URLs are returned as they are.
export function withRequestTypeScheme(url: string, type: SendRequestType): string {
    if (type === 'websocket') return url.replace(/^(\s*)http(s?):\/\//i, '$1ws$2://');
    else return url.replace(/^(\s*)ws(s?):\/\//i, '$1http$2://');
}

// When the URL switches the type of a request, the request line is replaced by the other
// type's one, which takes over the focus (so typing a URL isn't interrupted).
let lastSwitch: { at: number, focus: 'url' | 'type' } | undefined;
const SWITCH_FOCUS_WINDOW_MS = 1000;

export function takeSwitchFocus(): 'url' | 'type' | undefined {
    const recent = lastSwitch && Date.now() - lastSwitch.at < SWITCH_FOCUS_WINDOW_MS
        ? lastSwitch.focus
        : undefined;
    lastSwitch = undefined;
    return recent;
}

/**
 * Keeps the request type in line with the URL as it's edited. Like upstream's
 * syncUrlToHeaders, it only reacts to changes, so a loaded request keeps its stored type.
 * A request built without a type (e.g. from a HAR file) can take its URL's type straight away.
 */
export function syncRequestTypeToUrl(
    getUrl: () => string,
    getExtras: () => SendExtras,
    typeFromUrlNow = false
) {
    const initialType = typeFromUrlNow ? requestTypeForUrl(getUrl()) : undefined;
    if (initialType) runInAction(() => { getExtras().requestType = initialType; });

    return reaction(() => requestTypeForUrl(getUrl()), (urlType) => {
        const extras = getExtras();
        if (!urlType || extras.requestType === urlType) return;

        runInAction(() => { extras.requestType = urlType; });
        lastSwitch = { at: Date.now(), focus: 'url' };
    });
}

/**
 * The explicit switch, from the method picker. The URL's scheme follows the new type, and
 * switching to HTTP can pick the method at the same time.
 */
export function switchRequestType(
    request: { url: string, method: string, extras: SendExtras },
    type: SendRequestType,
    method?: string
) {
    runInAction(() => {
        request.url = withRequestTypeScheme(request.url, type);
        request.extras.requestType = type;
        if (method) request.method = method;
    });
    lastSwitch = { at: Date.now(), focus: 'type' };
}

// Subprotocols are offered with the Sec-WebSocket-Protocol header, as a comma separated list
export function subprotocolsFromHeaders(headers: RawHeaders): string[] {
    return _.flatMap(getHeaderValues(headers, 'sec-websocket-protocol'), (value) => value.split(','))
        .map((protocol) => protocol.trim())
        .filter((protocol) => protocol.length > 0);
}
