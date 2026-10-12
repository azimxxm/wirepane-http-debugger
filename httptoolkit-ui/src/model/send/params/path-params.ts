import { action } from 'mobx';

import type { RequestInput } from '../send-request-model';

/**
 * Path params: the `:name` segments of a URL's path, like `:id` in `/users/:id`.
 *
 * Send sends the URL as it is, so the Params tab writes a path param's value into the URL
 * in place of its `:name`. The tab remembers the path with its `:name` segments, its
 * template (SendExtras.pathTemplate): that's how it still knows that `/users/42` is
 * `/users/:id` with 42 as the id. Requests opened from a collection start with their
 * item's path as the template. Clearing a value puts the `:name` back.
 */

export interface PathParam {
    name: string;
    // As written in the URL. Empty while the URL still has the :name.
    value: string;
}

interface SplitPath {
    // "scheme://host:port", or '' when the URL starts with something else, like {{baseUrl}}
    origin: string;
    segments: string[];
    // The "?" or "#" and what follows them
    suffix: string;
}

// Port numbers aren't path params, so the origin is split off first
const ORIGIN_PATTERN = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i;

function splitPath(url: string): SplitPath {
    const suffixStart = url.search(/[?#]/);
    const path = suffixStart === -1 ? url : url.slice(0, suffixStart);
    const origin = ORIGIN_PATTERN.exec(path)?.[0] ?? '';

    return {
        origin,
        segments: path.slice(origin.length).split('/'),
        suffix: suffixStart === -1 ? '' : url.slice(suffixStart)
    };
}

// The same segments as the collections mapping's pathParamNames: ":id", not ":" or "a:b"
const paramNameOf = (segment: string): string | undefined =>
    /^:[^/:]+$/.test(segment) ? segment.slice(1) : undefined;

const escapeCharacter = (character: string) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`;

// A value as typed: "/", "?" and "#" are encoded, so it stays one segment of the path
export const encodePathValue = (value: string) => value.replace(/[/?#]/g, escapeCharacter);
// The value to show for a segment: the opposite of encodePathValue
export const decodePathValue = (value: string) =>
    value.replace(/%(2F|3F|23)/gi, (escape) => decodeURIComponent(escape));

// The URL's path, if it has :name segments
export function pathTemplateOf(url: string): string | undefined {
    const { origin, segments } = splitPath(url);
    return segments.some((segment) => paramNameOf(segment) !== undefined)
        ? `${origin}${segments.join('/')}`
        : undefined;
}

/**
 * The path params of a URL made from `template`, with their values as written in the URL.
 * Undefined if the URL's path doesn't fit the template: another origin, other fixed
 * segments or another number of segments.
 */
export function matchPathTemplate(template: string, url: string): PathParam[] | undefined {
    const pattern = splitPath(template);
    const actual = splitPath(url);
    if (pattern.origin !== actual.origin || pattern.segments.length !== actual.segments.length) return undefined;

    const params: PathParam[] = [];
    for (let i = 0; i < pattern.segments.length; i++) {
        const name = paramNameOf(pattern.segments[i]);
        const segment = actual.segments[i];

        if (name === undefined) {
            if (segment !== pattern.segments[i]) return undefined;
        } else {
            params.push({ name, value: segment === `:${name}` ? '' : segment });
        }
    }

    return params.length ? params : undefined;
}

/**
 * The path params the Params tab shows: the template's, while the URL still fits it, or else
 * the :name segments of the URL itself, which have no value yet.
 */
export function getPathParams(url: string, template: string | undefined): PathParam[] {
    const matched = template !== undefined ? matchPathTemplate(template, url) : undefined;
    if (matched) return matched;

    return splitPath(url).segments
        .map(paramNameOf)
        .filter((name): name is string => name !== undefined)
        .map((name) => ({ name, value: '' }));
}

/**
 * The URL with one path param (by its position among the path params) set to a value as
 * typed, and the template that the URL now comes from.
 */
export function withPathParamValue(
    url: string,
    template: string | undefined,
    index: number,
    value: string
): { url: string, template: string | undefined } {
    const current = template !== undefined && matchPathTemplate(template, url)
        ? template
        : pathTemplateOf(url);
    if (current === undefined) return { url, template };

    const pattern = splitPath(current);
    const actual = splitPath(url);

    let paramIndex = -1;
    const segments = pattern.segments.map((segment, i) => {
        if (paramNameOf(segment) === undefined) return segment;

        paramIndex += 1;
        if (paramIndex !== index) return actual.segments[i];
        return value === '' ? segment : encodePathValue(value);
    });

    return { url: `${actual.origin}${segments.join('/')}${actual.suffix}`, template: current };
}

export const setPathParamValue = action((input: RequestInput, index: number, value: string) => {
    const { url, template } = withPathParamValue(input.url, input.extras.pathTemplate, index, value);
    input.url = url;
    input.extras.pathTemplate = template;
});
