import { CollectedEvent } from '../../types';

/**
 * What the toolbar's breadcrumb calls the event that's open in View's inspector, as in
 * "View › GET /todos/1". Short, as the toolbar truncates it: the path without its query
 * string (which can be hundreds of characters of tokens), and the inspector has the rest.
 */
export function describeOpenEvent(event: CollectedEvent): string {
    if (event.isHttp()) {
        const { method, parsedUrl } = event.request;
        // A connection that broke before it sent a readable request has no URL or method to show
        if (!parsedUrl.parseable) return method ? `${method} (unreadable URL)` : 'Broken request';

        const path = parsedUrl.pathname;
        return [event.isWebSocket() ? 'WebSocket' : method, path].filter(Boolean).join(' ');
    }

    if (event.isTlsFailure()) return `Failed TLS connection to ${event.upstreamHostname ?? 'an unknown host'}`;
    if (event.isTlsTunnel()) return `TLS tunnel to ${event.upstreamHostname ?? 'an unknown host'}`;
    if (event.isRawTunnel()) return `Tunnel to ${event.upstreamHostname}`;
    if (event.isRTCConnection()) return 'WebRTC connection';
    if (event.isRTCDataChannel()) return 'WebRTC data channel';
    if (event.isRTCMediaTrack()) return 'WebRTC media track';
    return 'Selected event';
}

// The breadcrumb's tooltip: the whole URL, query string included
export function describeOpenEventUrl(event: CollectedEvent): string | undefined {
    if (!event.isHttp() || !event.request.parsedUrl.parseable) return undefined;
    return [event.isWebSocket() ? 'WebSocket' : event.request.method, event.request.url].filter(Boolean).join(' ');
}

export function describeSelection(count: number): string {
    return `${count.toLocaleString()} selected`;
}
