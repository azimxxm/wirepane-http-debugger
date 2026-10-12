import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { CheckCircle, Info } from '@phosphor-icons/react';

import { styled, css, keyframes } from '../../../styles';
import { formatHandshakeAge, VpnModeStore } from '../../../model/interception/vpn-mode';

import { ActionButton } from '../../common/action-button';
import { Mono } from './phone-setup-parts';

const Root = styled.section<{ connected: boolean }>`
    box-sizing: border-box;
    padding: 20px;
    min-width: 0;

    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 12px 14px;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.connected ? p.theme.popColor : p.theme.containerBorder};
    border-radius: 8px;
    transition: border-color 0.15s;
`;

const waitingPulse = keyframes`
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
`;

const pulse = css`
    animation: ${waitingPulse} 1.6s ease-in-out infinite;

    @media (prefers-reduced-motion: reduce) {
        animation: none;
    }
`;

const Dot = styled.span<{ waiting: boolean }>`
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    margin: 4px 4px 0;
    border-radius: 50%;
    background-color: ${p => p.theme.containerWatermark};

    ${p => p.waiting && pulse}
`;

const StateIcon = styled.span<{ connected: boolean }>`
    flex-shrink: 0;
    display: flex;
    color: ${p => p.connected ? p.theme.popColor : p.theme.mainLowlightColor};
`;

const Text = styled.div`
    flex: 1 1 200px;
    min-width: 0;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};

    > * + * {
        margin-top: 4px;
    }
`;

const Title = styled.h2`
    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.3;
    color: ${p => p.theme.mainColor};
`;

/**
 * Live state of the tunnel and the phone: off, waiting for the iPhone, connected (with how
 * long ago its last handshake was), or quiet for a while.
 */
export const VpnStatus = observer((props: {
    store: VpnModeStore,
    onViewRequests: () => void
}) => {
    const { store } = props;
    const peer = store.trackedPeer;
    const deviceName = peer?.name ?? 'iPhone';
    const age = store.handshakeAgeMs;
    const lastHandshake = age === undefined ? undefined : formatHandshakeAge(age);

    const state = !store.running ? 'off' : store.phoneState;
    const connected = state === 'connected';

    return <Root connected={connected} aria-label='VPN connection status'>
        { connected
            ? <StateIcon connected={true}><CheckCircle size={24} weight='fill' aria-hidden={true} /></StateIcon>
            : state === 'quiet'
                ? <StateIcon connected={false}><Info size={24} aria-hidden={true} /></StateIcon>
                : <Dot waiting={state === 'waiting'} aria-hidden={true} />
        }
        <Text>
            <div role='status'>
                <Title>
                    { state === 'off' && 'VPN capture is off' }
                    { state === 'waiting' && 'Waiting for the iPhone…' }
                    { state === 'connected' && `${deviceName} connected over VPN` }
                    { state === 'quiet' && `${deviceName} has gone quiet` }
                </Title>
            </div>
            { state === 'off' && <p>Start it in step 2. Nothing is captured until then.</p> }
            { state === 'waiting' && <p>
                Turn the tunnel on in the WireGuard app (step 3). This updates by itself.
            </p> }
            { (connected || state === 'quiet') && <p>
                (last handshake { lastHandshake }){ peer?.endpoint && <>
                    { ' · ' }<Mono>{ peer.endpoint.replace(/:\d+$/, '') }</Mono>
                </> }
            </p> }
            { state === 'quiet' && <p>
                Check that the tunnel is still on in WireGuard, and that the iPhone is on the same Wi-Fi.
            </p> }
        </Text>
        { connected && <ActionButton
            variant='primary'
            icon='Rows'
            shortcut='Cmd+2'
            title='Show the captured requests'
            onClick={props.onViewRequests}
        >
            View requests
        </ActionButton> }
    </Root>;
});
