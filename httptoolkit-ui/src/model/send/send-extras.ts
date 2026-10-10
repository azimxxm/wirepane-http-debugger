import * as _ from 'lodash';
import { observable, toJS } from 'mobx';

/**
 * What Wirepane adds to a Send tab's request: the request type (HTTP or WebSocket) and the
 * structured body modes (form, multipart, binary, GraphQL).
 *
 * Upstream's RequestInput keeps a raw body, edited as text. That stays the 'raw' mode. The
 * other modes keep their own data here, and the real body is only built when the request
 * is sent (build-request.ts), so a big file isn't copied on every keystroke. The raw body
 * is left as it was, so switching back to a raw mode gets the old text back.
 */

export type SendRequestType = 'http' | 'websocket';

// 'raw' is upstream's editor, with its own content type picker (Text, JSON, XML...)
export type SendBodyMode = 'raw' | 'form' | 'multipart' | 'binary' | 'graphql';

// A file attached in Send. Its bytes live in the Send file store (send-files.ts), not here,
// because tabs are persisted in localStorage, which is far too small for files.
export interface FileRef {
    fileId: string;
    name: string;
    size: number;
    contentType: string;
}

export interface FormField {
    id: string;
    name: string;
    value: string;
    enabled: boolean;
    description?: string;
}

export interface MultipartField {
    id: string;
    name: string;
    enabled: boolean;
    kind: 'text' | 'file';
    // Text fields
    value: string;
    // File fields: one or more files sent under the same name
    files: FileRef[];
    // Overrides the part's Content-Type (by default: none for text, the file's own type for files)
    contentType?: string;
    description?: string;
}

export interface GraphqlBody {
    query: string;
    // JSON text as written. It may hold {{variables}}, so it's only parsed when sending.
    variables: string;
    operationName?: string;
}

export type WebSocketMessageType = 'text' | 'json' | 'xml' | 'binary';

// A saved WebSocket message. Collections store these as Bruno's body:ws entries.
export interface WebSocketMessage {
    id: string;
    name: string;
    type: WebSocketMessageType;
    // Binary messages are stored as base64
    content: string;
}

export interface WebSocketDraft {
    // The message being written
    message: string;
    messageType: WebSocketMessageType;
    savedMessages: WebSocketMessage[];
}

export interface SendExtrasData {
    requestType: SendRequestType;
    bodyMode: SendBodyMode;
    formFields: FormField[];
    multipartFields: MultipartField[];
    binaryFile?: FileRef;
    graphql: GraphqlBody;
    websocket: WebSocketDraft;
}

const defaultData = (): SendExtrasData => ({
    requestType: 'http',
    bodyMode: 'raw',
    formFields: [],
    multipartFields: [],
    binaryFile: undefined,
    graphql: { query: '', variables: '' },
    websocket: { message: '', messageType: 'text', savedMessages: [] }
});

export class SendExtras implements SendExtrasData {

    @observable requestType: SendRequestType = 'http';
    @observable bodyMode: SendBodyMode = 'raw';
    @observable formFields: FormField[] = [];
    @observable multipartFields: MultipartField[] = [];
    @observable binaryFile: FileRef | undefined = undefined;
    @observable graphql: GraphqlBody = defaultData().graphql;
    @observable websocket: WebSocketDraft = defaultData().websocket;

    constructor(data?: Partial<SendExtrasData>) {
        if (!data) return;
        const filled = { ...defaultData(), ...data };

        this.requestType = filled.requestType;
        this.bodyMode = filled.bodyMode;
        this.formFields = filled.formFields;
        this.multipartFields = filled.multipartFields;
        this.binaryFile = filled.binaryFile;
        this.graphql = { ...defaultData().graphql, ...filled.graphql };
        this.websocket = { ...defaultData().websocket, ...filled.websocket };
    }

    // A plain deep copy, for persisting, snapshots and building copies of a request
    toData(): SendExtrasData {
        return toJS({
            requestType: this.requestType,
            bodyMode: this.bodyMode,
            formFields: this.formFields,
            multipartFields: this.multipartFields,
            binaryFile: this.binaryFile,
            graphql: this.graphql,
            websocket: this.websocket
        });
    }

    static from(source: SendExtras | Partial<SendExtrasData> | undefined): SendExtras {
        if (source instanceof SendExtras) return new SendExtras(source.toData());
        return new SendExtras(source);
    }

    // True when the raw body is what gets sent, as in upstream Send
    get sendsRawBody(): boolean {
        return this.requestType === 'http' && this.bodyMode === 'raw';
    }

    // Every file this request refers to, so the file store can drop the rest
    get fileRefs(): FileRef[] {
        return [
            ..._.flatMap(this.multipartFields, (field) => field.kind === 'file' ? field.files : []),
            ...(this.binaryFile ? [this.binaryFile] : [])
        ];
    }

}
