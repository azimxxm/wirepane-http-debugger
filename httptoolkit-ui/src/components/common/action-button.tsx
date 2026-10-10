import * as React from 'react';

import { styled, css } from '../../styles';
import { IconKey, PhosphorIcon } from '../../icons';
import { formatShortcut, toAriaShortcut } from '../../util/shortcuts';

import { UnstyledButton } from './inputs';

export type ActionButtonVariant = 'primary' | 'secondary' | 'ghost';

// The compact 28px buttons used in page headers, toolbars & empty states. Use the
// primary (accent) variant for at most one button per view.
const ActionButtonRoot = styled(UnstyledButton)<{ variant: ActionButtonVariant }>`
    flex-shrink: 0;
    height: 28px;
    padding: 0 10px;
    border-radius: 6px;
    border: 1px solid transparent;

    display: inline-flex;
    align-items: center;
    gap: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
    line-height: 1;
    white-space: nowrap;

    transition: background-color 0.12s, border-color 0.12s, color 0.12s;

    &[disabled] {
        opacity: 0.5;
    }

    > svg {
        flex-shrink: 0;
    }

    ${p => p.variant === 'primary' && css`
        background-color: ${p => p.theme.primaryInputBackground};
        color: ${p => p.theme.primaryInputColor};

        &:not([disabled]):hover {
            background-color: ${p => p.theme.accentHover};
        }
    `}

    ${p => p.variant === 'secondary' && css`
        background-color: ${p => p.theme.mainBackground};
        border-color: ${p => p.theme.inputBorder};
        color: ${p => p.theme.mainColor};

        &:not([disabled]):hover {
            background-color: ${p => p.theme.rowHover};
        }
    `}

    ${p => p.variant === 'ghost' && css`
        color: ${p => p.theme.mainColor};

        &:not([disabled]):hover {
            background-color: ${p => p.theme.rowHover};
        }
    `}
`;

const ShortcutHint = styled.kbd<{ variant: ActionButtonVariant }>`
    font-family: ${p => p.theme.fontFamily};
    font-weight: 400;
    color: ${p => p.variant === 'primary'
        ? 'inherit'
        : p.theme.mainLowlightColor
    };
`;

export const ActionButton = React.forwardRef((props: {
    variant?: ActionButtonVariant,
    icon?: IconKey,
    // An icon after the label, e.g. a ▾ for menu buttons. Stays visible in compact mode.
    trailingIcon?: IconKey,
    // A shortcut like 'Cmd+M', shown after the label & in the tooltip:
    shortcut?: string,
    // Show the shortcut in the tooltip only, for busy toolbars:
    shortcutInTooltipOnly?: boolean,
    children?: React.ReactNode,
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type'>,
    ref: React.Ref<HTMLButtonElement>
) => {
    const {
        variant = 'secondary',
        icon,
        trailingIcon,
        shortcut,
        shortcutInTooltipOnly,
        children,
        title,
        ...buttonProps
    } = props;
    const shortcutLabel = shortcut ? formatShortcut(shortcut) : undefined;

    return <ActionButtonRoot
        ref={ref}
        variant={variant}
        title={title && shortcutLabel ? `${title} (${shortcutLabel})` : title}
        aria-keyshortcuts={shortcut ? toAriaShortcut(shortcut) : undefined}
        {...buttonProps}
    >
        { icon && <PhosphorIcon icon={icon} size={16} aria-hidden={true} /> }
        { children && <span className='action-label'>{ children }</span> }
        { shortcutLabel && !shortcutInTooltipOnly && <ShortcutHint variant={variant} className='action-shortcut'>
            { shortcutLabel }
        </ShortcutHint> }
        { trailingIcon && <PhosphorIcon icon={trailingIcon} size={12} weight='bold' aria-hidden={true} /> }
    </ActionButtonRoot>;
});
