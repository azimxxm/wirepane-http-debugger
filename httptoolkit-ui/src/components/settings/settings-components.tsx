import { styled, css } from '../../styles';

import { Button, ButtonLink } from '../common/inputs';
import { ContentLabel } from '../common/text-content';

// wirepane: the settings cards' icons in Phosphor, like the toolbars (see toolbar-icons)
export { UnifiedIcon as SettingsIcon } from '../common/toolbar-icons';

// wirepane: compact secondary buttons, sized to their label, so rarely used file pickers
// aren't the loudest things on the page. `highlight` makes the one primary action.
const SettingsButtonCss = css`
    && {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        justify-self: start;
        align-self: center;
        min-height: 28px;
        padding: 4px 12px;
        border-radius: 6px;

        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 500;
        white-space: nowrap;

        border: 1px solid ${p => p.theme.inputBorder};
        background-color: ${p => p.theme.mainBackground};
        background-image: none;
        color: ${p => p.theme.mainColor};
    }

    /* Button's own states would turn the label white and add a gradient */
    &&:not([disabled]):hover {
        background-color: ${p => p.theme.rowHover};
    }

    &&:not([disabled]):hover, &&:not([disabled]):active, &&:not([disabled]):focus {
        background-image: none;
        color: ${p => p.theme.mainColor};
    }

    &&[disabled] {
        opacity: 0.5;
        color: ${p => p.theme.mainColor};
    }

    ${(p: { highlight?: boolean }) => p.highlight && css`
        && {
            border-color: transparent;
            background-color: ${p => p.theme.primaryInputBackground};
            color: ${p => p.theme.primaryInputColor};
        }

        &&:not([disabled]):hover {
            background-color: ${p => p.theme.accentHover};
        }

        &&:not([disabled]):hover, &&:not([disabled]):active, &&:not([disabled]):focus {
            color: ${p => p.theme.primaryInputColor};
        }
    `}
`;

export const SettingsButton = styled(Button)`${SettingsButtonCss}`;
export const SettingsButtonLink = styled(ButtonLink)<{
    highlight?: boolean
}>`${SettingsButtonCss}`;

// wirepane: plain 13px secondary text, not italic
export const SettingsExplanation = styled.p`
    margin-top: 6px;
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};
`;

// wirepane: sentence case, like the card titles, instead of small capitals
export const SettingsSubheading = styled(ContentLabel)`
    text-transform: none;
    opacity: 1;
    font-size: ${p => p.theme.textSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};

    &:not(header + &):not(:first-child) {
        margin-top: 32px;
    }
`;

// Subheaders can be wrapped with this if there are other controls
export const SettingsSubheadingRow = styled.div`
    display: flex;
    align-items: center;
    justify-content: start;

    &:not(header + &) {
        margin-top: 32px;
    }

    ${SettingsSubheading} {
        margin-top: 0;
    }
`;