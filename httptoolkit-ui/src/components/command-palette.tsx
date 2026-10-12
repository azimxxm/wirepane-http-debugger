import * as React from 'react';
import { observer } from 'mobx-react-lite';
import {
    type Icon,
    AndroidLogo,
    BookOpen,
    ChatText,
    Copy,
    DeviceMobile,
    DownloadSimple,
    GearSix,
    MagnifyingGlass,
    PaperPlaneTilt,
    Pencil,
    Plugs,
    Plus,
    PushPin,
    Record,
    Rows,
    SidebarSimple,
    Sparkle,
    TerminalWindow,
    Trash,
    UploadSimple
} from '@phosphor-icons/react';

import { styled } from '../styles';
import { formatShortcut, toAriaShortcut } from '../util/shortcuts';

import { AppAction, AppActionId, APP_ACTION_SECTIONS } from '../model/ui/app-actions';
import { CommandMatch, searchCommands } from '../model/ui/command-search';

import { AppModal } from './common/modal';

const ACTION_ICONS: { [id in AppActionId]?: Icon } = {
    'request-mock-response': Pencil,
    'request-resend': PaperPlaneTilt,
    'request-copy-curl': TerminalWindow,
    'request-pin': PushPin,
    'go-intercept': Plugs,
    'go-view': Rows,
    'go-modify': Pencil,
    'go-send': PaperPlaneTilt,
    'go-settings': GearSix,
    'toggle-recording': Record,
    'clear-traffic': Trash,
    'copy-proxy-address': Copy,
    'import-har': DownloadSimple,
    'export-har': UploadSimple,
    'connect-iphone': DeviceMobile,
    'connect-android': AndroidLogo,
    'connect-ai': Sparkle,
    'toggle-devices-panel': SidebarSimple,
    'new-send-tab': Plus,
    'toggle-collections-panel': SidebarSimple,
    'open-docs': BookOpen,
    'report-issue': ChatText
};

const PaletteModal = styled(AppModal)`
    width: 620px;
    max-width: calc(100vw - 48px);
`;

// A fixed height, so the dialog doesn't jump around while the list filters
const PaletteRoot = styled.div`
    height: min(460px, calc(100vh - 96px));
    display: flex;
    flex-direction: column;
    overflow: hidden;

    color: ${p => p.theme.mainColor};
    background-color: ${p => p.theme.modalColor};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 12px;
    box-shadow: ${p => p.theme.floatingShadow};
`;

const SearchField = styled.label`
    flex-shrink: 0;
    height: 40px;
    margin: 12px 12px 6px;
    padding: 0 12px;
    border-radius: 8px;

    display: flex;
    align-items: center;
    gap: 10px;

    color: ${p => p.theme.mainLowlightColor};
    background-color: ${p => p.theme.inputBackground};
    border: 1px solid ${p => p.theme.inputBorder};

    /* The field's ring shows keyboard focus, as the input inside is always focused */
    &:focus-within {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: 2px;
    }

    > svg {
        flex-shrink: 0;
    }
`;

const SearchInput = styled.input`
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    padding: 0;

    border: none;
    background: none;
    color: ${p => p.theme.inputColor};
    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.subHeadingSize};

    &::placeholder {
        color: ${p => p.theme.inputPlaceholderColor};
    }

    &:focus, &:focus-visible {
        outline: none; /* SearchField shows the ring */
    }
`;

const ResultArea = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 0 8px 8px;
`;

const SectionHeader = styled.div`
    padding: 10px 10px 4px;

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const OptionRow = styled.div`
    min-height: 36px;
    padding: 6px 10px;
    border-radius: 6px;

    display: flex;
    align-items: center;
    gap: 10px;

    cursor: pointer;
    transition: background-color 0.12s, color 0.12s;

    > svg {
        flex-shrink: 0;
        color: ${p => p.theme.mainLowlightColor};
    }

    /* rowHover is too close to the raised dialog surface in dark mode */
    &:hover {
        background-color: ${p => p.theme.selectionInactiveBackground};
    }

    &[aria-disabled='true'] {
        cursor: default;
        opacity: 0.5;
    }

    /* The keyboard's current option. Hover only tints, it never looks like this. */
    &[aria-selected='true'] {
        &, &:hover {
            background-color: ${p => p.theme.selectionBackground};
            color: ${p => p.theme.selectionColor};
        }

        > svg, .option-description, .option-shortcut {
            color: ${p => p.theme.selectionColor};
        }
    }
`;

