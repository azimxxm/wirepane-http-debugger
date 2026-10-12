import { action } from 'mobx';

import type { QueryParam } from '../send-extras';
import type { RequestInput } from '../send-request-model';

/**
 * The query params of a Send tab, as the Params tab shows them.
 *
 * The URL holds the params that are sent: the table reads them from it and writes them
 * back into it. Names and values are kept as written in the URL, not decoded, like Bruno
 * and Postman do, so `%20`, `+` and `{{variables}}` stay exactly as they are. Only the
 * characters that would change the query's structure are encoded when they're typed in
 * the table: `&` and `#`, and `=` in names.
 *
 * Disabled params aren't in the URL, so the tab keeps the table itself
 * (SendExtras.queryParams), with the enabled params as typed. That copy is used while it
 * still matches the URL. Once the URL is edited, the enabled params are read from the URL
 * again, and the disabled ones keep their place among them.
 */

const escapeCharacter = (character: string) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

export const encodeQueryName = (name: string) => name.replace(/[&=#]/g, escapeCharacter);
export const encodeQueryValue = (value: string) => value.replace(/[&#]/g, escapeCharacter);

export interface UrlQueryParts {
    // Everything before the "?" (the whole URL without its fragment, if there's no "?")
    beforeQuery: string;
    // What's between "?" and "#", or undefined without a "?"
    query: string | undefined;
    // The "#" and what follows it, or ''
    fragment: string;
}

export function splitQuery(url: string): UrlQueryParts {
    const fragmentStart = url.indexOf('#');
    const withoutFragment = fragmentStart === -1 ? url : url.slice(0, fragmentStart);
    const fragment = fragmentStart === -1 ? '' : url.slice(fragmentStart);

    const queryStart = withoutFragment.indexOf('?');
    return queryStart === -1
        ? { beforeQuery: withoutFragment, query: undefined, fragment }
        : {
            beforeQuery: withoutFragment.slice(0, queryStart),
            query: withoutFragment.slice(queryStart + 1),
            fragment
        };
}

// A query string's params, as written. Empty pairs ("a=1&&b=2") are skipped.
export function parseQueryString(query: string): QueryParam[] {
    return query.split('&').filter((pair) => pair !== '').map((pair): QueryParam => {
        const separator = pair.indexOf('=');
        if (separator === -1) return { name: pair, value: '', enabled: true };

        const value = pair.slice(separator + 1);
        return value === ''
            ? { name: pair.slice(0, separator), value, enabled: true, hasEquals: true }
            : { name: pair.slice(0, separator), value, enabled: true };
    });
}

// A row with nothing typed in it yet. It isn't written to the URL.
export const isBlankQueryParam = (param: QueryParam) => param.name === '' && param.value === '';

// One param as it's written in the URL
export function serializeQueryParam(param: QueryParam): string {
    const name = encodeQueryName(param.name);
    return param.value !== '' || param.hasEquals
        ? `${name}=${encodeQueryValue(param.value)}`
        : name;
}

// The query string for a table: its enabled rows, in order
export function serializeQueryParams(params: readonly QueryParam[]): string {
    return params
        .filter((param) => param.enabled && !isBlankQueryParam(param))
        .map(serializeQueryParam)
        .join('&');
}

/**
 * The URL's params replace the table's enabled rows. Rows still in the URL as written keep
 * what the table knew about them (the text as typed, a description), and each disabled row
 * goes after as many enabled rows as it had before it.
 */
function mergeIntoUrlParams(fromUrl: QueryParam[], stored: readonly QueryParam[]): QueryParam[] {
    const unusedRows = stored.filter((param) => param.enabled && !isBlankQueryParam(param));
    const enabled = fromUrl.map((param) => {
        const written = serializeQueryParam(param);
        const index = unusedRows.findIndex((row) => serializeQueryParam(row) === written);
        return index === -1 ? param : unusedRows.splice(index, 1)[0];
    });

    const merged: QueryParam[] = [];
    let enabledBefore = 0;
    let nextEnabled = 0;

    for (const param of stored) {
        if (param.enabled) {
            if (!isBlankQueryParam(param)) enabledBefore += 1;
            continue;
        }

        while (nextEnabled < Math.min(enabledBefore, enabled.length)) merged.push(enabled[nextEnabled++]);
        merged.push(param);
    }

    return [...merged, ...enabled.slice(nextEnabled)];
}

/**
 * The rows the Params tab shows for a URL, given the tab's own copy of the table
 * (SendExtras.queryParams, unset until the table is edited).
 */
export function getQueryParams(url: string, stored: readonly QueryParam[] | undefined): readonly QueryParam[] {
    const query = splitQuery(url).query ?? '';
    if (stored && serializeQueryParams(stored) === query) return stored;

    const fromUrl = parseQueryString(query);
    return stored ? mergeIntoUrlParams(fromUrl, stored) : fromUrl;
}

// The URL with its query rebuilt from a table. No params at all drops the "?".
export function withQueryParams(url: string, params: readonly QueryParam[]): string {
    const { beforeQuery, fragment } = splitQuery(url);
    const query = serializeQueryParams(params);
    return `${beforeQuery}${query ? `?${query}` : ''}${fragment}`;
}

// What the params sent with the request are: the enabled rows that aren't blank
export const sentQueryParams = (params: readonly QueryParam[]) =>
    params.filter((param) => param.enabled && !isBlankQueryParam(param));

/**
 * What a tab's table holds that its URL doesn't, its disabled params, as a string that
 * changes whenever they do (so collections can tell when a tab has unsaved changes).
 */
export function disabledQueryParamsKey(url: string, stored: readonly QueryParam[] | undefined): string {
    if (!stored) return '';

    const disabled = getQueryParams(url, stored)
        .filter((param) => !param.enabled && !isBlankQueryParam(param));
    return disabled.length
        ? JSON.stringify(disabled.map(({ name, value }) => [name, value]))
        : '';
}

// Edits from the Params tab: the URL and the tab's copy of the table change together
export const setQueryParams = action((input: RequestInput, params: readonly QueryParam[]) => {
    input.url = withQueryParams(input.url, params);
    input.extras.queryParams = params.map((param) => ({ ...param }));
});
