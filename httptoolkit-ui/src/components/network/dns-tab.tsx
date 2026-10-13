import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { FixedSizeList as List, ListChildComponentProps } from 'react-window';
import AutoSizer from 'react-virtualized-auto-sizer';
import { GlobeSimple, MagnifyingGlass } from '@phosphor-icons/react';

import { styled } from '../../styles';
import { appHistory } from '../../routing';
import { VpnDnsQuery, VpnNetworkStore } from '../../model/interception/vpn-network';
import { VpnMetadataLoader, VpnPeerNames } from '../../model/devices/vpn-peer-names';

import { IPHONE_SETUP_PATH } from '../intercept/phone/phone-setup-routes';
import { ActionButton } from '../common/action-button';
import { TextInput } from '../common/inputs';
import { DnsRulesEditor } from './dns-rules-editor';
import { peerLabel, useAskedPeers } from './peer-labels';
import {
    ALL_DEVICES,
    DnsFilter,
    DnsView,
    PeerNameLookup,
    buildDnsView,
    describeAnswers,
    describeCounts,
    describeRule,
    deviceLabel,
    formatDuration,
    formatQueryTime,
    getEmptyReason,
    isFiltering,
    peerNamesFromStats,
    ruleLabel
} from './dns-tab-model';

const ROW_HEIGHT = 32;
const HEADER_HEIGHT = 30;

// Time, device, name, type, answers, took, rule. The name and answers share what is left. The
// device is wide enough for "Removed device (p42)", whose id is what tells removed devices apart.
const COLUMNS = '68px 148px minmax(0, 1.3fr) 52px minmax(0, 1.5fr) 62px 80px';

const Root = styled.div`
    display: flex;
    flex-direction: column;
    gap: 12px;

    box-sizing: border-box;
    height: 100%;
    min-height: 0;
`;

const Toolbar = styled.div`
    flex-shrink: 0;
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 8px 12px;
`;

const SearchBox = styled.div`
    position: relative;
    flex: 1 1 220px;
    max-width: 360px;

    > svg {
        position: absolute;
        left: 10px;
        top: 50%;
        transform: translateY(-50%);
        pointer-events: none;
        color: ${p => p.theme.containerWatermark};
    }
`;

const SearchInput = styled(TextInput)`
    box-sizing: border-box;
    width: 100%;
    height: 30px;
    padding-left: 32px;
`;

const DeviceSelect = styled.select`
    flex: 0 0 auto;
    max-width: 220px;
    height: 30px;
    padding: 0 8px;
    border-radius: 4px;
    border: 1px solid ${p => p.theme.inputBorder};

    font-family: inherit;
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.inputColor};
    background-color: ${p => p.theme.inputBackground};

    &:hover {
        background-color: ${p => p.theme.inputHoverBackground};
    }
`;

const Counts = styled.p`
    margin: 0 0 0 auto;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
    font-variant-numeric: tabular-nums;
`;

// The Network page lets its content grow and scrolls as a whole, so the list asks for most of the
// window's height itself (a flex basis: it still shrinks when a parent gives it less)
const TableCard = styled.div`
    position: relative;
    flex: 1 1 clamp(360px, calc(100vh - 260px), 900px);
    min-height: 240px;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
    background-color: ${p => p.theme.mainBackground};
    overflow: hidden;
`;

const RowGrid = styled.div`
    display: grid;
    grid-template-columns: ${COLUMNS};
    align-items: center;
    column-gap: 10px;

    box-sizing: border-box;
    padding: 0 12px;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainColor};
`;

const HeaderRow = styled(RowGrid)`
    position: sticky;
    top: 0;
    z-index: 1;
    height: ${HEADER_HEIGHT}px;

    border-bottom: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainLowlightBackground};

    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const BodyRow = styled(RowGrid)`
    border-bottom: 1px solid ${p => p.theme.containerBorder};

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }
`;

const Cell = styled.div`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
`;

const MonoCell = styled(Cell)`
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    font-variant-numeric: tabular-nums;
    color: ${p => p.theme.mainLowlightColor};
`;

const DeviceCell = styled(Cell)`
    color: ${p => p.theme.mainLowlightColor};
`;

const NameCell = styled(Cell)`
    font-weight: 500;
`;

const TypeCell = styled(Cell)`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const AnswersCell = styled(Cell)`
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};

    /* Nothing came back (no records, NXDOMAIN...): said in words, so not in the data font */
    &[data-kind='none'] {
        font-family: inherit;
        font-size: ${p => p.theme.textInputFontSize};
        color: ${p => p.theme.mainLowlightColor};
    }

    &[data-kind='failed'] {
        font-family: inherit;
        font-size: ${p => p.theme.textInputFontSize};
        color: ${p => p.theme.warning};
    }
`;

