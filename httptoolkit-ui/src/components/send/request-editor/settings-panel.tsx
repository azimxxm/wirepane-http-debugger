import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { action } from 'mobx';

import { styled, css } from '../../../styles';
import { RequestInput } from '../../../model/send/send-request-model';
import { PanelScroll } from './panel-layout';

const SettingsList = styled.div`
    display: flex;
    flex-direction: column;
    gap: 20px;
    max-width: 680px;
`;

const SettingItem = styled.div`
    display: flex;
    flex-direction: row;
    justify-content: space-between;
    align-items: flex-start;
    gap: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid ${p => p.theme.containerBorder};

    &:last-child {
        border-bottom: none;
    }
`;

const SettingText = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
    flex: 1 1 auto;
`;

const SettingTitle = styled.div`
    font-size: ${p => p.theme.textSize};
    font-weight: 500;
    color: ${p => p.theme.mainColor};
`;

const SettingDescription = styled.div`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
    line-height: 1.4;
`;

const ToggleSwitch = styled.label<{ checked: boolean }>`
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    flex-shrink: 0;
    cursor: pointer;

    > input {
        opacity: 0;
        width: 0;
        height: 0;
    }

    > span {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: ${p => p.checked ? p.theme.popColor : p.theme.containerBorder};
        transition: 0.2s;
        border-radius: 20px;

        &:before {
            position: absolute;
            content: "";
            height: 14px;
            width: 14px;
            left: 3px;
            bottom: 3px;
            background-color: white;
            transition: 0.2s;
            border-radius: 50%;
            transform: ${p => p.checked ? 'translateX(16px)' : 'none'};
        }
    }
`;

const SettingSelect = styled.select`
    height: 32px;
    border-radius: 4px;
    padding: 0 12px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};
    font-family: inherit;
    font-size: ${p => p.theme.textInputFontSize};
    min-width: 120px;

    &:focus {
        outline: none;
        border-color: ${p => p.theme.popColor};
    }
`;

export const SettingsPanel = observer((props: { requestInput: RequestInput }) => {
    const { requestInput } = props;
    const settings = requestInput.extras.settings;

    return <PanelScroll>
        <SettingsList>
            <SettingItem>
                <SettingText>
                    <SettingTitle>HTTP version</SettingTitle>
                    <SettingDescription>
                        Select the HTTP version to use for sending this request.
                    </SettingDescription>
                </SettingText>
                <SettingSelect
                    value={settings.httpVersion}
                    onChange={action((e: React.ChangeEvent<HTMLSelectElement>) => {
                        settings.httpVersion = e.target.value as 'auto' | 'http1.1' | 'http2';
                    })}
                >
                    <option value="auto">Auto</option>
                    <option value="http1.1">HTTP/1.1</option>
                    <option value="http2">HTTP/2</option>
                </SettingSelect>
            </SettingItem>

            <SettingItem>
                <SettingText>
                    <SettingTitle>Enable SSL certificate verification</SettingTitle>
                    <SettingDescription>
                        Verify SSL certificates when sending this request. Verification failures will result in the request being aborted.
                    </SettingDescription>
                </SettingText>
                <ToggleSwitch checked={settings.sslVerification}>
                    <input
                        type="checkbox"
                        checked={settings.sslVerification}
                        onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                            settings.sslVerification = e.target.checked;
                        })}
                    />
                    <span />
                </ToggleSwitch>
            </SettingItem>

            <SettingItem>
                <SettingText>
                    <SettingTitle>Automatically follow redirects</SettingTitle>
                    <SettingDescription>
                        Follow HTTP 3xx responses as redirects.
                    </SettingDescription>
                </SettingText>
                <ToggleSwitch checked={settings.followRedirects}>
                    <input
                        type="checkbox"
                        checked={settings.followRedirects}
                        onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                            settings.followRedirects = e.target.checked;
                        })}
                    />
                    <span />
                </ToggleSwitch>
            </SettingItem>

            <SettingItem>
                <SettingText>
                    <SettingTitle>Follow original HTTP Method</SettingTitle>
                    <SettingDescription>
                        Redirect with the original HTTP method instead of the default behavior of redirecting with GET.
                    </SettingDescription>
                </SettingText>
                <ToggleSwitch checked={settings.followOriginalMethod}>
                    <input
                        type="checkbox"
                        checked={settings.followOriginalMethod}
                        onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                            settings.followOriginalMethod = e.target.checked;
                        })}
                    />
                    <span />
                </ToggleSwitch>
            </SettingItem>

            <SettingItem>
                <SettingText>
                    <SettingTitle>Follow Authorization header</SettingTitle>
                    <SettingDescription>
                        Retain authorization header when a redirect happens to a different hostname.
                    </SettingDescription>
                </SettingText>
                <ToggleSwitch checked={settings.followAuthorizationHeader}>
                    <input
                        type="checkbox"
                        checked={settings.followAuthorizationHeader}
                        onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                            settings.followAuthorizationHeader = e.target.checked;
                        })}
                    />
                    <span />
                </ToggleSwitch>
            </SettingItem>
        </SettingsList>
    </PanelScroll>;
});
