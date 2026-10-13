import * as React from 'react';
import { inject } from 'mobx-react';
// The lite observer keeps this a function component, so hooks work inside inject()
import { observer } from 'mobx-react-lite';
import { QRCodeSVG } from 'qrcode.react';

import { styled } from '../../../styles';
import { saveFile } from '../../../util/ui';
import { activateInterceptor } from '../../../services/server-api';
import { ProxyStore } from '../../../model/proxy-store';
import { CHECK_PAGE_URL } from '../../../model/interception/phone-setup';
import { VPN_INTERCEPTOR_ID } from '../../../model/interception/vpn-mode';

import { ActionButton } from '../../common/action-button';
import { CopyButton, MenuPath, Mono, SetupStep, SetupSteps } from './phone-setup-parts';

// IKEv2 mode: iOS's built-in VPN, set up by one .mobileconfig profile (the Wirepane CA
// plus the VPN). The server builds the profile (httptoolkit-server/src/interceptors/
// wireguard-vpn-ikev2.ts) and the sidecar's IKEv2 front-end serves the VPN
// (wirepane-tunnel/docs/ikev2.md).

export const IKEV2_PROFILE_ACTION = 'ikev2-profile';
export const IKEV2_PROFILE_FILENAME = 'Wirepane-VPN.mobileconfig';
export const IKEV2_PROFILE_MIME_TYPE = 'application/x-apple-aspen-config';
const DEFAULT_DEVICE_NAME = 'iPhone';

// What the server answers to { action: 'ikev2-profile', name }
export interface Ikev2ProfileAnswer {
    peer: string;
    name: string;
    // The .mobileconfig XML. It holds the device's secret: it stays in memory, never in storage.
    profile: string;
    // A one-time download link on the Mac's LAN address, for Safari on the iPhone
    link?: string;
}

// Only the exact link shape the server makes is shown as a QR code
const PROFILE_LINK_PATTERN = /^http:\/\/\d{1,3}(\.\d{1,3}){3}:\d{1,5}\/[0-9a-f]{32}\.mobileconfig$/;

export function parseIkev2ProfileAnswer(raw: unknown): Ikev2ProfileAnswer | undefined {
    if (!raw || typeof raw !== 'object') return undefined;
    const { peer, name, profile, link } = raw as Record<string, unknown>;
    if (typeof peer !== 'string' || typeof name !== 'string' || typeof profile !== 'string') return undefined;
    if (!profile.includes('<plist')) return undefined;
    return {
        peer,
        name,
        profile,
        link: typeof link === 'string' && PROFILE_LINK_PATTERN.test(link) ? link : undefined
    };
}

// A server without IKEv2 support turns the action down by name; a sidecar started without
// --ikev2 (or whose UDP 500 was taken) says IKEv2 isn't running
export function isIkev2Unsupported(error: unknown): boolean {
    const message = String((error as { message?: unknown } | undefined)?.message ?? '');
    return /unknown wireguard-vpn action/i.test(message) || /ikev2 is not (available|supported|running)/i.test(message);
}

type ProfileState =
    | { kind: 'idle' }
    | { kind: 'creating' }
    | { kind: 'ready', answer: Ikev2ProfileAnswer }
    | { kind: 'unsupported' }
    | { kind: 'failed', message: string };

const Actions = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-top: 6px;
`;

const Problem = styled.p`
    color: ${p => p.theme.warning};
`;

const ProfileLayout = styled.div`
    display: flex;
    gap: 24px;
    align-items: flex-start;
    margin-top: 6px;

    @media (max-width: 760px) {
        flex-direction: column;
    }
