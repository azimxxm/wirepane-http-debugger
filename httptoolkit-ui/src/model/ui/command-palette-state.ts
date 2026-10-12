import { action, observable } from 'mobx';

// Whether the ⌘K palette is open, and the text its search starts with. AppActionsHost shows
// it, and anything can open it, like the toolbar's "Search or run a command" field.
export const commandPaletteState = observable({ isOpen: false, initialQuery: '' });

// Opens the palette, optionally with some text already typed into its search
export const openCommandPalette = action((initialQuery?: string) => {
    // Never an event object, when this is used as an event handler directly
    commandPaletteState.initialQuery = typeof initialQuery === 'string' ? initialQuery : '';
    commandPaletteState.isOpen = true;
});

export const closeCommandPalette = action(() => {
    commandPaletteState.isOpen = false;
});

export const toggleCommandPalette = action(() => {
    if (!commandPaletteState.isOpen) commandPaletteState.initialQuery = '';
    commandPaletteState.isOpen = !commandPaletteState.isOpen;
});
