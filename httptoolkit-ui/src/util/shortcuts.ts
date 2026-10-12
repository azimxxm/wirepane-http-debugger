import { isMac } from './ui';

// Display names for shortcut keys: macOS symbols, or plain names elsewhere.
const MAC_KEY_SYMBOLS: { [key: string]: string } = {
    'Cmd': '⌘',
    'Ctrl': '⌃',
    'Shift': '⇧',
    'Alt': '⌥',
    'Backspace': '⌫',
    'Enter': '↵',
    'Tab': '⇥'
};

const OTHER_KEY_NAMES: { [key: string]: string } = {
    'Cmd': 'Ctrl'
};

/**
 * Formats a shortcut like 'Cmd+Shift+R' for display: '⌘⇧R' on macOS and
 * 'Ctrl+Shift+R' elsewhere. 'Cmd' always means the platform's main modifier.
 */
export function formatShortcut(shortcut: string, mac: boolean = isMac): string {
    const keys = shortcut.split('+');

    if (mac) {
        return keys.map((key) => MAC_KEY_SYMBOLS[key] ?? key.toUpperCase()).join('');
    } else {
        return keys.map((key) => OTHER_KEY_NAMES[key] ?? (key.length === 1 ? key.toUpperCase() : key)).join('+');
    }
}

/**
 * Formats a shortcut for Electron menu accelerators, e.g. 'Cmd+Backspace' becomes
 * 'CmdOrCtrl+Backspace'.
 */
export function toAccelerator(shortcut: string): string {
    return shortcut.split('+').map((key) => key === 'Cmd' ? 'CmdOrCtrl' : key).join('+');
}

/**
 * Formats a shortcut for aria-keyshortcuts, e.g. 'Cmd+M' becomes 'Meta+M' on macOS
 * and 'Control+M' elsewhere.
 */
export function toAriaShortcut(shortcut: string, mac: boolean = isMac): string {
    return shortcut.split('+').map((key) =>
        key === 'Cmd' ? (mac ? 'Meta' : 'Control') : key
    ).join('+');
}

// Electron's names for modifier keys, as our shortcut format writes them:
const ACCELERATOR_MODIFIERS: { [key: string]: string } = {
    'CmdOrCtrl': 'Cmd',
    'CommandOrControl': 'Cmd',
    'Command': 'Cmd',
    'Control': 'Ctrl',
    'Option': 'Alt'
};

/**
 * Formats an Electron accelerator like 'CmdOrCtrl+Shift+S' for display, the same way
 * as formatShortcut: '⌘⇧S' on macOS and 'Ctrl+Shift+S' elsewhere.
 */
export function formatAccelerator(accelerator: string, mac: boolean = isMac): string {
    const shortcut = accelerator.split('+')
        .map((key) => ACCELERATOR_MODIFIERS[key] ?? key)
        .join('+');
    return formatShortcut(shortcut, mac);
}

/**
 * The react-hotkeys-hook keys for a shortcut: 'Cmd+K' listens for ⌘K on macOS and
 * Ctrl+K elsewhere, so it never takes over a text field's Ctrl+K on macOS.
 */
export function toHotkeys(shortcut: string, mac: boolean = isMac): string {
    return shortcut.split('+').map((key) =>
        key === 'Cmd' ? (mac ? 'Cmd' : 'Ctrl') : key
    ).join('+');
}
