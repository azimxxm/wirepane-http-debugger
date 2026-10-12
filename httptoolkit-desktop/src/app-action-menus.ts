import type {
    BaseWindow,
    KeyboardEvent,
    MenuItemConstructorOptions,
    WebContents
} from 'electron';

/**
 * wirepane: the menu bar entries for the UI's app actions (httptoolkit-ui/src/model/ui/app-actions.ts).
 * A click sends the action's id to the window's UI over APP_ACTION_CHANNEL, and the UI runs it, so the
 * ids here must be ids from the UI's list. The UI also handles every shortcut shown here itself.
 */
export const APP_ACTION_CHANNEL = 'wirepane:app-action';

export const DOCS_URL = 'https://httptoolkit.com/docs';
// The same page as the feedback button at the bottom of the UI's rail:
export const REPORT_ISSUE_URL = 'https://github.com/azimxxm/wirepane-http-debugger/issues/new';

export interface AppActionDetails {
    // True for a shortcut press, false for a click. The UI drops a shortcut it already handled itself.
    triggeredByAccelerator: boolean;
}

export type AppActionSender = (
    actionId: string,
    details: AppActionDetails,
    focusedWindow: BaseWindow | undefined
) => void;

const actionItem = (
    send: AppActionSender,
    id: string,
    label: string,
    accelerator?: string
): MenuItemConstructorOptions => ({
    id,
    label,
    accelerator,
    // The page handles these shortcuts itself. On Windows & Linux the menu only shows them, so a key
    // press can't fire twice. macOS ignores this, but its menu only gets keys the page didn't handle.
    registerAccelerator: false,
    click: (_menuItem, focusedWindow, event: KeyboardEvent) => send(id, {
        triggeredByAccelerator: !!event?.triggeredByAccelerator
    }, focusedWindow)
});

// In the app menu on macOS, and in the File menu elsewhere:
export const buildSettingsItem = (send: AppActionSender): MenuItemConstructorOptions =>
    actionItem(send, 'go-settings', 'Settings…', 'CmdOrCtrl+,');

export const buildGoMenu = (send: AppActionSender): MenuItemConstructorOptions => ({
    label: '&Go',
    submenu: [
        actionItem(send, 'go-intercept', 'Intercept', 'CmdOrCtrl+1'),
        actionItem(send, 'go-view', 'View', 'CmdOrCtrl+2'),
        actionItem(send, 'go-modify', 'Modify', 'CmdOrCtrl+3'),
        actionItem(send, 'go-send', 'Send', 'CmdOrCtrl+4'),
        { type: 'separator' },
        actionItem(send, 'command-palette', 'Command Palette…', 'CmdOrCtrl+K')
    ]
});

export const buildCaptureMenu = (send: AppActionSender): MenuItemConstructorOptions => ({
    label: '&Capture',
    submenu: [
        actionItem(send, 'toggle-recording', 'Pause/Resume Recording', 'CmdOrCtrl+Shift+R'),
        actionItem(send, 'clear-traffic', 'Clear Traffic', 'CmdOrCtrl+Shift+Backspace'),
        { type: 'separator' },
        actionItem(send, 'copy-proxy-address', 'Copy Proxy Address'),
        { type: 'separator' },
        actionItem(send, 'import-har', 'Import HAR…', 'CmdOrCtrl+O'),
        actionItem(send, 'export-har', 'Export HAR…')
    ]
});

export const buildReportIssueItem = (
    openExternal: (url: string) => void
): MenuItemConstructorOptions => ({
    label: 'Report an Issue…',
    click: () => openExternal(REPORT_ISSUE_URL)
});

/**
 * Sends an action to a window's UI. A menu click is a user gesture, but the page doesn't see it, and
 * file pickers & clipboard writes need one. So the page gets a user activation first.
 */
export async function sendAppActionTo(
    contents: WebContents,
    actionId: string,
    details: AppActionDetails
): Promise<void> {
    if (contents.isDestroyed()) return;

    try {
        await contents.executeJavaScript('void 0', true);
    } catch {
        // The page isn't ready yet. Send the action anyway, it just can't open a file picker.
    }

    if (!contents.isDestroyed()) contents.send(APP_ACTION_CHANNEL, actionId, details);
}
