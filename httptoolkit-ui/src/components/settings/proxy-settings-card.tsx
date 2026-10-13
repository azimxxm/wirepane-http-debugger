import * as _ from 'lodash';
import * as React from 'react';
import { observable, action, computed, runInAction } from 'mobx';
import { observer, inject } from "mobx-react";

import { styled } from '../../styles';
import { isWindows } from '../../util/ui';
import { WarningIcon } from '../../icons';
import { FloppyDisk, FolderOpen, LockSimple, ToggleLeft, ToggleRight, Trash } from '@phosphor-icons/react'; // wirepane

import { DEFAULT_TLS_PASSTHROUGH_HOSTNAMES, isValidPortConfiguration, ProxyStore } from '../../model/proxy-store'; // wirepane
import { isValidHostnamePattern } from '../../model/network';
import {
    serverVersion,
    desktopVersion,
    versionSatisfies,
    INITIAL_HTTP2_RANGE,
    TLS_PASSTHROUGH_SUPPORTED,
    KEY_LOG_FILE_SUPPORTED,
    DESKTOP_SELECT_SAVE_FILE_SUPPORTED
} from '../../services/service-versions';
import { DesktopApi } from '../../services/desktop-api';

import { inputValidation } from '../component-utils';
import {
    CollapsibleCardProps,
    CollapsibleCard,
    CollapsibleCardHeading
} from '../common/card';
import { ContentLabel } from '../common/text-content';
import { Select, TextInput } from '../common/inputs';
import { IconButton } from '../common/icon-button';
import {
    SettingsButton,
    SettingsExplanation,
    SettingsSubheading,
    SettingsSubheadingRow
} from './settings-components';
import { StringSettingsList } from './string-settings-list';
import { DEFAULT_PROXY_PORT_RANGE } from '../../model/proxy-port-memory'; // wirepane

// wirepane: the card's one primary action, at the top right, clear of the left-aligned title
const RestartApp = styled(SettingsButton).attrs(() => ({
    children: 'Restart app to activate',
    highlight: true,
    onClick: () => window.location.reload()
}))`
    position: absolute;
    top: 14px;
    right: 20px;

    ${(p: { visible: boolean }) => !p.visible && '&& { display: none; }'}
`;

const UnsavedIcon = styled((p: { title: string, className?: string }) => // wirepane: Phosphor
    <FloppyDisk className={p.className} size={16} alt={p.title} />
)`
    margin-left: 10px;
    color: ${p => p.theme.warningColor};
`;

const ProxyPortsContainer = styled.div`
    display: grid;
    grid-template-columns: fit-content(45%) fit-content(45%) fit-content(10%);
    align-items: baseline;

    grid-gap: 10px;
    margin-bottom: 10px;

    input {
        & + ${WarningIcon} {
            visibility: hidden;
            align-self: center;
        }

        &:invalid + ${WarningIcon} {
            visibility: visible;
        }
    }
`;

const ProxyPortStateExplanation = styled.p`
    margin-bottom: 10px;
`;

const Http2Select = styled(Select)`
    display: inline-block;
    margin-top: 10px;
    width: auto;
    font-size: ${p => p.theme.textSize};
    padding: 3px;
`;

const TlsPassthroughModeToggle = styled.button.attrs(() => ({
    type: 'button' as const
}))`
    display: flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;

    margin-left: auto;

    background: none;
    border: none;
    padding: 0;
    color: ${p => p.theme.mainColor};
    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.textSize};
`;

// wirepane: the hostnames Wirepane always passes through (DEFAULT_TLS_PASSTHROUGH_HOSTNAMES),
// shown read-only below the user's own list
const BuiltInHostnamesHeading = styled.p`
    margin-top: 16px;
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};
`;

const BuiltInHostnames = styled.ul`
    display: flex;
    flex-wrap: wrap;
    gap: 6px 8px;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
`;

const BuiltInHostname = styled.li`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 2px 8px;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 4px;
    background-color: ${p => p.theme.mainLowlightBackground};

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainColor};

    > svg {
        flex-shrink: 0;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const TlsKeyLogInputContainer = styled.div`
    margin: 10px 0;
    display: flex;
    flex-direction: column;
    position: relative;
`;

const TlsKeyLogButtonsContainer = styled.div`
    display: grid;
    grid-template-columns: auto min-content min-content;
    grid-gap: 10px;
    align-items: center;
    font-family: ${p => p.theme.monoFontFamily};
`;

const InputClearButton = styled(IconButton)`
    position: absolute;
    top: 1px;
    right: 2px;
