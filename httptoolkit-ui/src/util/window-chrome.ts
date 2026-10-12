import { isMac } from './ui';

/*
 * Wirepane: on macOS the desktop app hides the title bar (titleBarStyle 'hiddenInset' in
 * httptoolkit-desktop/src/index.ts), so the page runs up to the top of the window. The
 * traffic lights then sit over the top of the rail, which leaves room for them, and the
 * rail's top & the page headers are where the window can be dragged from.
 *
 * Only the desktop app has window.desktopApi; browsers and other platforms are unchanged.
 */
export const HAS_HIDDEN_TITLE_BAR = isMac && typeof window !== 'undefined' && !!window.desktopApi;

// Room for the traffic lights above the rail's logo: they're placed at y=12 and ~14px tall
export const TRAFFIC_LIGHTS_INSET = 22;
