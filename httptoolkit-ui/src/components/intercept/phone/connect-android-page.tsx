import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { Power } from '@phosphor-icons/react';

import { styled } from '../../../styles';
import { logError } from '../../../errors';
import { appHistory } from '../../../routing';

import { ProxyStore } from '../../../model/proxy-store';
import { EventsStore } from '../../../model/events/events-store';
import { InterceptorStore } from '../../../model/interception/interceptor-store';
import { Interceptor } from '../../../model/interception/interceptors';
import { CERTIFICATE_PAGE_URL } from '../../../model/interception/phone-setup';

import { ActionButton } from '../../common/action-button';
import { AndroidDeviceCustomUi } from '../config/android-device-config';
import { AndroidAdbCustomUi } from '../config/android-adb-config';
import {
    Card,
    CardTitle,
    CopyButton,
    MenuPath,
    Mono,
    Note,
    PhoneSetupLayout,
    PhoneStatus,
    ProxyAddressValues,
    SetupStep,
    SetupSteps,
    useConnectedPhone,
    useLanAddresses
} from './phone-setup-parts';

const QR_INTERCEPTOR_ID = 'android-device';
const ADB_INTERCEPTOR_ID = 'android-adb';
const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=tech.httptoolkit.android.v1';

const NETWORK_SECURITY_CONFIG = `<!-- res/xml/network_security_config.xml -->
<network-security-config>
    <debug-overrides>
        <trust-anchors>
            <certificates src="user" />
        </trust-anchors>
    </debug-overrides>
</network-security-config>

<!-- AndroidManifest.xml -->
<application android:networkSecurityConfig="@xml/network_security_config" ...>`;

const OptionGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    align-items: stretch;

    @media (max-width: 1000px) {
        grid-template-columns: minmax(0, 1fr);
    }
`;

const OptionLabel = styled.span`
    display: block;
    margin-bottom: 2px;

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

// The embedded QR config grows its code to fill the space it's given
const QrConfigFrame = styled.div`
    height: 430px;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainColor};
`;

const AdbConfigFrame = styled.div`
    padding: 12px 15px 0;
    border-top: 1px solid ${p => p.theme.containerBorder};

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainColor};
`;

const StatusLine = styled.p`
    font-size: ${p => p.theme.textInputFontSize};
`;

const ErrorLine = styled.p`
    font-size: ${p => p.theme.textInputFontSize};

    && {
        color: ${p => p.theme.error};
    }
`;

const CodeBlock = styled.pre`
    margin: 0;
    padding: 12px 14px;
    overflow-x: auto;

    background-color: ${p => p.theme.mainLowlightBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.5;
    color: ${p => p.theme.mainColor};
    white-space: pre;
`;

const ExplanationList = styled.ul`
    list-style: disc;
    padding-left: 20px;
    color: ${p => p.theme.mainLowlightColor};

    > li + li {
        margin-top: 8px;
    }

    > li > * + * {
        margin-top: 8px;
    }
`;

const CodeHeader = styled.div`
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
`;

const noop = () => {};

const QrOption = (props: { interceptor: Interceptor | undefined, hasNetwork: boolean }) => {
    const QrConfig = AndroidDeviceCustomUi.configComponent;
    const usable = !!props.interceptor?.isActivable && props.hasNetwork;

    return <Card aria-labelledby='android-qr-heading'>
        <header>
            <OptionLabel>Any device on your Wi-Fi · recommended</OptionLabel>
            <CardTitle id='android-qr-heading'>With the HTTP Toolkit app</CardTitle>
        </header>
        <p>
            Install <a href={PLAY_STORE_URL} target='_blank' rel='noreferrer noopener'>HTTP Toolkit
            from Google Play</a> on the phone, open it and tap Scan code. It sends the phone's
            traffic here through a VPN, and sets up the certificate.
        </p>
        { usable
            ? <QrConfigFrame>
                <QrConfig
                    interceptor={props.interceptor!}
                    activateInterceptor={() => Promise.resolve()}
                    reportStarted={noop}
                    // The status above flips by itself once the phone's traffic arrives
                    reportSuccess={noop}
                    closeSelf={noop}
                />
            </QrConfigFrame>
            : <StatusLine>{ props.hasNetwork
                ? 'Not available with this version of the server.'
                : "This computer isn't on a network yet, so there's no address for the phone to connect to."
            }</StatusLine>
        }
    </Card>;
};

