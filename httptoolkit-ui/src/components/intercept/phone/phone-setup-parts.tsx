import * as React from 'react';
import { Check, CheckCircle, Copy, Info } from '@phosphor-icons/react';
import { QRCodeSVG } from 'qrcode.react';

import { styled, css, keyframes } from '../../../styles';
import { copyToClipboard } from '../../../util/ui';
import { logError } from '../../../errors';
import { getNetworkInterfaces } from '../../../services/server-api';
import { EventsStore } from '../../../model/events/events-store';
import {
    CERTIFICATE_PAGE_URL,
    ConnectedPhone,
    ConnectedPhoneTracker,
    describeConnectedApps,
    LanAddress,
    PhonePlatform,
    getLanAddresses
} from '../../../model/interception/phone-setup';

import { PageHeader, PageLayout } from '../../common/page-header';
import { ActionButton } from '../../common/action-button';
import { UnstyledButton } from '../../common/inputs';

const COPIED_FEEDBACK_MS = 1500;
const NETWORK_REFRESH_MS = 10_000; // Wi-Fi can change while the page is open

// --- Page frame ---

const PageScroll = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
`;

const PageContent = styled.div`
    max-width: 1120px;
    box-sizing: border-box;
    margin: 0 auto;
    padding: 24px 24px 48px;

    display: flex;
    flex-direction: column;
    gap: 16px;
`;

/**
 * A phone setup page: "Intercept › <phone>" in the toolbar, with Intercept as the way
 * back to all sources (⌘[ too), then the content.
 */
export const PhoneSetupLayout = (props: {
    title: string,
    purpose: string,
    onBack: () => void,
    children: React.ReactNode
}) => <PageLayout>
    <PageHeader
        title={props.title}
        purpose={props.purpose}
        parent={{
            label: 'Intercept',
            description: 'Back to all sources on the Intercept page',
            onSelect: props.onBack,
            shortcut: 'Cmd+['
        }}
    />
    <PageScroll>
        <PageContent>
            { props.children }
        </PageContent>
    </PageScroll>
</PageLayout>;

// Two cards side by side, stacking on narrow windows. The second column has a fixed width.
export const CardRow = styled.div<{ sideWidth?: number }>`
    display: grid;
    grid-template-columns: minmax(0, 1fr) ${p => p.sideWidth ? `${p.sideWidth}px` : 'minmax(0, 1fr)'};
    gap: 16px;
    align-items: stretch;

    @media (max-width: 900px) {
        grid-template-columns: minmax(0, 1fr);
    }
`;

export const Card = styled.section`
    box-sizing: border-box;
    padding: 20px;
    min-width: 0;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;

    font-size: ${p => p.theme.textSize};
    line-height: 1.5;
    color: ${p => p.theme.mainColor};

    > p {
        color: ${p => p.theme.mainLowlightColor};
    }

    > * + * {
        margin-top: 10px;
    }

    a[href] {
        color: ${p => p.theme.linkColor};
    }
`;

export const CardTitle = styled.h2`
    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.3;
    color: ${p => p.theme.mainColor};
`;

export const Mono = styled.span`
    font-family: ${p => p.theme.monoFontFamily};
    font-size: 0.95em;
    color: ${p => p.theme.mainColor};
    overflow-wrap: anywhere;
