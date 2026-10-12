import * as path from 'path';
import { app, BrowserWindow, Menu, MenuItemConstructorOptions, shell } from 'electron';
import ElectronStore from 'electron-store';

import {
    AppActionSender,
    buildCaptureMenu,
    buildGoMenu,
    buildReportIssueItem,
    buildSettingsItem,
    sendAppActionTo
} from './app-action-menus.ts';

const store = new ElectronStore();
const AUTO_HIDE_SETTING_KEY = "autoHideMenuBar";

export const shouldAutoHideMenu = () => !!store.get(AUTO_HIDE_SETTING_KEY);

type MenuKey =
    | 'mac'
    | 'file'
    | 'edit'
    | 'view'
    | 'go' // wirepane
    | 'capture' // wirepane
    | 'window'
    | 'help';

// wirepane: menu bar actions go to the focused window's UI, or the newest window when none has focus
const getAppActionSender = (browserWindows: Electron.BrowserWindow[]): AppActionSender =>
    (actionId, details, focusedWindow) => {
        const target = (focusedWindow && BrowserWindow.fromId(focusedWindow.id))
            || BrowserWindow.getFocusedWindow()
            || browserWindows[browserWindows.length - 1];
        if (target) sendAppActionTo(target.webContents, actionId, details);
    };

const getVersionMenuItems = (
    versions?: Record<string, string>
): MenuItemConstructorOptions[] => {
    if (!versions || Object.keys(versions).length === 0) return [];

    return [
        { type: 'separator' },
        ...Object.entries(versions).map(([name, version]) => ({
            label: `${name}: ${version}`,
            enabled: false
        }))
    ];
};

export const getMenu = (
    browserWindows: Electron.BrowserWindow[],
    openNewWindow: () => void,
    componentVersions?: Record<string, string>
) => {
    const sendAppAction = getAppActionSender(browserWindows); // wirepane

    const menuTemplate: { [key in MenuKey]?: MenuItemConstructorOptions } = {
        edit: {
            label: '&Edit',
            submenu: [
                { role: 'undo' },
                { role: 'redo' },
                { type: 'separator' },
                { role: 'cut', registerAccelerator: false },
                { role: 'copy', registerAccelerator: false },
                { role: 'paste', registerAccelerator: false },
                { role: 'pasteAndMatchStyle', registerAccelerator: false },
                { role: 'delete' }
            ]
        },
        view: {
            label: '&View',
            submenu: [
                { role: 'resetZoom' },
                { role: 'zoomIn' },
                { role: 'zoomOut' },
                { type: 'separator' },
                { role: 'togglefullscreen' },
                { type: 'separator' },
                // Reload shortcuts disabled because they're rarely used and very easy to hit accidentally when debugging
                // traffic in a web browser at the same time
                { role: 'reload', accelerator: '' },
                { role: 'forceReload', accelerator: '' },
                { role: 'toggleDevTools' }
            ]
        },
        go: buildGoMenu(sendAppAction), // wirepane
        capture: buildCaptureMenu(sendAppAction), // wirepane
        help: {
            label: '&Help',
            role: 'help',
            submenu: [
                {
                    label: 'Open Documentation',
                    click () { shell.openExternal('https://httptoolkit.com/docs') }
                },
                buildReportIssueItem((url) => shell.openExternal(url)), // wirepane: our own issues page
                {
                    label: 'View Wirepane Logs',
                    click () { shell.showItemInFolder(path.join(app.getPath('logs'), 'last-run.log')) }
                },
                ...getVersionMenuItems(componentVersions)
            ]
        }
    };

    if (process.platform === 'darwin') {
        menuTemplate.mac = {
            label: app.getName(),
            submenu: [
                { role: 'about', label: 'About Wirepane' }, // wirepane: not the package name
                { type: 'separator' },
                buildSettingsItem(sendAppAction), // wirepane
                { type: 'separator' },
                { role: 'services' },
                { type: 'separator' },
                { role: 'hide', label: 'Hide Wirepane' }, // wirepane
                { role: 'hideOthers' },
                { role: 'unhide' },
                { type: 'separator' },
                { role: 'quit', label: 'Quit Wirepane' } // wirepane
            ]
        };

        menuTemplate.file = {
            label: '&File',
            submenu: [
                {
                    label: 'New Session',
                    accelerator: 'CommandOrControl+Shift+N',
                    click: openNewWindow
                },
                {
                    role: 'close',
                    accelerator: 'CommandOrControl+Shift+W',
                    label: 'Close Session'
                }
            ]
        };

        // Add to Edit menu
        (menuTemplate.edit!.submenu as MenuItemConstructorOptions[]).push(
            { type: 'separator' },
            {
                label: 'Speech',
                submenu: [
                    { role: 'startSpeaking' },
                    { role: 'stopSpeaking' }
                ]
            }
        );

        // Mac apps usually have a 'window' menu
        menuTemplate.window = {
            label: '&Window',
            submenu: [
                { role: 'minimize' },
                { role: 'zoom' },
                { type: 'separator' },
                { role: 'front' }
            ]
        };
    } else {
        menuTemplate.file = {
            label: '&File',
            submenu: [
                {
                    label: 'New Session',
                    accelerator: 'CommandOrControl+Shift+N',
                    click: openNewWindow
                },
                { type: 'separator' }, // wirepane
                buildSettingsItem(sendAppAction), // wirepane
                { type: 'separator' }, // wirepane
                {
                    // This should close the Window, but look like Quit. End behaviour is that every
                    // Window _acts_ like a separate process, but is really just a separate window.
                    // (This lets us easily share a single server instance)
                    role: 'close',
                    label: 'Quit',
                    accelerator: 'CommandOrControl+Q'
                }
            ]
        };

        // On Windows & Linux, it's possible to autohide the menu bar:
        (menuTemplate.view!.submenu as MenuItemConstructorOptions[]).push({
            type: 'checkbox',
            label: 'Autohide Menu Bar',
            sublabel: 'Reveal with Alt',
            checked: shouldAutoHideMenu(),
            click: (event) => {
                const shouldAutoHide = event.checked || false;
                browserWindows.forEach((window) => {
                    window.setAutoHideMenuBar(shouldAutoHide);
                    window.setMenuBarVisibility(!shouldAutoHide);
                });
                store.set({ [AUTO_HIDE_SETTING_KEY]: shouldAutoHide });
            }
        })
    }

    return Menu.buildFromTemplate([
        menuTemplate.mac,
        menuTemplate.file,
        menuTemplate.edit,
        menuTemplate.view,
        menuTemplate.go, // wirepane
        menuTemplate.capture, // wirepane
        menuTemplate.window,
        menuTemplate.help
    ].filter(Boolean) as MenuItemConstructorOptions[]);
}
