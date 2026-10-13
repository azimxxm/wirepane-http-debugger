import * as electron from 'electron';
const {
    contextBridge,
    ipcRenderer: { invoke: ipcInvoke },
    webUtils
} = electron;

import type { ContextMenuDefinition } from './context-menu.ts';

// Read values passed sync in additionalArguments:
const readArg = (name: string): string | undefined => {
    const prefix = `--${name}=`;
    const arg = process.argv.find(a => a.startsWith(prefix));
    return arg?.slice(prefix.length);
};

const desktopVersion = readArg('htk-desktop-version');
const authToken = readArg('htk-server-auth-token');

const parsePort = (raw: string | undefined): number | undefined => {
    if (!raw) return undefined;
    const port = Number(raw);
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : undefined;
};
const serverPort = parsePort(readArg('htk-server-port'));
const mockttpPort = parsePort(readArg('htk-mockttp-port'));

let deviceInfo: {} | undefined;
const preloadPromise = Promise.race([
    ipcInvoke('get-device-info').then(result => { deviceInfo = result; }),
    // Give up after 500ms - might complete later, but we don't want to block
    // 'API ready' for this info.
    new Promise((resolve) => setTimeout(resolve, 500))
]);

contextBridge.exposeInMainWorld('desktopApi', {
    waitUntilDesktopApiReady: () => preloadPromise.then(() => {}),

    getDesktopVersion: () => desktopVersion,
    getServerAuthToken: () => authToken,
    getDeviceInfo: () => deviceInfo,

    getServerPort: () => serverPort,
    getMockttpPort: () => mockttpPort,

    selectApplication: () =>
        ipcInvoke('select-application'),
    selectFilePath: () =>
        ipcInvoke('select-file-path'),
    selectSaveFilePath: () =>
        ipcInvoke('select-save-file-path'),

    openContextMenu: (options: ContextMenuDefinition) =>
        ipcInvoke('open-context-menu', options),

    restartApp: () =>
        ipcInvoke('restart-app'),

    setComponentVersions: (versions: Record<string, string>) =>
        ipcInvoke('set-component-versions', versions),

    getPathForFile: (file: File) => webUtils.getPathForFile(file) || null,

    // wirepane: "Show in Finder" for a saved packet capture. The main process only accepts files in the captures folder.
    showItemInFolder: (filePath: string) =>
        ipcInvoke('show-item-in-folder', filePath),

    // wirepane: menu bar clicks (app-action-menus.ts, whose channel name this repeats, as the
    // sandboxed preload can't import it). Returns a function that stops listening.
    onAppAction: (callback: (actionId: string, details: { triggeredByAccelerator: boolean }) => void) => {
        const listener = (_event: unknown, actionId: unknown, details?: { triggeredByAccelerator?: unknown }) => {
            if (typeof actionId !== 'string') return;
            callback(actionId, { triggeredByAccelerator: details?.triggeredByAccelerator === true });
        };
        electron.ipcRenderer.on('wirepane:app-action', listener);
        return () => { electron.ipcRenderer.removeListener('wirepane:app-action', listener); };
    }
});
