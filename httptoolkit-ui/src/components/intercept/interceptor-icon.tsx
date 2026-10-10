import * as _ from 'lodash';
import * as React from 'react';
import * as polished from 'polished';

import { styled } from '../../styles';
import { Icon, IconProps } from '../../icons';

// Icons need 3:1 against the card to be seen (WCAG 1.4.11, graphical objects)
const MIN_ICON_CONTRAST = 3;

/**
 * Keeps a vendor's colour where it's readable on the card, otherwise darkens or
 * lightens it until it is. Black & white icons (e.g. Apple) just follow the text.
 */
function readableIconColor(color: string, background: string, textColor: string): string {
    if (color.startsWith('var(')) return color; // Already a theme colour

    try {
        if (polished.getContrast(color, background) >= MIN_ICON_CONTRAST) return color;
        if (polished.parseToHsl(color).saturation < 0.05) return textColor;

        const darkBackground = polished.getLuminance(background) < 0.5;
        let adjusted = color;
        for (let i = 0; i < 20 && polished.getContrast(adjusted, background) < MIN_ICON_CONTRAST; i++) {
            adjusted = darkBackground
                ? polished.lighten(0.05, adjusted)
                : polished.darken(0.05, adjusted);
        }
        return adjusted;
    } catch (e) {
        return textColor; // Not a colour polished can parse
    }
}

const IconSlot = styled.span<{ iconColor: string }>`
    flex-shrink: 0;
    width: 24px;
    height: 24px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    font-size: 22px; /* FontAwesome brand glyphs fill their box, so a touch smaller */
    color: ${p => readableIconColor(p.iconColor, p.theme.mainBackground, p.theme.mainColor)};
`;

/**
 * The 24px icon next to an intercept option's title. Options with layered icons
 * (e.g. Chrome + globe) show just the first one.
 */
export const InterceptorIcon = (props: { iconProps: IconProps | IconProps[] }) => {
    const iconProps = _.isArray(props.iconProps) ? props.iconProps[0] : props.iconProps;
    const isFontAwesome = Array.isArray(iconProps.icon);

    return <IconSlot iconColor={iconProps.color} aria-hidden={true}>
        <Icon
            icon={iconProps.icon}
            size={isFontAwesome ? undefined : '24px'}
        />
    </IconSlot>;
};
