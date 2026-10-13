import * as React from 'react';
import { inject } from 'mobx-react';
// The lite observer: mobx-react's own turns a function component into a class, which breaks hooks
import { observer } from 'mobx-react-lite';

import { styled } from '../../styles';
import { appHistory } from '../../routing';
import { VpnNetworkStore } from '../../model/interception/vpn-network';

import { PageHeader, PageLayout } from '../common/page-header';
import { ActionButton } from '../common/action-button';
import { IPHONE_SETUP_PATH } from '../intercept/phone/phone-setup-routes';

import { DnsTab } from './dns-tab';
import { UdpTab } from './udp-tab';
import { TlsTab } from './tls-tab';
import { ConditionsTab } from './conditions-tab';
import { CaptureTab } from './capture-tab';

// The Network page: what the VPN sees of the phones' traffic below HTTP, and the tools that
// change it (docs/plans/2026-10-13-rust-network-tools.md). Each tab is its own component.

export const NETWORK_PATH = '/network';

const TABS = [
    { id: 'dns', label: 'DNS', component: DnsTab },
    { id: 'udp', label: 'UDP', component: UdpTab },
    { id: 'tls', label: 'TLS', component: TlsTab },
    { id: 'conditions', label: 'Conditions', component: ConditionsTab },
    { id: 'capture', label: 'Capture', component: CaptureTab }
] as const;

type TabId = typeof TABS[number]['id'];

const PageScroll = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
`;

const PageContent = styled.div`
    max-width: 1120px;
    box-sizing: border-box;
    margin: 0 auto;
    padding: 16px 24px 48px;

    display: flex;
    flex-direction: column;
    gap: 16px;
`;

const TabList = styled.div`
    display: flex;
    gap: 4px;
    border-bottom: 1px solid ${p => p.theme.containerBorder};
`;

const Tab = styled.button<{ selected: boolean }>`
    appearance: none;
    background: none;
    border: none;
    border-bottom: 2px solid ${p => p.selected ? p.theme.popColor : 'transparent'};
    margin-bottom: -1px;
    padding: 8px 14px;

    font: inherit;
    font-size: ${p => p.theme.textSize};
    font-weight: ${p => p.selected ? 600 : 'normal'};
    color: ${p => p.selected ? p.theme.mainColor : p.theme.mainLowlightColor};
    cursor: pointer;

    &:hover {
        color: ${p => p.theme.mainColor};
    }

    &:focus-visible {
        outline: 2px solid ${p => p.theme.popColor};
        outline-offset: -2px;
    }
`;

const Notice = styled.div`
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 12px;

    padding: 12px 16px;
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};

    > p {
        margin: 0;
        flex: 1 1 300px;
    }
`;

const navigate = (path: string) => { appHistory.navigate(path); };

const NetworkPageContent = observer((props: { store: VpnNetworkStore }) => {
    const { store } = props;
    const [tab, setTab] = React.useState<TabId>('dns');

    // Polls the tunnel's events only while this page is open
    React.useEffect(() => store.startPolling(), [store]);

    const selected = TABS.find((candidate) => candidate.id === tab) ?? TABS[0];
    const TabContent = selected.component;

    // Arrow keys move between tabs, like a native tab bar
    const onTabKey = (event: React.KeyboardEvent) => {
        if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
        const index = TABS.findIndex((candidate) => candidate.id === tab);
        const next = TABS[(index + (event.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
        setTab(next.id);
        document.getElementById(`network-tab-${next.id}`)?.focus();
        event.preventDefault();
    };

    return <PageLayout>
        <PageHeader
            title='Phone network'
            purpose='DNS, UDP, TLS fingerprints, network conditions and packet captures of the phones on the VPN'
            parent={{
                label: 'Intercept',
                description: 'Back to all sources on the Intercept page',
                onSelect: () => navigate('/intercept'),
                shortcut: 'Cmd+['
            }}
        />
        <PageScroll>
            <PageContent>
                { !store.running && <Notice role='status'>
                    <p>
                        The VPN isn't running. These tools work on the traffic of phones connected
                        through Wirepane's VPN: start it on the iPhone page.
                    </p>
                    <ActionButton icon='ArrowRight' onClick={() => navigate(IPHONE_SETUP_PATH)}>
                        iPhone setup
                    </ActionButton>
                </Notice> }
                { store.error && <Notice role='alert'>
                    <p>Couldn't read the VPN's network data: { store.error }</p>
                </Notice> }

                <TabList role='tablist' aria-label='Network tools' onKeyDown={onTabKey}>
                    { TABS.map((candidate) => <Tab
                        key={candidate.id}
                        id={`network-tab-${candidate.id}`}
                        role='tab'
                        aria-selected={candidate.id === tab}
                        aria-controls={`network-panel-${candidate.id}`}
                        tabIndex={candidate.id === tab ? 0 : -1}
                        selected={candidate.id === tab}
                        onClick={() => setTab(candidate.id)}
                    >
                        { candidate.label }
                    </Tab>) }
                </TabList>

                <div
                    role='tabpanel'
                    id={`network-panel-${selected.id}`}
                    aria-labelledby={`network-tab-${selected.id}`}
                >
                    <TabContent store={store} />
                </div>
            </PageContent>
        </PageScroll>
    </PageLayout>;
});

export const NetworkPage = inject('vpnNetworkStore')((props: {
    vpnNetworkStore?: VpnNetworkStore
}) => <NetworkPageContent store={props.vpnNetworkStore!} />);
