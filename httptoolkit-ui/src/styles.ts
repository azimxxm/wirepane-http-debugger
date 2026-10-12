import * as styledComponents from 'styled-components';
import * as polished from 'polished';
import type { ThemeProps } from 'styled-components';
import type * as monacoTypes from 'monaco-editor';

import { generateHexColors, buildHexTokenRules } from './util/hex-colors';

// Real weights, so bold and italic text is never synthesized by the browser:
import "@fontsource/dm-sans/400.css";
import "@fontsource/dm-sans/500.css";
import "@fontsource/dm-sans/600.css";
import "@fontsource/dm-sans/700.css";
import "@fontsource/dm-sans/400-italic.css";
import "@fontsource/dm-mono/400.css";
import "@fontsource/dm-mono/500.css";

import reset from 'styled-reset';

// Desktop type scale: 11px rail labels & badges, 12px captions & column headers,
// 13px inputs & buttons, 14px body text & list rows, 15px page titles in the window
// toolbar, 16px card titles, 22px headings.
const fontSizes = {
    tinyTextSize: '11px',
    smallPrintSize: '12px',
    textInputFontSize: '13px',
    textSize: '14px',
    toolbarTitleSize: '15px',
    subHeadingSize: '16px',
    headingSize: '16px',
    largeHeadingSize: '22px',
    loudHeadingSize: '22px',
    screamingHeadingSize: '22px'
};
import "react-contexify/dist/ReactContexify.css";

export const NARROW_LAYOUT_BREAKPOINT = 1100;

// An amber that reads on light and dark surfaces, for the few places with no theme
// access (static icon HTML, pill base colours). Themed code uses theme.warningColor.
export const warningColor = '#D97706';

const black = "#000000";
const white = "#FFFFFF";
const darkGrey = "#32343B";
const mediumGrey = "#818490";

// The Wirepane palette (docs/design-plan.md): navy chrome, teal for action and
// selection, sky for keyboard focus, and green/amber/red/sky only for HTTP outcomes.
// Text colours are AA-checked against every surface they're used on.
const brandNavy700 = '#1B2C4B';
const brandNavy900 = '#0A1222';
const brandTeal = '#2DD4BF';
const brandSky = '#38BDF8';

const gradientWire = `linear-gradient(90deg, ${brandTeal}, ${brandSky})`; // Decoration only, never behind text
const gradientWireVertical = `linear-gradient(180deg, ${brandTeal}, ${brandSky})`; // The same wire, for vertical bars
const gradientTile = `linear-gradient(160deg, ${brandNavy700}, ${brandNavy900})`;
const navyBackdrop = `radial-gradient(${brandNavy700}, ${brandNavy900})`; // The logo tile, behind modals

const light = {
    canvas: '#F4F7FB',
    surface: '#FFFFFF',
    surfaceRaised: '#FFFFFF',
    surfaceSunken: '#EEF2F7',
    borderSubtle: '#D5DDE8',
    borderControl: '#78869B',
    textPrimary: '#0F1B2D',
    textSecondary: '#475569',
    textTertiary: '#5E6B7E',
    accent: '#0F766E',
    accentHover: '#115E59',
    textOnAccent: '#FFFFFF',
    focusRing: '#0284C7',
    rowHover: '#F1F5F9',
    selectionInactive: '#E8EDF3',
    success: '#157238',
    warning: '#9A4A07',
    error: '#B91C1C',
    info: '#0369A1'
} as const;

const dark = {
    canvas: '#0B1220',
    surface: '#111B2E',
    surfaceRaised: '#18253C',
    surfaceSunken: '#0D1626',
    borderSubtle: '#22314A',
    borderControl: '#5F7088',
    textPrimary: '#E6EDF7',
    textSecondary: '#A9B6C9',
    textTertiary: '#94A3B8',
    accent: '#2DD4BF',
    accentHover: '#5EEAD4',
    textOnAccent: '#042F2E',
    focusRing: '#38BDF8',
    rowHover: '#16233A',
    selectionInactive: '#22314A',
    success: '#4ADE80',
    warning: '#FBBF24',
    error: '#FB8585',
    info: '#7DD3FC'
} as const;

