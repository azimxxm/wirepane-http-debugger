import * as React from 'react';

import { styled } from '../../styles';
import { formatShortcut } from '../../util/shortcuts';

import { EmptyState } from '../common/empty-state';
import { ActionButton } from '../common/action-button';

const EmptyTitle = styled.h2`
    margin-top: 12px;

    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};
`;

const EmptyText = styled.p`
    max-width: 420px;
    margin-top: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};
`;

const EmptyActions = styled.div`
    margin-top: 16px;

    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: 8px;
`;

/**
 * View with nothing captured yet: says what will show up here, and how to get it.
 */
export const NoTrafficState = (props: {
    isPaused: boolean,
    onConnectSource: () => void,
    onResumeRecording: () => void
}) => <EmptyState icon='Plugs'>
    <EmptyTitle>No traffic yet</EmptyTitle>
    <EmptyText>{ props.isPaused
        ? "Recording is paused, so new requests won't show up here. Resume it, or connect a source."
        : 'Connect a browser, terminal or device to start recording.'
    }</EmptyText>
    <EmptyActions>
        <ActionButton
            variant='primary'
            icon='Plugs'
            shortcut='Cmd+1'
            title='Go to Intercept to connect a source'
            onClick={props.onConnectSource}
        >
            Connect a source
        </ActionButton>
        { props.isPaused &&
            <ActionButton
                icon='Play'
                shortcut='Cmd+Shift+R'
                title='Resume recording'
                onClick={props.onResumeRecording}
            >
                Resume recording
            </ActionButton>
        }
    </EmptyActions>
</EmptyState>;

const ShortcutList = styled.ul`
    margin-top: 12px;

    display: flex;
    flex-direction: column;
    gap: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const Key = styled.kbd`
    display: inline-block;
    min-width: 20px;
    padding: 1px 5px;
    margin: 0 2px;
    box-sizing: border-box;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 4px;
    background-color: ${p => p.theme.mainBackground};

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainColor};
    text-align: center;
`;

/**
 * View with requests but none selected, in the details pane: a pointer to the
 * list, and the shortcuts that matter most here.
 */
export const SelectRequestState = () => <EmptyState icon='ArrowLeft'>
    <EmptyTitle>Select a request to inspect it</EmptyTitle>
    <ShortcutList aria-label='Keyboard shortcuts'>
        <li><Key>↑</Key><Key>↓</Key> or <Key>J</Key><Key>K</Key> to move</li>
        <li><Key>{ formatShortcut('Cmd+F') }</Key> to filter</li>
        <li><Key>{ formatShortcut('Cmd+M') }</Key> to mock the response</li>
        <li><Key>{ formatShortcut('Cmd+R') }</Key> to resend</li>
    </ShortcutList>
</EmptyState>;
