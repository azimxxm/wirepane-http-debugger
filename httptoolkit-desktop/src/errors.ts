import { randomUUID } from 'crypto';

const DEV_MODE = process.env.HTK_DEV === 'true';

import * as Sentry from '@sentry/electron/main';

// wirepane: no built-in DSN, as in the server. Upstream builds send their crashes to HTTP
// Toolkit's own Sentry; Wirepane only reports to a Sentry that you set up, with SENTRY_DSN.
const SENTRY_DSN = process.env.SENTRY_DSN;

if (!DEV_MODE && SENTRY_DSN) {
    Sentry.init({
        dsn: SENTRY_DSN,
        integrations: [
            Sentry.rewriteFramesIntegration({
                // Make all paths relative to this root, because otherwise it can make
                // errors unnecessarily distinct, especially on Windows.
                root: process.platform === 'win32'
                    // Root must always be POSIX format, so we transform it on Windows:
                    ? import.meta.dirname
                        .replace(/^[A-Z]:/, '') // remove Windows-style prefix
                        .replace(/\\/g, '/') // replace all `\\` instances with `/`
                    : import.meta.dirname
            })
        ]
    });

    // We use a random id to distinguish between many errors in one session vs
    // one error in many sessions. This isn't persisted and can't be used to
    // identify anybody between sessions.
    const randomId = randomUUID();
    Sentry.setUser({ id: randomId, username: `anon-${randomId}` });
}

export function logError(error: Error | string, fingerprint?: string[]) {
    console.log(error);

    const context = fingerprint
        ? {
            fingerprint:[
                "{{ default }}",
                ...fingerprint.filter(x => !!x)
            ]
        }
        : undefined;

    if (typeof error === 'string') {
        Sentry.captureMessage(error, context);
    } else {
        Sentry.captureException(error, context);
    }
}

export function addBreadcrumb(breadcrumb: Sentry.Breadcrumb) {
    Sentry.addBreadcrumb(breadcrumb);
}