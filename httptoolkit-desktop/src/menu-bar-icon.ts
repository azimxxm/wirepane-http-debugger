import * as path from 'path';
import { app, BrowserWindow, Menu, Tray, nativeImage } from 'electron';

// The Wirepane icon in the macOS menu bar. It's kept in this module because Electron removes a
// tray icon from the menu bar once it's garbage collected.
let menuBarIcon: Tray | undefined;

// A "Template" image (see brand/tray-template.svg): macOS draws it in the menu bar's own colour
const ICON_PATH = path.join(import.meta.dirname, '..', 'src', 'icons', 'trayTemplate.png');

function showWindow(windows: BrowserWindow[], openNewWindow: () => void) {
    const window = windows[windows.length - 1];
    if (!window) {
        openNewWindow();
        return;
    }

    if (window.isMinimized()) window.restore();
    window.show();
    app.focus({ steal: true });
    window.focus();
}

export function createMenuBarIcon(windows: BrowserWindow[], openNewWindow: () => void) {
    if (process.platform !== 'darwin' || menuBarIcon) return;

    const icon = nativeImage.createFromPath(ICON_PATH);
    if (icon.isEmpty()) {
        console.warn(`Menu bar icon not found at ${ICON_PATH}`);
        return;
    }
    icon.setTemplateImage(true);

    menuBarIcon = new Tray(icon);
    menuBarIcon.setToolTip('Wirepane');
    menuBarIcon.setContextMenu(Menu.buildFromTemplate([
        { label: 'Show Wirepane', click: () => showWindow(windows, openNewWindow) },
        { label: 'New Window', click: () => openNewWindow() },
        { type: 'separator' },
        { label: 'Quit Wirepane', role: 'quit' }
    ]));
}
