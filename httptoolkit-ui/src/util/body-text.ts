import { Headers } from '../types';

// wirepane: helpers for showing bodies as text. They live apart from util/buffer.ts so the
// web worker can use them without pulling in anything else.

// Hex is about 3x the size of the data and Monaco takes ~1.5s to lay out a hex dump of a 4 MB
// body, so the hex view only shows the start of big bodies. The download button has all of it.
// (In kB, not KiB, as the size pills in the UI use kB.)
export const MAX_HEX_VIEW_BYTES = 250_000;

// Charset names that mean "this is UTF-8 / plain ASCII". Browsers decode 'us-ascii' as
// windows-1252, but servers that say it very often send UTF-8, which is the safer guess here.
const UTF8_CHARSETS = ['utf-8', 'utf8', 'unicode-1-1-utf-8', 'us-ascii', 'ascii'];

const CHARSET_PARAM_REGEX = /;\s*charset\s*=\s*(?:"([^"]*)"|([^\s;]*))/i;

// undefined means "unknown charset", so that's only looked up once per name
const decoderCache = new Map<string, TextDecoder | undefined>();

function getContentType(headers: Headers | undefined): string | undefined {
    if (!headers) return undefined;

    const key = Object.keys(headers).find((name) => name.toLowerCase() === 'content-type');
    if (!key) return undefined;

    const value = headers[key];
    return Array.isArray(value) ? value[value.length - 1] : value;
}

export function getDeclaredCharset(headers: Headers | undefined): string | undefined {
    const match = CHARSET_PARAM_REGEX.exec(getContentType(headers) ?? '');
    const charset = (match?.[1] ?? match?.[2])?.trim().toLowerCase();
    return charset || undefined;
}

function getDecoderFor(charset: string): TextDecoder | undefined {
    if (decoderCache.has(charset)) return decoderCache.get(charset);

    let decoder: TextDecoder | undefined;
    try {
        decoder = new TextDecoder(charset);
    } catch (e) {
        decoder = undefined; // Not a charset TextDecoder knows, so we stay on UTF-8
    }

    decoderCache.set(charset, decoder);
    return decoder;
}

/**
 * Decodes a body with the charset its Content-Type header declares (windows-1251, koi8-r,
 * shift_jis...), so legacy text doesn't turn into U+FFFD. Returns undefined when there's
 * nothing to do (no charset, UTF-8, or one TextDecoder doesn't know), and the caller then
 * decodes it as UTF-8 like before.
 */
export function decodeWithDeclaredCharset(
    content: Uint8Array,
    headers: Headers | undefined
): string | undefined {
    const charset = getDeclaredCharset(headers);
    if (!charset || UTF8_CHARSETS.includes(charset)) return undefined;

    return getDecoderFor(charset)?.decode(content);
}