`;

const hostnameValidation = inputValidation(isValidHostnamePattern, "Should be a valid hostname (with optional * wildcards)");

const isAbsoluteWindowsPath = (path: string) => /^([a-zA-Z]:[\\\/]|[\\\/])((?:[^<>:"\/\\|?*]+)[\\\/]?)*$/.test(path);
const isAbsolutePosixPath = (path: string) => /^\/(?:[^/]+\/?)*$/.test(path);

const pathValidation = inputValidation(
    isWindows ? isAbsoluteWindowsPath : isAbsolutePosixPath,
    "Should be a valid absolute file path"
);

@inject('proxyStore')
@observer
export class ProxySettingsCard extends React.Component<
    CollapsibleCardProps & {
        proxyStore?: ProxyStore
    }
> {

    @observable
    minPortValue = (this.props.proxyStore!.portConfig?.startPort || DEFAULT_PROXY_PORT_RANGE.startPort).toString(); // wirepane

    @observable
    maxPortValue = (this.props.proxyStore!.portConfig?.endPort || DEFAULT_PROXY_PORT_RANGE.endPort).toString(); // wirepane

    @action.bound
    onMinPortChange({ target: { value } }: React.ChangeEvent<HTMLInputElement>) {
        this.minPortValue = value;
        this.updatePortConfig();
    }

    @action.bound
    onMaxPortChange({ target: { value } }: React.ChangeEvent<HTMLInputElement>) {
        this.maxPortValue = value;
        this.updatePortConfig();
    }

    @computed
    get isCurrentPortInRange() {
        const { httpProxyPort, portConfig } = this.props.proxyStore!;

        if (!portConfig) {
            // wirepane: Wirepane's default range, not 8000 and up
            return httpProxyPort >= DEFAULT_PROXY_PORT_RANGE.startPort && httpProxyPort <= DEFAULT_PROXY_PORT_RANGE.endPort;
        } else {
            return httpProxyPort >= portConfig.startPort && httpProxyPort <= portConfig.endPort;
        }
    }

    @computed
    get portConfig() {
        return {
            startPort: parseInt(this.minPortValue, 10),
            endPort: parseInt(this.maxPortValue, 10)
        };
    }

    @computed
    get isCurrentPortConfigValid() {
        return isValidPortConfiguration(this.portConfig);
    }

    updatePortConfig() {
        if (!this.isCurrentPortConfigValid) return;
        else this.props.proxyStore!.setPortConfig(this.portConfig);
    }

    private get tlsHostnames() {
        const config = this.props.proxyStore!.tlsInterceptionConfig;
        return 'tlsPassthrough' in config
            ? config.tlsPassthrough
            : config.tlsInterceptOnly;
    }

    private get tlsMode(): 'passthrough' | 'intercept-only' {
        return 'tlsInterceptOnly' in this.props.proxyStore!.tlsInterceptionConfig
            ? 'intercept-only'
            : 'passthrough';
    }

    @action.bound
    addTlsPassthroughHostname(hostname: string) {
        this.tlsHostnames.push({ hostname });
    }

    @action.bound
    removeTlsPassthroughHostname(hostname: string) {
        const hostnames = this.tlsHostnames;
        const hostnameIndex = _.findIndex(hostnames, (item) =>
            item.hostname === hostname
        );

        if (hostnameIndex === -1) return;

        hostnames.splice(hostnameIndex, 1);
    }

    @action.bound
    toggleTlsMode() {
        const proxyStore = this.props.proxyStore!;
        const hostnames = this.tlsHostnames;
        if (this.tlsMode === 'passthrough') {
            proxyStore.tlsInterceptionConfig = { tlsInterceptOnly: hostnames };
        } else {
            proxyStore.tlsInterceptionConfig = { tlsPassthrough: hostnames };
        }
    }

    @observable
    tlsKeyFileInput: string = this.props.proxyStore!.keyLogFilePath || '';

    @action.bound
    setTlsKeyFilePath({ target }: React.ChangeEvent<HTMLInputElement>) {
        this.tlsKeyFileInput = target.value;

        if (!this.tlsKeyFileInput.trim()) {
            this.props.proxyStore!.keyLogFilePath = undefined;
        } else if (pathValidation(target)) {
            this.props.proxyStore!.keyLogFilePath = this.tlsKeyFileInput.trim();
        }
    }

    @action.bound
    async setTlsKeyFilePathFromDialog() {
        const path = await DesktopApi.selectSaveFilePath!();
        if (!path) return; // Dialog cancelled, change nothing

        runInAction(() => {
            this.props.proxyStore!.keyLogFilePath = path;
        });
    }

    @action.bound
    clearTlsKeyFilePath() {
        this.tlsKeyFileInput = '';
        this.props.proxyStore!.keyLogFilePath = undefined;
    }

    render() {
        const { proxyStore, ...cardProps } = this.props;
        const {
            httpProxyPort,

            http2Enabled,
            http2CurrentlyEnabled,

            tlsInterceptionConfig,
            currentTlsInterceptionConfig,

            keyLogFilePath,
            currentKeyLogFilePath
        } = proxyStore!;

        const tlsMode = this.tlsMode;
        const tlsHostnames = this.tlsHostnames;

        return <CollapsibleCard {...cardProps}>
            <header>
                <CollapsibleCardHeading onCollapseToggled={
                    cardProps.onCollapseToggled
                }>
                    Proxy
                </CollapsibleCardHeading>
            </header>
            <RestartApp
                visible={
                    (this.isCurrentPortConfigValid && !this.isCurrentPortInRange) ||
                    http2Enabled !== http2CurrentlyEnabled ||
                    !_.isEqual(tlsInterceptionConfig, currentTlsInterceptionConfig) ||
                    keyLogFilePath !== currentKeyLogFilePath
                }
            />

            <ProxyPortsContainer>
                <ContentLabel>
                    Minimum port
                </ContentLabel>
                <TextInput
                    type="number"
                    required
                    min="1"
                    max="65535"
                    value={this.minPortValue}
                    onChange={this.onMinPortChange}
                />
                <WarningIcon />

                <ContentLabel>
                    Maximum port
                </ContentLabel>
                <TextInput
                    type="number"
                    required
                    min={this.minPortValue}
                    max="65535"
                    value={this.maxPortValue}
                    onChange={this.onMaxPortChange}
                />
                <WarningIcon />
            </ProxyPortsContainer>
            <ProxyPortStateExplanation>
                The proxy is currently using port <strong>
                    { httpProxyPort }
                </strong>{
                    (this.isCurrentPortConfigValid && !this.isCurrentPortInRange)
                    ? ', outside this range. Restart the app now to use this configuration.'
                    : '.'
                }
            </ProxyPortStateExplanation>
            <SettingsExplanation>
                { /* wirepane: the last port is reused, see model/proxy-port-memory.ts */ }
                When opening Wirepane, it reuses the port it had last time if that's free
                and in this range, so phones and other devices keep working. Otherwise it
                starts the proxy on the first port in this range that is available. If all
                ports in the range are in use, any free port is used instead. By default Wirepane
                uses {DEFAULT_PROXY_PORT_RANGE.startPort}–{DEFAULT_PROXY_PORT_RANGE.endPort}, clear of the
                ports that dev servers and frameworks use, like 3000, 5173, 8000 and 8080.
            </SettingsExplanation>

            {
                versionSatisfies(serverVersion.value, TLS_PASSTHROUGH_SUPPORTED) && <>
                    <SettingsSubheadingRow>
                        <SettingsSubheading>TLS passthrough</SettingsSubheading>

                        { !_.isEqual(tlsInterceptionConfig, currentTlsInterceptionConfig) &&
                            <UnsavedIcon title="Restart app to apply changes" />
                        }

                        <TlsPassthroughModeToggle
                            title={tlsMode === 'passthrough'
                                ? "Listed hostnames are not intercepted. Click to switch to intercept-only mode."
                                : "Only listed hostnames are intercepted. Click to switch to passthrough mode."
                            }
                            onClick={this.toggleTlsMode}
                        >
                            { tlsMode === 'passthrough'
                                ? 'Exclude hostnames'
                                : 'Intercept only these hostnames'
                            }
                            { tlsMode === 'passthrough'
                                ? <ToggleRight size={20} weight='fill' aria-hidden={true} />
                                : <ToggleLeft size={20} aria-hidden={true} />
                            }
                        </TlsPassthroughModeToggle>
                    </SettingsSubheadingRow>

                    <StringSettingsList
                        values={tlsHostnames.map(c => c.hostname)}
                        onAdd={this.addTlsPassthroughHostname}
                        onDelete={this.removeTlsPassthroughHostname}
                        placeholder={tlsMode === 'intercept-only'
                            ? 'A hostname whose TLS connections should be intercepted'
                            : 'A hostname whose TLS connections should not be intercepted'
                        }
                        validationFn={hostnameValidation}
                    />

                    <SettingsExplanation>
                        { tlsMode === 'intercept-only'
                            ? <>
                                Only TLS connections to these hostnames will be intercepted by Wirepane.
                                All other TLS connections will be forwarded upstream without
                                interception. Non-TLS traffic is always visible regardless of this setting.
                            </>
                            : <>
                                TLS connections to these hostnames will be forwarded upstream untouched, without
                                interception. This may solve some certificate trust connectivity issues,
                                but traffic within these TLS connections will not be accessible.
                            </>
                        }
                    </SettingsExplanation>

                    { /* wirepane: in intercept-only mode everything else is left alone anyway */ }
                    { tlsMode === 'passthrough' && <>
                        <BuiltInHostnamesHeading>Always passed through</BuiltInHostnamesHeading>
                        <BuiltInHostnames aria-label='Hostnames that are always passed through'>
                            { DEFAULT_TLS_PASSTHROUGH_HOSTNAMES.map((hostname) =>
                                <BuiltInHostname key={hostname}>
                                    <LockSimple size={14} aria-hidden={true} />
                                    { hostname }
                                </BuiltInHostname>
                            ) }
                        </BuiltInHostnames>
                        <SettingsExplanation>
                            Built in, so they can't be changed: pinned Apple services, so the
                            phone keeps working in VPN mode.
                        </SettingsExplanation>
                    </> }
                </>
            }

            {
                versionSatisfies(serverVersion.value, INITIAL_HTTP2_RANGE) && <>
                    <SettingsSubheadingRow>
                        <SettingsSubheading>HTTP/2 support</SettingsSubheading>

                        { http2Enabled !== http2CurrentlyEnabled &&
                            <UnsavedIcon title="Restart app to apply changes" />
                        }
                    </SettingsSubheadingRow>

                    <Http2Select
                        value={JSON.stringify(http2Enabled)}
                        onChange={action((event: React.ChangeEvent<HTMLSelectElement>) => {
                            const value = event.currentTarget.value;
                            if (value) {
                                proxyStore!.http2Enabled = JSON.parse(value);
                            }
                        })}
                    >
                        <option value={'true'}>Enabled for all clients</option>
                        <option value={'"fallback"'}>Enabled only for HTTP/2-only clients</option>
                        <option value={'false'}>Disabled for all clients</option>
                    </Http2Select>
                </>
            }

            {
                versionSatisfies(serverVersion.value, KEY_LOG_FILE_SUPPORTED) && <>
                    <SettingsSubheadingRow>
                        <SettingsSubheading>TLS key log file</SettingsSubheading>

                        { keyLogFilePath !== currentKeyLogFilePath &&
                            <UnsavedIcon title="Restart app to apply changes" />
                        }
                    </SettingsSubheadingRow>

                    <TlsKeyLogInputContainer>
                        { versionSatisfies(desktopVersion.value, DESKTOP_SELECT_SAVE_FILE_SUPPORTED)
                            ? !keyLogFilePath
                                ? <SettingsButton
                                    onClick={this.setTlsKeyFilePathFromDialog}
                                >
                                    Choose where to save it…
                                </SettingsButton>
                                : <TlsKeyLogButtonsContainer>
                                    { keyLogFilePath }
                                    <SettingsButton
                                        onClick={this.setTlsKeyFilePathFromDialog}
                                        title='Choose another file'
                                        aria-label='Choose another file'
                                    >
                                        <FolderOpen size={16} aria-hidden={true} />
                                    </SettingsButton>
                                    <SettingsButton
                                        onClick={this.clearTlsKeyFilePath}
                                        title='Stop logging TLS keys'
                                        aria-label='Stop logging TLS keys'
                                    >
                                        <Trash size={16} aria-hidden={true} />
                                    </SettingsButton>
                                </TlsKeyLogButtonsContainer>
                            : <>
                                <TextInput
                                    placeholder={
                                        navigator.platform.startsWith('Win')
                                            ? 'C:\\tls-keys.log'
                                            : '/tmp/tls-keys.log'
                                    }
                                    value={this.tlsKeyFileInput}
                                    onChange={this.setTlsKeyFilePath}
                                />
                                { !!this.tlsKeyFileInput &&
                                    <InputClearButton
                                        title="Unset TLS key file"
                                        icon={['fas', 'times']}
                                        onClick={this.clearTlsKeyFilePath}
                                    />
                                }
                            </>
                        }
                    </TlsKeyLogInputContainer>

                    <SettingsExplanation>
                        If set, TLS keys for all client & server traffic will be logged to this file,
                        allowing inspection of raw TLS packet contents & details in low-level packet
                        inspection tools like Wireshark.
                    </SettingsExplanation>
                </>
            }
        </CollapsibleCard>
    }

}