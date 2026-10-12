import { CollectedEvent } from '../../types';

/**
 * What the toolbar's breadcrumb calls the event that's open in View's inspector, as in
 * "View › GET /todos/1". Short, as the toolbar truncates it: the inspector has the rest.
 */
export function describeOpenEvent(event: CollectedEvent): string {
    if (event.isHttp()) {
        const { method, parsedUrl } = event.request;
        const path = `${parsedUrl.pathname}${parsedUrl.search}`;
        return event.isWebSocket()
            ? `WebSocket ${path}`
            : `${method} ${path}`;
    }

    if (event.isTlsFailure()) return `Failed TLS connection to ${event.upstreamHostname ?? 'an unknown host'}`;
    if (event.isTlsTunnel()) return `TLS tunnel to ${event.upstreamHostname ?? 'an unknown host'}`;
    if (event.isRawTunnel()) return `Tunnel to ${event.upstreamHostname}`;
    if (event.isRTCConnection()) return 'WebRTC connection';
    if (event.isRTCDataChannel()) return 'WebRTC data channel';
    if (event.isRTCMediaTrack()) return 'WebRTC media track';
    return 'Selected event';
}

export function describeSelection(count: number): string {
    return `${count.toLocaleString()} selected`;
}
