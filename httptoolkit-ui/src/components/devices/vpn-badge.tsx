import { ShieldCheck } from '@phosphor-icons/react';

import { styled } from '../../styles';

/**
 * The small "VPN" tag next to the name of a device in the Devices panel that connected
 * through Wirepane's VPN.
 */
export const VpnBadge = styled.span`
    flex-shrink: 0;
    padding: 0 4px;
    border-radius: 3px;
    border: 1px solid ${p => p.theme.containerBorder};

    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 600;
    line-height: 14px;
    color: ${p => p.theme.mainLowlightColor};
`;

/**
 * The same marker for the list's Device cell, which is too narrow for the word, and where a
 * second item would cut the device's name short. So it sits on the corner of the device's icon.
 * The cell's tooltip says what it is.
 */
export const VpnShield = styled(ShieldCheck)`
    position: absolute;
    right: -4px;
    bottom: -3px;
    color: ${p => p.theme.popColor};
`;
