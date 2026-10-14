import { action } from 'mobx';

import { RawHeaders } from '../../types';

import type { RequestEditorTab } from './send-extras';
import type { RequestInput } from './send-request-model';
import { getQueryParams, sentQueryParams, splitQuery } from './params/query-params';
import { getPathParams } from './params/path-params';

/**
 * The tabs of Send's request pane: Params, Authorization, Headers, Body, Scripts, Settings
 * and Docs (Docs only for requests from a collection).
 */

export const REQUEST_EDITOR_TABS: readonly RequestEditorTab[] = [
    'params',
    'authorization',
    'headers',
    'body',
    'scripts',
    'settings',
    'docs'
];

// Methods whose requests usually carry a body
const BODY_METHODS = ['POST', 'PUT', 'PATCH'];

type EditorTabInput = Pick<RequestInput, 'method' | 'url' | 'rawBody' | 'extras'>;

export const hasRequestBody = (input: EditorTabInput) =>
    input.extras.bodyMode !== 'raw' || input.rawBody.decoded.byteLength > 0;

export const hasAuth = (input: EditorTabInput) =>
    input.extras.auth.mode !== 'none';

export const hasScripts = (input: EditorTabInput) =>
    !!(input.extras.scripts.preRequest?.trim() || input.extras.scripts.postResponse?.trim());

export const hasCustomSettings = (input: EditorTabInput) => {
    const s = input.extras.settings;
    return s.httpVersion !== 'auto' || !s.sslVerification || !s.followRedirects || s.followOriginalMethod || s.followAuthorizationHeader;
};

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