// The navy rail is the same in light & dark: the logo tile, with the dark theme's
// secondary text for idle items (at least 6.8:1 on the navy) and white when active.
const navyRail = {
    railBackground: gradientTile,
    railColor: dark.textSecondary,
    railActiveColor: white,
    railActiveBackground: polished.rgba(brandTeal, 0.14),
    railHoverBackground: polished.rgba(white, 0.06),
    railEdge: polished.rgba(white, 0.08), // Keeps the rail distinct from dark page backgrounds
    railFocusRing: dark.focusRing
} as const;

// Request method & 1xx status text colours, for list rows and tabs:
const lightHttpColors = {
    methodGet: '#0F766E',
    methodPost: '#0369A1',
    methodPut: '#6D28D9', // PUT & PATCH
    methodDelete: '#B91C1C',
    methodOther: '#475569', // HEAD, OPTIONS, CONNECT & anything else
    statusNeutral: '#475569' // 1xx
} as const;

const darkHttpColors = {
    methodGet: '#5EEAD4',
    methodPost: '#7DD3FC',
    methodPut: '#C4B5FD',
    methodDelete: '#FCA5A5',
    methodOther: '#94A3B8',
    statusNeutral: '#94A3B8'
} as const;

// The focused list selection: the same deep teal in light & dark, with white text:
const selectionTeal = '#0F766E';

// The neutral base colour for pills that don't set their own:
const pillGrey = '#94A3B8';

const globalMonacoOverrides = {
    'editorWarning.foreground': '#ff0000'
};

export const lightTheme = {
    fontFamily: '"DM Sans", Arial, sans-serif',
    titleTextFamily: '"DM Sans", Arial, sans-serif',
    monoFontFamily: '"DM Mono", monospace',

    mainBackground: light.surface,
    mainLowlightBackground: light.surfaceSunken,
    mainColor: light.textPrimary,
    mainLowlightColor: light.textSecondary,

    highlightBackground: light.surfaceRaised,
    highlightColor: light.textPrimary,

    lowlightTextOpacity: 0.65,
    boxShadowAlpha: 0.15,

    pillContrast: 0.9,
    pillDefaultColor: pillGrey,

    primaryInputBackground: light.accent,
    primaryInputColor: light.textOnAccent,

    secondaryInputBorder: light.borderControl,
    secondaryInputColor: light.textPrimary,

    inputBackground: light.surface,
    inputHoverBackground: light.rowHover,
    inputBorder: light.borderControl,
    inputColor: light.textPrimary,
    inputPlaceholderColor: light.textTertiary,
    inputWarningPlaceholder: light.warning, // Readable on warningBackground

    popColor: light.accent,
    popOverlayColor: light.textOnAccent,

    warningColor: '#B45309', // Icons & borders. Warning text uses `warning`.
    warningBackground: '#FEF3C7FF', // Always #RRGGBBAA: the contrast tests read its alpha

    containerBackground: light.canvas,
    containerWatermark: light.textTertiary,
    containerBorder: light.borderSubtle,

    linkColor: light.accent,
    visitedLinkColor: light.accent,

    editorBackground: '#ffffff', // Monaco 'vs' theme default
    hexColorMinContrast: 4.6, // WCAG AA (4.5) + margin for float rounding

    monacoTheme: 'vs-custom',
    monacoThemeBase: 'vs',
    monacoThemeOverrides: globalMonacoOverrides,

    modalGradient: navyBackdrop,
    modalColor: light.surfaceRaised,

    // Wirepane tokens with no upstream equivalent:
    accentHover: light.accentHover,
    focusRing: light.focusRing,
    rowHover: light.rowHover,
    selectionBackground: selectionTeal,
    selectionColor: '#FFFFFF',
    selectionInactiveBackground: light.selectionInactive,
    selectionInactiveBar: light.borderControl,
    floatingShadow: '0 8px 24px rgba(10, 18, 34, 0.18)', // Menus & modals only

    success: light.success,
    warning: light.warning,
    error: light.error,
    info: light.info,
    ...lightHttpColors,
    ...navyRail,

    gradientWire,
    gradientWireVertical,
    gradientTile,

    ...fontSizes,

    globalCss: ''
} as const;

