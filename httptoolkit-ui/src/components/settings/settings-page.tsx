import * as _ from 'lodash';
import * as React from 'react';
import { observer, inject } from "mobx-react";
import { ArrowsLeftRight, BookOpen, Globe, Palette, Pulse, Sparkle } from '@phosphor-icons/react';

import { WithInjected } from '../../types';

import { UiStore } from '../../model/ui/ui-store';
import { ProxyStore } from '../../model/proxy-store';
import { serverVersion, versionSatisfies, PORT_RANGE_SERVER_RANGE } from '../../services/service-versions';

import { PageHeader, PageLayout } from '../common/page-header';

import { ProxySettingsCard } from './proxy-settings-card';
import { ConnectionSettingsCard } from './connection-settings-card';
import { ApiSettingsCard } from './api-settings-card';
// wirepane: sections with a list on the left, the status first & "Appearance" for themes
import { SettingsLayout, SettingsSection, SettingsSectionInfo } from './settings-layout';
import { SettingsStatusCard } from './settings-status-card';
import { AppearanceSettingsCard } from './appearance-settings-card';
import { AiSettingsCard } from './ai-settings-card';

interface SettingsPageProps {
    uiStore: UiStore;
    proxyStore: ProxyStore;
}

@inject('uiStore')
@inject('proxyStore')
@observer
class SettingsPage extends React.Component<SettingsPageProps> {

    render() {
        const { uiStore, proxyStore } = this.props;
        const cardProps = uiStore.settingsCardProps;

        const hasProxySettings = _.isString(serverVersion.value) &&
            versionSatisfies(serverVersion.value, PORT_RANGE_SERVER_RANGE);
        // The same check as the rail's AI item
        const canUseMcp = !!proxyStore.toolPaths?.mcp?.length;

        const sections: SettingsSectionInfo[] = [
            { id: 'settings-status', label: 'Status', icon: Pulse },
            { id: 'settings-appearance', label: 'Appearance', icon: Palette },
            ...(hasProxySettings ? [
                { id: 'settings-proxy', label: 'Proxy', icon: ArrowsLeftRight },
                { id: 'settings-connection', label: 'Connection', icon: Globe }
            ] : []),
            { id: 'settings-api', label: 'API specifications', icon: BookOpen },
            ...(canUseMcp ? [{ id: 'settings-ai', label: 'AI assistants', icon: Sparkle }] : [])
        ];

        return <PageLayout><PageHeader
            title='Settings'
            purpose='What is running, how Wirepane looks, and how the proxy handles connections.'
        />
            <SettingsLayout sections={sections}>
                <SettingsSection id='settings-status' label='Status'>
                    <SettingsStatusCard />
                </SettingsSection>

                <SettingsSection id='settings-appearance' label='Appearance'>
                    <AppearanceSettingsCard {...cardProps.themes} />
                </SettingsSection>

                {
                    hasProxySettings && <>
                        <SettingsSection id='settings-proxy' label='Proxy'>
                            <ProxySettingsCard {...cardProps.proxy} />
                        </SettingsSection>
                        <SettingsSection id='settings-connection' label='Connection'>
                            <ConnectionSettingsCard {...cardProps.connection} />
                        </SettingsSection>
                    </>
                }

                <SettingsSection id='settings-api' label='API specifications'>
                    <ApiSettingsCard {...cardProps.api} />
                </SettingsSection>

                { canUseMcp && <SettingsSection id='settings-ai' label='AI assistants'>
                    <AiSettingsCard />
                </SettingsSection> }
            </SettingsLayout>
        </PageLayout>;
    }
}

// Annoying cast required to handle the store prop nicely in our types
const InjectedSettingsPage = SettingsPage as unknown as WithInjected<
    typeof SettingsPage,
    'uiStore' | 'proxyStore'
>;
export { InjectedSettingsPage as SettingsPage };