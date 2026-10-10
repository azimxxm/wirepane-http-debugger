import { RequestParts } from './request-mapping';

/**
 * What a Send tab held when it was last opened from or saved to its collection request,
 * to tell when it has unsaved changes. Bodies are kept as a fingerprint, not a copy.
 */
export interface TabSnapshot {
    method: string;
    url: string;
    headers: string;
    body: string;
    docs: string;
}

// FNV-1a: cheap and stable. Each body buffer is only hashed once, as edits make new buffers.
const bodyFingerprints = new WeakMap<Buffer, string>();
function fingerprint(body: Buffer): string {
    const known = bodyFingerprints.get(body);
    if (known) return known;

    let hash = 0x811c9dc5;
    for (let i = 0; i < body.length; i++) {
        hash ^= body[i];
        hash = Math.imul(hash, 0x01000193);
    }
    const result = `${body.length}:${(hash >>> 0).toString(16)}`;
    bodyFingerprints.set(body, result);
    return result;
}

export const snapshotOf = (parts: RequestParts, docs: string): TabSnapshot => ({
    method: parts.method,
    url: parts.url,
    headers: JSON.stringify(parts.headers),
    body: fingerprint(parts.body),
    docs
});

export const isSameSnapshot = (a: TabSnapshot, b: TabSnapshot) =>
    a.method === b.method && a.url === b.url && a.headers === b.headers && a.body === b.body && a.docs === b.docs;
