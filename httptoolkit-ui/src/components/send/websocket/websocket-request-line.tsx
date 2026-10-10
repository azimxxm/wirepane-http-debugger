import * as React from 'react';
import { Method } from 'mockttp';
import { observer } from 'mobx-react-lite';

import { styled } from '../../../styles';
import { Icon } from '../../../icons';
import { isMac } from '../../../util/ui';
import { formatShortcut } from '../../../util/shortcuts';

import { WEBSOCKET_OPTION } from '../../../model/send/websocket/request-type';
import type { WebSocketSessionState } from '../../../model/send/websocket/websocket-session';

import {
    MethodSelect,
    MethodSelectArrow,
    MethodSelectContainer,
    SendButton,
    SendRequestLineContainer,
    SendShortcut,
    UrlInput
} from '../send-request-line';
import { useTypeSwitchFocus } from './use-type-switch-focus';

const httpMethods = Object.values(Method).filter(
    (value): value is string => typeof value === 'string'
);

const CONNECT_SHORTCUT = formatShortcut('Cmd+Enter');

const ConnectButton = styled(SendButton)`
    min-width: 112px;
`;

// "WebSocket" is longer than any HTTP method
const TypeSelectContainer = styled(MethodSelectContainer)`
    flex-basis: 124px;
`;

/**
 * The request line of a WebSocket tab: the type picker (WebSocket, or an HTTP method to
 * switch back), the URL, and Connect / Disconnect.
 */
export const WebSocketRequestLine = observer((props: {
    url: string,
    updateUrl: (url: string) => void,
    switchToHttp: (method: string) => void,

    connectionStatus: WebSocketSessionState['status'],
    connect: () => void,
    cancel: () => void,
    disconnect: () => void
}) => {
    const { connectionStatus } = props;

    const typeSelectRef = React.useRef<HTMLSelectElement>(null);
    const urlInputRef = React.useRef<HTMLInputElement>(null);
    useTypeSwitchFocus(typeSelectRef, urlInputRef);

    const onTypeChange = React.useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        if (event.target.value !== WEBSOCKET_OPTION) props.switchToHttp(event.target.value);
    }, [props.switchToHttp]);

    const onUrlChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        props.updateUrl(event.target.value);
    }, [props.updateUrl]);

    // Like the HTTP request line: focusing an empty URL starts it for you
    const prepopulateUrl = React.useCallback((event: React.FocusEvent<HTMLInputElement>) => {
        if (!event.target.value) event.target.value = 'wss://';
    }, []);

    // A pasted URL replaces that start, instead of being added after it
    const onPaste = React.useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
        const pastedText = event.clipboardData.getData('text/plain');
        if (event.currentTarget.value === 'wss://' && /^\s*[a-z][a-z0-9+.-]*:\/\//i.test(pastedText)) {
            event.preventDefault();
            props.updateUrl(pastedText.trim());
        }
    }, [props.updateUrl]);

    // Enter in the URL connects. The button also disconnects.
    const onSubmit = React.useCallback((event: React.FormEvent) => {
        event.preventDefault();
        if (connectionStatus !== 'connecting' && connectionStatus !== 'open' && connectionStatus !== 'closing') {
            props.connect();
        }
    }, [connectionStatus, props.connect]);

    const button = connectionStatus === 'connecting'
        ? {
            label: <><Icon spin fixedWidth={true} icon={['fas', 'spinner']} /> Cancel</>,
            title: 'Stop connecting (Esc)',
            onClick: props.cancel
        }
        : connectionStatus === 'open'
        ? {
            label: <>Disconnect</>,
            title: 'Close this connection, with close code 1000',
            onClick: props.disconnect
        }
        : connectionStatus === 'closing'
        ? {
            label: <><Icon spin fixedWidth={true} icon={['fas', 'spinner']} /> Closing</>,
            title: 'Waiting for the server to close the connection',
            onClick: undefined
        }
        : {
            label: <>Connect <SendShortcut aria-hidden='true'>{ CONNECT_SHORTCUT }</SendShortcut></>,
            title: `Connect to this WebSocket (${CONNECT_SHORTCUT})`,
            onClick: props.connect
        };

    return <SendRequestLineContainer
        className='ignores-expanded' // This always shows, even if something is expanded
        onSubmit={onSubmit}
    >
        <TypeSelectContainer>
            <MethodSelect
                ref={typeSelectRef}
                aria-label='Request type'
                title='WebSocket request. Pick an HTTP method to switch back to HTTP.'
                value={WEBSOCKET_OPTION}
                onChange={onTypeChange}
                httpMethod='WS'
            >
                <option value={WEBSOCKET_OPTION}>WebSocket</option>
                { httpMethods.map((method) =>
                    <option key={method} value={method}>{ method }</option>
                ) }
            </MethodSelect>
            <MethodSelectArrow />
        </TypeSelectContainer>
        <UrlInput
            ref={urlInputRef}
            // {{variables}} aren't URL syntax until they're filled in when connecting
            type={/\{\{.*\}\}/.test(props.url) ? 'text' : 'url'}
            spellCheck='false'
            placeholder='Enter a ws:// or wss:// URL'
            aria-label='WebSocket URL'
            required={true}

            value={props.url}
            onFocus={prepopulateUrl}
            onChange={onUrlChange}
            onPaste={onPaste}
        />
        <ConnectButton
            type='button'
            disabled={!button.onClick}
            title={button.title}
            aria-keyshortcuts={button.onClick === props.connect
                ? (isMac ? 'Meta+Enter' : 'Control+Enter')
                : undefined
            }
            onClick={button.onClick}
        >
            { button.label }
        </ConnectButton>
    </SendRequestLineContainer>;
});
