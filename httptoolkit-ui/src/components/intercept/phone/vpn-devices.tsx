import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { DeviceMobile } from '@phosphor-icons/react';

import { styled } from '../../../styles';
import {
    describePeerActivity,
    getPeerState,
    VpnModeStore
} from '../../../model/interception/vpn-mode';

import { ActionButton } from '../../common/action-button';
import { appHistory } from '../../../routing'; // wirepane: the Network tools link
import { Card, CardTitle, Mono } from './phone-setup-parts';
import { VpnProblem } from './vpn-problem';

const DeviceList = styled.ul`
    list-style: none;
    margin: 0;
    padding: 0;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
`;

const DeviceRow = styled.li`
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 10px 12px;

    & + & {
        border-top: 1px solid ${p => p.theme.containerBorder};
    }
`;

const DeviceIcon = styled.span<{ connected: boolean }>`
    flex-shrink: 0;
    display: flex;
    color: ${p => p.connected ? p.theme.popColor : p.theme.mainLowlightColor};
`;

const DeviceText = styled.div`
    flex: 1 1 auto;
    min-width: 0;

    line-height: 1.4;

    > strong {
        display: block;
        font-weight: 600;
        color: ${p => p.theme.mainColor};
        overflow-wrap: anywhere;
    }

    > span {
        display: block;
        font-size: ${p => p.theme.textInputFontSize};
        color: ${p => p.theme.mainLowlightColor};
    }
`;

/**
 * The devices the VPN knows (every QR code that was scanned), with a way to remove the ones
 * that aren't used any more. Only shown while the tunnel runs: that's when the server lists them.
 */
export const VpnDevices = observer((props: { store: VpnModeStore }) => {
    const { store } = props;
    if (!store.running || store.peers.length === 0) return null;

    return <Card aria-labelledby='iphone-vpn-devices-heading'>
        <CardTitle id='iphone-vpn-devices-heading'>Devices set up for the VPN</CardTitle>
        <p>
            Remove the ones you don't use any more. A removed device loses its VPN: to use it
            again, set it up with a new QR code.
        </p>
        <DeviceList aria-label='VPN devices'>
            { store.peers.map((peer) => {
                const connected = getPeerState(peer, store.observedAt) === 'connected';

                return <DeviceRow key={peer.peer}>
                    <DeviceIcon connected={connected}>
                        <DeviceMobile size={24} weight={connected ? 'fill' : 'regular'} aria-hidden={true} />
                    </DeviceIcon>
                    <DeviceText>
                        <strong>{ peer.name }</strong>
                        <span>
                            { peer.tunnelIp && <><Mono>{ peer.tunnelIp }</Mono>{ ' · ' }</> }
                            { describePeerActivity(peer, store.observedAt) }
                        </span>
                    </DeviceText>
                    <ActionButton
                        icon='Trash'
                        disabled={!!store.busy}
                        aria-label={`Remove ${peer.name}`}
                        onClick={() => { store.removeDevice(peer); }}
                    >
                        Remove
                    </ActionButton>
                </DeviceRow>;
            }) }
        </DeviceList>
        { store.deviceError && <VpnProblem message={store.deviceError} /> }
        {/* wirepane: DNS, UDP, TLS, conditions and captures of these devices */}
        <p>
            <ActionButton icon='ArrowRight' onClick={() => { appHistory.navigate('/network'); }}>
                Network tools
            </ActionButton>
        </p>
    </Card>;
});
