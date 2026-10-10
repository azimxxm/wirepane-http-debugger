import { action, computed, observable, runInAction } from 'mobx';

import type { RawHeaders } from '../../../types';
import type { RequestOptions } from '../send-request-model';
import type {
    FailedHandshakeResponse,
    WebSocketOpenRequest,
    WebSocketStreamEvent
} from '../../../services/websocket-client-api';
import { closeCodeName, messageText } from './websocket-messages';

/**
 * Wirepane: one Send tab's WebSocket connection, and the log of what it sent and received.
 * Kept in memory only (websocket-sessions.ts keeps one per tab), never persisted.
 */

// What the session needs from the server (services/websocket-client-api.ts)
export interface WebSocketClientApi {
    open(
        request: WebSocketOpenRequest,
        options: RequestOptions,
        abortSignal: AbortSignal
    ): Promise<ReadableStream<WebSocketStreamEvent>>;
    send(id: string, data: Buffer, isBinary: boolean): Promise<void>;
    close(id: string, code?: number, reason?: string): Promise<void>;
}

export interface SessionError {
    code?: string;
    message: string;
}

export interface HandshakeDetails {
    openedAt: number;
    protocol: string;
    extensions: string;
    statusCode: number;
    statusMessage: string;
    headers: RawHeaders;
}

export type WebSocketSessionState =
    | { status: 'idle' }
    | { status: 'connecting', url: string, startedAt: number }
    | {
        status: 'open' | 'closing',
        url: string,
        startedAt: number,
        handshake: HandshakeDetails
    }
    | {
        status: 'closed',
        url: string,
        startedAt: number,
        closedAt: number,
        handshake?: HandshakeDetails,
        // Undefined when the connection ended without a close frame
        code?: number,
        reason: string,
        // Closed before it opened, from Cancel or Disconnect
        cancelled?: boolean,
        // An error that ended the connection, if any
        error?: SessionError
    }
    | {
        status: 'failed',
        url: string,
        startedAt: number,
        failedAt: number,
        error: SessionError,
        // The server's answer when it refused the handshake (e.g. a 401)
        response?: FailedHandshakeResponse
    };

export type LogDirection = 'sent' | 'received';

export class WebSocketLogEntry {

    // Sent messages show up straight away, and are marked once the server has them
    @observable sendState: 'sending' | 'sent' | 'failed';
    @observable sendError: string | undefined = undefined;

    private textCache: string | undefined;

    constructor(
        readonly id: number,
        readonly direction: LogDirection,
        readonly data: Buffer,
        readonly isBinary: boolean,
        readonly timestamp: number,
        sending: boolean
    ) {
        this.sendState = sending ? 'sending' : 'sent';
    }

    get text(): string {
        if (this.textCache === undefined) this.textCache = messageText(this.data);
        return this.textCache;
    }

}

// A connection event in the log (opened, closed, failed), between the messages
export class WebSocketLogNote {

    readonly direction = 'note';

    constructor(
        readonly id: number,
        readonly text: string,
        readonly timestamp: number,
        readonly tone: 'neutral' | 'error'
    ) {}

}

export type WebSocketLogItem = WebSocketLogEntry | WebSocketLogNote;

export const isLogEntry = (item: WebSocketLogItem): item is WebSocketLogEntry =>
    item.direction !== 'note';

// Older messages are dropped past this, so a chatty socket can't use up all the memory
export const MAX_LOG_ITEMS = 5000;

const LOST_CONNECTION_MESSAGE = 'The connection to Wirepane\'s server was lost.';

function describeClose(code: number | undefined, reason: string) {
    if (code === undefined) return 'Connection closed';
    const name = closeCodeName(code);
    return `Closed: ${code}${name ? ` ${name}` : ''}${reason ? `, "${reason}"` : ''}`;
}

export class WebSocketSession {

    @observable.ref
    state: WebSocketSessionState = { status: 'idle' };

    readonly log = observable.array<WebSocketLogItem>([], { deep: false });

    @observable
    droppedCount = 0;

    @observable
    sentCount = 0;

    @observable
    receivedCount = 0;

    @observable
    filter = '';

    @observable
    expandedEntryId: number | undefined = undefined;

    // Why the last Connect didn't start (shown under the URL while it's unchanged)
    @observable.ref
    connectProblem: { url: string, message: string } | undefined = undefined;

    // Why the last message wasn't sent (shown under the composer while it's unchanged)
    @observable.ref
    sendProblem: { content: string, message: string } | undefined = undefined;

