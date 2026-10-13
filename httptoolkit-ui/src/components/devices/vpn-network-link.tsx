import * as React from 'react';

import { styled } from '../../styles';
import { appHistory } from '../../routing';

const LinkButton = styled.button`
    flex-shrink: 0;
    appearance: none;
    background: none;
    border: none;
    padding: 0 2px;

    font: inherit;
    font-size: ${p => p.theme.tinyTextSize};
    line-height: 14px;
    color: ${p => p.theme.linkColor};
    cursor: pointer;
    text-decoration: underline;

    &:hover {
        color: ${p => p.theme.mainColor};
    }

    &:focus-visible {
        outline: 2px solid ${p => p.theme.popColor};
        outline-offset: 1px;
    }
`;

/**
 * "Network" next to a VPN device in the Devices panel: opens the Network page (DNS, UDP, TLS,
 * conditions, captures). It stops the click and keys, so the row itself isn't selected too.
 */
export const VpnNetworkLink = (props: { deviceName: string }) => <LinkButton
    type='button'
    title={`Network tools for ${props.deviceName}: DNS, UDP, TLS, conditions and captures`}
    aria-label={`Network tools for ${props.deviceName}`}
    onClick={(event) => {
        event.stopPropagation();
        appHistory.navigate('/network');
    }}
    onKeyDown={(event) => event.stopPropagation()}
>
    Network
</LinkButton>;
