import { action, observable } from 'mobx';

// Whether the ⌘K palette is open. AppActionsHost shows it, and anything can open it, like
// the status bar's "⌘K Commands" button.
export const commandPaletteState = observable({ isOpen: false });

export const openCommandPalette = action(() => {
    commandPaletteState.isOpen = true;
});

export const closeCommandPalette = action(() => {
    commandPaletteState.isOpen = false;
});

export const toggleCommandPalette = action(() => {
    commandPaletteState.isOpen = !commandPaletteState.isOpen;
});