    private socketId: string | undefined;
    private abortController: AbortController | undefined;
    // An error from an open socket, reported with the close that follows it
    private pendingError: SessionError | undefined;
    private nextLogId = 0;
    private disposed = false;

    constructor(
        private api: WebSocketClientApi
    ) {}

    @computed
    get isActive() {
        const { status } = this.state;
        return status === 'connecting' || status === 'open' || status === 'closing';
    }

    @computed
    get isOpen() {
        return this.state.status === 'open';
    }

    @computed
    get messages(): WebSocketLogEntry[] {
        return this.log.filter(isLogEntry);
    }

    // The log as shown: with a filter, only the messages that contain its text
    @computed
    get visibleLog(): WebSocketLogItem[] {
        const filter = this.filter.trim().toLowerCase();
        if (!filter) return this.log.slice();

        return this.messages.filter((entry) => entry.text.toLowerCase().includes(filter));
    }

    connect(request: WebSocketOpenRequest, options: RequestOptions): Promise<void> {
        if (this.isActive || this.disposed) return Promise.resolve();

        const abortController = new AbortController();
        runInAction(() => {
            this.abortController = abortController;
            this.socketId = undefined;
            this.pendingError = undefined;
            this.state = { status: 'connecting', url: request.url, startedAt: Date.now() };
        });

        return this.readEvents(request, options, abortController);
    }

    private async readEvents(
        request: WebSocketOpenRequest,
        options: RequestOptions,
        abortController: AbortController
    ) {
        try {
            const events = await this.api.open(request, options, abortController.signal);
            const reader = events.getReader();

            while (true) {
                const { done, value } = await reader.read();
                if (done || abortController !== this.abortController) break;
                this.onEvent(value);
            }

            this.onStreamEnded(abortController);
        } catch (error) {
            this.onStreamFailed(abortController, error as Error);
        }
    }

    @action
    private onEvent(event: WebSocketStreamEvent) {
        const state = this.state;

        switch (event.type) {
            case 'ws-open': {
                if (state.status !== 'connecting') return;
                this.socketId = event.id;
                this.state = {
                    status: 'open',
                    url: state.url,
                    startedAt: state.startedAt,
                    handshake: {
                        openedAt: event.timestamp,
                        protocol: event.protocol,
                        extensions: event.extensions,
                        statusCode: event.statusCode,
                        statusMessage: event.statusMessage,
                        headers: event.headers
                    }
                };
                this.addNote(`Connected to ${state.url}${
                    event.protocol ? ` with protocol ${event.protocol}` : ''
                }`, event.timestamp, 'neutral');
                return;
            }
            case 'ws-message':
                this.addEntry('received', event.data, event.isBinary, event.timestamp, false);
                return;
            case 'ws-close': {
                if (state.status !== 'open' && state.status !== 'closing') return;
                this.socketId = undefined;
                this.state = {
                    status: 'closed',
                    url: state.url,
                    startedAt: state.startedAt,
                    closedAt: event.timestamp,
                    handshake: state.handshake,
                    code: event.code,
                    reason: event.reason,
                    error: this.pendingError
                };
                this.addNote(describeClose(event.code, event.reason), event.timestamp,
                    event.code === 1000 || event.code === 1001 ? 'neutral' : 'error'
                );
                return;
            }
            case 'error':
                if (state.status === 'connecting') {
                    this.state = {
                        status: 'failed',
                        url: state.url,
                        startedAt: state.startedAt,
                        failedAt: event.timestamp,
                        error: event.error,
                        response: event.response
                    };
                    this.addNote(`Couldn't connect: ${event.error.message}`, event.timestamp, 'error');
                } else {
                    this.pendingError = event.error;
                    this.addNote(`Error: ${event.error.message}`, event.timestamp, 'error');
                }
                return;
        }
    }

    @action
    private onStreamEnded(abortController: AbortController) {
        if (abortController !== this.abortController) return; // A newer connection took over
        this.abortController = undefined;
        this.socketId = undefined;

        // The stream always ends with a close or an error, unless the server went away
        if (this.isActive) this.endWith(this.lostConnectionError());
    }

