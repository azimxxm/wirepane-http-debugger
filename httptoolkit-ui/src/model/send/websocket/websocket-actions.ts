import { logError } from '../../../errors';

import type { SendStore } from '../send-store';
import type { SendRequest } from '../send-request-model';
import type { WebSocketMessageType } from '../send-extras';
import type { WebSocketSession } from './websocket-session';
import { subprotocolsFromHeaders } from './request-type';
import { encodeMessage } from './websocket-messages';

/**
 * Wirepane: Connect and Send for a WebSocket tab. Both go through the same hooks as an HTTP
 * Send, so {{variables}}, collection settings and the connection options all apply.
 */

// The parts of the Send store used here
export type WebSocketSendHooks = Pick<SendStore, 'prepareRequestInput' | 'getRequestOptions' | 'resolveTemplates'>;

const WEBSOCKET_PROTOCOLS = ['ws:', 'wss:', 'http:', 'https:'];

export async function connectTab(
    sendStore: WebSocketSendHooks,
    sendRequest: SendRequest,
    session: WebSocketSession
): Promise<void> {
    if (session.isActive) return;
    session.setConnectProblem(undefined);

    // The tab as it'll be sent, with {{variables}} filled in. When that's not possible, the
    // collections store says why, under the URL.
    const request = await sendStore.prepareRequestInput(sendRequest);
    if (!request) return;

    const typedUrl = sendRequest.request.url;
    const url = request.url.trim();

    let parsedUrl: URL;
    try {
        parsedUrl = new URL(url);
    } catch {
        session.setConnectProblem({
            url: typedUrl,
            message: url
                ? `"${url}" isn't a full URL. WebSocket URLs look like wss://example.com/socket.`
                : 'Enter a ws:// or wss:// URL to connect to.'
        });
        return;
    }

    if (!WEBSOCKET_PROTOCOLS.includes(parsedUrl.protocol)) {
        session.setConnectProblem({
            url: typedUrl,
            message: `WebSocket URLs start with ws:// or wss://, not ${parsedUrl.protocol}`
        });
        return;
    }

    session.connect({
        url,
        headers: request.headers,
        protocols: subprotocolsFromHeaders(request.headers)
    }, sendStore.getRequestOptions(parsedUrl)).catch(logError);
}

// Sends the composer's message, with {{variables}} filled in
export async function sendComposedMessage(
    sendStore: WebSocketSendHooks,
    sendRequest: SendRequest,
    session: WebSocketSession,
    content: string,
    type: WebSocketMessageType
): Promise<void> {
    if (!session.isOpen) return;
    session.setSendProblem(undefined);

    let message: { data: Buffer, isBinary: boolean };
    try {
        message = encodeMessage(sendStore.resolveTemplates(sendRequest, content), type);
    } catch (error: any) {
        session.setSendProblem({ content, message: error.message ?? String(error) });
        return;
    }

    await session.send(message.data, message.isBinary);
}
