import * as React from 'react';
import { observer } from 'mobx-react-lite';

import { styled, Theme } from '../../../styles';
import { Icon } from '../../../icons';
import { formatDuration } from '../../../util/text';

import { getStatusColor, getWebSocketCloseColor } from '../../../model/events/categorization';
import { getStatusMessage } from '../../../model/http/http-docs';
import type { WebSocketSession } from '../../../model/send/websocket/websocket-session';
import { closeCodeName } from '../../../model/send/websocket/websocket-messages';

import { Pill, PillButton } from '../../common/pill';
import { SendCardSection } from '../send-card-section';

const StatusSectionCard = styled(SendCardSection)`
    padding-top: 7px;
    padding-bottom: 7px;
    flex-shrink: 0;
    flex-grow: 0;

    z-index: 1;
    box-shadow: 0 2px 3px 0 rgba(0,0,0,${p => p.theme.boxShadowAlpha});

    > header {
        flex-direction: row;
        justify-content: flex-start;
        flex-wrap: wrap;
        row-gap: 6px;
    }
`;

const StatusText = styled.span`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const StatusButton = styled(PillButton)`
    margin-left: auto;
    svg {
        margin-right: 5px;
    }
`;

// Re-renders every second, for "connected for N seconds"
function useTicker(active: boolean) {
    const [, setTick] = React.useState(0);
    React.useEffect(() => {
        if (!active) return;
        const interval = setInterval(() => setTick((tick) => tick + 1), 1000);
        return () => clearInterval(interval);
    }, [active]);
}

// How long a connection has been open: whole seconds, then minutes and hours
function formatOpenTime(durationMs: number) {
    const seconds = Math.max(0, Math.floor(durationMs / 1000));
    if (seconds < 60) return `${seconds} s`;

    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ${seconds % 60} s`;

    return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

const MessageCounts = observer((props: { session: WebSocketSession }) => {
    const { sentCount, receivedCount } = props.session;
    if (!sentCount && !receivedCount) return null;

    return <Pill title='Messages sent and received'>
        { sentCount } sent, { receivedCount } received
    </Pill>;
});

/**
 * The connection's status, above the message log: connecting, open (with its subprotocol
 * and how long it's been open), closed (with the close code) or failed.
 */
export const WebSocketStatusSection = observer((props: {
    session: WebSocketSession,
    theme: Theme
}) => {
    const { session, theme } = props;
    const { state } = session;

    useTicker(state.status === 'connecting' || state.status === 'open' || state.status === 'closing');

    let content: React.ReactNode;
    switch (state.status) {
        case 'idle':
            content = <Pill role='status'>Not connected</Pill>;
            break;
        case 'connecting':
            content = <>
                <Pill role='status' color={getStatusColor(undefined, theme)}>Connecting</Pill>
                <Pill>{ formatOpenTime(Date.now() - state.startedAt) }</Pill>
                <StatusButton color={theme.popColor} onClick={() => session.cancel()}>
                    <Icon icon={['fas', 'times']} />
                    Cancel
                </StatusButton>
            </>;
            break;
        case 'open':
        case 'closing':
            content = <>
                <Pill role='status' color={getStatusColor(101, theme)} title={
                    `${state.handshake.statusCode} ${state.handshake.statusMessage || getStatusMessage(state.handshake.statusCode)}`
                }>
                    { state.status === 'open' ? 'Open' : 'Closing' }
                </Pill>
                { state.handshake.protocol && <Pill title='The subprotocol the server picked'>
                    { state.handshake.protocol }
                </Pill> }
                <Pill title='How long this connection has been open'>
                    { formatOpenTime(Date.now() - state.handshake.openedAt) }
                </Pill>
                <MessageCounts session={session} />
                { state.status === 'open' && <StatusButton
                    color={theme.popColor}
                    onClick={() => { session.disconnect(); }}
                >
                    <Icon icon={['fas', 'times']} />
                    Disconnect
                </StatusButton> }
            </>;
            break;
        case 'closed': {
            const name = closeCodeName(state.code);
            content = <>
                <Pill role='status' color={state.cancelled
                    ? theme.mainColor
                    : getWebSocketCloseColor(state.code, theme)
                }>
                    { state.cancelled
                        ? 'Cancelled'
                        : state.code !== undefined
                            ? `Closed: ${state.code}${name ? ` ${name}` : ''}`
                            : 'Closed'
                    }
                </Pill>
                { state.handshake && <Pill title='How long the connection was open'>
                    Was open { formatOpenTime(state.closedAt - state.handshake.openedAt) }
                </Pill> }
                <MessageCounts session={session} />
                { (state.reason || state.error) && <StatusText title={state.error?.message ?? state.reason}>
                    { state.error?.message ?? `Reason: ${state.reason}` }
                </StatusText> }
            </>;
            break;
        }
        case 'failed':
            content = <>
                <Pill role='status' color={getStatusColor('aborted', theme)}>
                    { state.response ? 'Handshake refused' : 'Connection failed' }
                </Pill>
                { state.response && <Pill color={getStatusColor(state.response.statusCode, theme)}>
                    { state.response.statusCode }: { state.response.statusMessage || getStatusMessage(state.response.statusCode) }
                </Pill> }
                <Pill title='How long it took to fail'>{ formatDuration(state.failedAt - state.startedAt) }</Pill>
            </>;
            break;
    }

    return <StatusSectionCard
        className='ignores-expanded'
        ariaLabel='Connection status section'
        collapsed={false}
        headerAlignment='left'
    >
        <header>
            { content }
        </header>
    </StatusSectionCard>;
});
