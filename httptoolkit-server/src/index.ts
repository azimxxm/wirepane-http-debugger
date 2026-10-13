import * as path from 'path';
import * as fs from 'fs';
import type * as http from 'http';
import type { Duplex } from 'stream';
import envPaths from 'env-paths';

import {
    PluggableAdmin,
    generateCACertificate
} from 'mockttp';
import {
    MockttpAdminPlugin
} from 'mockttp/dist/pluggable-admin-api/mockttp-pluggable-admin';
import {
    MockRTCAdminPlugin
} from 'mockrtc';


import { HttpToolkitServerApi, getBearerToken } from './api/api-server';
import { checkBrowserConfig } from './browsers';
import { logError } from './error-tracking';
import { IS_PROD_BUILD, MOCKTTP_ALLOWED_ORIGINS } from './constants';

import { readFile, checkAccess, writeFile, ensureDirectoryExists } from './util/fs';

import { addShutdownHandler, registerShutdownHandler, shutdown } from './shutdown';
import { getTimeToCertExpiry, parseCert } from './certificates';

import {
    startDockerInterceptionServices,
    stopDockerInterceptionServices
} from './interceptors/docker/docker-interception-services';
import { clearWebExtensionConfig, updateWebExtensionConfig } from './webextension';
import { HttpClient } from './client/http-client';

async function generateHTTPSConfig(configPath: string) {
    // wirepane: our own "Wirepane CA", in its own files. The official HTTP Toolkit app uses this
    // same config folder, and its ca.pem & ca.key are left alone.
    const keyPath = path.join(configPath, 'wirepane-ca.key');
    const certPath = path.join(configPath, 'wirepane-ca.pem');

    const [ certContent ] = await Promise.all([
        readFile(certPath, 'utf8').then((certContent) => {
            checkCertExpiry(certContent);
            return certContent;
        }),
        checkAccess(keyPath, fs.constants.R_OK),
    ]).catch(async () => {
        // Cert doesn't exist, or is too close/past expiry. Generate a new one:

        const newCertPair = await generateCACertificate({
            subject: {
                commonName: 'Wirepane CA',
                organizationName: 'Wirepane'
            }
        });

        return Promise.all([
            writeFile(certPath, newCertPair.cert).then(() => newCertPair.cert),
            writeFile(keyPath, newCertPair.key, {
                mode: 0o600 // Only readable for ourselves, nobody else
            })
        ]);
    });

    return {
        keyPath,
        certPath,
        certContent,
        keyLength: 2048, // Reasonably secure keys please
        certificateTransparency: true
    };
}

function checkCertExpiry(certContents: string): void {
    const remainingLifetime = getTimeToCertExpiry(parseCert(certContents));
    if (remainingLifetime < 1000 * 60 * 60 * 48) { // Next two days
        console.warn('Certificate expires soon - it must be regenerated');
        throw new Error('Certificate regeneration required');
    }
}