const OptionText = styled.span`
    flex: 1 1 auto;
    min-width: 0;

    display: flex;
    align-items: baseline;
    gap: 8px;

    white-space: nowrap;
`;

const OptionLabel = styled.span`
    flex-shrink: 0;
    font-size: ${p => p.theme.textSize};

    strong {
        font-weight: 700;
    }
`;

const OptionDescription = styled.span`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;

    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

// The UI font, like every other shortcut hint in the app. In DM Mono, ⌘O reads as ⌘0.
const OptionShortcut = styled.kbd`
    flex-shrink: 0;
    margin-left: auto;

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    letter-spacing: 0.04em;
    color: ${p => p.theme.containerWatermark};
`;

const EmptyState = styled.div`
    padding: 48px 24px;

    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;

    > svg {
        color: ${p => p.theme.containerWatermark};
        margin-bottom: 4px;
    }

    p {
        font-size: ${p => p.theme.textSize};
        font-weight: 600;
        overflow-wrap: anywhere;
    }

    span {
        font-size: ${p => p.theme.smallPrintSize};
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const Footer = styled.footer`
    flex-shrink: 0;
    padding: 8px 14px;
    border-top: 1px solid ${p => p.theme.containerBorder};

    display: flex;
    gap: 14px;

    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};

    kbd {
        margin-right: 4px;
        padding: 0 5px;
        border-radius: 4px;

        font-family: ${p => p.theme.monoFontFamily};
        font-size: ${p => p.theme.tinyTextSize};
        background-color: ${p => p.theme.mainLowlightBackground};
        border: 1px solid ${p => p.theme.containerBorder};
    }
`;

// The label, with the letters the search matched in bold:
const HighlightedLabel = (props: { label: string, matches: readonly number[] }) => {
    if (props.matches.length === 0) return <>{ props.label }</>;

    const matched = new Set(props.matches);
    const parts: Array<{ text: string, matched: boolean }> = [];
    Array.from(props.label).forEach((char, index) => {
        const isMatched = matched.has(index);
        const last = parts[parts.length - 1];
        if (last && last.matched === isMatched) last.text += char;
        else parts.push({ text: char, matched: isMatched });
    });

    return <>{ parts.map((part, i) => part.matched
        ? <strong key={i}>{ part.text }</strong>
        : <React.Fragment key={i}>{ part.text }</React.Fragment>
    ) }</>;
};

const optionDomId = (idPrefix: string, action: AppAction) => `${idPrefix}-${action.id}`;

const CommandGroupRows = observer((props: {
    section: string,
    matches: readonly CommandMatch<AppAction>[],
    idPrefix: string,
    activeAction: AppAction | undefined,
    onRun: (action: AppAction) => void
}) => {
    const headerId = `${props.idPrefix}-section-${props.section}`;

    return <div role='group' aria-labelledby={headerId}>
        <SectionHeader id={headerId} role='presentation'>{ props.section }</SectionHeader>
        { props.matches.map(({ command, labelMatches }) => {
            const ActionIcon = ACTION_ICONS[command.id];

            return <OptionRow
                key={command.id}
                id={optionDomId(props.idPrefix, command)}
                role='option'
                aria-selected={command === props.activeAction}
                aria-disabled={!command.enabled}
                aria-keyshortcuts={command.shortcut && toAriaShortcut(command.shortcut)}
                // Clicking keeps focus in the search field:
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => { if (command.enabled) props.onRun(command); }}
            >
                { ActionIcon && <ActionIcon size={16} aria-hidden={true} /> }
                <OptionText>
                    <OptionLabel>
                        <HighlightedLabel label={command.label} matches={labelMatches} />
                    </OptionLabel>
                    { command.description &&
                        <OptionDescription className='option-description'>
                            { command.description }
                        </OptionDescription>
                    }
                </OptionText>
                { command.shortcut &&
                    <OptionShortcut className='option-shortcut'>
                        { formatShortcut(command.shortcut) }
                    </OptionShortcut>
                }
            </OptionRow>;
        }) }
    </div>;
});

