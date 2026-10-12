// wirepane: the electron-builder config of `npm run build` (build:electron). The app ships our own
// code from this repo, never the official downloads:
//   - the server release scripts/build-server.sh makes from ../httptoolkit-server (../build/server)
//   - the UI production build of ../httptoolkit-ui (dist/), served from wirepane://app (src/bundled-ui.ts)
// ./scripts/build-pkg.sh builds both and then runs this.
//
// There's no Apple Developer account yet (CLAUDE.md, "Distribution"), so by default this makes an
// unsigned .pkg holding an ad-hoc signed arm64 Wirepane.app, without notarization or certificates.
// ENABLE_SIGNING=true uses upstream's signed setup instead (electron-builder.config.cjs and the
// `build` field in package.json: Developer ID signing, notarization, dmg), for when the account arrives.

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.join(__dirname, '..');
// Relative to the project dir, as electron-builder expects
const SERVER_RELEASE = '../build/server/httptoolkit-server';
const UI_BUILD = '../httptoolkit-ui/dist';

const signed = process.env.ENABLE_SIGNING === 'true';
const config = signed
    ? require('./electron-builder.config.cjs')
    : structuredClone(require('../package.json').build);

for (const [file, what] of [
    [path.join(SERVER_RELEASE, 'bin', 'httptoolkit-server'), 'server release'],
    [path.join(UI_BUILD, 'index.html'), 'UI build']
]) {
    if (!fs.existsSync(path.join(PROJECT_DIR, file))) {
        throw new Error(`The ${what} is missing (${path.resolve(PROJECT_DIR, file)}). Build everything with ./scripts/build-pkg.sh`);
    }
}

config.extraResources = [
    // Copied from the folder above it: electron-builder always leaves out the node_modules at the
    // root of a file set, and the server needs its node_modules
    { from: path.dirname(SERVER_RELEASE), filter: [`${path.basename(SERVER_RELEASE)}/**/*`] },
    {
        from: UI_BUILD,
        to: 'httptoolkit-ui',
        // Source maps, the bundle size report and the update service worker (never registered in
        // this build, DISABLE_UPDATES) aren't needed in the app
        filter: ['**/*', '!**/*.map', '!report.html', '!ui-update-worker.js*']
    },
    'httptoolkit-ctl{,.*}',
    'httptoolkit-mcp{,.*}'
];
// httptoolkit-server/ in this folder is start.sh's dev stub (or an old official download): the real
// server above goes to Resources, so keep that folder out of app.asar
config.files = [...config.files, '!httptoolkit-server{,/**/*}'];

if (!signed) {
    console.log('\nBuilding the unsigned Wirepane .pkg: ad-hoc signed app, no Apple Developer account\n');

    // CSC_LINK, CSC_NAME etc. would make electron-builder import and use a real certificate
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('CSC_')) delete process.env[key];
    }
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';

    config.mac = {
        ...config.mac,
        target: [
            { target: 'pkg', arch: ['arm64'] },
            { target: 'zip', arch: ['arm64'] } // The same app as a zip, e.g. for a curl | sh install
        ],
        identity: '-', // Ad-hoc signing: Apple Silicon only runs signed code, and this needs no certificate
        hardenedRuntime: false, // Only notarization needs it, and with an ad-hoc signature its library validation stops the app from starting
        timestamp: 'none', // Ad-hoc signatures have no trusted timestamp, so don't ask Apple's server for one
        forceCodeSigning: false,
        notarize: false
    };
    config.pkg = {
        ...config.pkg,
        identity: null, // An unsigned installer
        isRelocatable: false, // Always install to /Applications (or ~/Applications), never over another Wirepane.app found on disk
        mustClose: [config.appId] // Ask to quit a running Wirepane before replacing it
    };
}

module.exports = config;
