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
 *
 * It also holds what the request pane's tabs keep per request: the Params tab's disabled
 * query params and path template, and which tab is open.
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

// A row of the Params tab's query table (see params/query-params.ts)
export interface QueryParam {
    // As typed in the table, or as written in the URL
    name: string;
    value: string;
    // Disabled params stay in the table but aren't in the URL
    enabled: boolean;
    // Set for "name=" in the URL, so it isn't written back as "name"
    hasEquals?: boolean;
    // From the collection request, kept when it's saved
    description?: string;
}

// The tabs of the request pane
export type RequestEditorTab = 'params' | 'headers' | 'body' | 'docs';

export interface SendExtrasData {
    requestType: SendRequestType;
    bodyMode: SendBodyMode;
    formFields: FormField[];
    multipartFields: MultipartField[];
    binaryFile?: FileRef;
    graphql: GraphqlBody;
    websocket: WebSocketDraft;
    // The query table as the Params tab last showed it, disabled params included. Unset
    // until the table is edited: the URL alone is enough until then.
    queryParams?: QueryParam[];
    // The URL path with its :name segments, which the Params tab fills in (params/path-params.ts)
    pathTemplate?: string;
    // The request pane tab picked for this request. Unset: it follows the request (request-editor-tabs.ts).
    editorTab?: RequestEditorTab;
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
    // Always replaced as a whole, never changed in place
    @observable.ref queryParams: QueryParam[] | undefined = undefined;
    @observable pathTemplate: string | undefined = undefined;
    @observable editorTab: RequestEditorTab | undefined = undefined;

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
        this.queryParams = filled.queryParams?.map((param) => ({ ...param }));
        this.pathTemplate = filled.pathTemplate;
        this.editorTab = filled.editorTab;
    }

    // A plain deep copy, for persisting, snapshots and building copies of a request.
    // Each value goes through toJS on its own: toJS returns a plain object as it is, so
    // wrapping them all in one would hand out (and only track) the live observables.
    toData(): SendExtrasData {
        return {
            requestType: this.requestType,
            bodyMode: this.bodyMode,
            formFields: toJS(this.formFields),
            multipartFields: toJS(this.multipartFields),
            binaryFile: toJS(this.binaryFile),
            graphql: toJS(this.graphql),
            websocket: toJS(this.websocket),
            // The request pane's state, only once there is some
            ...(this.queryParams ? { queryParams: this.queryParams.map((param) => ({ ...param })) } : {}),
            ...(this.pathTemplate !== undefined ? { pathTemplate: this.pathTemplate } : {}),
            ...(this.editorTab ? { editorTab: this.editorTab } : {})
        };
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