// wirepane: the Mockttp admin API runs the proxy: it starts sessions, changes their rules and
// stops everyone's (POST /reset). It listens on 127.0.0.1 only, but proxied requests reach it
// too (`GET http://127.0.0.1:45456/...` from any device that can use the proxy), and its CORS
// check stops browsers only. So it needs the desktop's per-run token, like the server API.
// It's an "Authorization: Bearer <token>" header, or a /token/<token> prefix on the path, which
// the UI uses because browsers can't set headers on WebSockets. Mockttp sees the path without it.
// With no token configured (dev runs), everything is allowed, as on the server API.
const ADMIN_TOKEN_PATH_PREFIX = /^\/token\/([^/?#]*)/;
// The Chromium web extension (WebRTC interception) only knows its session's URL, not the token
// (see webextension.ts). It just POSTs GraphQL there. Session ids are random UUIDs that the
// admin API only gives to whoever started the session.
const WEBEXTENSION_ORIGIN = 'chrome-extension://oeehdgfohghfelggpifolochpnkdmpog';
const SESSION_QUERY_PATH = /^\/session\/[\w-]+\/?$/;

function takeTokenFromPath(req: http.IncomingMessage): string | undefined {
    const match = req.url?.match(ADMIN_TOKEN_PATH_PREFIX);
    if (!match) return undefined;

    req.url = req.url!.slice(match[0].length) || '/';
    try {
        return decodeURIComponent(match[1]);
    } catch (e) {
        return undefined; // Malformed escapes can't be our token
    }
}

export function isAdminRequestAllowed(req: http.IncomingMessage, authToken: string | undefined) {
    const pathToken = takeTokenFromPath(req); // Always removed, so dev runs work with or without it
    if (!authToken) return true;

    if (pathToken === authToken || getBearerToken(req) === authToken) return true;

    // CORS preflights can't carry the token. Mockttp's CORS middleware answers every OPTIONS
    // request itself, so they never reach a route.
    if (req.method === 'OPTIONS') return true;

    return req.method === 'POST' &&
        req.headers['origin'] === WEBEXTENSION_ORIGIN &&
        SESSION_QUERY_PATH.test(req.url ?? '');
}

// Puts the token check in front of the admin server's own request & upgrade handlers. Call it
// straight after start(), before any connection can be handled.
export function requireAdminToken(adminServer: http.Server, authToken: string | undefined) {
    const requestListeners = adminServer.listeners('request');
    const upgradeListeners = adminServer.listeners('upgrade');
    adminServer.removeAllListeners('request');
    adminServer.removeAllListeners('upgrade');

    adminServer.on('request', (req: http.IncomingMessage, res: http.ServerResponse) => {
        if (!isAdminRequestAllowed(req, authToken)) {
            res.writeHead(403, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: { message: 'Valid token required' } }));
            return;
        }
        requestListeners.forEach((listener) => listener.call(adminServer, req, res));
    });

    adminServer.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
        if (!isAdminRequestAllowed(req, authToken)) {
            socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
            socket.destroy();
            return;
        }
        upgradeListeners.forEach((listener) => listener.call(adminServer, req, socket, head));
    });
}

let shutdownTimer: NodeJS.Timeout | undefined;

function manageBackgroundServices(
    standalone: PluggableAdmin.AdminServer<{
        http: MockttpAdminPlugin,
        webrtc: MockRTCAdminPlugin
    }>,
    httpsConfig: { certPath: string, certContent: string },
    mockttpPort: number
) {
    let activeSessions = 0;

    standalone.on('mock-session-started', async ({ http, webrtc }, sessionId) => {
        activeSessions += 1;
        if (shutdownTimer) {
            clearTimeout(shutdownTimer);
            shutdownTimer = undefined;
        }

        const httpProxyPort = http.getMockServer().port;

        console.log(`Mock session started, http on port ${
            httpProxyPort
        }, webrtc ${
            !!webrtc ? 'enabled' : 'disabled'
        }`);

        startDockerInterceptionServices(httpProxyPort, httpsConfig, ruleParameters)
        .catch((error) => {
            console.log("Could not start Docker components:", error);
        });

        updateWebExtensionConfig(sessionId, httpProxyPort, !!webrtc, mockttpPort)
        .catch((error) => {
            console.log("Could not update WebRTC config:", error);
        });
    });

    standalone.on('mock-session-stopping', ({ http }) => {
        activeSessions -= 1;
        const httpProxyPort = http.getMockServer().port;

        stopDockerInterceptionServices(httpProxyPort, ruleParameters)
        .catch((error) => {
            console.log("Could not stop Docker components:", error);
        });

        clearWebExtensionConfig(httpProxyPort);

        // In some odd cases, the server can end up running even though all UIs & desktop have exited
        // completely. This can be problematic, as it leaves the server holding ports that HTTP Toolkit
        // needs, and blocks future startups. To avoid this, if no Mock sessions are running at all
        // for 10 minutes, the server shuts down automatically. Skipped for dev, where that might be OK.
        // This should catch even hard desktop shell crashes, as sessions shut down automatically if the
        // client websocket becomes non-responsive.
        // We skip this on Mac, where apps don't generally close when the last window closes.
        if (activeSessions <= 0 && IS_PROD_BUILD && process.platform !== 'darwin') {
            if (shutdownTimer) {
                clearTimeout(shutdownTimer);
                shutdownTimer = undefined;
            }

            // We do a two-step timer here: 1 minute then a logged warning, then 9 more minutes
            // until an automatic server shutdown:
            shutdownTimer = setTimeout(() => {
                if (activeSessions !== 0) return;
                console.log('Server is inactive, preparing for auto-shutdown...');

                shutdownTimer = setTimeout(() => {
                    if (activeSessions !== 0) return;
                    shutdown(99, '10 minutes inactive');
                }, 1000 * 60 * 9).unref();
            }, 1000 * 60 * 1).unref();
        }
    });
}

