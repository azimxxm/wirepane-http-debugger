import * as React from 'react';

import { css, styled } from '../../../styles';
import { formatShortcut, toAriaShortcut } from '../../../util/shortcuts';

import type { RequestEditorTab } from '../../../model/send/send-extras';

export const TAB_BAR_HEIGHT = '32px';

// ⌘⌥1–7 (Ctrl+Alt+1–7 elsewhere), in the order of the tabs
export const EDITOR_TAB_SHORTCUTS: { readonly [tab in RequestEditorTab]: string } = {
    params: 'Cmd+Alt+1',
    authorization: 'Cmd+Alt+2',
    headers: 'Cmd+Alt+3',
    body: 'Cmd+Alt+4',
    scripts: 'Cmd+Alt+5',
    settings: 'Cmd+Alt+6',
    docs: 'Cmd+Alt+7'
};

export interface EditorTabInfo {
    id: RequestEditorTab;
    label: string;
    // A number after the label, e.g. "Headers 3". Zero isn't shown.
    count?: number;
    // A dot after the label, with this text for screen readers, e.g. "has a body"
    marker?: string;
}

export const editorTabId = (idBase: string, tab: RequestEditorTab) => `${idBase}-${tab}-tab`;
export const editorPanelId = (idBase: string) => `${idBase}-panel`;

const TabList = styled.div`
    flex-shrink: 0;
    height: ${TAB_BAR_HEIGHT};
    padding: 0 10px;

    display: flex;
    align-items: stretch;
    gap: 2px;
    overflow: hidden;

    background-color: ${p => p.theme.mainBackground};
    border-bottom: 1px solid ${p => p.theme.containerBorder};
`;

const Tab = styled.button.attrs(() => ({ type: 'button' }))<{ isSelected: boolean }>`
    position: relative;
    flex-shrink: 0;
    padding: 0 10px;
    border: none;
    border-radius: 4px 4px 0 0;

    display: inline-flex;
    align-items: center;
    gap: 5px;

    font-family: inherit;
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
    white-space: nowrap;
    cursor: pointer;

    color: ${p => p.theme.mainLowlightColor};
    background-color: transparent;

    &:focus-visible {
        outline-offset: -2px;
    }

    ${p => p.isSelected
        ? css`
            color: ${p.theme.popColor};

            &::after {
                content: '';
                position: absolute;
                left: 10px;
                right: 10px;
                bottom: -1px;
                height: 2px;
                border-radius: 1px;
                background-color: ${p.theme.popColor};
            }
        `
        : css`
            &:hover {
                color: ${p.theme.mainColor};
                background-color: ${p.theme.rowHover};
            }
        `
    }
`;

const TabCount = styled.span`
    font-weight: 400;
    font-variant-numeric: tabular-nums;
    color: ${p => p.theme.containerWatermark};
`;

const TabMarker = styled.span`
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background-color: ${p => p.theme.containerWatermark};
`;

const VisuallyHidden = styled.span`
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
`;

/**
 * The Params · Headers · Body · Docs tabs under the URL. Arrow keys, Home and End move
 * between them (each tab opens as it gets focus), and ⌘⌥1–4 open them from anywhere.
 */
export const RequestEditorTabBar = (props: {
    idBase: string,
    tabs: readonly EditorTabInfo[],
    selected: RequestEditorTab,
    onSelect: (tab: RequestEditorTab, options: { focus: boolean }) => void
}) => {
    const { idBase, tabs, selected, onSelect } = props;

    const onKeyDown = (event: React.KeyboardEvent) => {
        const index = tabs.findIndex((tab) => tab.id === selected);
        const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length
            : event.key === 'ArrowLeft' ? (index - 1 + tabs.length) % tabs.length
            : event.key === 'Home' ? 0
            : event.key === 'End' ? tabs.length - 1
            : undefined;
        if (next === undefined) return;

        event.preventDefault();
        onSelect(tabs[next].id, { focus: true });
    };

    return <TabList role='tablist' aria-label='Request parts' onKeyDown={onKeyDown}>
        { tabs.map((tab) => {
            const isSelected = tab.id === selected;
            const shortcut = EDITOR_TAB_SHORTCUTS[tab.id];

            return <Tab
                key={tab.id}
                id={editorTabId(idBase, tab.id)}
                role='tab'
                aria-selected={isSelected}
                aria-controls={editorPanelId(idBase)}
                aria-keyshortcuts={toAriaShortcut(shortcut)}
                tabIndex={isSelected ? 0 : -1}
                isSelected={isSelected}
                title={`${tab.label} (${formatShortcut(shortcut)})`}
                onClick={() => onSelect(tab.id, { focus: false })}
            >
                { tab.label }
                { !!tab.count && <TabCount>{ tab.count }</TabCount> }
                { tab.marker && <>
                    <TabMarker aria-hidden={true} />
                    <VisuallyHidden>, { tab.marker }</VisuallyHidden>
                </> }
            </Tab>;
        }) }
    </TabList>;
};
