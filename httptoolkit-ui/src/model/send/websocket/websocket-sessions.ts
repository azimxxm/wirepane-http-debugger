import { reaction } from 'mobx';

import type { SendRequest } from '../send-request-model';
import { WebSocketClientApi, WebSocketSession } from './websocket-session';
import {
    closeWebSocket,
    openWebSocket,
    sendWebSocketMessage
} from '../../../services/websocket-client-api';

/**
 * Wirepane: the WebSocket session of each Send tab, in memory only. A session lives while
 * its tab does and is a WebSocket request: closing the tab, or switching it back to HTTP,
 * closes its socket.
 */

const serverApi: WebSocketClientApi = {
    open: openWebSocket,
    send: sendWebSocketMessage,
    close: closeWebSocket
};

// All this needs from the Send store
interface SendTabs {
    readonly sendRequests: ReadonlyArray<SendRequest>;
}

export class WebSocketSessions {

    private readonly sessions = new Map<string, WebSocketSession>();

    constructor(
        private sendTabs: SendTabs,
        private api: WebSocketClientApi = serverApi
    ) {
        reaction(
            () => this.sendTabs.sendRequests
                .filter((sendRequest) => sendRequest.request.extras.requestType === 'websocket')
                .map((sendRequest) => sendRequest.id),
            (webSocketTabIds) => this.keepOnly(webSocketTabIds)
        );
    }

    sessionFor(sendRequest: SendRequest): WebSocketSession {
        let session = this.sessions.get(sendRequest.id);
        if (!session) {
            session = new WebSocketSession(this.api);
            this.sessions.set(sendRequest.id, session);
        }
        return session;
    }

    has(sendRequestId: string) {
        return this.sessions.has(sendRequestId);
    }

    private keepOnly(sendRequestIds: string[]) {
        for (const [id, session] of this.sessions) {
            if (sendRequestIds.includes(id)) continue;
            session.dispose();
            this.sessions.delete(id);
        }
    }

}

const sessionsByStore = new WeakMap<SendTabs, WebSocketSessions>();

// One set of sessions per Send store (in practice: the app's one)
export function webSocketSessionsFor(sendTabs: SendTabs): WebSocketSessions {
    let sessions = sessionsByStore.get(sendTabs);
    if (!sessions) {
        sessions = new WebSocketSessions(sendTabs);
        sessionsByStore.set(sendTabs, sessions);
    }
    return sessions;
}
