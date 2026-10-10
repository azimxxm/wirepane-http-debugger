// Characters that are invalid in file names on Windows, macOS or Linux
const INVALID_FILE_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/g;
const WINDOWS_RESERVED_NAMES = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

// File systems usually cap names at 255 bytes. This leaves room for " (99)" and ".bru".
const MAX_NAME_BYTES = 180;

const truncateToBytes = (value: string, maxBytes: number) => {
    let result = '';
    for (const character of value) { // Iterates code points, so surrogate pairs stay whole
        if (Buffer.byteLength(result + character) > maxBytes) break;
        result += character;
    }
    return result;
};

/**
 * Turns a collection, folder, request or environment name into a safe file name:
 * no path separators or reserved characters, no leading dots (hidden files, '..'),
 * no trailing dots or spaces (dropped by Windows), and a bounded length.
 */
export function sanitizeFileName(name: string): string {
    const cleaned = name
        .normalize('NFC')
        .replace(INVALID_FILE_NAME_CHARACTERS, '-')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^\.+/, '')
        .replace(/[. ]+$/, '');

    const safe = truncateToBytes(cleaned, MAX_NAME_BYTES).trim();
    if (!safe) return 'untitled';
    return WINDOWS_RESERVED_NAMES.test(safe) ? `${safe}_` : safe;
}

/**
 * Picks a file name that isn't in usedNames yet, adding " (2)", " (3)"... when needed,
 * and records it there. Names are compared case-insensitively, because the default
 * macOS and Windows file systems treat "Users" and "users" as the same entry.
 */
export function uniqueFileName(name: string, usedNames: Set<string>, extension = ''): string {
    const base = sanitizeFileName(name);

    for (let counter = 1; ; counter++) {
        const candidate = counter === 1
            ? `${base}${extension}`
            : `${base} (${counter})${extension}`;
        const key = candidate.toLowerCase();

        if (!usedNames.has(key)) {
            usedNames.add(key);
            return candidate;
        }
    }
}
