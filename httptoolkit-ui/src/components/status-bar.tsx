import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { Link } from '@reach/router';

import { styled, css } from '../styles';
import { PhosphorIcon } from '../icons';
import { useHotkeys, copyToClipboard } from '../util/ui';
import { formatShortcut, toAriaShortcut } from '../util/shortcuts';
import { logError } from '../errors';

import { EventsStore } from '../model/events/events-store';
import { ProxyStore } from '../model/proxy-store';
import { RulesStore } from '../model/rules/rules-store';
import { TrafficSource } from '../model/http/sources';
import { countActiveUserRules, getConnectedClients } from '../model/traffic-summary';

import { UnstyledButton } from './common/inputs';
import { ClientIcon } from './common/client-icon';

export const STATUS_BAR_HEIGHT = 28;

const TOGGLE_RECORDING_SHORTCUT = 'Cmd+Shift+R';
const COPIED_FEEDBACK_MS = 1500;

const StatusBarRoot = styled.footer<{ recording: boolean }>`
    flex-shrink: 0;
    box-sizing: border-box;
    height: ${STATUS_BAR_HEIGHT}px;
    padding: 0 10px;

    position: relative;
    z-index: 5;

    display: flex;
    align-items: center;
    gap: 4px;

    background-color: ${p => p.theme.mainLowlightBackground};
    border-top: 1px solid ${p => p.theme.containerBorder};

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 500;
    color: ${p => p.theme.mainLowlightColor};
    white-space: nowrap;

    /* The wire hairline along the top edge says "recording" at a glance */
    &::before {
        content: '';
        position: absolute;
        top: -1px;
        left: 0;
        right: 0;
        height: 2px;

        background: ${p => p.theme.gradientWire};
        opacity: ${p => p.recording ? 1 : 0};
        transition: opacity 0.15s;
    }
`;

const statusItemStyles = css`
    height: 22px;
    padding: 0 6px;
    border-radius: 4px;

    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-width: 0;

    color: inherit;
    font: inherit;
    text-decoration: none;

    transition: background-color 0.12s, color 0.12s;

    /* The bar is already sunken, so hover goes a step darker (light) or lighter (dark) */
    &:hover {
        background-color: ${p => p.theme.containerBorder};
        color: ${p => p.theme.mainColor};
    }

    > span {
        overflow: hidden;
        text-overflow: ellipsis;
    }

    > svg {
        flex-shrink: 0;
    }
`;

const StatusButton = styled(UnstyledButton)`${statusItemStyles}`;
const StatusLink = styled(Link)`${statusItemStyles}`;

const Spacer = styled.div`
    flex: 1 1 auto;
`;

const RecordingDot = styled.span<{ state: 'recording' | 'paused' | 'disconnected' }>`
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;

    background-color: ${p =>
        p.state === 'recording'
            ? p.theme.popColor
        : p.state === 'disconnected'
            ? p.theme.warningColor
        : p.theme.containerWatermark
    };
`;

const MonoValue = styled.span`
    font-family: ${p => p.theme.monoFontFamily};
`;

const KeyHint = styled.span`
    color: ${p => p.theme.containerWatermark};
`;

// Just the visible text: screen readers get the button labels instead.
const LiveRegion = styled.span`
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
`;

const StatusBarShortcuts = (props: { onToggleRecording: () => void }) => {
    useHotkeys('Ctrl+Shift+r, Cmd+Shift+r', (event) => {
        event.preventDefault();
        props.onToggleRecording();
    }, [props.onToggleRecording]);

    return null;
};

