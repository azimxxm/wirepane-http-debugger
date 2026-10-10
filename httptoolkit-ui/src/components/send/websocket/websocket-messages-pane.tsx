import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';

import { styled } from '../../../styles';
import { formatShortcut } from '../../../util/shortcuts';

import { SendRequest } from '../../../model/send/send-request-model';
import { SendStore } from '../../../model/send/send-store';
import { UiStore } from '../../../model/ui/ui-store';
import { webSocketSessionsFor } from '../../../model/send/websocket/websocket-sessions';

import { EmptyState } from '../../common/empty-state';
import { SendCardContainer } from '../send-card-section';
import { WebSocketStatusSection } from './websocket-status';
import { WebSocketFailureCard, WebSocketHandshakeCard } from './websocket-handshake-cards';
import { WebSocketMessageLog } from './websocket-message-log';

const PlaceholderTitle = styled.h2`
    margin-top: 12px;

    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};
`;

const PlaceholderText = styled.p`
    margin-top: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};
`;

const MessagesPlaceholder = () => <EmptyState icon='Plugs'>
    <PlaceholderTitle>Not connected</PlaceholderTitle>
    <PlaceholderText>
        Press Connect or { formatShortcut('Cmd+Enter') }. Messages you send and receive show up here.
    </PlaceholderText>
</EmptyState>;

/**
 * The right side of Send for a WebSocket request: connection status and the log of sent
 * and received messages. Shown instead of the HTTP response pane.
 */
export const WebSocketMessagesPane = inject('sendStore', 'uiStore')(observer((props: {
    sendRequest: SendRequest,
    sendStore?: SendStore,
    uiStore?: UiStore
}) => {
    const session = webSocketSessionsFor(props.sendStore!).sessionFor(props.sendRequest);
    const { state } = session;

    if (state.status === 'idle' && session.log.length === 0) return <MessagesPlaceholder />;

    return <SendCardContainer hasExpandedChild={false}>
        <WebSocketStatusSection session={session} theme={props.uiStore!.theme} />
        { state.status === 'failed' && <WebSocketFailureCard state={state} /> }
        { 'handshake' in state && state.handshake &&
            <WebSocketHandshakeCard url={state.url} handshake={state.handshake} />
        }
        <WebSocketMessageLog session={session} />
    </SendCardContainer>;
})) as unknown as React.ComponentType<{ sendRequest: SendRequest }>;
