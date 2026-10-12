import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite'; // Supports hooks, unlike mobx-react 5's observer
import { DownloadSimple } from '@phosphor-icons/react';

import { styled } from '../../styles';
import { saveFile } from '../../util/ui';

import { ProxyStore } from '../../model/proxy-store';
import { UI_VERSION, desktopVersion, serverVersion } from '../../services/service-versions';

import { MediumCard } from '../common/card';
import { CopyButton, useLanAddresses } from '../intercept/phone/phone-setup-parts';
import { SettingsButton } from './settings-components';

/*
 * Wirepane: the first thing on the Settings page. What's running, where to point clients,
 * which certificate they need to trust, and which versions are in use.
 */

const CA_NAME = 'Wirepane CA';
const CERTIFICATE_FILENAME = 'wirepane-ca-certificate.crt';

const StatusRows = styled.dl`
    display: grid;
    grid-template-columns: 104px minmax(0, 1fr);
    gap: 16px 16px;
    align-items: baseline;
`;

const Term = styled.dt`
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const Value = styled.dd`
    min-width: 0;
`;

const ValueLine = styled.div`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 6px 12px;
`;

const Detail = styled.div`
    margin-top: 4px;
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const Mono = styled.span`
    font-family: ${p => p.theme.monoFontFamily};
    overflow-wrap: anywhere;
`;

const StrongMono = styled(Mono)`
    font-weight: 500;
    color: ${p => p.theme.mainColor};
`;

const RunningDot = styled.span`
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background-color: ${p => p.theme.popColor};
`;

const ProxyStatus = observer((p: { proxyStore: ProxyStore }) => {
    const port = p.proxyStore.httpProxyPort;
    const lanAddresses = useLanAddresses(p.proxyStore.externalNetworkAddresses);
    const lanAddress = lanAddresses?.[0]?.address;
    const localAddress = `localhost:${port}`;

    return <Value>
        <ValueLine>
            <RunningDot aria-hidden={true} />
            <span>Running on <StrongMono>{ localAddress }</StrongMono></span>
            <CopyButton value={localAddress} label='the proxy address' />
        </ValueLine>
        <Detail>
            { lanAddress
                ? <>Phones and other devices on this network use <Mono>{ lanAddress }:{ port }</Mono></>
                : 'Not on a network, so only apps on this computer can use it'
            }
        </Detail>
    </Value>;
});

// /Users/me/Library/... reads better as ~/Library/... (copying still gives the full path)
const shortenHomePath = (path: string) => path.replace(/^(\/Users|\/home)\/[^/]+(?=\/)/, '~');

const CertificateStatus = observer((p: { proxyStore: ProxyStore }) => {
    const { certPath, certContent } = p.proxyStore;

    return <Value>
        <ValueLine>
            <strong>{ CA_NAME }</strong>
            { certContent && <SettingsButton
                onClick={() => saveFile(CERTIFICATE_FILENAME, 'application/x-x509-ca-cert', certContent)}
            >
                <DownloadSimple size={16} aria-hidden={true} /> Save certificate…
            </SettingsButton> }
        </ValueLine>
        { certPath && <Detail>
            <ValueLine>
                <Mono title={certPath}>{ shortenHomePath(certPath) }</Mono>
                <CopyButton value={certPath} label='the certificate path' />
            </ValueLine>
        </Detail> }
        <Detail>Devices need to trust it to show HTTPS traffic. It's only used by Wirepane.</Detail>
    </Value>;
});

// Wirepane's own version (the repo's VERSION file), set when the UI is built. The app and server
// versions below are the HTTP Toolkit ones they're built on, which the UI checks for features.
const WIREPANE_VERSION = process.env.WIREPANE_VERSION || undefined;

const VersionStatus = observer(() => {
    const parts = [
        desktopVersion.state === 'fulfilled' && desktopVersion.value
            ? `app ${desktopVersion.value}`
            : undefined,
        `server ${serverVersion.state === 'fulfilled' ? serverVersion.value : '…'}`,
        `UI ${UI_VERSION === 'Unknown' ? 'dev build' : UI_VERSION.slice(0, 8)}`
    ].filter((part): part is string => !!part);

    return <Value>
        <strong>Wirepane { WIREPANE_VERSION ?? 'dev build' }</strong>
        <Detail>Based on HTTP Toolkit: { parts.join(' · ') }</Detail>
        { desktopVersion.state !== 'fulfilled' && <Detail>Running in a browser, not the desktop app</Detail> }
    </Value>;
});

export const SettingsStatusCard = inject('proxyStore')(observer((p: {
    proxyStore?: ProxyStore,
    id?: string
}) => <MediumCard id={p.id} aria-labelledby='settings-status-heading'>
    <header>
        <h1 id='settings-status-heading'>Status</h1>
    </header>
    <StatusRows>
        <Term>Proxy</Term>
        <ProxyStatus proxyStore={p.proxyStore!} />

        <Term>Certificate</Term>
        <CertificateStatus proxyStore={p.proxyStore!} />

        <Term>Version</Term>
        <VersionStatus />
    </StatusRows>
</MediumCard>));