// A map of rule parameters, which may be referenced by the UI, to pass configuration
// set here directly within the Node process to Mockttp (e.g. to set callbacks etc that
// can't be transferred through the API or which need access to server internals).
// This is a constant but mutable dictionary, which will be modified as the appropriate
// parameters change. Mockttp reads from the dictionary each time rules are configured.
const ruleParameters: { [key: string]: any } = {};

export async function runHTK(options: {
    configPath?: string
    authToken?: string
    serverPort: number
    mockttpPort: number
}) {
    const startTime = Date.now();
    registerShutdownHandler();

    const configPath = options.configPath || envPaths('httptoolkit', { suffix: '' }).config;

    await ensureDirectoryExists(configPath);
    await checkBrowserConfig(configPath);

    const configCheckTime = Date.now();
    console.log('Config checked in', configCheckTime - startTime, 'ms');

    const httpsConfig = await generateHTTPSConfig(configPath);

    const certSetupTime = Date.now();
    console.log('Certificates setup in', certSetupTime - configCheckTime, 'ms');

    // Start a Mockttp standalone server
    const standalone = new PluggableAdmin.AdminServer<{
        http: MockttpAdminPlugin,
        webrtc: MockRTCAdminPlugin
    }>({
        adminPlugins: {
            http: MockttpAdminPlugin,
            webrtc: MockRTCAdminPlugin
        },
        pluginDefaults: {
            http: {
                options: {
                    cors: false, // Don't add mocked CORS responses to intercepted traffic
                    recordTraffic: false, // Don't persist traffic here (keep it in the UI)
                    https: httpsConfig // Use our HTTPS config for HTTPS MITMs.
                }
            },
            webrtc: {
                recordMessages: false // Don't persist WebRTC traffic server-side either.
            }
        },
        corsOptions: {
            strict: true, // For the standalone admin API, require valid CORS headers
            origin: MOCKTTP_ALLOWED_ORIGINS, // Only allow mock admin control from our origins
            maxAge: 86400, // Cache CORS responses for as long as possible
            allowPrivateNetworkAccess: true // Allow access from non-local domains in Chrome 102+
        },
        webSocketKeepAlive: 20000, // Send a keep-alive ping to Mockttp clients every minute
        ruleParameters // Rule parameter dictionary
    });

    manageBackgroundServices(standalone, httpsConfig, options.mockttpPort);

    await standalone.start({
        port: options.mockttpPort,
        host: '127.0.0.1'
    });
    // wirepane: before anything else runs, so no request gets in without the token
    requireAdminToken(standalone['server'], options.authToken);

    addShutdownHandler(() => standalone.stop());

    const standaloneSetupTime = Date.now();
    console.log('Standalone server started in', standaloneSetupTime - certSetupTime, 'ms');

    // Start the HTK server API
    const apiServer = new HttpToolkitServerApi(
        { configPath, authToken: options.authToken, https: httpsConfig },
        new HttpClient(ruleParameters),
        () => standalone.ruleParameterKeys
    );

    // wirepane: no self-updates. The UI asks for one on every start, and oclif's update would
    // fetch the official HTTP Toolkit server from its GitHub releases and run it instead of
    // this one. Wirepane's server is updated together with the app.
    apiServer.on('update-requested', () => {
        console.log('Ignored a server update request: Wirepane updates come with the app');
    });

    await apiServer.start(options.serverPort);

    console.log('Server started in', Date.now() - standaloneSetupTime, 'ms');
    console.log('Total startup took', Date.now() - startTime, 'ms');
}