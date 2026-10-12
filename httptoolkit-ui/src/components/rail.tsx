import * as React from 'react';
import { observer } from 'mobx-react';
import { Link, Match } from '@reach/router';
import * as dedent from 'dedent';

import { styled, css } from '../styles';
import { IconKey, PhosphorIcon } from '../icons';
import { UI_VERSION, desktopVersion, serverVersion } from '../services/service-versions';

import { UnstyledButton } from './common/inputs';
import logo from '../images/logo-icon.svg';
import { HAS_HIDDEN_TITLE_BAR, TRAFFIC_LIGHTS_INSET } from '../util/window-chrome'; // wirepane

export const RAIL_WIDTH = 64;

export interface RailItem {
    name: string;
    icon: IconKey;
    position: 'top' | 'bottom';
    title: string;

    type: 'web' | 'router' | 'callback';
    url?: string;
    onClick?: () => void;

    // Shown as a small icon with a tooltip, without a label:
    iconOnly?: boolean;
}

const RailNav = styled.nav`
    width: ${RAIL_WIDTH}px;
    flex-shrink: 0;
    height: 100%;
    box-sizing: border-box;
    padding-bottom: 6px;

    position: relative;
    z-index: 5;

    display: flex;
    flex-direction: column;
    align-items: stretch;

    background: ${p => p.theme.railBackground};
    color: ${p => p.theme.railColor};
    box-shadow: inset -1px 0 0 ${p => p.theme.railEdge};

    user-select: none;
`;

// wirepane: room for macOS's traffic lights in the desktop app, which has no title bar
// there. The window can be dragged by it, like a title bar.
const TrafficLightsInset = styled.div`
    flex-shrink: 0;
    height: ${TRAFFIC_LIGHTS_INSET}px;
    -webkit-app-region: drag;
`;

const RailLogo = styled.img.attrs(() => ({
    src: logo,
    alt: 'Wirepane'
}))`
    display: block;
    width: 36px;
    height: 36px;
    margin: 12px auto 10px;
    -webkit-user-drag: none;
`;

const railItemStyles = css`
    position: relative;
    box-sizing: border-box;
    width: 100%;
    height: 52px;
    padding: 0;

    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 3px;

    color: ${p => p.theme.railColor};
    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 600;
    line-height: 1.2;
    text-decoration: none;

    cursor: pointer;
    -webkit-user-drag: none;
    transition: background-color 0.12s, color 0.12s;

    &:hover {
        background-color: ${p => p.theme.railHoverBackground};
        color: ${p => p.theme.railActiveColor};
    }

    /* Inside the item, so the rail edge never clips it */
    &:focus-visible {
        outline: 2px solid ${p => p.theme.railFocusRing};
        outline-offset: -2px;
    }

    /* The current page: a teal tint & the wire bar on the leading edge. Hover never
       looks like this, it only lightens the text. */
    &[aria-current='page'] {
        &, &:hover {
            background-color: ${p => p.theme.railActiveBackground};
            color: ${p => p.theme.railActiveColor};
        }

        &::before {
            content: '';
            position: absolute;
            left: 0;
            top: 6px;
            bottom: 6px;
            width: 3px;
            border-radius: 0 3px 3px 0;
            background: ${p => p.theme.gradientWireVertical};
        }
    }
`;

const iconOnlyStyles = css`
    height: 40px;
`;

const RailLink = styled(Link)`${railItemStyles}`;

const RailButton = styled(UnstyledButton)<{ iconOnly?: boolean }>`
    ${railItemStyles}
    ${p => p.iconOnly && iconOnlyStyles}
`;

const RailWebLink = styled.a<{ iconOnly?: boolean }>`
    ${railItemStyles}
    ${p => p.iconOnly && iconOnlyStyles}
`;

const Separator = styled.div`
    margin-top: auto;
`;

const RailItemContent = (props: { item: RailItem, active?: boolean }) => <>
    <PhosphorIcon
        icon={props.item.icon}
        size={props.item.iconOnly ? 20 : 22}
        weight={props.active ? 'fill' : 'regular'}
        aria-hidden={true}
    />
    { !props.item.iconOnly && <span>{ props.item.name }</span> }
</>;

const RailEntry = (props: { item: RailItem }) => {
    const { item } = props;

    if (item.type === 'router') {
        return <Match path={`${item.url!}/*`}>{({ match }) =>
            <RailLink
                to={item.url!}
                title={item.title}
                aria-current={match ? 'page' : undefined}
            >
                <RailItemContent item={item} active={!!match} />
            </RailLink>
        }</Match>;
    } else if (item.type === 'web') {
        return <RailWebLink
            href={item.url}
            target='_blank'
            rel='noreferrer noopener'
            title={item.title}
            aria-label={item.iconOnly ? item.name : undefined}
            iconOnly={item.iconOnly}
        >
            <RailItemContent item={item} />
        </RailWebLink>;
    } else {
        return <RailButton
            onClick={item.onClick}
            title={item.title}
            aria-label={item.iconOnly ? item.name : undefined}
            iconOnly={item.iconOnly}
        >
            <RailItemContent item={item} />
        </RailButton>;
    }
};

/**
 * The navy navigation rail: the four steps of the flow at the top (Intercept,
 * View, Modify, Send), and Settings & friends at the bottom.
 */
export const Rail = observer((props: { items: Array<RailItem> }) => {
    const topItems = props.items.filter((item) => item.position === 'top');
    const bottomItems = props.items.filter((item) => item.position === 'bottom');

    return <RailNav aria-label='Main navigation'>
        { HAS_HIDDEN_TITLE_BAR && <TrafficLightsInset aria-hidden={true} /> }
        <RailLogo
            title={dedent`
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
            `}
        />

        { topItems.map((item) => <RailEntry key={item.name} item={item} />) }
        <Separator />
        { bottomItems.map((item) => <RailEntry key={item.name} item={item} />) }
    </RailNav>;
});
