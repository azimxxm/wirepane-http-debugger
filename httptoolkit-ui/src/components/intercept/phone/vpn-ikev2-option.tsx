import * as React from 'react';
import { GearSix } from '@phosphor-icons/react';

import { styled } from '../../../styles';

import { ActionButton } from '../../common/action-button';
import { VpnIkev2Setup } from './vpn-ikev2-setup';

const Box = styled.section`
    padding: 12px 18px;

    background-color: ${p => p.theme.mainBackground};
    border: 1px dashed ${p => p.theme.containerBorder};
    border-radius: 8px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.5;
    color: ${p => p.theme.mainLowlightColor};
`;

const Row = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 16px;
`;

const Text = styled.div`
    flex: 1 1 320px;
    min-width: 0;
`;

const Title = styled.h2`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;

    font-size: ${p => p.theme.textSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};

    > svg {
        flex-shrink: 0;
    }
`;

const Tag = styled.span`
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainLowlightBackground};

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    line-height: 1.6;
    color: ${p => p.theme.mainColor};
`;

const Steps = styled.div`
    margin-top: 12px;
    padding-top: 12px;
    border-top: 1px solid ${p => p.theme.containerBorder};
`;

/**
 * "Without an app (IKEv2, beta)": the iPhone's built-in VPN instead of the WireGuard app.
 * It sits under the two main choices and opens its own steps, so it can be tried without
 * changing how the page's main modes work.
 */
export const VpnIkev2Option = () => {
    const [open, setOpen] = React.useState(false);
    const stepsId = React.useId();

    return <Box aria-labelledby={`${stepsId}-title`}>
        <Row>
            <Text>
                <Title id={`${stepsId}-title`}>
                    <GearSix size={18} aria-hidden={true} />
                    Without an app (IKEv2, beta)
                    <Tag>Beta</Tag>
                </Title>
                <p>
                    Uses the VPN built into iOS, set up by one profile, so the WireGuard app
                    isn't needed. Still being tested on real iPhones.
                </p>
            </Text>
            <ActionButton
                trailingIcon={open ? 'CaretDown' : 'CaretRight'}
                aria-expanded={open}
                aria-controls={stepsId}
                onClick={() => setOpen(!open)}
            >
                { open ? 'Hide the steps' : 'Show the steps' }
            </ActionButton>
        </Row>
        { open && <Steps id={stepsId}>
            <VpnIkev2Setup />
        </Steps> }
    </Box>;
};
