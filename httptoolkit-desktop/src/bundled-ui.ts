// wirepane: serves the UI that ships inside the app (Resources/httptoolkit-ui, built by
// scripts/build-pkg.sh) from wirepane://app, instead of loading the hosted app.httptoolkit.tech.
// The origin never changes, so localStorage and IndexedDB (settings, Send tabs, files) survive
// restarts. A localhost server on a random port would give the UI a new origin every launch.

import { promises as fs } from 'fs';
import * as path from 'path';
import { protocol } from 'electron';

const SCHEME = 'wirepane';
const HOST = 'app';
export const BUNDLED_UI_URL = `${SCHEME}://${HOST}`;

const MIME_TYPES: Record<string, string> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.txt': 'text/plain; charset=utf-8',
    '.wasm': 'application/wasm', // WebAssembly.instantiateStreaming needs this exact type
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.ico': 'image/x-icon',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf'
};

// Has to run before the app is ready
export function registerBundledUiScheme() {
    protocol.registerSchemesAsPrivileged([{
        scheme: SCHEME,
        privileges: {
            standard: true, // A real origin (wirepane://app), so storage, relative URLs and workers work
            secure: true, // A secure context, like https
            supportFetchAPI: true, // The UI fetches its own files, e.g. /api/<spec>.json
            corsEnabled: true,
            codeCache: true // Faster startups: V8 caches the compiled scripts
        }
    }]);
}

const readFileOrUndefined = (filePath: string) =>
    fs.readFile(filePath).catch(() => undefined); // Missing file, or a folder

const notFound = () => new Response('Not found', { status: 404 });

// Has to run once the app is ready, before any window loads the UI
export function serveBundledUi(uiRoot: string) {
    protocol.handle(SCHEME, async (request) => {
        const url = new URL(request.url);
        if (url.host !== HOST) return notFound();

        let filePath: string;
        try {
            filePath = path.join(uiRoot, decodeURIComponent(url.pathname));
        } catch (e) {
            return new Response('Bad request', { status: 400 }); // Malformed %-encoding
        }
        // path.join resolves '..', so this refuses anything outside the UI folder
        if (filePath !== uiRoot && !filePath.startsWith(uiRoot + path.sep)) return notFound();

        let content = await readFileOrUndefined(filePath);
        if (!content && path.extname(filePath) === '') {
            // Client-side routes like /view or /send/<tab> have no file of their own: the app's
            // index.html handles them (it uses <base href="/">, so its assets still resolve)
            filePath = path.join(uiRoot, 'index.html');
            content = await readFileOrUndefined(filePath);
        }
        if (!content) return notFound();

        return new Response(new Uint8Array(content), { // A copy, as Response's types don't take a Buffer
            headers: {
                'content-type': MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
            }
        });
    });
}
