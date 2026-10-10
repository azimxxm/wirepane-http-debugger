import * as React from 'react';

import { styled } from '../../styles';

export const PAGE_HEADER_HEIGHT = 56;

const PageHeaderRoot = styled.header<{ compactBelow: number }>`
    flex-shrink: 0;
    box-sizing: border-box;
    height: ${PAGE_HEADER_HEIGHT}px;
    padding: 0 24px;

    display: flex;
    align-items: center;
    gap: 24px;

    position: relative;
    z-index: 10; /* Above page content, so toolbar popups (e.g. filter suggestions) overlay it */

    background-color: ${p => p.theme.mainBackground};
    border-bottom: 1px solid ${p => p.theme.containerBorder};

    /* Action labels give way to icons (with tooltips) when the window gets narrow.
       A media query, because styled-components 5 can't parse container queries. */
    @media (max-width: ${p => p.compactBelow}px) {
        .action-label, .action-shortcut {
            display: none;
        }
    }
`;

const TitleBlock = styled.div`
    flex: 0 1 auto;
    min-width: 140px;

    display: flex;
    flex-direction: column;
    gap: 2px;
`;

const PageTitle = styled.h1`
    font-size: ${p => p.theme.largeHeadingSize};
    font-weight: 600;
    line-height: 1.2;
    color: ${p => p.theme.mainColor};
`;

const PagePurpose = styled.p`
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};

    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

const PageActions = styled.div`
    flex: 1 1 auto;
    min-width: 0;

    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;
`;

/**
 * The header at the top of every page: the title (always the same as the nav label),
 * a one-line purpose, and the page's actions on the right. It also keeps the window
 * title in sync with the current page.
 */
export const PageHeader = (props: {
    title: string,
    purpose: string,
    // The window width below which action buttons show only their icons:
    compactBelow?: number,
    children?: React.ReactNode
}) => {
    React.useEffect(() => {
        document.title = `${props.title} — Wirepane`;
    }, [props.title]);

    return <PageHeaderRoot compactBelow={props.compactBelow ?? 1000}>
        <TitleBlock>
            <PageTitle>{ props.title }</PageTitle>
            <PagePurpose title={props.purpose}>{ props.purpose }</PagePurpose>
        </TitleBlock>
        { props.children && <PageActions>
            { props.children }
        </PageActions> }
    </PageHeaderRoot>;
};

// A full-height page: the header on top, and a body that takes the remaining space.
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
