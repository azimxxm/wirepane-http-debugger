import * as React from 'react';
import { QRCodeSVG } from 'qrcode.react';

import { styled } from '../../../styles';

import { CopyButton } from './phone-setup-parts';

const Figure = styled.figure`
    flex-shrink: 0;
    width: 240px;
    max-width: 100%;

    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;

    > figcaption {
        font-size: ${p => p.theme.smallPrintSize};
        line-height: 1.4;
        text-align: center;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

// Always dark on white, in every theme: that's what phone cameras read reliably
const Frame = styled.div`
    display: flex;
    width: 100%;
    box-sizing: border-box;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: #FFFFFF;

    > svg {
        width: 100%;
        height: auto;
    }
`;

/**
 * The WireGuard configuration as a QR code, which the WireGuard app scans to add the tunnel.
 */
export const VpnConfigQrCode = (props: { config: string, deviceName: string }) => <Figure>
    <Frame>
        <QRCodeSVG
            value={props.config}
            size={232}
            level='L'
            marginSize={2}
            bgColor='#FFFFFF'
            fgColor='#0A1222'
            role='img'
            aria-label={`QR code with the WireGuard configuration for ${props.deviceName}`}
        />
    </Frame>
    <figcaption>
        Scan this in the WireGuard app (step 3). It holds this device's private key, so keep it to yourself.
    </figcaption>
</Figure>;

const TextDetails = styled.details`
    > summary {
        cursor: pointer;
        width: fit-content;
        border-radius: 4px;
        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 500;
        color: ${p => p.theme.mainColor};
    }

    > summary:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: 2px;
    }
`;

const ConfigText = styled.pre`
    margin: 8px 0;
    padding: 10px 12px;
    max-height: 220px;
    overflow: auto;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
    background-color: ${p => p.theme.mainLowlightBackground};

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.5;
    color: ${p => p.theme.mainColor};
    user-select: all;
    overflow-wrap: anywhere;
    white-space: pre-wrap;
`;

/**
 * The same configuration as text, for pasting into WireGuard when the camera isn't an option.
 */
export const VpnConfigText = (props: { config: string }) => <TextDetails>
    <summary>Show the configuration as text</summary>
    <ConfigText tabIndex={0} aria-label='WireGuard configuration'>{ props.config }</ConfigText>
    <CopyButton value={props.config} label='the WireGuard configuration' />
</TextDetails>;
