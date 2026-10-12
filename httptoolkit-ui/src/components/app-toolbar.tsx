import * as React from 'react';
import { action, observable } from 'mobx';
import { observer } from 'mobx-react-lite';
import * as dedent from 'dedent';
import { MagnifyingGlass } from '@phosphor-icons/react';

import { styled, css } from '../styles';
import { formatShortcut, toAriaShortcut } from '../util/shortcuts';
import {
    HAS_HIDDEN_TITLE_BAR,
    TOOLBAR_EXTRA_INSET,
    TOOLBAR_HEIGHT,
    TOOLBAR_LEADING_INSET
} from '../util/window-chrome';
import { UI_VERSION, desktopVersion, serverVersion } from '../services/service-versions';
import { COMMAND_PALETTE_SHORTCUT } from '../model/ui/app-actions';
import { openCommandPalette } from '../model/ui/command-palette-state';

import { UnstyledButton } from './common/inputs';
import logo from '../images/logo-icon.svg';

// Below this window width (plus the traffic lights' extra room), the command field
// shrinks to its search icon.
export const COMPACT_COMMAND_FIELD_BELOW = 1100;

/**
 * Where the current page shows its title and actions. Pages fill them through PageHeader
 * (components/common/page-header.tsx), which renders into these elements with portals.
 */
export const toolbarSlots = observable({
    title: null as HTMLElement | null,
    actions: null as HTMLElement | null
}, {
    title: observable.ref,
    actions: observable.ref
});

const setTitleSlot = action((element: HTMLElement | null) => { toolbarSlots.title = element; });
const setActionsSlot = action((element: HTMLElement | null) => { toolbarSlots.actions = element; });

const ToolbarRoot = styled.header`
    flex-shrink: 0;
    box-sizing: border-box;
    height: ${TOOLBAR_HEIGHT}px;
    padding: 0 16px 0 ${TOOLBAR_LEADING_INSET}px;

    /* Above the rail and the page, so popups that start here (View's filter suggestions)
       drop down over them */
    position: relative;
    z-index: 10;

    display: flex;
    align-items: center;

    background-color: ${p => p.theme.mainBackground};
    border-bottom: 1px solid ${p => p.theme.containerBorder};
    color: ${p => p.theme.mainColor};

    user-select: none;
    cursor: default;

    /* With no title bar (the macOS desktop app) this is the title bar: its empty space
       drags the window, and double-clicking it zooms (macOS does that for drag regions).
       Everything that takes a click opts out. */
    ${HAS_HIDDEN_TITLE_BAR && css`
        -webkit-app-region: drag;

        button, a, input, select, textarea, label, [role='button'], [tabindex]:not([tabindex='-1']) {
            -webkit-app-region: no-drag;
        }
    `}
`;

const ToolbarMark = styled.img.attrs(() => ({
    src: logo,
    alt: 'Wirepane'
}))`
    flex-shrink: 0;
    display: block;
    width: 24px;
    height: 24px;
    margin-right: 12px;
    -webkit-user-drag: none;
`;

// The page's title & purpose. It gives way first when the window gets narrow.
const TitleSlot = styled.div`
    flex: 0 100 auto;
    min-width: 120px;
    display: flex;
`;

const FlexibleSpace = styled.div`
    flex: 1 1 0;
    min-width: 16px;
`;

// In the field's own text colour, so it reads on the field in every theme
const KeyCap = styled.kbd`
    flex-shrink: 0;
    padding: 0 5px;
    border-radius: 4px;

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 500;
    line-height: 16px;
    color: inherit;

    border: 1px solid ${p => p.theme.containerBorder};
`;

const compactCommandField = css`
    flex: 0 0 auto;
    width: 38px;
    min-width: 0;
    padding: 0;
    justify-content: center;

    /* Like the secondary toolbar buttons next to it */
    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    .command-field-label, .command-field-key {
        display: none;
    }
`;

// Looks like a search field, but it's a button: it opens the ⌘K palette, which does the
// searching. Typing into it opens the palette with what was typed.
const CommandField = styled(UnstyledButton)`
    flex: 0 1 280px;
    min-width: 180px;
    height: 28px;
    padding: 0 5px 0 9px;
    border-radius: 6px;
    border: 1px solid ${p => p.theme.inputBorder};

    display: flex;
    align-items: center;
    gap: 8px;

    background-color: ${p => p.theme.inputBackground};
    color: ${p => p.theme.inputPlaceholderColor};
    font-size: ${p => p.theme.textInputFontSize};
    text-align: left;
    white-space: nowrap;

    transition: background-color 0.12s, color 0.12s;

    &:hover {
        background-color: ${p => p.theme.inputHoverBackground};
    }

    > svg {
        flex-shrink: 0;
    }

    .command-field-label {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
    }

    @media (max-width: ${COMPACT_COMMAND_FIELD_BELOW + TOOLBAR_EXTRA_INSET - 1}px) {
        ${compactCommandField}
    }
`;

// Where the page's actions go. Hidden on pages without any, so the field moves right up.
const ActionsSlot = styled.div`
    flex: 0 1 auto;
    min-width: 0;
    height: 100%;
    margin-left: 12px;
    display: flex;

    &:empty {
        display: none;
    }
`;

const isTypedCharacter = (event: React.KeyboardEvent) =>
    event.key.length === 1 &&
    event.key !== ' ' && // Space presses the button, as usual
    !event.metaKey && !event.ctrlKey && !event.altKey &&
    !event.nativeEvent.isComposing;

const CommandSearchField = () => {
    const shortcut = formatShortcut(COMMAND_PALETTE_SHORTCUT);

    return <CommandField
        aria-label='Search or run a command'
        aria-haspopup='dialog'
        aria-keyshortcuts={toAriaShortcut(COMMAND_PALETTE_SHORTCUT)}
        title={`Search pages and commands (${shortcut})`}
        onClick={() => openCommandPalette()}
        onKeyDown={(event) => {
            if (!isTypedCharacter(event)) return;
            event.preventDefault();
            openCommandPalette(event.key);
        }}
    >
        <MagnifyingGlass size={16} aria-hidden={true} />
        <span className='command-field-label'>Search or run a command</span>
        <KeyCap className='command-field-key' aria-hidden={true}>{ shortcut }</KeyCap>
    </CommandField>;
};

// The mark, with the versions of each part in its tooltip (as the rail's logo had)
const Mark = observer(() => <ToolbarMark title={dedent`
    UI version: ${UI_VERSION.slice(0, 8)}
    Desktop version: ${
        desktopVersion.state === 'fulfilled'
            ? desktopVersion.value
            : 'Unknown'
    }
    Server version: ${
        serverVersion.state === 'fulfilled'
            ? serverVersion.value
            : 'Unknown'
    }
`} />);

/**
 * The unified toolbar along the top of the window, like Mail's or Proxyman's: the
 * Wirepane mark, the page's title with its purpose underneath, a field that opens the ⌘K
 * palette, and the page's own actions. On macOS it's the title bar too.
 */
export const AppToolbar = () => <ToolbarRoot aria-label='Toolbar'>
    <Mark />
    <TitleSlot ref={setTitleSlot} />
    <FlexibleSpace />
    <CommandSearchField />
    <ActionsSlot ref={setActionsSlot} />
</ToolbarRoot>;
