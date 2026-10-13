import * as React from 'react';
import { observer } from 'mobx-react-lite';
import * as polished from 'polished';
import { ArrowsLeftRight } from '@phosphor-icons/react';

import { styled, css, Theme } from '../../styles';
import { VpnNetworkStore, VpnUdpFlow } from '../../model/interception/vpn-network';
import { VpnMetadataLoader, VpnPeerNames } from '../../model/devices/vpn-peer-names';
import {
    MAX_UDP_ROWS,
    QUIC_MODE_OPTIONS,
    QuicMarkKind,
    QuicModeController,
    UDP_SORT_OPTIONS,
    UdpSortKey,
    describeQuicMark,
    formatUdpBytes,
    formatUdpCount,
    formatUdpDuration,
    getUdpFlowDurationMs,
    getQuicSupport,
    getUdpFlowState,
    hasUdpCounts,
    quicModeUnavailableReason,
    sortUdpFlows,
    summariseUdpFlows
} from '../../model/interception/vpn-udp';
import { UnstyledButton } from '../common/inputs';

const CLOCK_TICK_MS = 1000;

// --- Layout ---

const TabLayout = styled.div`
    display: flex;
    flex-direction: column;
    gap: 16px;

    font-size: ${p => p.theme.textSize};
    line-height: 1.5;
    color: ${p => p.theme.mainColor};
`;

const Panel = styled.section`
    box-sizing: border-box;
    min-width: 0;
    padding: 20px;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;
`;

const PanelHeader = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 8px 16px;
`;

const PanelTitle = styled.h2`
    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.3;
`;

const Lowlight = styled.p`
    margin-top: 4px;
    color: ${p => p.theme.mainLowlightColor};
`;

// --- QUIC mode ---

const ModeGroup = styled.div`
    margin-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 4px;
`;

const ModeOption = styled.div<{ unavailable: boolean }>`
    display: grid;
    grid-template-columns: 20px minmax(0, 1fr);
    column-gap: 10px;
    align-items: start;
    padding: 8px 10px;
    border-radius: 6px;

    &:hover {
        background-color: ${p => p.unavailable ? 'transparent' : p.theme.rowHover};
    }

    > input {
        margin: 3px 0 0;
        accent-color: ${p => p.theme.popColor};
    }

    > label {
        display: block;
        cursor: ${p => p.unavailable ? 'default' : 'pointer'};
    }

    > input:focus-visible + label {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: 4px;
        border-radius: 2px;
    }

    /* An option that can't be picked reads as off, except the reason why (the last line) */
    ${p => p.unavailable && css`
        > label > span:not(:last-child) {
            opacity: 0.7;
        }
    `}
`;

const ModeLabel = styled.span`
    display: block;
    font-weight: 600;

    > span {
        font-weight: 400;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const ModeHelp = styled.span`
    display: block;
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const ModeReason = styled.span`
    display: block;
    margin-top: 2px;
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
    color: ${p => p.theme.warning};
`;

const ModeStatus = styled.p<{ problem?: boolean }>`
    margin-top: 8px;
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.problem ? p.theme.error : p.theme.mainLowlightColor};
`;

// --- The flow table ---

const SortGroup = styled.div`
    display: inline-flex;
    border: 1px solid ${p => p.theme.inputBorder};
    border-radius: 6px;
    overflow: hidden;
`;

const SortButton = styled(UnstyledButton)<{ active: boolean }>`
    height: 28px;
    padding: 0 12px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: ${p => p.active ? 600 : 400};
    color: ${p => p.active ? p.theme.mainColor : p.theme.mainLowlightColor};
    background-color: ${p => p.active ? p.theme.selectionInactiveBackground : 'transparent'};

    & + & {
        border-left: 1px solid ${p => p.theme.inputBorder};
    }

    &:not([disabled]):hover {
        background-color: ${p => p.active ? p.theme.selectionInactiveBackground : p.theme.rowHover};
    }

    &:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: -2px;
    }
`;

const TableScroll = styled.div`
    margin-top: 12px;
    overflow-x: auto;
`;

const Table = styled.table`
    width: 100%;
    min-width: 820px;
    border-collapse: collapse;
    font-size: ${p => p.theme.textInputFontSize};
    font-variant-numeric: tabular-nums;

    th, td {
        padding: 8px 12px;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid ${p => p.theme.containerBorder};
    }

    th {
        font-size: ${p => p.theme.smallPrintSize};
        font-weight: 600;
        white-space: nowrap;
        color: ${p => p.theme.mainLowlightColor};
    }

    .number {
        text-align: right;
        white-space: nowrap;
    }

    tbody tr:hover {
        background-color: ${p => p.theme.rowHover};
    }

    tbody tr:last-child td {
        border-bottom: none;
    }
`;

const Mono = styled.span`
    font-family: ${p => p.theme.monoFontFamily};
    white-space: nowrap;
`;

const Muted = styled.span`
    color: ${p => p.theme.mainLowlightColor};
