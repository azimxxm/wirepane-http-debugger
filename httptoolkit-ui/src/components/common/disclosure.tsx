import * as React from 'react';

import { styled } from '../../styles';
import { PhosphorIcon } from '../../icons';

import { UnstyledButton } from './inputs';

const DisclosureButton = styled(UnstyledButton)`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px 0 4px;
    margin-left: -4px;
    border-radius: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    > svg {
        color: ${p => p.theme.mainLowlightColor};
        transition: transform 0.12s;
    }

    &[aria-expanded='true'] > svg {
        transform: rotate(90deg);
    }
`;

const DisclosureBody = styled.div`
    margin-top: 8px;
`;

/**
 * A collapsible section with a ▸ toggle, like a macOS disclosure triangle.
 */
export const Disclosure = (props: {
    id: string,
    title: string,
    open: boolean,
    onToggle: () => void,
    children: React.ReactNode,
    className?: string
}) => {
    const bodyId = `${props.id}-body`;

    return <section className={props.className}>
        <DisclosureButton
            aria-expanded={props.open}
            aria-controls={bodyId}
            onClick={props.onToggle}
        >
            <PhosphorIcon icon='CaretRight' size={14} weight='bold' aria-hidden={true} />
            { props.title }
        </DisclosureButton>
        { props.open && <DisclosureBody id={bodyId}>
            { props.children }
        </DisclosureBody> }
    </section>;
};
