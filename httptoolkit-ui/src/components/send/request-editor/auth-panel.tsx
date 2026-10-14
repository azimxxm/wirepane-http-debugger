import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { action, runInAction } from 'mobx';

import { styled, css } from '../../../styles';
import { RequestInput } from '../../../model/send/send-request-model';
import {
    SendAuthData,
    SendAuthMode,
    SendBearerAuth,
    SendBasicAuth,
    SendApiKeyAuth,
    SendDigestAuth,
    SendHawkAuth,
    SendJwtAuth,
    SendOAuth1Auth,
    SendOAuth2Auth,
    SendAwsAuth
} from '../../../model/send/send-extras';
import { PanelScroll, PanelNote } from './panel-layout';
import { TextInput } from '../../common/inputs';

const AuthContainer = styled.div`
    display: flex;
    flex-direction: row;
    gap: 24px;
    align-items: flex-start;
    min-height: 250px;
`;

const AuthSidebar = styled.div`
    width: 240px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
`;

const AuthContent = styled.div`
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 16px;
    border-left: 1px solid ${p => p.theme.containerBorder};
    padding-left: 24px;
`;

const FieldLabel = styled.label`
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
    display: flex;
    flex-direction: column;
    gap: 6px;
`;

const FieldRow = styled.div`
    display: flex;
    flex-direction: column;
    gap: 6px;
`;

const FieldInput = styled(TextInput)`
    height: 32px;
    font-size: ${p => p.theme.textInputFontSize};
`;

const FieldSelect = styled.select`
    height: 32px;
    border-radius: 4px;
    padding: 0 10px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};
    font-family: inherit;
    font-size: ${p => p.theme.textInputFontSize};

    &:focus {
        outline: none;
        border-color: ${p => p.theme.popColor};
    }
`;

const FieldTextarea = styled.textarea`
    min-height: 80px;
    border-radius: 4px;
    padding: 8px 10px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    resize: vertical;

    &:focus {
        outline: none;
        border-color: ${p => p.theme.popColor};
    }
`;

const AdvancedToggle = styled.button.attrs(() => ({ type: 'button' }))`
    background: none;
    border: none;
    color: ${p => p.theme.popColor};
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 500;
    cursor: pointer;
    padding: 0;
    margin-top: 4px;
    align-self: flex-start;

    &:hover {
        text-decoration: underline;
    }
`;

const EmptyStateText = styled.div`
    padding: 24px 0;
    color: ${p => p.theme.mainLowlightColor};
    font-size: ${p => p.theme.textSize};
    display: flex;
    flex-direction: column;
    gap: 8px;
`;

const CheckboxLabel = styled.label`
    display: inline-flex;
    align-items: center;
    gap: 8px;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainColor};
    cursor: pointer;

    > input[type="checkbox"] {
        accent-color: ${p => p.theme.popColor};
    }
`;

const AUTH_MODES: Array<{ mode: SendAuthMode; label: string }> = [
    { mode: 'none', label: 'No Auth' },
    { mode: 'inherit', label: 'Inherit auth from parent' },
    { mode: 'bearer', label: 'Bearer Token' },
    { mode: 'basic', label: 'Basic Auth' },
    { mode: 'apikey', label: 'API Key' },
    { mode: 'jwt', label: 'JWT Bearer' },
    { mode: 'digest', label: 'Digest Auth' },
    { mode: 'oauth1', label: 'OAuth 1.0' },
    { mode: 'oauth2', label: 'OAuth 2.0' },
    { mode: 'hawk', label: 'Hawk Authentication' },
    { mode: 'aws', label: 'AWS Signature' }
];

