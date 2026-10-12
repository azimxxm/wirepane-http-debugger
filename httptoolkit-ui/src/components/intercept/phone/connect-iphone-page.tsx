import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { Power } from '@phosphor-icons/react';

import { styled } from '../../../styles';
import { saveFile } from '../../../util/ui';
import { appHistory } from '../../../routing';

import { ProxyStore } from '../../../model/proxy-store';
import { EventsStore } from '../../../model/events/events-store';
import { CERTIFICATE_PAGE_URL, CHECK_PAGE_URL } from '../../../model/interception/phone-setup';

import { ActionButton } from '../../common/action-button';
import {
    Card,
    CardRow,
    CardTitle,
    CertificateQrCode,
    CopyButton,
    InfoButtonGlyph,
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

// Wirepane's own CA, separate from the official app's ca.pem (see CLAUDE.md, Branding)
const CA_NAME = 'Wirepane CA';
const CERTIFICATE_FILENAME = 'wirepane-ca-certificate.crt';

const StepsLayout = styled.div`
    display: flex;
    gap: 32px;
    align-items: flex-start;

    > ol {
        flex: 1 1 auto;
    }

    @media (max-width: 760px) {
        flex-direction: column;
    }
`;

const InlineCopy = styled.span`
    white-space: nowrap;
`;

/**
 * Connect an iPhone or iPad over Wi-Fi: the proxy address to type in, the certificate
 * steps, and a live status that flips once the device's traffic comes through.
 */
export const ConnectIPhonePage = inject('proxyStore', 'eventsStore')(observer((props: {
    proxyStore?: ProxyStore,
    eventsStore?: EventsStore,
    navigate?: (path: string) => void
}) => {
    const proxyStore = props.proxyStore!;
    const eventsStore = props.eventsStore!;
    const navigate = props.navigate ?? ((path: string) => { appHistory.navigate(path); });

    const addresses = useLanAddresses(proxyStore.externalNetworkAddresses);
    const phone = useConnectedPhone(eventsStore, 'ios');

    const port = proxyStore.httpProxyPort;
    const server = addresses?.[0]?.address;
    const { certContent } = proxyStore;

    return <PhoneSetupLayout
        title='Connect iPhone or iPad'
        purpose="Send an iPhone's or iPad's traffic through Wirepane over Wi-Fi."
        onBack={() => navigate('/intercept')}
    >
        <CardRow sideWidth={360}>
            <Card aria-labelledby='iphone-proxy-heading'>
                <CardTitle id='iphone-proxy-heading'>Proxy settings for the iPhone</CardTitle>
                <ProxyAddressValues addresses={addresses} port={port} />
                <p>The iPhone has to be on the same Wi-Fi network as this computer.</p>
            </Card>

            <PhoneStatus
                phone={phone}
                waitingTitle='Waiting for your iPhone…'
                waitingHint='Do steps 1 and 2, then open any page on the iPhone. This updates by itself.'
                httpsHint='No HTTPS requests yet. If HTTPS pages fail to load on the iPhone, finish steps 3 to 5.'
                onViewRequests={() => navigate('/view')}
            />
        </CardRow>

        <Card aria-labelledby='iphone-steps-heading'>
            <CardTitle id='iphone-steps-heading'>Set up the iPhone</CardTitle>
            <StepsLayout>
                <SetupSteps>
                    <SetupStep number={1} title='Join the same Wi-Fi'>
                        <p>Connect the iPhone to the Wi-Fi network this computer is on.</p>
                    </SetupStep>
                    <SetupStep number={2} title='Set the proxy'>
                        <MenuPath items={[
                            'Settings',
                            'Wi-Fi',
                            <><InfoButtonGlyph /> next to your network</>,
                            'Configure Proxy',
                            'Manual'
                        ]} />
                        <p>
                            Server <Mono>{ server ?? '…' }</Mono>, Port <Mono>{ port }</Mono>,
                            Authentication off. Then tap Save.
                        </p>
                    </SetupStep>
                    <SetupStep number={3} title='Download the certificate'>
                        <p>
                            In Safari, open <Mono>{ CERTIFICATE_PAGE_URL }</Mono> <InlineCopy>
                                <CopyButton value={CERTIFICATE_PAGE_URL} label='the certificate page address' />
                            </InlineCopy>, or scan the code with the Camera. Tap Allow to download the profile.
                        </p>
                    </SetupStep>
                    <SetupStep number={4} title='Install the profile'>
                        <MenuPath items={[
                            'Settings',
                            'General',
                            'VPN & Device Management',
                            CA_NAME,
                            'Install'
                        ]} />
                    </SetupStep>
                    <SetupStep number={5} title='Trust it for HTTPS'>
                        <MenuPath items={[
                            'Settings',
                            'General',
                            'About',
                            'Certificate Trust Settings'
                        ]} />
                        <p>Turn on full trust for <strong>{ CA_NAME }</strong>.</p>
                    </SetupStep>
                    <SetupStep number={6} title='Check it works'>
                        <p>
                            Open <Mono>{ CHECK_PAGE_URL }</Mono> in Safari. It should say
                            "You're being intercepted by Wirepane".
                        </p>
                    </SetupStep>
                </SetupSteps>

                <CertificateQrCode caption={<>
                    The certificate page, for step 3. Scan it after step 2: it only opens
                    through Wirepane's proxy.
                </>} />
            </StepsLayout>
        </Card>

        <CardRow>
            <Card aria-labelledby='iphone-airdrop-heading'>
                <CardTitle id='iphone-airdrop-heading'>Or send the certificate with AirDrop</CardTitle>
                <p>
                    If Safari won't download it, save the certificate here and AirDrop it to the
                    iPhone (in Finder: right-click the file › Share › AirDrop). Then do steps&nbsp;4&nbsp;and&nbsp;5.
                </p>
                { certContent
                    ? <div>
                        <ActionButton
                            icon='DownloadSimple'
                            onClick={() => saveFile(
                                CERTIFICATE_FILENAME,
                                'application/x-x509-ca-cert',
                                certContent
                            )}
                        >
                            Save certificate (.crt)
                        </ActionButton>
                    </div>
                    : <p>The certificate is on this computer at <Mono>{ proxyStore.certPath }</Mono>.</p>
                }
            </Card>

            <Note
                icon={<Power size={18} aria-hidden={true} />}
                title="When you're done, turn the proxy off"
            >
                <MenuPath items={[
                    'Settings',
                    'Wi-Fi',
                    <><InfoButtonGlyph /> next to your network</>,
                    'Configure Proxy',
                    'Off'
                ]} />
                <p>
                    Otherwise the iPhone has no internet while Wirepane isn't running. The
                    certificate can stay installed for next time.
                </p>
            </Note>
        </CardRow>
    </PhoneSetupLayout>;
}));