`;

const QrFrame = styled.figure`
    flex-shrink: 0;
    width: 200px;
    max-width: 100%;

    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;

    > div {
        display: flex;
        width: 100%;
        box-sizing: border-box;
        padding: 4px;
        border-radius: 8px;
        border: 1px solid ${p => p.theme.containerBorder};
        background-color: #FFFFFF; /* Dark on white in every theme: what phone cameras read */
    }

    > div > svg {
        width: 100%;
        height: auto;
    }

    > figcaption {
        font-size: ${p => p.theme.smallPrintSize};
        line-height: 1.4;
        text-align: center;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const ProfileLinkQr = (props: { link: string }) => <QrFrame>
    <div>
        <QRCodeSVG
            value={props.link}
            size={192}
            level='L'
            marginSize={2}
            bgColor='#FFFFFF'
            fgColor='#0A1222'
            role='img'
            aria-label='QR code with the one-time profile link'
        />
    </div>
    <figcaption>
        Scan with the iPhone's Camera, then open it in Safari. Works once, for 10 minutes.
    </figcaption>
</QrFrame>;

const GetProfileStep = (props: {
    state: ProfileState,
    onCreate: () => void
}) => {
    const { state } = props;

    if (state.kind === 'ready') {
        const { answer } = state;
        return <ProfileLayout>
            <div>
                <p>
                    The profile for <strong>{ answer.name }</strong> is ready. AirDrop is the safest
                    way: save it here, then in Finder right-click it › Share › AirDrop.
                </p>
                <Actions>
                    <ActionButton
                        icon='DownloadSimple'
                        onClick={() => saveFile(IKEV2_PROFILE_FILENAME, IKEV2_PROFILE_MIME_TYPE, answer.profile)}
                    >
                        Save profile (.mobileconfig)
                    </ActionButton>
                </Actions>
                { answer.link && <p>
                    Or open <Mono>{ answer.link }</Mono> <CopyButton
                        value={answer.link}
                        label='the profile link'
                    /> in Safari on the iPhone. It's plain HTTP on this Wi-Fi, so only use it on a
                    network you trust.
                </p> }
                <p>The profile holds this device's key. Don't share it.</p>
            </div>
            { answer.link && <ProfileLinkQr link={answer.link} /> }
        </ProfileLayout>;
    }

    return <>
        <p>
            Wirepane makes one profile per device. It installs the Wirepane CA and the VPN
            together.
        </p>
        <Actions>
            <ActionButton
                variant='primary'
                icon='Plus'
                disabled={state.kind === 'creating' || state.kind === 'unsupported'}
                onClick={props.onCreate}
            >
                { state.kind === 'creating' ? 'Creating the profile…' : 'Create the profile' }
            </ActionButton>
        </Actions>
        { state.kind === 'unsupported' && <Problem role='status'>
            This build of Wirepane can't run the IKEv2 VPN yet. Use "Capture all apps (VPN)"
            with the WireGuard app for now.
        </Problem> }
        { state.kind === 'failed' && <Problem role='alert'>
            Couldn't create the profile: { state.message }
        </Problem> }
    </>;
};

/**
 * The steps for IKEv2 mode: get the profile onto the iPhone, install it, trust the CA,
 * connect. Nothing is created until the button is pressed, because every profile is a
 * new VPN device.
 */
export const VpnIkev2Setup = inject('proxyStore')(observer((props: {
    proxyStore?: ProxyStore,
    // Tests pass their own server call
    requestProfile?: (proxyPort: number, name: string) => Promise<unknown>
}) => {
    const proxyStore = props.proxyStore!;
    const requestProfile = props.requestProfile ?? ((proxyPort: number, name: string) =>
        activateInterceptor(VPN_INTERCEPTOR_ID, proxyPort, { action: IKEV2_PROFILE_ACTION, name })
    );
    const [state, setState] = React.useState<ProfileState>({ kind: 'idle' });

    // A request that finishes after the steps were closed mustn't set state
    const mounted = React.useRef(true);
    React.useEffect(() => () => { mounted.current = false; }, []);

    const create = React.useCallback(async () => {
        setState({ kind: 'creating' });
        try {
            const answer = parseIkev2ProfileAnswer(await requestProfile(proxyStore.httpProxyPort, DEFAULT_DEVICE_NAME));
            if (!mounted.current) return;
            setState(answer
                ? { kind: 'ready', answer }
                : { kind: 'failed', message: 'the server sent something that is not a profile.' }
            );
        } catch (error) {
            if (!mounted.current) return;
            setState(isIkev2Unsupported(error)
                ? { kind: 'unsupported' }
                : { kind: 'failed', message: String((error as Error)?.message ?? error) }
            );
        }
    }, [requestProfile, proxyStore]);

    return <SetupSteps>
        <SetupStep number={1} title='Get the profile onto the iPhone'>
            <GetProfileStep state={state} onCreate={create} />
        </SetupStep>
        <SetupStep number={2} title='Install the profile'>
            <MenuPath items={['Settings', 'Profile Downloaded', 'Install']} />
            <p>It shows as "Wirepane VPN" and asks for the iPhone's passcode.</p>
        </SetupStep>
        <SetupStep number={3} title='Trust the certificate for HTTPS'>
            <MenuPath items={['Settings', 'General', 'About', 'Certificate Trust Settings']} />
            <p>Turn on full trust for <strong>Wirepane CA</strong>.</p>
        </SetupStep>
        <SetupStep number={4} title='Connect'>
            <MenuPath items={['Settings', 'VPN', 'Wirepane']} />
            <p>
                Then open <Mono>{ CHECK_PAGE_URL }</Mono> in Safari: it should say "You're
                being intercepted by Wirepane".
            </p>
        </SetupStep>
        <SetupStep number={5} title='When you are done'>
            <p>
                Turn the VPN off in Settings › VPN. Remove the profile in Settings › General ›
                VPN & Device Management when you no longer need it.
            </p>
        </SetupStep>
    </SetupSteps>;
}));
