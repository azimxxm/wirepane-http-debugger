import { action } from 'mobx';

import { RawHeaders } from '../../types';

import type { RequestEditorTab } from './send-extras';
import type { RequestInput } from './send-request-model';
import { getQueryParams, sentQueryParams, splitQuery } from './params/query-params';
import { getPathParams } from './params/path-params';

/**
 * The tabs of Send's request pane: Params, Headers, Body and Docs (Docs only for requests
 * from a collection). Until one is picked, a request shows the tab that fits it, and that
 * follows the request as it changes. Picking a tab, or working inside one, keeps it.
 */

export const REQUEST_EDITOR_TABS: readonly RequestEditorTab[] = ['params', 'headers', 'body', 'docs'];

// Methods whose requests usually carry a body
const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

type EditorTabInput = Pick<RequestInput, 'method' | 'url' | 'rawBody' | 'extras'>;

export const hasRequestBody = (input: EditorTabInput) =>
    input.extras.bodyMode !== 'raw' || input.rawBody.decoded.byteLength > 0;

/**
 * Body for requests with a body, or whose method usually has one; Params when the URL has
 * query or path params; Headers otherwise.
 */
export function defaultEditorTab(input: EditorTabInput): RequestEditorTab {
    if (BODY_METHODS.includes(input.method.toUpperCase()) || hasRequestBody(input)) return 'body';

    const hasQuery = !!splitQuery(input.url).query;
    if (hasQuery || getPathParams(input.url, input.extras.pathTemplate).length > 0) return 'params';

    return 'headers';
}

// The tab to show: the one picked for this request if it's there, or else the default
export function shownEditorTab(input: EditorTabInput, available: readonly RequestEditorTab[]): RequestEditorTab {
    const picked = input.extras.editorTab;
    return picked && available.includes(picked) ? picked : defaultEditorTab(input);
}

export const pickEditorTab = action((input: RequestInput, tab: RequestEditorTab) => {
    input.extras.editorTab = tab;
});

// The count on the Params tab: query params sent with the request, and path params
export const paramsCount = (input: Pick<RequestInput, 'url' | 'extras'>) =>
    sentQueryParams(getQueryParams(input.url, input.extras.queryParams)).length +
    getPathParams(input.url, input.extras.pathTemplate).length;

export const headersCount = (headers: RawHeaders) =>
    headers.filter(([name]) => name !== '').length;