const AdbOption = observer((props: {
    interceptor: Interceptor | undefined,
    interceptorStore: InterceptorStore
}) => {
    const { interceptor, interceptorStore } = props;
    const [open, setOpen] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>();

    const AdbConfig = AndroidAdbCustomUi.configComponent;
    const deviceCount: number = interceptor?.metadata?.deviceIds?.length ?? 0;

    const activate = (options: { deviceId: string }) => {
        setError(undefined);
        return interceptorStore.activateInterceptor(ADB_INTERCEPTOR_ID, options)
            .then(noop)
            .catch((e: any) => {
                logError(e);
                setError(e?.failureMessage ?? e?.message ?? 'Unknown error');
            });
    };

    return <Card aria-labelledby='android-adb-heading'>
        <header>
            <OptionLabel>USB cable or emulator</OptionLabel>
            <CardTitle id='android-adb-heading'>With ADB</CardTitle>
        </header>
        <p>
            Wirepane installs the HTTP Toolkit app and the certificate over ADB. On rooted devices
            and most emulators the certificate becomes a system certificate, so every app trusts it.
        </p>

        { !interceptor?.isSupported
            ? <StatusLine>Not available with this version of the server.</StatusLine>
        : interceptor.inProgress
            ? <StatusLine role='status'>Setting up the device… Accept any prompts on the phone.</StatusLine>
        : interceptor.isActivable
            ? <>
                <StatusLine role='status'>
                    { deviceCount === 1 ? '1 device' : `${deviceCount} devices` } found.
                </StatusLine>
                { open
                    ? <AdbConfigFrame>
                        <AdbConfig
                            interceptor={interceptor}
                            activateInterceptor={activate}
                            reportStarted={noop}
                            reportSuccess={noop}
                            closeSelf={() => setOpen(false)}
                        />
                    </AdbConfigFrame>
                    : <div>
                        <ActionButton icon='Plug' onClick={() => setOpen(true)}>
                            Intercept via ADB
                        </ActionButton>
                    </div>
                }
            </>
        : <StatusLine role='status'>
            No device found yet. Turn on USB debugging on the phone and plug it in, or start an
            emulator. This needs adb (Android platform-tools) on this computer. The list
            updates by itself.
        </StatusLine>
        }
        { error && <ErrorLine role='alert'>Couldn't set up the device: { error }</ErrorLine> }
    </Card>;
});

const ManualOption = (props: { addresses: ReturnType<typeof useLanAddresses>, port: number }) => {
    const server = props.addresses?.[0]?.address;

    return <Card aria-labelledby='android-manual-heading'>
        <header>
            <OptionLabel>Any device, no app</OptionLabel>
            <CardTitle id='android-manual-heading'>Manual proxy</CardTitle>
        </header>
        <ProxyAddressValues addresses={props.addresses} port={props.port} serverLabel='Hostname' />
        <SetupSteps>
            <SetupStep number={1} title='Set the proxy'>
                <MenuPath items={['Wi-Fi settings', 'your network', 'Edit', 'Proxy', 'Manual']} />
                <p>
                    Hostname <Mono>{ server ?? '…' }</Mono>, Port <Mono>{ props.port }</Mono>.
                    Menu names differ between phone makers.
                </p>
            </SetupStep>
            <SetupStep number={2} title='Install the certificate'>
                <p>
                    In Chrome, open <Mono>{ CERTIFICATE_PAGE_URL }</Mono> <CopyButton
                        value={CERTIFICATE_PAGE_URL}
                        label='the certificate page address'
                    />, then install the downloaded file:
                </p>
                <MenuPath items={[
                    'Settings',
                    'Security',
                    'Encryption & credentials',
                    'Install a certificate',
                    'CA certificate'
                ]} />
            </SetupStep>
        </SetupSteps>
    </Card>;
};

/**
 * Connect an Android phone or emulator: the HTTP Toolkit app via QR code, ADB, or a
 * manual proxy, plus what Android's certificate rules mean for HTTPS.
 */
export const ConnectAndroidPage = inject('proxyStore', 'eventsStore', 'interceptorStore')(observer((props: {
    proxyStore?: ProxyStore,
    eventsStore?: EventsStore,
    interceptorStore?: InterceptorStore,
    navigate?: (path: string) => void
}) => {
    const proxyStore = props.proxyStore!;
    const eventsStore = props.eventsStore!;
    const interceptorStore = props.interceptorStore!;
    const navigate = props.navigate ?? ((path: string) => { appHistory.navigate(path); });

    const addresses = useLanAddresses(proxyStore.externalNetworkAddresses);
    const phone = useConnectedPhone(eventsStore, 'android');
    const port = proxyStore.httpProxyPort;

    // The QR code carries the addresses the proxy store knows, so it needs at least one
    const hasNetwork = proxyStore.externalNetworkAddresses.length > 0;

    return <PhoneSetupLayout
        title='Connect Android'
        purpose="Send an Android phone's or emulator's traffic through Wirepane."
        onBack={() => navigate('/intercept')}
    >
        <PhoneStatus
            phone={phone}
            waitingTitle='Waiting for your Android device…'
            waitingHint='Connect it with one of the options below. This updates as soon as its first request comes through.'
            httpsHint='No HTTPS requests yet. Browsers should work once the certificate is installed. For apps, see below.'
            onViewRequests={() => navigate('/view')}
        />

        <OptionGrid>
            <QrOption
                interceptor={interceptorStore.interceptors[QR_INTERCEPTOR_ID]}
                hasNetwork={hasNetwork}
            />
            <AdbOption
                interceptor={interceptorStore.interceptors[ADB_INTERCEPTOR_ID]}
                interceptorStore={interceptorStore}
            />
            <ManualOption addresses={addresses} port={port} />
        </OptionGrid>

        <Card aria-labelledby='android-https-heading'>
            <CardTitle id='android-https-heading'>Why some apps show no HTTPS traffic</CardTitle>
            <p>
                Since Android 7, apps only trust certificates you installed yourself if the app
                allows it. Chrome and most other browsers do, so they work with the HTTP Toolkit
                app's VPN or the manual proxy. Other apps don't by default:
            </p>
            <ExplanationList>
                <li>
                    <p>
                        <strong>Your own app:</strong> let its debug build trust user certificates
                        with a network security config.
                    </p>
                    <CodeHeader>
                        <span>Debug builds only, so release builds keep the default.</span>
                        <CopyButton value={NETWORK_SECURITY_CONFIG} label='the network security config' />
                    </CodeHeader>
                    <CodeBlock>{ NETWORK_SECURITY_CONFIG }</CodeBlock>
                </li>
                <li>
                    <strong>Other apps:</strong> use an emulator or a rooted device with ADB. There the
                    certificate is a system certificate, which every app trusts, unless the app pins
                    its own certificates.
                </li>
            </ExplanationList>
        </Card>

        <Note
            icon={<Power size={18} aria-hidden={true} />}
            title="When you're done"
        >
            <p>
                Turn the phone's Wi-Fi proxy off, or disconnect in the HTTP Toolkit app. Otherwise
                the phone has no internet while Wirepane isn't running.
            </p>
        </Note>
    </PhoneSetupLayout>;
}));