`;

export const VisuallyHidden = styled.span`
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
`;

// --- Copying values ---

const CopyButtonRoot = styled(UnstyledButton)`
    flex-shrink: 0;
    height: 24px;
    padding: 0 8px;
    border-radius: 5px;
    border: 1px solid ${p => p.theme.inputBorder};
    background-color: ${p => p.theme.mainBackground};

    display: inline-flex;
    align-items: center;
    gap: 4px;
    vertical-align: middle;

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 500;
    color: ${p => p.theme.mainColor};

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }
`;

export const CopyButton = (props: {
    value: string,
    // What's being copied, for the tooltip & screen readers, e.g. "the server address"
    label: string
}) => {
    const [copied, setCopied] = React.useState(false);
    React.useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    return <>
        <CopyButtonRoot
            title={`Copy ${props.label}: ${props.value}`}
            aria-label={`Copy ${props.label}`}
            onClick={() => copyToClipboard(props.value)
                .then(() => setCopied(true))
                .catch((e) => logError(e))
            }
        >
            { copied
                ? <Check size={12} weight='bold' aria-hidden={true} />
                : <Copy size={12} aria-hidden={true} />
            }
            { copied ? 'Copied' : 'Copy' }
        </CopyButtonRoot>
        <VisuallyHidden aria-live='polite'>{ copied ? `Copied ${props.label}` : '' }</VisuallyHidden>
    </>;
};

// --- The proxy address to type into the phone ---

const ValuesRow = styled.div`
    display: flex;
    flex-wrap: wrap;
    gap: 12px 40px;
`;

const ValueBlock = styled.div`
    min-width: 0;
`;

const ValueLabel = styled.div`
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const ValueLine = styled.div`
    margin-top: 2px;
    display: flex;
    align-items: center;
    gap: 10px;
`;

const BigValue = styled.span<{ pending?: boolean }>`
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.largeHeadingSize};
    font-weight: 500;
    line-height: 1.3;
    user-select: all;

    color: ${p => p.pending ? p.theme.mainLowlightColor : p.theme.mainColor};
`;

const ProxyValue = (props: {
    label: string,
    value: string | undefined,
    placeholder: string,
    copyLabel: string
}) => <ValueBlock>
    <ValueLabel>{ props.label }</ValueLabel>
    <ValueLine>
        { props.value
            ? <>
                <BigValue>{ props.value }</BigValue>
                <CopyButton value={props.value} label={props.copyLabel} />
            </>
            : <BigValue pending={true}>{ props.placeholder }</BigValue>
        }
    </ValueLine>
</ValueBlock>;

const OtherAddresses = styled.p`
    font-size: ${p => p.theme.textInputFontSize};
`;

/**
 * The address & port to type into the phone's proxy settings, big and copyable.
 * Addresses are undefined while they're still loading.
 */
export const ProxyAddressValues = (props: {
    addresses: LanAddress[] | undefined,
    port: number,
    serverLabel?: string
}) => {
    const { addresses, port } = props;
    const [best, ...others] = addresses ?? [];

    return <>
        <ValuesRow>
            <ProxyValue
                label={props.serverLabel ?? 'Server'}
                value={best?.address}
                placeholder={addresses ? 'No network' : 'Looking up…'}
                copyLabel='the server address'
            />
            <ProxyValue
                label='Port'
                value={port.toString()}
                placeholder=''
                copyLabel='the port'
            />
        </ValuesRow>
        { addresses?.length === 0 &&
            <p>This computer isn't connected to a network. Join the same Wi-Fi as the phone first.</p>
        }
        { others.length > 0 &&
            <OtherAddresses>
                This computer has other addresses too: { others.map((other, i) =>
                    <React.Fragment key={other.address}>
                        { i > 0 && ', ' }
                        <Mono>{ other.address }</Mono>{ other.interfaceName && ` (${other.interfaceName})` }
                    </React.Fragment>
                ) }. If the phone can't connect, try the one on its network.
            </OtherAddresses>
        }
    </>;
};

/**
 * This machine's LAN addresses, refreshed while the page is open. Falls back to the
 * addresses the proxy store knows if the server can't be asked.
 */
