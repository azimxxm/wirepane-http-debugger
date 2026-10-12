import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { observer } from 'mobx-react-lite';

import { styled } from '../../styles';
import { useHotkeys } from '../../util/ui';
import { formatShortcut, toAriaShortcut, toHotkeys } from '../../util/shortcuts';
import { TOOLBAR_EXTRA_INSET } from '../../util/window-chrome';

import { toolbarSlots } from '../app-toolbar';
import { UnstyledButton } from './inputs';

// Where a sub-page sits, shown before its title as a breadcrumb: "Intercept › iPhone or iPad"
export interface PageHeaderParent {
    label: string;
    // The tooltip, e.g. 'Back to all sources on the Intercept page'
    description: string;
    onSelect: () => void;
    // Also goes back, e.g. 'Cmd+[' (bound while the page is open)
    shortcut?: string;
}

const TitleBlock = styled.div`
    flex: 1 1 auto;
    min-width: 0;

    display: flex;
    flex-direction: column;
    justify-content: center;
`;

const TitleRow = styled.div`
    display: flex;
    align-items: baseline;
    min-width: 0;

    font-size: ${p => p.theme.toolbarTitleSize};
    line-height: 20px;
`;

const PageTitle = styled.h1`
    min-width: 0;

    font-size: inherit;
    font-weight: 600;
    color: ${p => p.theme.mainColor};

    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

const ParentLink = styled(UnstyledButton)`
    flex-shrink: 0;
    margin-left: -4px;
    padding: 0 4px;
    border-radius: 4px;

    font-size: inherit;
    font-weight: 500;
    line-height: inherit;
    color: ${p => p.theme.mainLowlightColor};

    transition: background-color 0.12s, color 0.12s;

    &:hover {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

const Separator = styled.span`
    flex-shrink: 0;
    margin: 0 4px 0 2px;
    color: ${p => p.theme.containerWatermark};
`;

const PagePurpose = styled.p`
    font-size: ${p => p.theme.smallPrintSize};
    line-height: 16px;
    color: ${p => p.theme.mainLowlightColor};

    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

const ToolbarActions = styled.div<{ compactBelow: number, shortcutsBelow: number }>`
    flex: 1 1 auto;
    min-width: 0;

    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;

    /* Each control takes its own clicks; the gaps between them still drag the window */
    > * {
        -webkit-app-region: no-drag;
    }

    /* When the window gets narrow, shortcut hints go first (they're in the tooltips too),
       then labels give way to icons. Media queries, because styled-components 5 can't
       parse container queries. */
    @media (max-width: ${p => p.shortcutsBelow + TOOLBAR_EXTRA_INSET}px) {
        .action-shortcut {
            display: none;
        }
    }

    @media (max-width: ${p => p.compactBelow + TOOLBAR_EXTRA_INSET}px) {
        .action-label, .action-shortcut {
            display: none;
        }
    }
`;

const ParentShortcut = (props: { shortcut: string, onSelect: () => void }) => {
    useHotkeys(toHotkeys(props.shortcut), (event) => {
        event.preventDefault();
        props.onSelect();
    }, [props.onSelect]);
    return null;
};

/**
 * The current page's part of the window toolbar (components/app-toolbar.tsx): its title
 * (always the same as the nav label, or a breadcrumb starting with it), a one-line
 * purpose, and its actions. It renders nothing in place, so the page's own content starts
 * right below the toolbar. It also keeps the window title in sync with the page.
 */
export const PageHeader = observer((props: {
    title: string,
    purpose: string,
    parent?: PageHeaderParent,
    // The window widths below which action buttons show only their icons, and drop the
    // shortcut hints after their labels (the tooltips keep them):
    compactBelow?: number,
    shortcutsBelow?: number,
    children?: React.ReactNode
}) => {
    const { title, purpose, parent } = props;
    const fullTitle = parent ? `${parent.label} › ${title}` : title;

    React.useEffect(() => {
        document.title = `${fullTitle} — Wirepane`;
    }, [fullTitle]);

    const titleSlot = toolbarSlots.title;
    const actionsSlot = toolbarSlots.actions;

    return <>
        { parent?.shortcut && <ParentShortcut shortcut={parent.shortcut} onSelect={parent.onSelect} /> }

        { titleSlot && ReactDOM.createPortal(<TitleBlock>
            <TitleRow>
                { parent && <>
                    <ParentLink
                        onClick={parent.onSelect}
                        title={parent.shortcut
                            ? `${parent.description} (${formatShortcut(parent.shortcut)})`
                            : parent.description
                        }
                        aria-keyshortcuts={parent.shortcut ? toAriaShortcut(parent.shortcut) : undefined}
                    >
                        { parent.label }
                    </ParentLink>
                    <Separator aria-hidden={true}>›</Separator>
                </> }
                <PageTitle title={title}>{ title }</PageTitle>
            </TitleRow>
            <PagePurpose title={purpose}>{ purpose }</PagePurpose>
        </TitleBlock>, titleSlot) }

        { actionsSlot && props.children && ReactDOM.createPortal(
            <ToolbarActions
                compactBelow={props.compactBelow ?? 1000}
                shortcutsBelow={props.shortcutsBelow ?? props.compactBelow ?? 1000}
            >
                { props.children }
            </ToolbarActions>,
            actionsSlot
        ) }
    </>;
});

// A full-height page, starting right below the toolbar, with a body that takes the
// remaining space.
export const PageLayout = styled.div`
    height: 100%;
    min-height: 0;
    display: flex;
    flex-direction: column;
`;

export const PageBody = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
`;
