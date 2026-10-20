import * as _ from 'lodash';
import * as React from 'react';
import { inject, observer } from 'mobx-react'; // wirepane

import { styled } from '../../../styles';
import { Icon, SourceIcons } from '../../../icons';

import { getReadableIP } from '../../../model/network';
import { FailedTlsConnection } from '../../../model/tls/failed-tls-connection';
import { describeJa4, findHelloForFailure, findJa4ForFailure } from '../../../model/interception/vpn-ja4'; // wirepane: JA4 from the VPN
import type { VpnNetworkStore } from '../../../model/interception/vpn-network'; // wirepane
import type { DevicesStore } from '../../../model/devices/devices-store'; // wirepane: device attribution

import { MediumCard } from '../../common/card';
import { ContentLabelBlock, Content, CopyableMonoValue } from '../../common/text-content';
import { PaneScrollContainer } from '../view-details-pane';

const AndroidIcon = styled(Icon).attrs({
    icon: SourceIcons.Android.icon
})`
    float: left;
    margin-right: 10px;
    margin-top: 3px;
    color: ${SourceIcons.Android.color};
`;

@inject((stores: any) => ({
    vpnNetworkStore: stores.vpnNetworkStore,
    devicesStore: stores.devicesStore
}))
@observer
export class TlsFailureDetailsPane extends React.Component<{
    failure: FailedTlsConnection,
    certPath: string,
    vpnNetworkStore?: VpnNetworkStore,
    devicesStore?: DevicesStore
}> {

    private stopReadingHellos: (() => void) | undefined;

    componentDidMount() {
        // wirepane: the store only reads the VPN's events while someone needs them. Mockttp gives a
        // failed connection no JA4 tag, so this pane looks it up in the hellos, and needs them here.
        this.stopReadingHellos = this.props.vpnNetworkStore?.startPolling();
    }

    componentWillUnmount() {
        this.stopReadingHellos?.();
    }

    render() {
        const { failure, certPath, vpnNetworkStore, devicesStore } = this.props;

        // This _should_ always be available, but due to some awkward & unclear Node issues it isn't,
        // so we need to be a little careful here.
        const sourceDetailParts = failure.remoteIpAddress
            ? getReadableIP(failure.remoteIpAddress).split(' ')
            : undefined;
        const sourceIp = sourceDetailParts?.[0];
        const sourceDetails = sourceDetailParts?.slice(1).join(' ');

        // wirepane: the JA4 fingerprint of the client's hello, when it came through the VPN
        const matchingHello = findHelloForFailure(failure, vpnNetworkStore?.tlsHellos ?? []);
        const ja4 = findJa4ForFailure(failure, vpnNetworkStore?.tlsHellos ?? []);

        const vpnPeer = matchingHello?.peer;
        const vpnPeerStats = vpnPeer ? vpnNetworkStore?.stats?.peers?.find(p => p.peer === vpnPeer) : undefined;
        const vpnDevice = vpnPeer ? devicesStore?.getListedDevice(vpnPeer) : undefined;
        const vpnDeviceName = vpnPeerStats?.name || vpnDevice?.name;
        const vpnDeviceIp = vpnPeerStats?.tunnelIp || vpnDevice?.address;

        return <PaneScrollContainer>
            <MediumCard>
                <header>
                    <h1>Failed HTTPS request</h1>
                </header>

                <ContentLabelBlock>Details</ContentLabelBlock>
                <Content>
                    <p>{
                        ({
                            'closed': <>
                                This connection was aborted and closed before any HTTP request was sent.
                            </>,
                            'reset': <>
                                This connection was aborted and reset before any HTTP request was sent.
                            </>,
                            'cert-rejected': <>
                                This connection was aborted, before any HTTP request was sent,
                                because the client did not trust the Wirepane certificate.
                            </>,
                            'no-shared-cipher': <>
                                This connection was aborted, before any HTTP request was sent,
                                because the client failed to agree on a TLS configuration.
                            </>,
                            'unknown': <>
                                This connection was aborted, before any HTTP request was sent,
                                due to a TLS error.
                            </>,
                        } as _.Dictionary<JSX.Element>)[failure.failureCause]
                    }</p>
                    { vpnDeviceName ? (
                        <p>
                            The request was sent by <strong>{ vpnDeviceName }</strong>
                            { vpnDeviceIp && <> ({ vpnDeviceIp })</> } via VPN tunnel
                            { sourceIp && <> (local proxy: <CopyableMonoValue>{ sourceIp }</CopyableMonoValue>)</> }.
                        </p>
                    ) : (
                        sourceIp && sourceDetails && <p>
                            The request was sent by <CopyableMonoValue>
                                { sourceIp }
                            </CopyableMonoValue> { sourceDetails }.
                        </p>
                    ) }
                    { ja4 && <p>
                        { /* wirepane: JA4 */ }
                        The client's TLS fingerprint (JA4) is <CopyableMonoValue title={describeJa4(ja4)}>
                            { ja4 }
                        </CopyableMonoValue>. It is the same for every connection of that app.
                    </p> }
                </Content>

                <ContentLabelBlock>Cause</ContentLabelBlock>
                <Content>{
                    failure.failureCause === 'cert-rejected'
                        ? <p>
                            This means that the client hasn't yet been fully configured
                            to work with Wirepane. It has the proxy settings,
                            but it doesn't trust our certificate authority (CA), so we
                            can't intercept its HTTPS traffic.
                        </p>
                    : failure.failureCause === 'no-shared-cipher'
                        ? <>
                            <p>
                                This usually means that the client hasn't yet been 100% configured
                                to work with Wirepane, although it's also possible that
                                it has an unusual TLS setup.
                            </p>
                            <p>
                                The former case is much more likely. That would mean that the
                                client has the right proxy settings, but doesn't trust our
                                certificate authority (CA), so we can't imitate HTTPS sites and
                                we can't collect or see its HTTPS traffic.
                            </p>
                        </>
                    : <>
                        <p>This could be caused by a few things:</p>
                        <ul>
                            <li>The client might no longer want to make the request</li>
                            <li>The client might have connection issues</li>
                            <li>The client might not trust our HTTPS certificate</li>
                        </ul>
                    </>
                }</Content>
                <ContentLabelBlock>Solutions</ContentLabelBlock>
                <Content>
                    <p>
                        {
                            failure.failureCause === 'cert-rejected'
                                ? <>
                                    To resolve this, you need to configure the client to trust
                                    your Wirepane CA.
                                </>
                            : failure.failureCause === 'no-shared-cipher'
                                ? <>
                                    You probably need to ensure the client is configured to trust the
                                    Wirepane CA.
                                </>
                            : <>
                                In the first two cases, this is not related to Wirepane.
                                In the third case, you need to configure the client to trust your
                                Wirepane CA.
                            </>
                        }
                    </p>
                    <p>
                        How you do this depends on the specific client. Opening the certificate file
                        on the device may prompt you to trust it device-wide, or you may need a
                        specific option for the HTTP library or tool that's being used.
                    </p>

                    <p>
                        Your Wirepane certificate is stored on your machine at <CopyableMonoValue>
                            { certPath }
                        </CopyableMonoValue>
                    </p>
                    <AndroidIcon />
                    <p>
                        <strong>For Android devices</strong>, modern apps will not
                        trust your installed CA certificates by default. For apps targeting
                        API level 24+, the app must opt in to trusting user CA certificates, or
                        you need to inject a system certificate (only possible on rooted devices
                        and emulators).
                    </p>
                    <p>
                        Trusting user CA certificates in your own app is a small & simple
                        configuration change, see <a
                            href="https://httptoolkit.com/docs/guides/android#intercepting-traffic-from-your-own-android-app"
                        >the HTTP Toolkit docs</a> for more details. Alternatively Wirepane
                        can inject the system certificate for you automatically, on devices that
                        support this, by connecting the device with ADB and using the "Android
                        device via ADB" interception option.
                    </p>
                    <p>
                        Take a look at the <a href="https://httptoolkit.com/docs/guides/android/">
                            Android interception guide
                        </a> for more information.
                    </p>
                </Content>
            </MediumCard>
        </PaneScrollContainer>;
    }
}