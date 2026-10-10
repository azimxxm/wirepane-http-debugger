import * as React from 'react';
import { observer } from 'mobx-react-lite';

import { styled } from '../../../styles';
import { WarningIcon } from '../../../icons';
import { isProbablyUtf8 } from '../../../util/buffer';

import { getStatusMessage } from '../../../model/http/http-docs';
import type {
    HandshakeDetails,
    WebSocketSessionState
} from '../../../model/send/websocket/websocket-session';
import { hexDump } from '../../../model/send/websocket/websocket-messages';
import type { FailedHandshakeResponse } from '../../../services/websocket-client-api';

import { CollapsibleCardHeading } from '../../common/card';
import { ContentLabel, ContentMonoValue } from '../../common/text-content';
import { Pill } from '../../common/pill';
import { HeaderDetails } from '../../view/http/header-details';
import { SendCardScrollableWrapper, SendCardSection } from '../send-card-section';

const ExplanationBlock = styled.p`
    margin-bottom: 10px;
    line-height: 1.4;
`;

const FailureBlock = styled(ExplanationBlock)`
    font-weight: 600;
`;

const SectionLabel = styled(ContentLabel)`
    display: block;
    margin: 14px 0 6px;
`;

const BodyBlock = styled.pre`
    max-height: 240px;
    overflow: auto;
    padding: 8px 10px;

    white-space: pre-wrap;
    word-break: break-all;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.45;

    border-radius: 4px;
    background-color: ${p => p.theme.mainLowlightBackground};
    border: 1px solid ${p => p.theme.containerBorder};
`;

const parseUrl = (url: string) => {
    try {
        return new URL(url);
    } catch {
        return new URL('ws://unknown');
    }
};

const TLS_CERTIFICATE_ERRORS = [
    'CERT_HAS_EXPIRED',
    'CERT_NOT_YET_VALID',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_GET_ISSUER_CERT',
    'ERR_TLS_CERT_ALTNAME_INVALID'
];

// What went wrong, in words, for errors without an HTTP answer
function explainConnectionError(error: { code?: string, message: string }): string {
    const { code, message } = error;

    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
        return 'The hostname couldn\'t be found. Check the URL, and your DNS settings.';
    } else if (code === 'ECONNREFUSED') {
        return 'The server refused the connection. Check the host and port, and that the server is running.';
    } else if (code === 'ECONNRESET') {
        return 'The connection was reset before the WebSocket handshake finished.';
    } else if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
        return 'The server isn\'t reachable from your network.';
    } else if (code === 'ETIMEDOUT' || /timed out/i.test(message)) {
        return 'The server didn\'t answer the WebSocket handshake in time.';
    } else if (code && TLS_CERTIFICATE_ERRORS.includes(code)) {
        return 'The server\'s HTTPS certificate isn\'t trusted. You can trust its CA, or ignore HTTPS ' +
            'errors for this host, in Settings.';
    } else if (code === 'EPROTO' || code?.startsWith('ERR_SSL')) {
        return 'The TLS handshake with the server failed.';
    } else if (/subprotocol/i.test(message)) {
        return 'The server didn\'t agree on a subprotocol. Check the Sec-WebSocket-Protocol header.';
    } else if (/Sec-WebSocket|Upgrade header/i.test(message)) {
        return 'The server\'s answer to the handshake wasn\'t a valid WebSocket upgrade.';
    } else {
        return 'Wirepane couldn\'t open this WebSocket.';
    }
}

// A hint for the most common refused handshakes
function explainRefusal(statusCode: number): string | undefined {
    if (statusCode === 401 || statusCode === 403) {
        return 'The server may want a token, a cookie or a different Origin header. Check the handshake headers.';
    } else if (statusCode === 404) {
        return 'Check the URL\'s path: nothing at it accepts WebSockets.';
    } else if (statusCode >= 300 && statusCode < 400) {
        return 'WebSockets don\'t follow redirects. The Location header says where this one points.';
    } else if (statusCode === 400 || statusCode === 426) {
        return 'The server didn\'t accept the handshake. Check the headers and subprotocols.';
    }
}

const ResponseBody = (props: { response: FailedHandshakeResponse }) => {
    const { body, bodyTruncated } = props.response;
    if (body.byteLength === 0) return null;

    const text = isProbablyUtf8(body)
        ? body.toString('utf8')
        : hexDump(body);

    return <>
        <SectionLabel>Response body{ bodyTruncated ? ' (the first 1 MB)' : '' }</SectionLabel>
        <BodyBlock>{ text }</BodyBlock>
    </>;
};

/**
 * Why a connection didn't open. A refused handshake shows the server's answer: its status,
 * headers and body.
 */
export const WebSocketFailureCard = observer((props: {
    state: Extract<WebSocketSessionState, { status: 'failed' }>
}) => {
    const { error, response, url } = props.state;

    return <SendCardSection
        ariaLabel='Connection failure section'
        collapsed={false}
    >
        <header>
            <h1>{ response ? 'Handshake refused' : 'Connection failed' }</h1>
        </header>
        <SendCardScrollableWrapper>
            { response
                ? <>
                    <FailureBlock>
                        <WarningIcon /> The server answered the WebSocket handshake with { response.statusCode }{' '}
                        { response.statusMessage || getStatusMessage(response.statusCode) }, instead
                        of 101 Switching Protocols.
                    </FailureBlock>
                    { explainRefusal(response.statusCode) &&
                        <ExplanationBlock>{ explainRefusal(response.statusCode) }</ExplanationBlock>
                    }
                    <SectionLabel>Response headers</SectionLabel>
                    <HeaderDetails
                        httpVersion={1.1}
                        requestUrl={parseUrl(url)}
                        headers={response.headers}
                    />
                    <ResponseBody response={response} />
                </>
                : <>
                    <FailureBlock>
                        <WarningIcon /> { explainConnectionError(error) }
                    </FailureBlock>
                    <ContentMonoValue>
                        Error: { error.message }{ error.code ? ` (${error.code})` : '' }
                    </ContentMonoValue>
                </>
            }
        </SendCardScrollableWrapper>
    </SendCardSection>;
});

/**
 * The server's answer to the opening handshake (101 Switching Protocols), collapsed by
 * default to leave the space to the messages.
 */
export const WebSocketHandshakeCard = observer((props: {
    url: string,
    handshake: HandshakeDetails
}) => {
    const { handshake } = props;
    const [collapsed, setCollapsed] = React.useState(true);
    const toggleCollapsed = React.useCallback(() => setCollapsed((value) => !value), []);

    return <SendCardSection
        collapsed={collapsed}
        onCollapseToggled={toggleCollapsed}
        ariaLabel='Handshake response section'
        headerAlignment='left'
    >
        <header>
            { handshake.extensions && <Pill title='The extensions the server agreed to'>
                { handshake.extensions }
            </Pill> }
            <Pill>
                { handshake.statusCode } { handshake.statusMessage || getStatusMessage(handshake.statusCode) }
            </Pill>
            <CollapsibleCardHeading onCollapseToggled={toggleCollapsed}>
                Handshake response
            </CollapsibleCardHeading>
        </header>
        <SendCardScrollableWrapper>
            <HeaderDetails
                httpVersion={1.1}
                requestUrl={parseUrl(props.url)}
                headers={handshake.headers}
            />
        </SendCardScrollableWrapper>
    </SendCardSection>;
});
