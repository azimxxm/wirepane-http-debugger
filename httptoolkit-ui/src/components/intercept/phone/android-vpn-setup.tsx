import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { Info, Power } from '@phosphor-icons/react';

import { styled } from '../../../styles';
import { VpnModeStore } from '../../../model/interception/vpn-mode';
import { isAndroidPeer, startAndroidVpn } from '../../../model/interception/android-vpn';
import { CERTIFICATE_PAGE_URL, CHECK_PAGE_URL } from '../../../model/interception/phone-setup';

import { ActionButton } from '../../common/action-button';
import {
    Card,
    CardRow,
    CardTitle,
    CopyButton,
    MenuPath,
    Mono,
    Note,
    SetupStep,
    SetupSteps
} from './phone-setup-parts';
import { VpnConfigQrCode, VpnConfigText } from './vpn-config-qr';
import { VpnDevices } from './vpn-devices';
import { VpnProblem } from './vpn-problem';
import { AndroidVpnStatus } from './android-vpn-status';

// WireGuard's own Android app, published by the WireGuard project
const WIREGUARD_PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.wireguard.android';

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
 * Step 2: start the tunnel, then the QR code for the WireGuard app (or, if the phone was set
 * up before, a note that its tunnel still works).
 */
const StartStepContent = observer((props: { store: VpnModeStore }) => {
    const { store } = props;
    const { busy, peerConfig } = store;
    const problem = store.setupError ?? store.serverProblem;
    const androidSetUp = store.peers.some(isAndroidPeer);

    return <>
        { !store.running && <>
            <p>Wirepane starts a VPN server on this computer and makes a QR code for the phone.</p>
            <ButtonRow>
                <ActionButton
                    variant='primary'
                    icon='Play'
                    disabled={!!busy}
                    onClick={() => { startAndroidVpn(store); }}
                >
                    { busy === 'starting' || busy === 'adding-device' ? 'Starting…' : 'Start VPN capture' }
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
                { androidSetUp
                    ? ' Your Android phone was set up before, so the tunnel in WireGuard still works: just turn it on (step 3). To set up another phone, make a new QR code.'
                    : ' No Android phone is set up yet.'
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
            The phone connects to <Mono>{ metadata.endpointHost }</Mono>
            { port && <>, UDP port <Mono>{ port }</Mono></> }.
        </p>
        : null;
});

/**
 * The VPN way to connect an Android phone: what it is, the live status, the setup steps,
 * the devices on the tunnel, the note on which apps show their HTTPS, and the reminder to
 * turn the VPN off.
 */
export const AndroidVpnSetup = observer((props: {
    store: VpnModeStore,
    // Why some apps show hosts only, which the page also shows for its other ways to connect
    httpsNote: React.ReactNode,
    onViewRequests: () => void
}) => {
    const { store } = props;

    return <>
        <CardRow sideWidth={360}>
            <Card aria-labelledby='android-vpn-heading'>
                <CardTitle id='android-vpn-heading'>Capture all apps with a VPN</CardTitle>
                <p>
                    Wirepane runs a WireGuard VPN on this computer. The phone sends all of its
                    traffic through it, so apps that ignore a Wi-Fi proxy show up too.
                </p>
                <p>The phone has to be on the same Wi-Fi network as this computer.</p>
                <TunnelAddress store={store} />
            </Card>

            <AndroidVpnStatus store={store} onViewRequests={props.onViewRequests} />
        </CardRow>

        <Card aria-labelledby='android-vpn-steps-heading'>
            <CardTitle id='android-vpn-steps-heading'>Set up the Android phone</CardTitle>
            <SetupSteps>
                <SetupStep number={1} title='Install WireGuard on the phone'>
                    <p>
                        Get the free <strong>WireGuard</strong> app from Google Play.{ ' ' }
                        <a href={WIREGUARD_PLAY_STORE_URL} target='_blank' rel='noreferrer noopener'>
                            Open it on Google Play
                        </a>
                    </p>
                </SetupStep>
                <SetupStep number={2} title='Start the VPN and scan the QR code'>
                    <StartStepContent store={store} />
                </SetupStep>
                <SetupStep number={3} title='Add the tunnel in WireGuard'>
                    <MenuPath items={['WireGuard', '+', 'Scan from QR code']} />
                    <p>
                        Scan the QR code, name the tunnel Wirepane and turn it on. Tap OK when
                        Android asks to allow the VPN connection. Android runs one VPN at a time,
                        so turn off any other, like the HTTP Toolkit app's, first.
                    </p>
                </SetupStep>
                <SetupStep number={4} title='Install the certificate'>
                    <p>
                        With the tunnel on, open <Mono>{ CERTIFICATE_PAGE_URL }</Mono> <CopyButton
                            value={CERTIFICATE_PAGE_URL}
                            label='the certificate page address'
                        /> in Chrome, then install the downloaded file:
                    </p>
                    <MenuPath items={[
                        'Settings',
                        'Security',
                        'Encryption & credentials',
                        'Install a certificate',
                        'CA certificate'
                    ]} />
                    <p>
                        Menu names differ between phone makers. Android asks for the screen lock
                        and warns about the certificate: choose Install anyway.
                    </p>
                </SetupStep>
                <SetupStep number={5} title='Check it works'>
                    <p>
                        Open <Mono>{ CHECK_PAGE_URL }</Mono> in Chrome. It should say
                        "You're being intercepted by Wirepane".
                    </p>
                </SetupStep>
            </SetupSteps>
        </Card>

        <VpnDevices store={store} />

        { props.httpsNote }

        <Note
            icon={<Power size={18} aria-hidden={true} />}
            title="When you're done, turn the VPN off"
        >
            <p>
                Switch the tunnel off in the WireGuard app. Otherwise the phone has no internet
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
 * build without it). The other ways to connect keep working.
 */
export const AndroidVpnUnavailableNote = (props: { onUseOtherWays: () => void }) => <Note
    icon={<Info size={18} aria-hidden={true} />}
    title="VPN mode isn't available in this build"
>
    <p>
        This version of Wirepane doesn't include the VPN tunnel yet. You can still connect the
        phone with the HTTP Toolkit app, ADB or a manual Wi-Fi proxy.
    </p>
    <ButtonRow>
        <ActionButton onClick={props.onUseOtherWays}>Show the other ways</ActionButton>
    </ButtonRow>
</Note>;