export const darkTheme = {
    fontFamily: '"DM Sans", Arial, sans-serif',
    titleTextFamily: '"DM Sans", Arial, sans-serif',
    monoFontFamily: '"DM Mono", monospace',

    mainBackground: dark.surface,
    mainLowlightBackground: dark.surfaceSunken,
    mainColor: dark.textPrimary,
    mainLowlightColor: dark.textSecondary,

    highlightBackground: dark.surfaceRaised,
    highlightColor: dark.textPrimary,

    lowlightTextOpacity: 0.65,
    boxShadowAlpha: 0.3,

    pillContrast: 0.85,
    pillDefaultColor: pillGrey,

    primaryInputBackground: dark.accent,
    primaryInputColor: dark.textOnAccent,

    secondaryInputBorder: dark.borderControl,
    secondaryInputColor: dark.textPrimary,

    inputBackground: dark.surfaceSunken,
    inputHoverBackground: dark.rowHover,
    inputBorder: dark.borderControl,
    inputColor: dark.textPrimary,
    inputPlaceholderColor: dark.textTertiary,
    inputWarningPlaceholder: dark.warning, // Readable on warningBackground

    popColor: dark.accent,
    popOverlayColor: dark.textOnAccent,

    warningColor: dark.warning,
    warningBackground: '#FBBF2424',
    containerBackground: dark.canvas,
    containerWatermark: dark.textTertiary,
    containerBorder: dark.borderSubtle,

    linkColor: dark.accent,
    visitedLinkColor: dark.accent,

    editorBackground: dark.surfaceSunken, // Matches editor.background override below
    hexColorMinContrast: 4.6, // WCAG AA (4.5) + margin for float rounding

    monacoTheme: 'vs-dark-custom',
    monacoThemeBase: 'vs-dark',
    monacoThemeOverrides: {
        ...globalMonacoOverrides,
        'editor.background': dark.surfaceSunken // Same as input background - sunken below the card surface
    },

    modalGradient: navyBackdrop,
    modalColor: dark.surfaceRaised,

    // Wirepane tokens with no upstream equivalent:
    accentHover: dark.accentHover,
    focusRing: dark.focusRing,
    rowHover: dark.rowHover,
    selectionBackground: selectionTeal,
    selectionColor: '#FFFFFF',
    selectionInactiveBackground: dark.selectionInactive,
    selectionInactiveBar: dark.borderControl,
    floatingShadow: '0 8px 24px rgba(0, 0, 0, 0.5)', // Menus & modals only

    success: dark.success,
    warning: dark.warning,
    error: dark.error,
    info: dark.info,
    ...darkHttpColors,
    ...navyRail,

    gradientWire,
    gradientWireVertical,
    gradientTile,

    ...fontSizes,

    /* In dark theme, we need to override the scrollbars or they stick out like a sore thumb */
    globalCss: styledComponents.css`
        @supports (color-scheme: dark) {
            :root {
                color-scheme: dark;
            }
        }

        @supports not (color-scheme: dark) {
            ::-webkit-scrollbar {
                background-color: ${p => polished.darken(0.2, p.theme.containerBackground)};
            }

            ::-webkit-scrollbar-thumb {
                background-color: ${p => polished.lighten(0.2, p.theme.containerBackground)};
            }

            /* Standard, but poorly supported: */
            scrollbar-color: dark;
        }
    `
} as const;