/**
 * The ⌘K command palette: every app action, filtered as you type. ↑ and ↓ choose,
 * Enter runs, Escape closes. Focus stays in the search field the whole time.
 */
export const CommandPalette = observer((props: {
    actions: readonly AppAction[],
    onRun: (action: AppAction) => void,
    onClose: () => void
}) => {
    const [query, setQuery] = React.useState('');
    const [activeId, setActiveId] = React.useState<string | undefined>();

    const idPrefix = React.useId();
    const listId = `${idPrefix}-list`;

    const groups = searchCommands(props.actions, query, APP_ACTION_SECTIONS);
    const allMatches = groups.reduce<CommandMatch<AppAction>[]>((all, group) => all.concat(group.matches), []);
    const choosable = allMatches.filter((match) => match.command.enabled);
    const active = choosable.find((match) => match.command.id === activeId) ?? choosable[0];
    const activeOptionId = active ? optionDomId(idPrefix, active.command) : undefined;

    React.useLayoutEffect(() => {
        if (!activeOptionId) return;
        document.getElementById(activeOptionId)?.scrollIntoView({ block: 'nearest' });
    }, [activeOptionId]);

    // The input is the first focusable element, which is what showModal() focuses:
    const focusOnOpen = React.useCallback((input: HTMLInputElement | null) => {
        input?.setAttribute('autofocus', '');
    }, []);

    const move = (distance: number) => {
        if (choosable.length === 0) return;
        const index = active ? choosable.indexOf(active) : -1;
        const next = choosable[(index + distance + choosable.length) % choosable.length];
        setActiveId(next.command.id);
    };

    const onKeyDown = (event: React.KeyboardEvent) => {
        if (event.nativeEvent.isComposing) return;

        switch (event.key) {
            case 'ArrowDown':
                move(1);
                break;
            case 'ArrowUp':
                move(-1);
                break;
            case 'Enter':
                if (active) props.onRun(active.command);
                break;
            case 'Tab':
                break; // Focus stays in the search field
            case 'Escape':
                // The dialog closes itself on Escape. This just keeps page shortcuts (like
                // Send's Escape to cancel a request) from seeing it.
                event.stopPropagation();
                return;
            default:
                return; // Typing, and every other shortcut, carries on as usual
        }

        event.preventDefault();
        event.stopPropagation();
    };

    return <PaletteModal aria-label='Command palette' onClose={props.onClose} backdropOpacity={0.35}>
        <PaletteRoot onKeyDown={onKeyDown}>
            <SearchField>
                <MagnifyingGlass size={18} aria-hidden={true} />
                <SearchInput
                    ref={focusOnOpen}
                    role='combobox'
                    aria-label='Search commands'
                    aria-expanded={true}
                    aria-controls={listId}
                    aria-autocomplete='list'
                    aria-activedescendant={activeOptionId}
                    placeholder='Type a command, or search for one…'
                    spellCheck={false}
                    autoComplete='off'
                    value={query}
                    onChange={(event) => {
                        setQuery(event.target.value);
                        setActiveId(undefined); // The best match comes first
                    }}
                />
            </SearchField>

            <ResultArea>
                <div role='listbox' id={listId} aria-label='Commands'>
                    { groups.map((group) => <CommandGroupRows
                        key={group.section}
                        section={group.section}
                        matches={group.matches}
                        idPrefix={idPrefix}
                        activeAction={active?.command}
                        onRun={props.onRun}
                    />) }
                </div>

                { allMatches.length === 0 && <EmptyState role='status'>
                    <MagnifyingGlass size={28} aria-hidden={true} />
                    <p>No commands match “{ query.trim() }”</p>
                    <span>Try a page like View, or an action like Pause or Export</span>
                </EmptyState> }
            </ResultArea>

            <Footer aria-hidden={true}>
                <span><kbd>↑↓</kbd>choose</span>
                <span><kbd>↵</kbd>run</span>
                <span><kbd>esc</kbd>close</span>
            </Footer>
        </PaletteRoot>
    </PaletteModal>;
});