const ClientsItem = (props: { clients: TrafficSource[] }) => {
    const { clients } = props;
    const connectShortcut = formatShortcut('Cmd+1');

    if (clients.length === 0) {
        return <StatusLink
            to='/intercept'
            title={`Connect a browser, terminal, phone or container (${connectShortcut})`}
        >
            <PhosphorIcon icon='Plugs' size={14} aria-hidden={true} />
            <span>No clients yet — Connect a source</span>
            <KeyHint>{ connectShortcut }</KeyHint>
        </StatusLink>;
    }

    const [firstClient, ...otherClients] = clients;

    return <StatusLink
        to='/intercept'
        title={`Connected clients:\n${clients.map((c) => c.summary).join('\n')}`}
    >
        <ClientIcon source={firstClient} />
        <span>
            { clients.length } client{ clients.length === 1 ? '' : 's' } · { firstClient.summary }
            { otherClients.length > 0 && ` +${otherClients.length}` }
        </span>
    </StatusLink>;
};

/**
 * The bar along the bottom of every page: what Wirepane is doing right now (recording,
 * the proxy address, connected clients) and what it has (requests, active rules).
 * It's also the one place to pause & resume recording.
 */
export const StatusBar = inject('eventsStore', 'proxyStore', 'rulesStore')(observer((props: {
    eventsStore?: EventsStore,
    proxyStore?: ProxyStore,
    rulesStore?: RulesStore
}) => {
    const eventsStore = props.eventsStore!;
    const proxyStore = props.proxyStore!;
    const rulesStore = props.rulesStore!;

    const [copied, setCopied] = React.useState(false);
    React.useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    const { isPaused, togglePause, events } = eventsStore;
    const proxyAddress = `localhost:${proxyStore.httpProxyPort}`;
    const clients = getConnectedClients(eventsStore.activeSources);
    const activeRuleCount = countActiveUserRules(rulesStore.rules);
    const recordingShortcut = formatShortcut(TOGGLE_RECORDING_SHORTCUT);

    const recordingState = proxyStore.streamDisconnected
        ? 'disconnected'
        : isPaused
            ? 'paused'
            : 'recording';

    const copyProxyAddress = () => {
        copyToClipboard(`http://${proxyAddress}`)
            .then(() => setCopied(true))
            .catch((e) => logError(e));
    };

    return <StatusBarRoot recording={recordingState === 'recording'} aria-label='Status'>
        <StatusBarShortcuts onToggleRecording={togglePause} />

        <StatusButton
            onClick={togglePause}
            aria-pressed={!isPaused}
            aria-keyshortcuts={toAriaShortcut(TOGGLE_RECORDING_SHORTCUT)}
            title={isPaused
                ? `Resume recording (${recordingShortcut})`
                : `Pause recording: traffic keeps flowing, but isn't added to View (${recordingShortcut})`
            }
        >
            <RecordingDot state={recordingState} />
            <span>{
                recordingState === 'disconnected'
                    ? 'Reconnecting to the proxy…'
                : recordingState === 'paused'
                    ? "Paused — traffic still flows but isn't recorded"
                : 'Recording'
            }</span>
        </StatusButton>

        <StatusButton
            onClick={copyProxyAddress}
            title={`Copy the proxy address: http://${proxyAddress}`}
        >
            { copied
                ? <>
                    <PhosphorIcon icon='Check' size={14} aria-hidden={true} />
                    <span>Copied <MonoValue>http://{ proxyAddress }</MonoValue></span>
                </>
                : <span>Proxy <MonoValue>{ proxyAddress }</MonoValue></span>
            }
        </StatusButton>
        <LiveRegion aria-live='polite'>{ copied ? 'Proxy address copied' : '' }</LiveRegion>

        <ClientsItem clients={clients} />

        <Spacer />

        <StatusLink to='/view' title={`Show the captured requests (${formatShortcut('Cmd+2')})`}>
            <span>
                { events.length.toLocaleString() } request{ events.length === 1 ? '' : 's' }
            </span>
        </StatusLink>

        <StatusLink to='/modify' title={`Show your rules (${formatShortcut('Cmd+3')})`}>
            <span>
                { activeRuleCount } rule{ activeRuleCount === 1 ? '' : 's' } active
            </span>
        </StatusLink>
    </StatusBarRoot>;
}));