// Keeps its own black & white surfaces, but takes the dark theme's accent, focus and
// status colours, which are all at least 7:1 on black.
export const highContrastTheme = {
    fontFamily: '"DM Sans", Arial, sans-serif',
    titleTextFamily: '"DM Sans", Arial, sans-serif',
    monoFontFamily: '"DM Mono", monospace',

    mainBackground: '#000000',
    mainLowlightBackground: '#262626',
    mainColor: '#ffffff',
    mainLowlightColor: '#ffffff',

    highlightBackground: '#ffffff',
    highlightColor: '#000',

    lowlightTextOpacity: 0.8,
    boxShadowAlpha: 0.1,

    pillContrast: 0.95,
    pillDefaultColor: mediumGrey,

    primaryInputBackground: dark.accent,
    primaryInputColor: dark.textOnAccent,

    secondaryInputBorder: '#ffffff',
    secondaryInputColor: '#ffffff',

    inputBackground: '#ffffff',
    inputHoverBackground: '#ddd',
    inputBorder: '#aaa',
    inputColor: '#000000',
    inputPlaceholderColor: '#444',
    inputWarningPlaceholder: dark.warning, // Invalid inputs show warningBackground over black

    popColor: dark.accent,
    popOverlayColor: dark.textOnAccent,

    warningColor: dark.warning,
    warningBackground: '#FBBF2424',

    containerBackground: darkGrey,
    containerWatermark: '#a0a0b0',
    containerBorder: '#000000',

    linkColor: dark.accent,
    visitedLinkColor: dark.accent,

    editorBackground: '#000000', // Monaco 'hc-black' theme default
    hexColorMinContrast: 7.5, // WCAG AAA (7) + margin for float rounding

    monacoTheme: 'hc-black-custom',
    monacoThemeBase: 'hc-black',
    monacoThemeOverrides: globalMonacoOverrides,

    modalGradient: '#f0f0f0',
    modalColor: black,

    // Wirepane tokens with no upstream equivalent:
    accentHover: dark.accentHover,
    focusRing: dark.focusRing,
    rowHover: '#1a1a1a',
    selectionBackground: '#ffffff',
    selectionColor: '#000000',
    selectionInactiveBackground: '#262626',
    selectionInactiveBar: '#ffffff',
    floatingShadow: '0 8px 24px rgba(0, 0, 0, 0.5)', // Menus & modals only

    success: dark.success,
    warning: dark.warning,
    error: dark.error,
    info: dark.info,
    ...darkHttpColors,

    // A black rail with white labels, keeping the teal active marker:
    railBackground: black,
    railColor: white,
    railActiveColor: white,
    railActiveBackground: navyRail.railActiveBackground,
    railHoverBackground: polished.rgba(white, 0.12),
    railEdge: polished.rgba(white, 0.4),
    railFocusRing: dark.focusRing,

    gradientWire,
    gradientWireVertical,
    gradientTile,

    ...fontSizes,

    globalCss: ``
} as const;

export const Themes = {
    'light': lightTheme,
    'dark': darkTheme,
    'high-contrast': highContrastTheme
};

export type ThemeName = keyof typeof Themes;
export type Theme = typeof Themes[ThemeName];

export function defineMonacoThemes(monaco: typeof monacoTypes) {
    Object.values(Themes).forEach((theme) => {
        const hexColors = generateHexColors(theme.editorBackground, theme.hexColorMinContrast);
        const hexRules = buildHexTokenRules(hexColors);

        monaco.editor.defineTheme(theme.monacoTheme, {
            base: theme.monacoThemeBase,
            inherit: true,
            rules: hexRules,
            colors: theme.monacoThemeOverrides
        });
    });
}

const {
    default: styled,
    css,
    createGlobalStyle,
    keyframes,
    ThemeProvider,
    StyleSheetManager
} = styledComponents as unknown as styledComponents.ThemedStyledComponentsModule<Theme>;

export {
    styled,
    css,
    createGlobalStyle,
    keyframes,
    ThemeProvider,
    type ThemeProps,
    StyleSheetManager
};

export const GlobalStyles = createGlobalStyle`
    ${reset};

    * {
        box-sizing: border-box;
    }

    body {
        font-family: ${p => p.theme.fontFamily};
        font-size: ${p => p.theme.textSize};
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.containerBackground};
    }

    /* Theme colours for values that can only be a colour string, like client icon colours */
    :root {
        --wp-text-primary: ${p => p.theme.mainColor};
        --wp-text-secondary: ${p => p.theme.mainLowlightColor};
        --wp-text-tertiary: ${p => p.theme.containerWatermark};
    }

    input {
        font-family: ${p => p.theme.fontFamily};
    }

    em {
        font-style: italic;
    }

    strong {
        font-weight: bold;
    }

    :active:not(:focus-visible) {
        outline: none;
    }

    /* Keyboard focus is always visible as a sky ring. Mouse clicks don't show it. */
    :focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: 2px;
    }

    .slow-spin {
        animation: fa-spin 5s infinite linear;
    }

    /* Override some Monaco CSS internals */
    .monaco-editor {
        /* Our editors don't have real filenames, so hide that from error popups: */
        .zone-widget .filename {
            display: none;
        }
    }

    .phosphor-icon {
        /* Ensures icons line up with FontAwesome & neighbouring text */
        vertical-align: -0.125em;
    }

    ${p => p.theme.globalCss}
`;