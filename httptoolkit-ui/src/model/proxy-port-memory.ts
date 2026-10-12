import { PortRange } from '../types';
import { isValidPort } from './network';

/*
 * Wirepane: keeps the proxy on the same port across reloads & restarts, so phones and other
 * devices set up with "this Mac's IP + port" keep working.
 *
 * Why the port used to move: Mockttp picks a free port with get-port, which won't hand out
 * any port it gave out in the last 15-30 seconds, even once that port is free again. So
 * after a reload the old session was stopped, but the new one got the next port up. Asking
 * for the remembered port explicitly skips that search.
 */

// The range the proxy picks from when no range is set in Settings. 9473 spells WIRE on a phone
// keypad, and the range stays clear of the ports dev servers and frameworks default to (3000,
// 4200, 5000, 5173, 8000, 8080, 8888, 9000, 9090...), so Wirepane doesn't take theirs.
export const DEFAULT_PROXY_PORT_RANGE: PortRange = { startPort: 9473, endPort: 9999 };

// sessionStorage: this window's proxy session. It survives reloads, and each window has its own.
const WINDOW_SESSION_KEY = 'wirepane:proxy-session';
// localStorage: the port the proxy used last, for the next time the app starts.
const LAST_PORT_KEY = 'wirepane:last-proxy-port';

export interface RememberedProxySession {
    port?: number;
    // Only kept while the session may still be running. A page that unloads cleanly stops
    // its own session, so it drops the id.
    id?: string;
}

const isUsablePort = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && isValidPort(value);

const SESSION_ID_PATTERN = /^[\w-]+$/;

export function parseRememberedSession(value: string | null): RememberedProxySession {
    if (!value) return {};

    try {
        const data = JSON.parse(value);
        return {
            port: isUsablePort(data?.port) ? data.port : undefined,
            id: typeof data?.id === 'string' && SESSION_ID_PATTERN.test(data.id)
                ? data.id
                : undefined
        };
    } catch (e) {
        return {};
    }
}

export function parseRememberedPort(value: string | null): number | undefined {
    if (!value) return undefined;
    const port = Number(value);
    return isUsablePort(port) ? port : undefined;
}

/**
 * The port to ask for explicitly: the first remembered port that fits the port range from
 * Settings (or the default range). Undefined means "use the range as usual".
 */
export function getPreferredProxyPort(
    rememberedPorts: Array<number | undefined>,
    portConfig: PortRange | undefined
): number | undefined {
    const range = portConfig ?? DEFAULT_PROXY_PORT_RANGE;

    return rememberedPorts.find((port): port is number =>
        isUsablePort(port) &&
        port >= range.startPort &&
        port <= range.endPort
    );
}

// Mockttp's admin client keeps its session URL private. It ends with /session/<id>.
export function getSessionIdFromUrl(sessionUrl: unknown): string | undefined {
    if (typeof sessionUrl !== 'string') return undefined;
    return sessionUrl.match(/\/session\/([\w-]+)\/?$/)?.[1];
}

// Storage can be blocked or unavailable. Then we just don't remember anything.
function readStorage(getStorage: () => Storage, key: string): string | null {
    try {
        return getStorage().getItem(key);
    } catch (e) {
        return null;
    }
}

function writeStorage(getStorage: () => Storage, key: string, value: string | undefined) {
    try {
        if (value === undefined) getStorage().removeItem(key);
        else getStorage().setItem(key, value);
    } catch (e) {
        console.warn(`Could not save ${key}`, e);
    }
}

const getSessionStorage = () => window.sessionStorage;
const getLocalStorage = () => window.localStorage;

export function readWindowProxySession(): RememberedProxySession {
    return parseRememberedSession(readStorage(getSessionStorage, WINDOW_SESSION_KEY));
}

export function readLastProxyPort(): number | undefined {
    return parseRememberedPort(readStorage(getLocalStorage, LAST_PORT_KEY));
}

export function rememberProxySession(session: { port: number, id?: string }) {
    writeStorage(getSessionStorage, WINDOW_SESSION_KEY, JSON.stringify(session));
    writeStorage(getLocalStorage, LAST_PORT_KEY, String(session.port));
}

// Called as the page unloads, while it stops its own session: next time there's only
// the port to ask for again, and no session left to clean up.
export function forgetProxySessionId() {
    const { port } = readWindowProxySession();
    writeStorage(getSessionStorage, WINDOW_SESSION_KEY, port !== undefined
        ? JSON.stringify({ port })
        : undefined
    );
}

const STOP_TIMEOUT_MS = 2000;

/**
 * Stops a proxy session this window left running, e.g. because the page crashed instead of
 * unloading, so that its port can be taken again. Failing is fine: the server might not be
 * up yet, and then the session is gone anyway.
 */
export async function stopLeftoverProxySession(adminServerUrl: string, sessionId: string) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), STOP_TIMEOUT_MS);

    try {
        await fetch(`${adminServerUrl}/session/${encodeURIComponent(sessionId)}/stop`, {
            method: 'POST',
            signal: controller.signal
        });
    } catch (e) {
        console.log('Could not stop the previous proxy session', e);
    } finally {
        clearTimeout(timeout);
    }
}
