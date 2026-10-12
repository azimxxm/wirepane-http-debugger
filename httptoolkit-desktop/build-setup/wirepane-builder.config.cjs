// wirepane: the electron-builder config of `npm run build` (build:electron). The app ships our own
// code from this repo, never the official downloads:
//   - the server release scripts/build-server.sh makes from ../httptoolkit-server, for the OS and
//     CPU this runs on (../build/server/<target>, e.g. darwin-arm64)
//   - the UI production build of ../httptoolkit-ui with its API specs compressed
//     (../build/ui, scripts/assemble-ui.cjs), served from wirepane://app (src/bundled-ui.ts)
// ./scripts/build-release.sh <mac|win|linux> builds both and then runs this, on that OS.
//
// Nothing is signed: there's no Apple Developer account or code signing certificate yet
// (CLAUDE.md, "Distribution"). macOS gets an unsigned .pkg holding an ad-hoc signed arm64
// Wirepane.app (and the same app as a .zip), Windows an NSIS installer and a .zip, Linux an
// AppImage, a .deb and an .rpm (both x64). ENABLE_SIGNING=true uses upstream's signed setup instead
// (electron-builder.config.cjs and the `build` field in package.json: Developer ID signing,
// notarization), for when the account arrives.
//
// File names carry Wirepane's own version (the VERSION file at the repo root, or $WIREPANE_VERSION),
// e.g. Wirepane-1.0.0-mac-arm64.pkg. The app's internal version stays package.json's (HTTP
// Toolkit's), because the UI checks it to turn features on.

const fs = require('fs');
const path = require('path');

const PROJECT_DIR = path.join(__dirname, '..');

const PRODUCT_VERSION = (
    process.env.WIREPANE_VERSION || fs.readFileSync(path.join(PROJECT_DIR, '..', 'VERSION'), 'utf8')
).trim();
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(PRODUCT_VERSION)) {
    throw new Error(`Wirepane's version must look like 1.2.3, not "${PRODUCT_VERSION}" (the VERSION file or WIREPANE_VERSION)`);
}

// The server release for the OS and CPU being built for (scripts/build-release.sh sets it).
// Relative to the project dir, as electron-builder expects.
const SERVER_TARGET = process.env.WIREPANE_SERVER_TARGET || `${process.platform}-${process.arch}`;
const SERVER_RELEASE = `../build/server/${SERVER_TARGET}/httptoolkit-server`;
const UI_BUILD = '../build/ui';

const signed = process.env.ENABLE_SIGNING === 'true';
const config = signed
    ? require('./electron-builder.config.cjs')
    : structuredClone(require('../package.json').build);

const serverLauncher = SERVER_TARGET.startsWith('win32-') ? 'httptoolkit-server.cmd' : 'httptoolkit-server';
for (const [file, what] of [
    [path.join(SERVER_RELEASE, 'bin', serverLauncher), `server release for ${SERVER_TARGET}`],
    [path.join(UI_BUILD, 'index.html'), 'UI build']
]) {
    if (!fs.existsSync(path.join(PROJECT_DIR, file))) {
        throw new Error(`The ${what} is missing (${path.resolve(PROJECT_DIR, file)}). Build everything with ./scripts/build-release.sh`);
    }
}

// src/product-version.ts reads it, for the About panel
config.extraMetadata = { ...config.extraMetadata, wirepaneVersion: PRODUCT_VERSION };

config.extraResources = [
    // Copied from the folder above it: electron-builder always leaves out the node_modules at the
    // root of a file set, and the server needs its node_modules
    { from: path.dirname(SERVER_RELEASE), filter: [`${path.basename(SERVER_RELEASE)}/**/*`] },
    { from: UI_BUILD, to: 'httptoolkit-ui' },
    'httptoolkit-ctl{,.*}',
    'httptoolkit-mcp{,.*}'
];
// httptoolkit-server/ in this folder is start.sh's dev stub (or an old official download): the real
// server above goes to Resources, so keep that folder out of app.asar
config.files = [...config.files, '!httptoolkit-server{,/**/*}'];

// e.g. Wirepane-1.0.0-win-x64-setup.exe. ${arch} is each format's own spelling: arm64 and x64,
// but x86_64 for the AppImage and the .rpm and amd64 for the .deb.
const artifactName = (os, suffix = '') => `Wirepane-${PRODUCT_VERSION}-${os}-\${arch}${suffix}.\${ext}`;

config.artifactName = artifactName('${os}');
config.mac = {
    ...config.mac,
    artifactName: artifactName('mac'),
    // The UI is data only (scripts, fonts, compressed specs). The app's own signature seals those
    // files anyway, while signing each "binary-looking" one gave all 2500 specs a signature of
    // their own and slowed the build down.
    signIgnore: ['/Contents/Resources/httptoolkit-ui/']
};
config.pkg = { ...config.pkg, artifactName: artifactName('mac') };
config.dmg = { ...config.dmg, artifactName: artifactName('mac') };
config.win = {
    ...config.win,
    target: [
        { target: 'nsis', arch: ['x64'] },
        { target: 'zip', arch: ['x64'] }
    ],
    artifactName: artifactName('win')
};
config.nsis = {
    ...config.nsis,
    artifactName: artifactName('win', '-setup'),
    // Not "Wirepane 1.27.2": that's the internal version (Windows still lists it as the version)
    uninstallDisplayName: 'Wirepane'
};
config.linux = {
    ...config.linux,
    target: [
        { target: 'AppImage', arch: ['x64'] },
        { target: 'deb', arch: ['x64'] },
        { target: 'rpm', arch: ['x64'] }
    ],
    artifactName: artifactName('linux'),
    // /opt/Wirepane/wirepane and /usr/bin/wirepane, clear of the official app's httptoolkit
    executableName: 'wirepane',
    maintainer: 'Wirepane <azimxxm@users.noreply.github.com>'
};
config.appImage = { ...config.appImage, artifactName: artifactName('linux') };
config.deb = { ...config.deb, artifactName: artifactName('linux') };
config.rpm = {
    ...config.rpm,
    artifactName: artifactName('linux'),
    // Upstream's script removes the official app's /usr/bin/httptoolkit link
    afterRemove: 'build-setup/wirepane-rpm-after-remove.sh'
};

if (!signed) {
    console.log('\nBuilding unsigned Wirepane installers: no Apple Developer account or code signing certificate\n');

    // CSC_LINK, CSC_NAME, WIN_CSC_LINK etc. would make electron-builder import and use a certificate
    for (const key of Object.keys(process.env)) {
        if (key.startsWith('CSC_') || key.startsWith('WIN_CSC_')) delete process.env[key];
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
    // Upstream signs Windows builds through Azure, as its own company
    config.win = { ...config.win, forceCodeSigning: false };
    delete config.win.azureSignOptions;
}

module.exports = config;
