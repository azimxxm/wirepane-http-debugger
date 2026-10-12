import { isMac } from './ui';

/*
 * Wirepane: on macOS the desktop app hides the title bar (titleBarStyle 'hiddenInset' in
 * httptoolkit-desktop/src/index.ts), so the page runs up to the top of the window. The
 * toolbar along the top (components/app-toolbar.tsx) then works as the title bar: the
 * traffic lights sit at its left end, and the window is dragged (and double-click zoomed)
 * by its empty space.
 *
 * Only the desktop app has window.desktopApi; browsers and other platforms keep their own
 * title bar, so the toolbar is just a toolbar there.
 */
export const HAS_HIDDEN_TITLE_BAR = isMac && typeof window !== 'undefined' && !!window.desktopApi;

// The full-width toolbar at the top of every page, its 1px bottom divider included
export const TOOLBAR_HEIGHT = 52;

// The traffic lights are 14px buttons 9px apart (6px before macOS 26), placed at
// trafficLightPosition { x: 18, y: 19 } in httptoolkit-desktop/src/index.ts: that's x 18–78,
// centred 26px down, the middle of the toolbar. The toolbar's content starts after them.
export const TRAFFIC_LIGHTS_CLEARANCE = 92;

// Without traffic lights, the toolbar's mark sits centred over the 64px rail below it
export const TOOLBAR_INSET = 20;

export const TOOLBAR_LEADING_INSET = HAS_HIDDEN_TITLE_BAR
    ? TRAFFIC_LIGHTS_CLEARANCE
    : TOOLBAR_INSET;

// How much less room the toolbar has than in a browser. Width breakpoints for toolbar
// content add this, so it compacts at the same content width everywhere.
export const TOOLBAR_EXTRA_INSET = TOOLBAR_LEADING_INSET - TOOLBAR_INSET;