const DurationCell = styled(MonoCell)`
    text-align: right;
`;

const RuleBadge = styled.span`
    justify-self: start;
    padding: 0 6px;
    border-radius: 3px;
    border: 1px solid currentColor;

    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 600;
    line-height: 16px;

    &[data-rule='blocked'] {
        color: ${p => p.theme.error};
    }

    &[data-rule='answered'] {
        color: ${p => p.theme.info};
    }
`;

// --- The empty states ---

const EmptyBox = styled.div`
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;

    box-sizing: border-box;
    height: 100%;
    padding: 24px;

    text-align: center;
    color: ${p => p.theme.mainLowlightColor};

    > svg {
        color: ${p => p.theme.containerWatermark};
    }

    > h3 {
        margin: 4px 0 0;
        font-size: ${p => p.theme.subHeadingSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }

    > p {
        margin: 0 0 8px;
        max-width: 440px;
        line-height: 1.5;
    }
`;

const NoQueries = () => <EmptyBox>
    <GlobeSimple size={40} aria-hidden={true} />
    <h3>No DNS queries yet</h3>
    <p>
        Start VPN capture on the iPhone page (Capture all apps (VPN)), then use the phone.
        Every name its apps look up shows up here, with the answer it got.
    </p>
    <ActionButton
        variant='primary'
        icon='ArrowRight'
        onClick={() => { appHistory.navigate(IPHONE_SETUP_PATH); }}
    >
        Open the iPhone page
    </ActionButton>
</EmptyBox>;

const NoMatches = (props: { filter: DnsFilter, deviceName?: string, onClear: () => void }) => {
    const { search, device } = props.filter;
    const what = [
        search.trim() && `“${search.trim()}”`,
        device !== ALL_DEVICES && props.deviceName && `on ${props.deviceName}`
    ].filter(Boolean).join(' ');

    return <EmptyBox>
        <MagnifyingGlass size={40} aria-hidden={true} />
        <h3>No queries match</h3>
        <p>Nothing was looked up for {what || 'this filter'}.</p>
        <ActionButton onClick={props.onClear}>Clear filters</ActionButton>
    </EmptyBox>;
};

// --- The list ---

interface RowData {
    rows: readonly VpnDnsQuery[];
    nameOf: PeerNameLookup;
}

const answersKind = (query: VpnDnsQuery) =>
    query.answers.length > 0 ? 'records'
    // A rule's NXDOMAIN is what the person asked for, so it isn't flagged like a real failure
    : query.rcode === 'NOERROR' || query.rule ? 'none'
    : 'failed';

const Row = ({ index, style, data }: ListChildComponentProps) => {
    // The installed react-window types don't say what the item data is
    const { rows, nameOf } = data as RowData;
    const query = rows[index];
    const device = deviceLabel(query.peer, nameOf);
    const rule = ruleLabel(query.rule);

    return <BodyRow
        role='row'
        aria-rowindex={index + 2} // the header is row 1
        // The sticky header takes the first HEADER_HEIGHT of the scrolled area
        style={{ ...style, top: Number(style.top) + HEADER_HEIGHT }}
    >
        <MonoCell role='cell'>{ formatQueryTime(query.at) }</MonoCell>
        <DeviceCell role='cell' title={device}>{ device }</DeviceCell>
        <NameCell role='cell' title={query.name}>{ query.name }</NameCell>
        <TypeCell role='cell'>{ query.qtype }</TypeCell>
        <AnswersCell
            role='cell'
            data-kind={answersKind(query)}
            title={query.answers.join(', ') || undefined}
        >
            { describeAnswers(query) }
        </AnswersCell>
        <DurationCell role='cell'>{ formatDuration(query.ms) }</DurationCell>
        <Cell role='cell'>{ rule &&
            <RuleBadge data-rule={query.rule} title={describeRule(query.rule)}>{ rule }</RuleBadge>
        }</Cell>
    </BodyRow>;
};

// The column headers scroll with the list's own scroll area, so they line up with the rows
// whatever the width of the scrollbar is
const ListInner = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    function ListInner({ children, style, ...otherProps }, ref) {
        return <div
            ref={ref}
            {...otherProps}
            style={{ ...style, height: Number(style?.height ?? 0) + HEADER_HEIGHT }}
        >
            <HeaderRow role='row' aria-rowindex={1}>
                <div role='columnheader'>Time</div>
                <div role='columnheader'>Device</div>
                <div role='columnheader'>Name</div>
                <div role='columnheader'>Type</div>
                <div role='columnheader'>Answers</div>
                <div role='columnheader' style={{ textAlign: 'right' }}>Took</div>
                <div role='columnheader'>Rule</div>
            </HeaderRow>
            { children }
        </div>;
    }
);