export const AuthPanel = observer((props: { requestInput: RequestInput }) => {
    const { requestInput } = props;
    const auth = requestInput.extras.auth;
    const [showAdvanced, setShowAdvanced] = React.useState(false);

    const onModeChange = action((mode: SendAuthMode) => {
        auth.mode = mode;
        if (!auth.bearer && mode === 'bearer') auth.bearer = { token: '', prefix: 'Bearer' };
        if (!auth.basic && mode === 'basic') auth.basic = { username: '', password: '' };
        if (!auth.apikey && mode === 'apikey') auth.apikey = { key: '', value: '', placement: 'header' };
        if (!auth.jwt && mode === 'jwt') auth.jwt = { algorithm: 'HS256', secret: '', isSecretBase64: false, payload: '{}', headerPrefix: 'Bearer' };
        if (!auth.digest && mode === 'digest') auth.digest = { username: '', password: '', realm: '', nonce: '', algorithm: 'MD5', qop: 'auth' };
        if (!auth.oauth1 && mode === 'oauth1') auth.oauth1 = { signatureMethod: 'HMAC-SHA1', consumerKey: '', consumerSecret: '', accessToken: '', tokenSecret: '', placement: 'header' };
        if (!auth.oauth2 && mode === 'oauth2') auth.oauth2 = { grantType: 'authorization_code', token: '', headerPrefix: 'Bearer' };
        if (!auth.hawk && mode === 'hawk') auth.hawk = { authId: '', authKey: '', algorithm: 'sha256' };
        if (!auth.aws && mode === 'aws') auth.aws = { accessKey: '', secretKey: '', region: 'us-east-1', service: 'execute-api' };
    });

    const updateAuth = action(<K extends keyof SendAuthData>(key: K, value: SendAuthData[K]) => {
        auth[key] = value;
    });

    return <PanelScroll>
        <AuthContainer>
            <AuthSidebar>
                <FieldLabel>
                    Auth type
                    <FieldSelect
                        value={auth.mode}
                        onChange={(e) => onModeChange(e.target.value as SendAuthMode)}
                    >
                        {AUTH_MODES.map((item) => (
                            <option key={item.mode} value={item.mode}>
                                {item.label}
                            </option>
                        ))}
                    </FieldSelect>
                </FieldLabel>

                <PanelNote>
                    The authorization header will be automatically generated when you send the request.
                </PanelNote>
            </AuthSidebar>

            <AuthContent>
                {auth.mode === 'none' && (
                    <EmptyStateText>
                        <strong>No Auth</strong>
                        <span>This request does not use any authorization.</span>
                    </EmptyStateText>
                )}

                {auth.mode === 'inherit' && (
                    <EmptyStateText>
                        <strong>Inherit auth from parent</strong>
                        <span>This request will inherit the authorization configuration from its collection or parent folder.</span>
                    </EmptyStateText>
                )}

                {auth.mode === 'bearer' && (
                    <>
                        <FieldRow>
                            <FieldLabel>Token</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Token or {{token}}"
                                value={auth.bearer?.token ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.bearer = { ...auth.bearer, token: e.target.value };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Prefix</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Bearer"
                                value={auth.bearer?.prefix ?? 'Bearer'}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.bearer = { ...auth.bearer, token: auth.bearer?.token ?? '', prefix: e.target.value };
                                })}
                            />
                        </FieldRow>
                    </>
                )}

                {auth.mode === 'basic' && (
                    <>
                        <FieldRow>
                            <FieldLabel>Username</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Username"
                                value={auth.basic?.username ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.basic = { ...auth.basic, username: e.target.value, password: auth.basic?.password ?? '' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Password</FieldLabel>
                            <FieldInput
                                type="password"
                                placeholder="Password"
                                value={auth.basic?.password ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.basic = { ...auth.basic, username: auth.basic?.username ?? '', password: e.target.value };
                                })}
                            />
                        </FieldRow>
                    </>
                )}

                {auth.mode === 'apikey' && (
                    <>
                        <FieldRow>
                            <FieldLabel>Key</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Key (e.g. X-API-Key)"
                                value={auth.apikey?.key ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.apikey = { ...auth.apikey, key: e.target.value, value: auth.apikey?.value ?? '', placement: auth.apikey?.placement ?? 'header' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Value</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Value"
                                value={auth.apikey?.value ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.apikey = { ...auth.apikey, key: auth.apikey?.key ?? '', value: e.target.value, placement: auth.apikey?.placement ?? 'header' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Add to</FieldLabel>
                            <FieldSelect
                                value={auth.apikey?.placement ?? 'header'}
                                onChange={action((e: React.ChangeEvent<HTMLSelectElement>) => {
                                    auth.apikey = { ...auth.apikey, key: auth.apikey?.key ?? '', value: auth.apikey?.value ?? '', placement: e.target.value as 'header' | 'queryparams' };
                                })}
                            >
                                <option value="header">Header</option>
                                <option value="queryparams">Query Params</option>
                            </FieldSelect>
                        </FieldRow>
                    </>
                )}

                {auth.mode === 'jwt' && (
                    <>
                        <FieldRow>
                            <FieldLabel>Algorithm</FieldLabel>
                            <FieldSelect
                                value={auth.jwt?.algorithm ?? 'HS256'}
                                onChange={action((e: React.ChangeEvent<HTMLSelectElement>) => {
                                    auth.jwt = { ...auth.jwt, algorithm: e.target.value, secret: auth.jwt?.secret ?? '', isSecretBase64: !!auth.jwt?.isSecretBase64, payload: auth.jwt?.payload ?? '{}' };
                                })}
                            >
                                <option value="HS256">HS256</option>
                                <option value="HS384">HS384</option>
                                <option value="HS512">HS512</option>
                                <option value="RS256">RS256</option>
                            </FieldSelect>
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Secret or Ready Token</FieldLabel>
                            <FieldInput
                                type="password"
                                placeholder="Secret key or pre-signed JWT token"
                                value={auth.jwt?.secret ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.jwt = { ...auth.jwt, secret: e.target.value, algorithm: auth.jwt?.algorithm ?? 'HS256', isSecretBase64: !!auth.jwt?.isSecretBase64, payload: auth.jwt?.payload ?? '{}' };
                                })}
                            />
                        </FieldRow>
                        <CheckboxLabel>
                            <input
                                type="checkbox"
                                checked={auth.jwt?.isSecretBase64 ?? false}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.jwt = { ...auth.jwt, isSecretBase64: e.target.checked, secret: auth.jwt?.secret ?? '', algorithm: auth.jwt?.algorithm ?? 'HS256', payload: auth.jwt?.payload ?? '{}' };
                                })}
                            />
                            Secret Base64 encoded
                        </CheckboxLabel>
                        <FieldRow>
                            <FieldLabel>Payload (JSON)</FieldLabel>
                            <FieldTextarea
                                placeholder="{}"
                                value={auth.jwt?.payload ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLTextAreaElement>) => {
                                    auth.jwt = { ...auth.jwt, payload: e.target.value, secret: auth.jwt?.secret ?? '', algorithm: auth.jwt?.algorithm ?? 'HS256', isSecretBase64: !!auth.jwt?.isSecretBase64 };
                                })}
                            />
                        </FieldRow>
                    </>
                )}

                {auth.mode === 'digest' && (
                    <>
                        <FieldRow>
                            <FieldLabel>Username</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Username"
                                value={auth.digest?.username ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.digest = { ...auth.digest, username: e.target.value, password: auth.digest?.password ?? '' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Password</FieldLabel>
                            <FieldInput
                                type="password"
                                placeholder="Password"
                                value={auth.digest?.password ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.digest = { ...auth.digest, password: e.target.value, username: auth.digest?.username ?? '' };
                                })}
                            />
                        </FieldRow>
                        <AdvancedToggle onClick={() => setShowAdvanced(!showAdvanced)}>
                            {showAdvanced ? '▼ Hide advanced configuration' : '▶ Show advanced configuration'}
                        </AdvancedToggle>
                        {showAdvanced && (
                            <>
                                <FieldRow>
                                    <FieldLabel>Realm</FieldLabel>
                                    <FieldInput
                                        type="text"
                                        placeholder="Realm"
                                        value={auth.digest?.realm ?? ''}
                                        onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                            auth.digest = { ...auth.digest, realm: e.target.value, username: auth.digest?.username ?? '', password: auth.digest?.password ?? '' };
                                        })}
                                    />
                                </FieldRow>
                                <FieldRow>
                                    <FieldLabel>Nonce</FieldLabel>
                                    <FieldInput
                                        type="text"
                                        placeholder="Nonce"
                                        value={auth.digest?.nonce ?? ''}
                                        onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                            auth.digest = { ...auth.digest, nonce: e.target.value, username: auth.digest?.username ?? '', password: auth.digest?.password ?? '' };
                                        })}
                                    />
                                </FieldRow>
                                <FieldRow>
                                    <FieldLabel>Algorithm</FieldLabel>
                                    <FieldInput
                                        type="text"
                                        placeholder="MD5"
                                        value={auth.digest?.algorithm ?? 'MD5'}
                                        onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                            auth.digest = { ...auth.digest, algorithm: e.target.value, username: auth.digest?.username ?? '', password: auth.digest?.password ?? '' };
                                        })}
                                    />
                                </FieldRow>
                            </>
                        )}
                    </>
                )}

                {auth.mode === 'oauth1' && (
                    <>
                        <FieldRow>
                            <FieldLabel>Signature Method</FieldLabel>
                            <FieldSelect
                                value={auth.oauth1?.signatureMethod ?? 'HMAC-SHA1'}
                                onChange={action((e: React.ChangeEvent<HTMLSelectElement>) => {
                                    auth.oauth1 = { ...auth.oauth1, signatureMethod: e.target.value, consumerKey: auth.oauth1?.consumerKey ?? '', consumerSecret: auth.oauth1?.consumerSecret ?? '', accessToken: auth.oauth1?.accessToken ?? '', tokenSecret: auth.oauth1?.tokenSecret ?? '', placement: auth.oauth1?.placement ?? 'header' };
                                })}
                            >
                                <option value="HMAC-SHA1">HMAC-SHA1</option>
                                <option value="HMAC-SHA256">HMAC-SHA256</option>
                                <option value="PLAINTEXT">PLAINTEXT</option>
                            </FieldSelect>
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Consumer Key</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Consumer Key"
                                value={auth.oauth1?.consumerKey ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.oauth1 = { ...auth.oauth1, consumerKey: e.target.value, signatureMethod: auth.oauth1?.signatureMethod ?? 'HMAC-SHA1', consumerSecret: auth.oauth1?.consumerSecret ?? '', accessToken: auth.oauth1?.accessToken ?? '', tokenSecret: auth.oauth1?.tokenSecret ?? '', placement: auth.oauth1?.placement ?? 'header' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Consumer Secret</FieldLabel>
                            <FieldInput
                                type="password"
                                placeholder="Consumer Secret"
                                value={auth.oauth1?.consumerSecret ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.oauth1 = { ...auth.oauth1, consumerSecret: e.target.value, consumerKey: auth.oauth1?.consumerKey ?? '', signatureMethod: auth.oauth1?.signatureMethod ?? 'HMAC-SHA1', accessToken: auth.oauth1?.accessToken ?? '', tokenSecret: auth.oauth1?.tokenSecret ?? '', placement: auth.oauth1?.placement ?? 'header' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Access Token</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Access Token"
                                value={auth.oauth1?.accessToken ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.oauth1 = { ...auth.oauth1, accessToken: e.target.value, consumerKey: auth.oauth1?.consumerKey ?? '', consumerSecret: auth.oauth1?.consumerSecret ?? '', signatureMethod: auth.oauth1?.signatureMethod ?? 'HMAC-SHA1', tokenSecret: auth.oauth1?.tokenSecret ?? '', placement: auth.oauth1?.placement ?? 'header' };
                                })}
                            />
                        </FieldRow>
                    </>
                )}

                {auth.mode === 'oauth2' && (
                    <>
                        <FieldRow>
                            <FieldLabel>Access Token</FieldLabel>
                            <FieldInput
                                type="password"
                                placeholder="Paste OAuth 2.0 Access Token"
                                value={auth.oauth2?.token ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.oauth2 = { ...auth.oauth2, token: e.target.value, grantType: auth.oauth2?.grantType ?? 'authorization_code' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Header Prefix</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Bearer"
                                value={auth.oauth2?.headerPrefix ?? 'Bearer'}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.oauth2 = { ...auth.oauth2, headerPrefix: e.target.value, token: auth.oauth2?.token ?? '', grantType: auth.oauth2?.grantType ?? 'authorization_code' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Grant Type</FieldLabel>
                            <FieldSelect
                                value={auth.oauth2?.grantType ?? 'authorization_code'}
                                onChange={action((e: React.ChangeEvent<HTMLSelectElement>) => {
                                    auth.oauth2 = { ...auth.oauth2, grantType: e.target.value, token: auth.oauth2?.token ?? '' };
                                })}
                            >
                                <option value="authorization_code">Authorization Code</option>
                                <option value="client_credentials">Client Credentials</option>
                                <option value="password">Password Credentials</option>
                                <option value="implicit">Implicit</option>
                            </FieldSelect>
                        </FieldRow>
                    </>
                )}

                {auth.mode === 'hawk' && (
                    <>
                        <FieldRow>
                            <FieldLabel>Hawk Auth ID</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Auth ID"
                                value={auth.hawk?.authId ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.hawk = { ...auth.hawk, authId: e.target.value, authKey: auth.hawk?.authKey ?? '', algorithm: auth.hawk?.algorithm ?? 'sha256' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>Hawk Auth Key</FieldLabel>
                            <FieldInput
                                type="password"
                                placeholder="Auth Key"
                                value={auth.hawk?.authKey ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.hawk = { ...auth.hawk, authKey: e.target.value, authId: auth.hawk?.authId ?? '', algorithm: auth.hawk?.algorithm ?? 'sha256' };
                                })}
                            />
                        </FieldRow>
                    </>
                )}

                {auth.mode === 'aws' && (
                    <>
                        <FieldRow>
                            <FieldLabel>AccessKey</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="Access Key ID"
                                value={auth.aws?.accessKey ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.aws = { ...auth.aws, accessKey: e.target.value, secretKey: auth.aws?.secretKey ?? '' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>SecretKey</FieldLabel>
                            <FieldInput
                                type="password"
                                placeholder="Secret Access Key"
                                value={auth.aws?.secretKey ?? ''}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.aws = { ...auth.aws, secretKey: e.target.value, accessKey: auth.aws?.accessKey ?? '' };
                                })}
                            />
                        </FieldRow>
                        <FieldRow>
                            <FieldLabel>AWS Region</FieldLabel>
                            <FieldInput
                                type="text"
                                placeholder="us-east-1"
                                value={auth.aws?.region ?? 'us-east-1'}
                                onChange={action((e: React.ChangeEvent<HTMLInputElement>) => {
                                    auth.aws = { ...auth.aws, region: e.target.value, accessKey: auth.aws?.accessKey ?? '', secretKey: auth.aws?.secretKey ?? '' };
                                })}
                            />
                        </FieldRow>
                    </>
                )}
            </AuthContent>
        </AuthContainer>
    </PanelScroll>;
});
