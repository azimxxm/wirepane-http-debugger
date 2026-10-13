import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { Info, Power } from '@phosphor-icons/react';

import { styled } from '../../../styles';
import { isAndroidPeer, startIPhoneVpn, VpnModeStore } from '../../../model/interception/vpn-mode';

import { ActionButton } from '../../common/action-button';
import {
    Card,
    CardRow,
    CardTitle,
    MenuPath,
    Mono,
    Note,
    SetupStep,
    SetupSteps
} from './phone-setup-parts';
import { VpnConfigQrCode, VpnConfigText } from './vpn-config-qr';
import { VpnDevices } from './vpn-devices';
import { VpnProblem } from './vpn-problem';
import { VpnStatus } from './vpn-status';

// WireGuard's own iOS app, published by the WireGuard project
const WIREGUARD_APP_STORE_URL = 'https://apps.apple.com/app/wireguard/id1441195209';

// The certificate steps the page adds come after these three
export const VPN_STEPS_BEFORE_CERTIFICATE = 3;

const QrRow = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    gap: 16px 24px;
    padding-top: 6px;
`;

const QrSide = styled.div`
    flex: 1 1 220px;
    min-width: 0;

    > * + * {
        margin-top: 8px;
    }
`;

const ButtonRow = styled.div`
    padding-top: 4px;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
`;

const portOf = (listen: string | undefined) => listen?.match(/:(\d+)$/)?.[1];

/**
 * Step 2: start the tunnel, then the QR code for the WireGuard app (or, if the iPhone was
 * set up before, a note that its tunnel still works).
 */
const StartStepContent = observer((props: { store: VpnModeStore }) => {
    const { store } = props;
    const { busy, peerConfig } = store;
    const problem = store.setupError ?? store.serverProblem;

    return <>
        { !store.running && <>
            <p>Wirepane starts a VPN server on this computer and makes a QR code for the iPhone.</p>
            <ButtonRow>
                <ActionButton
                    variant='primary'
                    icon='Play'
                    disabled={!!busy}
                    onClick={() => { startIPhoneVpn(store); }}
                >
                    { busy === 'starting' ? 'Starting…' : 'Start VPN capture' }
                </ActionButton>
            </ButtonRow>
        </> }

        { store.running && peerConfig && <QrRow>
            <VpnConfigQrCode config={peerConfig.config} deviceName={peerConfig.name} />
            <QrSide>
                <p>
                    The VPN is running. This QR code sets up <strong>{ peerConfig.name }</strong>
                    { peerConfig.tunnelIp && <> (<Mono>{ peerConfig.tunnelIp }</Mono> inside the tunnel)</> }.
                </p>
                <VpnConfigText config={peerConfig.config} />
            </QrSide>
        </QrRow> }

        { store.running && !peerConfig && <>
            <p>
                The VPN is running.
                { store.peers.some((peer) => !isAndroidPeer(peer))
                    ? ' Your iPhone was set up before, so the tunnel in WireGuard still works: just turn it on (step 3). To set up another device, make a new QR code.'
                    : ' No device is set up yet.'
                }
            </p>
            <ButtonRow>
                <ActionButton
                    icon='Plus'
                    disabled={!!busy}
                    onClick={() => { store.addDevice(); }}
                >
                    { busy === 'adding-device' ? 'Making the QR code…' : 'Show a new QR code' }
                </ActionButton>
            </ButtonRow>
        </> }

        { problem && <VpnProblem message={problem} /> }
    </>;
});

const TunnelAddress = observer((props: { store: VpnModeStore }) => {
    const metadata = props.store.metadata;
    const port = portOf(metadata?.listen);

    return props.store.running && metadata?.endpointHost
        ? <p>
            The iPhone connects to <Mono>{ metadata.endpointHost }</Mono>
            { port && <>, UDP port <Mono>{ port }</Mono></> }.
        </p>
        : null;
});

/**
 * The VPN way to connect an iPhone: what it is, the live status, the setup steps (the page
 * adds its certificate steps after step 3) and the reminder to turn the VPN off.
 */
export const VpnSetup = observer((props: {
    store: VpnModeStore,
    certificateSteps: React.ReactNode,
    onViewRequests: () => void
}) => {
    const { store } = props;

    return <>
        <CardRow sideWidth={360}>
            <Card aria-labelledby='iphone-vpn-heading'>
                <CardTitle id='iphone-vpn-heading'>Capture all apps with a VPN</CardTitle>
                <p>
                    Wirepane runs a WireGuard VPN on this computer. The iPhone sends all of its
                    traffic through it, so apps that ignore the Wi-Fi proxy show up too.
                </p>
                <p>The iPhone has to be on the same Wi-Fi network as this computer.</p>
                <TunnelAddress store={store} />
            </Card>

            <VpnStatus store={store} onViewRequests={props.onViewRequests} />
        </CardRow>

        <Card aria-labelledby='iphone-vpn-steps-heading'>
            <CardTitle id='iphone-vpn-steps-heading'>Set up the iPhone</CardTitle>
            <SetupSteps>
                <SetupStep number={1} title='Install WireGuard on the iPhone'>
                    <p>
                        Get the free <strong>WireGuard</strong> app from the App Store.{ ' ' }
                        <a href={WIREGUARD_APP_STORE_URL} target='_blank' rel='noreferrer noopener'>
                            Open it on the App Store
                        </a>
                    </p>
                </SetupStep>
                <SetupStep number={2} title='Start the VPN and scan the QR code'>
                    <StartStepContent store={store} />
                </SetupStep>
                <SetupStep number={3} title='Add the tunnel in WireGuard'>
                    <MenuPath items={['WireGuard', '+', 'Create from QR code']} />
                    <p>
                        Scan the QR code, name the tunnel Wirepane, and tap Allow when iOS asks
                        to add a VPN configuration. Then turn the tunnel on.
                    </p>
                </SetupStep>
                { props.certificateSteps }
            </SetupSteps>
        </Card>

        <VpnDevices store={store} />

        <Note
            icon={<Power size={18} aria-hidden={true} />}
            title="When you're done, turn the VPN off"
        >
            <p>
                Switch the tunnel off in the WireGuard app. Otherwise the iPhone has no internet
                while Wirepane isn't running. The certificate can stay installed for next time.
            </p>
            { store.running && <ButtonRow>
                <ActionButton
                    disabled={!!store.busy}
                    onClick={() => { store.stop(); }}
                >
                    { store.busy === 'stopping' ? 'Stopping…' : 'Stop VPN capture' }
                </ActionButton>
            </ButtonRow> }
        </Note>
    </>;
});

/**
 * Shown in place of the VPN steps when the server has no VPN tunnel (an older server, or a
 * build without it). The proxy way keeps working.
 */
export const VpnUnavailableNote = (props: { onUseProxy: () => void }) => <Note
    icon={<Info size={18} aria-hidden={true} />}
    title="VPN mode isn't available in this build"
>
    <p>
        This version of Wirepane doesn't include the VPN tunnel yet. You can still connect the
        iPhone with the Wi-Fi proxy.
    </p>
    <ButtonRow>
        <ActionButton onClick={props.onUseProxy}>Use the Wi-Fi proxy</ActionButton>
    </ButtonRow>
</Note>;

export const VpnChecking = () => <Card aria-label='Checking VPN mode'>
    <p role='status'>Checking what this build supports…</p>
</Card>;