    @action
    private onStreamFailed(abortController: AbortController, error: Error) {
        if (abortController !== this.abortController) return;
        this.abortController = undefined;
        this.socketId = undefined;

        if (!this.isActive) return;

        if (abortController.signal.aborted) {
            // Cancelled here, so it's closed rather than failed
            const state = this.state as Extract<WebSocketSessionState, { url: string }>;
            const cancelled = state.status === 'connecting';
            this.state = {
                status: 'closed',
                url: state.url,
                startedAt: state.startedAt,
                closedAt: Date.now(),
                handshake: 'handshake' in state ? state.handshake : undefined,
                reason: '',
                cancelled
            };
            this.addNote(cancelled ? 'Cancelled' : 'Disconnected', Date.now(), 'neutral');
            return;
        }

        this.endWith(this.state.status === 'connecting'
            ? { message: error.message ?? String(error), code: (error as { code?: string }).code }
            : this.lostConnectionError()
        );
    }

    private lostConnectionError(): SessionError {
        return { message: LOST_CONNECTION_MESSAGE };
    }

    @action
    private endWith(error: SessionError) {
        const state = this.state;
        if (state.status === 'connecting') {
            this.state = {
                status: 'failed',
                url: state.url,
                startedAt: state.startedAt,
                failedAt: Date.now(),
                error
            };
            this.addNote(`Couldn't connect: ${error.message}`, Date.now(), 'error');
        } else if (state.status === 'open' || state.status === 'closing') {
            this.state = {
                status: 'closed',
                url: state.url,
                startedAt: state.startedAt,
                closedAt: Date.now(),
                handshake: state.handshake,
                reason: '',
                error
            };
            this.addNote(error.message, Date.now(), 'error');
        }
    }

    // Stops a connection that's still opening
    cancel() {
        if (this.state.status !== 'connecting') return;
        this.abortController?.abort();
    }

    async disconnect(code = 1000, reason = '') {
        const state = this.state;
        if (state.status === 'connecting') return this.cancel();
        if (state.status !== 'open' || !this.socketId) return;

        const socketId = this.socketId;
        runInAction(() => {
            this.state = { ...state, status: 'closing' };
        });

        try {
            await this.api.close(socketId, code, reason);
            // The close itself arrives as a ws-close event
        } catch (error) {
            // It's gone already, or the server can't be reached: stop waiting for it
            this.abortController?.abort();
        }
    }

    // Sends a message on the open socket. Problems show on the message in the log.
    async send(data: Buffer, isBinary: boolean): Promise<void> {
        if (!this.isOpen || !this.socketId) throw new Error('Connect before sending messages.');

        const entry = this.addEntry('sent', data, isBinary, Date.now(), true);

        try {
            await this.api.send(this.socketId, data, isBinary);
            runInAction(() => { entry.sendState = 'sent'; });
        } catch (error: any) {
            runInAction(() => {
                entry.sendState = 'failed';
                entry.sendError = error.message ?? String(error);
            });
        }
    }

    @action
    setConnectProblem(problem: { url: string, message: string } | undefined) {
        this.connectProblem = problem;
    }

    @action
    setSendProblem(problem: { content: string, message: string } | undefined) {
        this.sendProblem = problem;
    }

    @action.bound
    setFilter(filter: string) {
        this.filter = filter;
    }

    @action.bound
    toggleExpanded(entryId: number) {
        this.expandedEntryId = this.expandedEntryId === entryId ? undefined : entryId;
    }

    @action.bound
    clear() {
        this.log.clear();
        this.droppedCount = 0;
        this.sentCount = 0;
        this.receivedCount = 0;
        this.expandedEntryId = undefined;
    }

    // The tab is gone, or isn't a WebSocket any more: close the socket for good
    dispose() {
        this.disposed = true;
        this.abortController?.abort();
    }

    @action
    private addEntry(
        direction: LogDirection,
        data: Buffer,
        isBinary: boolean,
        timestamp: number,
        sending: boolean
    ): WebSocketLogEntry {
        const entry = new WebSocketLogEntry(this.nextLogId++, direction, data, isBinary, timestamp, sending);
        if (direction === 'sent') this.sentCount += 1;
        else this.receivedCount += 1;

        this.addToLog(entry);
        return entry;
    }

    @action
    private addNote(text: string, timestamp: number, tone: WebSocketLogNote['tone']) {
        this.addToLog(new WebSocketLogNote(this.nextLogId++, text, timestamp, tone));
    }

    private addToLog(item: WebSocketLogItem) {
        this.log.push(item);

        // The sent & received counts still include dropped messages
        const excess = this.log.length - MAX_LOG_ITEMS;
        if (excess > 0) {
            this.log.splice(0, excess);
            this.droppedCount += excess;
        }
    }

}
