import * as React from 'react';
import { type Icon as PhosphorIconComponent } from '@phosphor-icons/react';

import { styled, css } from '../../styles';

import { ContentLabel } from '../common/text-content';
import { SettingsSubheading } from './settings-components';

/*
 * Wirepane: Settings as sections, with a list of them on the left, like a desktop app's
 * preferences. Every section stays on one scrolling page, so nothing is hidden away: the
 * list jumps to a section, and shows which one you're reading.
 */

export interface SettingsSectionInfo {
    id: string;
    label: string;
    icon: PhosphorIconComponent;
}

// How far below the top of the page a section's start counts as "reading it"
const ACTIVE_SECTION_OFFSET = 96;
const NAV_HIDDEN_BELOW = 900;

const SettingsBody = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
`;

const SectionNav = styled.nav`
    flex: 0 0 208px;
    box-sizing: border-box;
    padding: 20px 12px;
    overflow-y: auto;

    border-right: 1px solid ${p => p.theme.containerBorder};

    @media (max-width: ${NAV_HIDDEN_BELOW}px) {
        display: none;
    }
`;

const NavList = styled.ul`
    display: flex;
    flex-direction: column;
    gap: 2px;
`;

const NavLink = styled.a<{ active: boolean }>`
    position: relative;
    height: 32px;
    padding: 0 10px;
    border-radius: 6px;

    display: flex;
    align-items: center;
    gap: 10px;

    color: ${p => p.theme.mainColor};
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;

    > svg {
        flex-shrink: 0;
        color: ${p => p.theme.mainLowlightColor};
    }

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    &:focus-visible {
        outline-offset: -2px;
    }

    /* The current section: a grey fill and a teal leading bar. Hover only tints. */
    ${p => p.active && css`
        &, &:hover {
            background-color: ${p.theme.selectionInactiveBackground};
        }

        font-weight: 600;

        > svg {
            color: ${p.theme.popColor};
        }

        &::before {
            content: '';
            position: absolute;
            left: 0;
            top: 7px;
            bottom: 7px;
            width: 3px;
            border-radius: 0 3px 3px 0;
            background-color: ${p.theme.popColor};
        }
    `}
`;

const SectionsScroller = styled.div`
    flex: 1 1 auto;
    min-width: 0;
    overflow-y: auto;
`;

const SectionsColumn = styled.div`
    max-width: 840px;
    padding: 24px 32px 40px;
    box-sizing: border-box;
    position: relative;

    /* Field labels in sentence case, in the secondary text colour, not small capitals */
    ${ContentLabel}:not(${SettingsSubheading}) {
        text-transform: none;
        opacity: 1;
        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 500;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const Section = styled.div`
    scroll-margin-top: 16px;
    border-radius: 6px;

    &:focus:not(:focus-visible) {
        outline: none;
    }

    &:focus-visible {
        outline-offset: 4px;
    }
`;

/**
 * One section of the Settings page: the target of its link in the section list.
 */
export const SettingsSection = (props: {
    id: string,
    label: string,
    children: React.ReactNode
}) => <Section id={props.id} tabIndex={-1} role='region' aria-label={props.label}>
    { props.children }
</Section>;

const prefersReducedMotion = () =>
    !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export const SettingsLayout = (props: {
    sections: SettingsSectionInfo[],
    children: React.ReactNode
}) => {
    const { sections } = props;
    const scrollerRef = React.useRef<HTMLDivElement>(null);
    const updateScheduled = React.useRef(false);
    const [activeId, setActiveId] = React.useState<string | undefined>(sections[0]?.id);

    const updateActiveSection = React.useCallback(() => {
        updateScheduled.current = false;
        const scroller = scrollerRef.current;
        if (!scroller) return;

        const scrollerTop = scroller.getBoundingClientRect().top;
        const presentSections = sections.filter(({ id }) => document.getElementById(id));
        let current = presentSections[0]?.id;

        for (const { id } of presentSections) {
            const sectionTop = document.getElementById(id)!.getBoundingClientRect().top;
            if (sectionTop - scrollerTop <= ACTIVE_SECTION_OFFSET) current = id;
        }

        // Scrolled to the end: the last sections can be too short to reach the top
        const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2;
        if (atBottom && scroller.scrollTop > 0) current = presentSections[presentSections.length - 1]?.id;

        setActiveId(current);
    }, [sections.map(({ id }) => id).join(',')]);

    React.useLayoutEffect(updateActiveSection, [updateActiveSection]);

    const onScroll = () => {
        if (updateScheduled.current) return;
        updateScheduled.current = true;
        requestAnimationFrame(updateActiveSection);
    };

    const jumpTo = (event: React.MouseEvent, id: string) => {
        event.preventDefault();
        const section = document.getElementById(id);
        if (!section) return;

        section.scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' });
        // Focus follows, so keyboard & screen reader users land in the section too
        section.focus({ preventScroll: true });
        setActiveId(id);
    };

    return <SettingsBody>
        <SectionNav aria-label='Settings sections'>
            <NavList>
                { sections.map(({ id, label, icon: SectionIcon }) =>
                    <li key={id}>
                        <NavLink
                            href={`#${id}`}
                            active={id === activeId}
                            aria-current={id === activeId ? 'location' : undefined}
                            onClick={(event: React.MouseEvent) => jumpTo(event, id)}
                        >
                            <SectionIcon size={16} aria-hidden={true} />
                            { label }
                        </NavLink>
                    </li>
                ) }
            </NavList>
        </SectionNav>
        <SectionsScroller ref={scrollerRef} onScroll={onScroll}>
            <SectionsColumn>
                { props.children }
            </SectionsColumn>
        </SectionsScroller>
    </SettingsBody>;
};