export function useLanAddresses(fallbackAddresses: string[]): LanAddress[] | undefined {
    const [addresses, setAddresses] = React.useState<LanAddress[] | undefined>();
    const fallbackRef = React.useRef(fallbackAddresses);
    fallbackRef.current = fallbackAddresses;

    React.useEffect(() => {
        let unmounted = false;

        const refresh = () => getNetworkInterfaces()
            .then((interfaces) => {
                if (!unmounted) setAddresses(getLanAddresses(interfaces));
            })
            .catch((e) => {
                console.warn('Could not load the network interfaces', e);
                if (!unmounted) setAddresses((current) => current ?? fallbackRef.current.map((address) =>
                    ({ address, interfaceName: '' })
                ));
            });

        refresh();
        const timer = setInterval(refresh, NETWORK_REFRESH_MS);
        return () => {
            unmounted = true;
            clearInterval(timer);
        };
    }, []);

    return addresses;
}

// --- Live connection status ---

/**
 * The latest phone of this platform seen in the captured traffic, live.
 */
export function useConnectedPhone(eventsStore: EventsStore, platform: PhonePlatform) {
    const [tracker] = React.useState(() =>
        new ConnectedPhoneTracker(() => eventsStore.exchanges, platform)
    );

    React.useEffect(() => {
        tracker.start();
        return () => tracker.stop();
    }, [tracker]);

    return tracker.phone; // Observable: read inside an observer component
}

const StatusRoot = styled.section<{ connected: boolean }>`
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

const WaitingDot = styled.span`
    flex-shrink: 0;
    width: 12px;
    height: 12px;
    margin: 4px 4px 0;
    border-radius: 50%;
    background-color: ${p => p.theme.containerWatermark};

    ${pulse}
`;

const ConnectedIcon = styled.span`
    flex-shrink: 0;
    display: flex;
    color: ${p => p.theme.popColor};
`;

const StatusText = styled.div`
    flex: 1 1 200px;
    min-width: 0;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};

    > * + * {
        margin-top: 4px;
    }
`;

const StatusTitle = styled.h2`
    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.3;
    color: ${p => p.theme.mainColor};
`;

const HttpsLine = styled.p`
    display: flex;
    gap: 6px;
    align-items: flex-start;

    > svg {
        flex-shrink: 0;
        margin-top: 2px;
    }
`;

/**
 * "Waiting for your iPhone…" until its first request comes through, then which device
 * connected, and whether HTTPS works yet.
 */
export const PhoneStatus = (props: {
    phone: ConnectedPhone | undefined,
    waitingTitle: string,
    waitingHint: React.ReactNode,
    // Shown while no HTTPS requests have come through from the phone yet
    httpsHint: React.ReactNode,
    onViewRequests: () => void
}) => {
    const { phone } = props;

    return <StatusRoot connected={!!phone} aria-label='Connection status'>
        { phone
            ? <ConnectedIcon><CheckCircle size={24} weight='fill' aria-hidden={true} /></ConnectedIcon>
            : <WaitingDot aria-hidden={true} />
        }
        <StatusText role='status'>
            { phone
                ? <>
                    <StatusTitle>{ phone.deviceName } connected</StatusTitle>
                    <p>
                        { phone.address
                            ? <Mono>{ phone.address }</Mono>
                            : 'Through ADB'
                        } · { describeConnectedApps(phone) }
                        { phone.viaVpn && ' · through the VPN' }
                    </p>
                    <HttpsLine>
                        { phone.sawHttps
                            ? <>
                                <Check size={14} weight='bold' aria-hidden={true} />
                                <span>HTTPS works: the phone trusts the certificate.</span>
                            </>
                            : <>
                                <Info size={14} aria-hidden={true} />
                                <span>{ props.httpsHint }</span>
                            </>
                        }
                    </HttpsLine>
                </>
                : <>
                    <StatusTitle>{ props.waitingTitle }</StatusTitle>
                    <p>{ props.waitingHint }</p>
                </>
            }
        </StatusText>
        { phone && <ActionButton
            variant='primary'
            icon='Rows'
            shortcut='Cmd+2'
            title='Show the captured requests'
            onClick={props.onViewRequests}
        >
            View requests
        </ActionButton> }
    </StatusRoot>;
};

// --- Setup steps ---

export const SetupSteps = styled.ol`
    display: flex;
    flex-direction: column;
    gap: 14px;
