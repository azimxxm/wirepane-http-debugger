import * as React from 'react';
import { ShieldCheck, WifiHigh } from '@phosphor-icons/react';

import { styled } from '../../../styles';
import type { IPhoneConnectionMode } from '../../../model/interception/vpn-mode';

const Group = styled.div`
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 16px;

    @media (max-width: 760px) {
        grid-template-columns: minmax(0, 1fr);
    }
`;

const Option = styled.label`
    position: relative;
    display: block;
    min-width: 0;
    cursor: pointer;
`;

// Covers the whole card, so a click anywhere picks it and the keyboard focus lands on a real radio
const Radio = styled.input.attrs({ type: 'radio' })`
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    opacity: 0;
    cursor: pointer;
`;

const Dot = styled.span`
    flex-shrink: 0;
    width: 16px;
    height: 16px;
    box-sizing: border-box;
    margin-top: 2px;
    border-radius: 50%;
    border: 1px solid ${p => p.theme.inputBorder};
    background-color: ${p => p.theme.mainBackground};
`;

const OptionBody = styled.div`
    box-sizing: border-box;
    height: 100%;
    padding: 16px 18px;

    display: flex;
    gap: 12px;
    align-items: flex-start;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;
    transition: border-color 0.15s, box-shadow 0.15s;

    ${Option}:hover > & {
        border-color: ${p => p.theme.inputBorder};
    }

    ${Radio}:checked + & {
        border-color: ${p => p.theme.popColor};
        box-shadow: 0 0 0 1px ${p => p.theme.popColor};
    }

    ${Radio}:checked + & ${Dot} {
        border-color: ${p => p.theme.popColor};
        border-width: 5px;
    }

    ${Radio}:focus-visible + & {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: 2px;
    }
`;

const OptionText = styled.div`
    min-width: 0;
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.5;
    color: ${p => p.theme.mainLowlightColor};
`;

const OptionTitle = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 10px;

    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.3;
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

const Description = styled.p`
    margin-top: 4px;
`;

/**
 * "Capture all apps (VPN)" or "Wi-Fi proxy": the two ways to send an iPhone's traffic through
 * Wirepane. A real radio group, so the arrow keys move between the two.
 */
export const VpnModeChoice = (props: {
    mode: IPhoneConnectionMode | undefined,
    // Whether this build has the VPN tunnel (undefined while that's still being checked)
    vpnAvailable: boolean | undefined,
    onChange: (mode: IPhoneConnectionMode) => void
}) => <Group role='radiogroup' aria-label='How to connect the iPhone'>
    <Option>
        <Radio
            name='iphone-connection-mode'
            value='vpn'
            checked={props.mode === 'vpn'}
            onChange={() => props.onChange('vpn')}
        />
        <OptionBody>
            <Dot aria-hidden={true} />
            <OptionText>
                <OptionTitle>
                    <ShieldCheck size={20} aria-hidden={true} />
                    Capture all apps (VPN)
                    { props.vpnAvailable === true && <Tag>Recommended</Tag> }
                    { props.vpnAvailable === false && <Tag>Not in this build</Tag> }
                </OptionTitle>
                <Description>
                    Also catches Flutter apps, games and apps with their own connections.
                    Needs the free WireGuard app on the iPhone.
                </Description>
            </OptionText>
        </OptionBody>
    </Option>
    <Option>
        <Radio
            name='iphone-connection-mode'
            value='proxy'
            checked={props.mode === 'proxy'}
            onChange={() => props.onChange('proxy')}
        />
        <OptionBody>
            <Dot aria-hidden={true} />
            <OptionText>
                <OptionTitle>
                    <WifiHigh size={20} aria-hidden={true} />
                    Wi-Fi proxy
                </OptionTitle>
                <Description>
                    No extra app. Only apps that follow the iPhone's Wi-Fi proxy are captured.
                </Description>
            </OptionText>
        </OptionBody>
    </Option>
</Group>;
