import { isProbablyUtf8 } from '../../../util/buffer';
import type { WebSocketMessageType } from '../send-extras';

/**
 * Wirepane: turning WebSocket messages into bytes and back into text, for the message
 * composer and the message log.
 */

// Why a message can't be sent as written. The message is shown under the composer.
export class MessageEncodingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MessageEncodingError';
    }
}

const BASE64_PATTERN = /^[A-Za-z0-9+/_-]*={0,2}$/;

function isValidBase64(text: string) {
    // A single character left over can't encode a byte
    return BASE64_PATTERN.test(text) && text.length % 4 !== 1;
}

// Text, JSON and XML messages go out as text frames. Binary ones are written as base64.
export function encodeMessage(content: string, type: WebSocketMessageType): { data: Buffer, isBinary: boolean } {
    if (type !== 'binary') return { data: Buffer.from(content, 'utf8'), isBinary: false };

    const base64 = content.replace(/\s+/g, '');
    if (!isValidBase64(base64)) {
        throw new MessageEncodingError('Binary messages are written as base64, and this isn\'t valid base64.');
    }

    return {
        data: Buffer.from(base64.replace(/-/g, '+').replace(/_/g, '/'), 'base64'),
        isBinary: true
    };
}

export function messageText(data: Buffer): string {
    return data.toString('utf8');
}

// Pretty-printed JSON, or undefined if the text isn't JSON
export function prettyJson(text: string): string | undefined {
    const trimmed = text.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;

    try {
        return JSON.stringify(JSON.parse(trimmed), null, 2);
    } catch {
        return undefined;
    }
}

// One line for the message log
export function messagePreview(data: Buffer, isBinary: boolean, maxLength = 200): string {
    const start = data.subarray(0, maxLength * 4); // UTF-8 is up to 4 bytes per character

    const text = isBinary && !isProbablyUtf8(start)
        ? start.subarray(0, maxLength / 2).toString('hex').replace(/(..)/g, '$1 ').trim()
        : start.toString('utf8');

    return text.replace(/\s+/g, ' ').slice(0, maxLength);
}

// A classic hex dump: offset, 16 bytes of hex, and their printable ASCII
export function hexDump(data: Buffer, maxBytes = 64 * 1024): string {
    const lines: string[] = [];
    const end = Math.min(data.byteLength, maxBytes);

    for (let offset = 0; offset < end; offset += 16) {
        const row = data.subarray(offset, Math.min(offset + 16, end));
        const hex = Array.from(row, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(row, (byte) => byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : '.').join('');

        lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex.padEnd(47)}  ${ascii}`);
    }

    return lines.join('\n');
}

// Close codes, as RFC 6455 names them
const CLOSE_CODE_NAMES: { [code: number]: string } = {
    1000: 'Normal closure',
    1001: 'Going away',
    1002: 'Protocol error',
    1003: 'Unsupported data',
    1005: 'No status received',
    1006: 'Abnormal closure',
    1007: 'Invalid payload data',
    1008: 'Policy violation',
    1009: 'Message too big',
    1010: 'Mandatory extension',
    1011: 'Internal error',
    1012: 'Service restart',
    1013: 'Try again later',
    1014: 'Bad gateway',
    1015: 'TLS handshake failed'
};

export function closeCodeName(code: number | undefined): string | undefined {
    if (code === undefined) return undefined;
    return CLOSE_CODE_NAMES[code];
}