`;

const StepItem = styled.li`
    display: flex;
    gap: 12px;
    align-items: flex-start;
`;

const StepNumber = styled.span`
    flex-shrink: 0;
    width: 24px;
    height: 24px;
    box-sizing: border-box;
    border-radius: 50%;
    border: 1px solid ${p => p.theme.inputBorder};

    display: inline-flex;
    align-items: center;
    justify-content: center;

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const StepBody = styled.div`
    flex: 1 1 auto;
    min-width: 0;
    padding-top: 1px;

    color: ${p => p.theme.mainLowlightColor};

    > * + * {
        margin-top: 4px;
    }
`;

const StepTitle = styled.h3`
    font-size: ${p => p.theme.textSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};
`;

export const SetupStep = (props: {
    number: number,
    title: string,
    children?: React.ReactNode
}) => <StepItem>
    <StepNumber aria-hidden={true}>{ props.number }</StepNumber>
    <StepBody>
        <StepTitle>{ props.title }</StepTitle>
        { props.children }
    </StepBody>
</StepItem>;

const PathItem = styled.span`
    font-weight: 600;
    color: ${p => p.theme.mainColor};
    white-space: nowrap; /* Lines break between the steps, not inside one */
`;

const PathSeparator = styled.span`
    margin: 0 2px; /* Plus the spaces around it, where long paths wrap */
    color: ${p => p.theme.containerWatermark};
`;

/**
 * Where to tap, e.g. Settings › Wi-Fi › Configure Proxy. Screen readers hear "then"
 * between the steps.
 */
export const MenuPath = (props: { items: React.ReactNode[] }) => <p>
    { props.items.map((item, i) => <React.Fragment key={i}>
        { i > 0 && <>
            { ' ' }<PathSeparator aria-hidden={true}>›</PathSeparator>{ ' ' }
            <VisuallyHidden>, then </VisuallyHidden>
        </> }
        <PathItem>{ item }</PathItem>
    </React.Fragment>) }
</p>;

// The (i) button next to each network in iOS Wi-Fi settings
export const InfoButtonGlyph = () => <>
    <Info size={15} weight='bold' aria-hidden={true} style={{ verticalAlign: '-0.15em' }} />
    <VisuallyHidden>the info button</VisuallyHidden>
</>;

// --- QR code for the certificate page ---

const QrFigure = styled.figure`
    flex-shrink: 0;
    width: 180px;

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
const QrFrame = styled.div`
    display: flex;
    padding: 4px;
    border-radius: 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: #FFFFFF;
`;

export const CertificateQrCode = (props: { caption: React.ReactNode }) => <QrFigure>
    <QrFrame>
        <QRCodeSVG
            value={CERTIFICATE_PAGE_URL}
            size={156}
            level='M'
            marginSize={2}
            bgColor='#FFFFFF'
            fgColor='#0A1222'
            role='img'
            aria-label={`QR code for ${CERTIFICATE_PAGE_URL}`}
        />
    </QrFrame>
    <figcaption>{ props.caption }</figcaption>
</QrFigure>;

// --- Notes ---

const NoteRoot = styled.aside`
    box-sizing: border-box;
    padding: 14px 16px;
    min-width: 0;

    display: flex;
    gap: 12px;
    align-items: flex-start;

    background-color: ${p => p.theme.mainLowlightBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.5;
    color: ${p => p.theme.mainLowlightColor};

    > svg {
        flex-shrink: 0;
        margin-top: 1px;
        color: ${p => p.theme.mainLowlightColor};
    }

    strong {
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }
`;

const NoteBody = styled.div`
    min-width: 0;

    > * + * {
        margin-top: 6px;
    }
`;

export const Note = (props: {
    icon: React.ReactNode,
    title: string,
    children: React.ReactNode
}) => <NoteRoot aria-label={props.title}>
    { props.icon }
    <NoteBody>
        <strong>{ props.title }</strong>
        { props.children }
    </NoteBody>
</NoteRoot>;