// The list's own scrolling box. It's a Tab stop with a name, so the list can be scrolled with the
// keyboard, and it has a focus ring inside the card (which cuts off anything drawn outside it).
// Its role keeps the rows inside the table, as a named box with no role isn't part of one.
const ListScroller = styled.div.attrs(() => ({
    role: 'rowgroup',
    tabIndex: 0,
    'aria-label': 'DNS queries, scrollable'
}))`
    &:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: -2px;
    }
`;

const DnsList = (props: { view: DnsView, nameOf: PeerNameLookup }) => {
    const { view, nameOf } = props;

    return <AutoSizer>{({ height, width }) =>
        <List
            height={height}
            width={width}
            outerElementType={ListScroller}
            itemCount={view.rows.length}
            itemSize={ROW_HEIGHT}
            itemData={{ rows: view.rows, nameOf }}
            innerElementType={ListInner}
            overscanCount={8}
        >
            { Row }
        </List>
    }</AutoSizer>;
};

/**
 * Every DNS question the phones asked through the VPN, newest first, with the answer, how long
 * the lookup took and a mark when a DNS rule blocked or answered it. The rules editor sits above
 * the list, so a rule can be made right where the names show up. `loadMetadata` is only for
 * tests: it replaces the call to the server for the device names.
 */
export const DnsTab = observer((props: { store: VpnNetworkStore, loadMetadata?: VpnMetadataLoader }) => {
    const { store, loadMetadata } = props;

    const [search, setSearch] = React.useState('');
    const [device, setDevice] = React.useState(ALL_DEVICES);
    const filter: DnsFilter = { search, device };

    // The stats event names the devices; the server's list of devices covers the time before
    // the first stats arrive
    const serverNames = React.useMemo(() => new VpnPeerNames(loadMetadata), [loadMetadata]);
    const statNames = peerNamesFromStats(store.stats);

    // The devices in the list (and the picked one) that the stats don't name: the server is asked
    const devicePeers = new Set(store.dnsQueries.map((query) => query.peer));
    if (device !== ALL_DEVICES) devicePeers.add(device);
    const unnamedPeers = Array.from(devicePeers).filter((peer) => !statNames.has(peer));
    const askedPeers = useAskedPeers(serverNames, unnamedPeers);

    const nameOf: PeerNameLookup = (peer) => statNames.get(peer) ?? peerLabel(serverNames, askedPeers, peer);

    const view = buildDnsView(store.dnsQueries, filter, nameOf);

    const clearFilters = () => {
        setSearch('');
        setDevice(ALL_DEVICES);
    };

    const emptyReason = getEmptyReason(view);
    const filtering = isFiltering(filter);
    const selectedDevice = view.devices.find((option) => option.peer === device);

    return <Root>
        <DnsRulesEditor store={store} />

        <Toolbar>
            <SearchBox>
                <MagnifyingGlass size={16} aria-hidden={true} />
                <SearchInput
                    type='search'
                    value={search}
                    placeholder='Search by name or address'
                    aria-label='Search DNS queries by name or address'
                    spellCheck={false}
                    autoComplete='off'
                    onChange={(event) => setSearch(event.target.value)}
                    onKeyDown={(event) => {
                        if (event.key === 'Escape') setSearch('');
                    }}
                />
            </SearchBox>

            <DeviceSelect
                aria-label='Show queries from'
                value={device}
                onChange={(event) => setDevice(event.target.value)}
            >
                <option value={ALL_DEVICES}>All devices</option>
                { view.devices.map((option) =>
                    <option key={option.peer} value={option.peer}>
                        { option.label } ({ option.count.toLocaleString('en-US') })
                    </option>
                ) }
            </DeviceSelect>

            <Counts>{ describeCounts(view.counts, view.totalCount, filtering) }</Counts>
        </Toolbar>

        <TableCard role='table' aria-label='DNS queries' aria-rowcount={view.rows.length + 1}>
            { emptyReason === 'no-queries' ? <NoQueries />
            : emptyReason === 'no-matches' ? <NoMatches
                filter={filter}
                deviceName={selectedDevice?.label}
                onClear={clearFilters}
            />
            : <DnsList view={view} nameOf={nameOf} /> }
        </TableCard>
    </Root>;
});