`;

const CountCell = styled.div`
    > strong {
        display: block;
        font-weight: 500;
    }

    > span {
        display: block;
        font-size: ${p => p.theme.smallPrintSize};
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const StateText = styled.span<{ open: boolean }>`
    display: inline-flex;
    align-items: center;
    gap: 6px;
    white-space: nowrap;
    color: ${p => p.open ? p.theme.mainColor : p.theme.mainLowlightColor};

    &::before {
        content: '';
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background-color: ${p => p.open ? p.theme.success : 'transparent'};
        border: 1px solid ${p => p.open ? p.theme.success : p.theme.mainLowlightColor};
    }
`;

const quicTone = (theme: Theme, kind: QuicMarkKind) =>
    kind === 'blocked' ? theme.warning :
    kind === 'decrypted' ? theme.success :
    theme.mainLowlightColor;

const QuicBadge = styled.span<{ kind: QuicMarkKind }>`
    display: inline-block;
    padding: 1px 8px;
    border-radius: 4px;
    white-space: nowrap;

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;

    color: ${p => quicTone(p.theme, p.kind)};
    background-color: ${p => polished.rgba(quicTone(p.theme, p.kind), 0.12)};
    border: 1px solid ${p => polished.rgba(quicTone(p.theme, p.kind), 0.4)};
`;

const EmptyFlows = styled.div`
    margin-top: 16px;
    padding: 32px 16px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    text-align: center;
    color: ${p => p.theme.mainLowlightColor};

    > svg {
        color: ${p => p.theme.containerWatermark};
    }

    > strong {
        font-size: ${p => p.theme.subHeadingSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }

    > span {
        max-width: 460px;
    }
`;

const TableNote = styled.p`
    margin-top: 8px;
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

// --- Pieces ---

const plural = (count: number, one: string, many: string) =>
    `${formatUdpCount(count)} ${count === 1 ? one : many}`;

// A clock that ticks while `active`, so the durations of open flows keep counting
function useNow(active: boolean): number {
    const [now, setNow] = React.useState(Date.now);

    React.useEffect(() => {
        if (!active) return;

        setNow(Date.now());
        const timer = setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
        return () => clearInterval(timer);
    }, [active]);

    return now;
}

const QuicModePanel = observer((props: { controller: QuicModeController, store: VpnNetworkStore }) => {
    const { controller, store } = props;
    const support = getQuicSupport(store);

    return <Panel aria-labelledby='udp-quic-heading'>
        <PanelTitle id='udp-quic-heading'>QUIC (HTTP/3)</PanelTitle>
        <Lowlight>
            Many apps try QUIC, a protocol on UDP port 443, before HTTPS. Wirepane can't read it
            unless it decrypts it, so pick what happens to it.
        </Lowlight>

        <ModeGroup role='radiogroup' aria-labelledby='udp-quic-heading' aria-busy={controller.saving}>
            { QUIC_MODE_OPTIONS.map((option) => {
                const reason = quicModeUnavailableReason(option.mode, support);
                const id = `udp-quic-mode-${option.mode}`;

                return <ModeOption key={option.mode} unavailable={!!reason}>
                    <input
                        type='radio'
                        id={id}
                        name='udp-quic-mode'
                        checked={controller.selected === option.mode}
                        disabled={!!reason}
                        aria-describedby={`${id}-help`}
                        onChange={() => { controller.choose(option.mode, support); }}
                    />
                    <label htmlFor={id}>
                        <ModeLabel>
                            { option.label }{ option.note && <span> { option.note }</span> }
                        </ModeLabel>
                        <ModeHelp id={`${id}-help`}>{ option.description }</ModeHelp>
                        { reason && <ModeReason>{ reason }</ModeReason> }
                    </label>
                </ModeOption>;
            }) }
        </ModeGroup>

        { controller.saving && <ModeStatus role='status'>Saving...</ModeStatus> }
        { controller.error && <ModeStatus problem role='alert'>
            Couldn't save the QUIC mode: { controller.error }
        </ModeStatus> }
    </Panel>;
});

const FlowRow = (props: { flow: VpnUdpFlow, deviceName: string, now: number }) => {
    const { flow, deviceName, now } = props;
    const state = getUdpFlowState(flow);
    const mark = describeQuicMark(flow);
    const hasCounts = state !== 'untracked' || hasUdpCounts(flow);

    return <tr>
        <td title={flow.src || undefined}>{ deviceName }</td>
        <td><Mono>{ flow.dst }</Mono></td>
        <td>{ flow.name ?? <Muted>-</Muted> }</td>
        <td className='number'>
            { hasCounts
                ? <CountCell>
                    <strong>{ formatUdpBytes(flow.bytesUp) }</strong>
                    <span>{ plural(flow.packetsUp, 'packet', 'packets') }</span>
                </CountCell>
                : <Muted>-</Muted>
            }
        </td>
        <td className='number'>
            { hasCounts
                ? <CountCell>
                    <strong>{ formatUdpBytes(flow.bytesDown) }</strong>
                    <span>{ plural(flow.packetsDown, 'packet', 'packets') }</span>
                </CountCell>
                : <Muted>-</Muted>
            }
        </td>
        <td className='number'>
            { state === 'untracked'
                ? <Muted>-</Muted>
                : formatUdpDuration(getUdpFlowDurationMs(flow, now))
            }
        </td>
        <td>
            { state === 'untracked'
                ? <Muted title={mark?.description}>-</Muted>
                : <StateText open={state === 'open'}>{ state === 'open' ? 'Open' : 'Closed' }</StateText>
            }
        </td>
        <td>
            { mark
                ? <QuicBadge kind={mark.kind} title={mark.description}>{ mark.label }</QuicBadge>
                : <Muted>-</Muted>
            }
        </td>
    </tr>;
};

const FlowsPanel = observer((props: { store: VpnNetworkStore, peerNames: VpnPeerNames }) => {
    const { store, peerNames } = props;
    const [sortKey, setSortKey] = React.useState<UdpSortKey>('newest');

    const flows = store.udpFlows;
    const summary = summariseUdpFlows(flows);
    const now = useNow(summary.open > 0);

    // Ask the server who each device is, once per device
    const peerIds = Array.from(new Set(flows.map((flow) => flow.peer))).join(',');
    React.useEffect(() => {
        if (peerIds) peerNames.ensureNamed(peerIds.split(','));
    }, [peerNames, peerIds]);

    const rows = sortUdpFlows(flows, sortKey).slice(0, MAX_UDP_ROWS);

    return <Panel aria-labelledby='udp-flows-heading'>
        <PanelHeader>
            <div>
                <PanelTitle id='udp-flows-heading'>UDP flows</PanelTitle>
                { summary.flows > 0 && <Lowlight>
                    { plural(summary.flows, 'flow', 'flows') }, { formatUdpCount(summary.open) } open,
                    { ' ' }{ formatUdpBytes(summary.bytes) } in total
                    { summary.quicBlocked > 0 && `, ${formatUdpCount(summary.quicBlocked)} QUIC blocked` }
                </Lowlight> }
            </div>
            { summary.flows > 0 && <SortGroup role='group' aria-label='Sort the flows'>
                { UDP_SORT_OPTIONS.map((option) =>
                    <SortButton
                        key={option.key}
                        type='button'
                        active={sortKey === option.key}
                        aria-pressed={sortKey === option.key}
                        onClick={() => setSortKey(option.key)}
                    >
                        { option.label }
                    </SortButton>
                ) }
            </SortGroup> }
        </PanelHeader>

        { summary.flows === 0
            ? <EmptyFlows>
                <ArrowsLeftRight size={40} aria-hidden={true} />
                <strong>No UDP traffic yet</strong>
                <span>
                    Games, calls and other apps that use UDP show up here as soon as a device on
                    the VPN sends some. Web pages and most apps use TCP: those are in View.
                </span>
            </EmptyFlows>
            : <>
                <TableScroll>
                    <Table aria-label='UDP flows'>
                        <thead>
                            <tr>
                                <th scope='col'>Device</th>
                                <th scope='col'>Destination</th>
                                <th scope='col'>Name</th>
                                <th scope='col' className='number' title='From the device to the server'>Sent</th>
                                <th scope='col' className='number' title='From the server to the device'>Received</th>
                                <th scope='col' className='number'>Duration</th>
                                <th scope='col'>Status</th>
                                <th scope='col'>QUIC</th>
                            </tr>
                        </thead>
                        <tbody>
                            { rows.map((flow) =>
                                <FlowRow
                                    key={`${flow.peer}:${flow.flow}`}
                                    flow={flow}
                                    deviceName={peerNames.nameOf(flow.peer)}
                                    now={now}
                                />
                            ) }
                        </tbody>
                    </Table>
                </TableScroll>
                { summary.flows > rows.length && <TableNote>
                    Showing { formatUdpCount(rows.length) } of { formatUdpCount(summary.flows) } flows.
                </TableNote> }
            </>
        }
    </Panel>;
});

/**
 * The UDP tab of the Network page: the QUIC mode, then every UDP flow the VPN has carried (the
 * ones that aren't DNS). `loadMetadata` is only for tests: it replaces the call to the server
 * for the device names.
 */
export const UdpTab = observer((props: { store: VpnNetworkStore, loadMetadata?: VpnMetadataLoader }) => {
    const { store, loadMetadata } = props;

    const services = React.useMemo(() => ({
        controller: new QuicModeController(store),
        peerNames: new VpnPeerNames(loadMetadata)
    }), [store, loadMetadata]);

    return <TabLayout>
        <QuicModePanel controller={services.controller} store={store} />
        <FlowsPanel store={store} peerNames={services.peerNames} />
    </TabLayout>;
});
