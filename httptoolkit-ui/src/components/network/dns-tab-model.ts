import type { VpnDnsQuery } from '../../model/interception/vpn-network';

/*
 * The logic behind the DNS tab: which queries to show (search and device filter), newest first,
 * the counts, the device list and the text of each cell. There's no React in here, so it is
 * tested on its own, and it stays one cheap pass over the list: the store keeps a few thousand
 * queries and the tab asks again after every poll and every key press.
 *
 * The store appends queries in the order they arrived, so the oldest is first.
 */

export const ALL_DEVICES = 'all';

export interface DnsFilter {
    // What was typed: matched against names and answers, ignoring case
    search: string;
    // A peer id, or ALL_DEVICES
    device: string;
}

export const NO_DNS_FILTER: DnsFilter = { search: '', device: ALL_DEVICES };

export interface DnsCounts {
    total: number;
    blocked: number; // a DNS rule blocked the name
    answered: number; // a DNS rule gave its own address
    failed: number; // the resolver said no (NXDOMAIN, SERVFAIL...) and no rule was involved
}

export interface DnsDeviceOption {
    peer: string;
    label: string;
    count: number;
}

export interface DnsView {
    // The queries that pass the filter, newest first
    rows: VpnDnsQuery[];
    // Of the rows
    counts: DnsCounts;
    // Every query, before the filter
    totalCount: number;
    // Every device that has queries, plus the selected one
    devices: DnsDeviceOption[];
}

export type PeerNameLookup = (peer: string) => string | undefined;

export function normalizeSearch(text: string): string {
    return text.trim().toLowerCase();
}

export function isFiltering(filter: DnsFilter): boolean {
    return normalizeSearch(filter.search) !== '' || filter.device !== ALL_DEVICES;
}

// Peer id -> device name, from the sidecar's `stats` event: { peers: [{ peer: 'p1', name: 'iPhone' }] }
export function peerNamesFromStats(stats: unknown): Map<string, string> {
    const names = new Map<string, string>();
    const peers = (stats as { peers?: unknown } | null | undefined)?.peers;
    if (!Array.isArray(peers)) return names;

    for (const entry of peers) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { peer, name } = entry as { peer?: unknown, name?: unknown };
        if (typeof peer === 'string' && typeof name === 'string' && name !== '') {
            names.set(peer, name);
        }
    }
    return names;
}

// A device's name, or its id while nothing has named it yet
export function deviceLabel(peer: string, nameOf: PeerNameLookup): string {
    return nameOf(peer) || peer;
}

/*
 * Newest first. A list in arrival order (the normal case) is just reversed. If it is out of
 * order, it is sorted by time instead, and queries with the same time (one poll brings a whole
 * batch) keep their arrival order, the last one first.
 */
export function newestFirst<T extends { at: number }>(queries: readonly T[]): T[] {
    let inOrder = true;
    for (let i = 1; i < queries.length; i++) {
        if (queries[i].at < queries[i - 1].at) {
            inOrder = false;
            break;
        }
    }
    if (inOrder) return queries.slice().reverse();

    return queries
        .map((query, index) => ({ query, index }))
        .sort((a, b) => (b.query.at - a.query.at) || (b.index - a.index))
        .map(({ query }) => query);
}

export function countQueries(queries: readonly VpnDnsQuery[]): DnsCounts {
    const counts: DnsCounts = { total: queries.length, blocked: 0, answered: 0, failed: 0 };
    for (const query of queries) {
        if (query.rule === 'blocked') counts.blocked += 1;
        else if (query.rule === 'answered') counts.answered += 1;
        else if (query.rcode !== 'NOERROR') counts.failed += 1;
    }
    return counts;
}

function matchesSearch(query: VpnDnsQuery, search: string): boolean {
    if (search === '') return true;
    if (query.name.toLowerCase().includes(search)) return true;
    return query.answers.some((answer) => answer.includes(search));
}

/*
 * Everything the tab shows, in one pass over the queries (plus the sort of the ones that
 * match, which is a plain reverse for a list in arrival order).
 */
export function buildDnsView(
    queries: readonly VpnDnsQuery[],
    filter: DnsFilter,
    nameOf: PeerNameLookup
): DnsView {
    const search = normalizeSearch(filter.search);
    const device = filter.device;
    const perDevice = new Map<string, number>();
    const matching: VpnDnsQuery[] = [];

    for (const query of queries) {
        perDevice.set(query.peer, (perDevice.get(query.peer) ?? 0) + 1);

        if (device !== ALL_DEVICES && query.peer !== device) continue;
        if (!matchesSearch(query, search)) continue;
        matching.push(query);
    }

    // The selected device stays in the list when it has no queries any more (e.g. after a
    // clear), or the dropdown would show nothing
    if (device !== ALL_DEVICES && !perDevice.has(device)) perDevice.set(device, 0);

    const devices = Array.from(perDevice, ([peer, count]) => ({
        peer,
        label: deviceLabel(peer, nameOf),
        count
    })).sort((a, b) => a.label.localeCompare(b.label) || a.peer.localeCompare(b.peer));

    return {
        rows: newestFirst(matching),
        counts: countQueries(matching),
        totalCount: queries.length,
        devices
    };
}

export type DnsEmptyReason = 'no-queries' | 'no-matches';

// Why the list has nothing to show: nothing was captured yet, or the filter hides it all
export function getEmptyReason(view: Pick<DnsView, 'rows' | 'totalCount'>): DnsEmptyReason | undefined {
    if (view.rows.length > 0) return undefined;
    return view.totalCount === 0 ? 'no-queries' : 'no-matches';
}

const formatCount = (count: number) => count.toLocaleString('en-US');
const pluralQueries = (count: number) => `${formatCount(count)} ${count === 1 ? 'query' : 'queries'}`;

// "37 of 1,204 queries · 12 blocked · 3 answered by a rule"
export function describeCounts(counts: DnsCounts, totalCount: number, filtering: boolean): string {
    const parts = [
        filtering
            ? `${formatCount(counts.total)} of ${pluralQueries(totalCount)}`
            : pluralQueries(totalCount)
    ];
    if (counts.blocked > 0) parts.push(`${formatCount(counts.blocked)} blocked`);
    if (counts.answered > 0) parts.push(`${formatCount(counts.answered)} answered by a rule`);
    if (counts.failed > 0) parts.push(`${formatCount(counts.failed)} failed`);
    return parts.join(' · ');
}

const pad2 = (value: number) => String(value).padStart(2, '0');

// Local time of day: "14:03:07"
export function formatQueryTime(at: number): string {
    const date = new Date(at);
    return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms) || ms < 0) return '';
    if (ms < 1) return '<1 ms';

    const rounded = Math.round(ms);
    if (rounded < 1000) return `${rounded} ms`;
    return `${(ms / 1000).toFixed(1)} s`;
}

// Two addresses and "+N more" fit the answers column at the usual window width without being cut
const MAX_SHOWN_ANSWERS = 2;

// What the answers cell says: the addresses, or why there are none
export function describeAnswers(query: Pick<VpnDnsQuery, 'answers' | 'rcode'>): string {
    const { answers, rcode } = query;
    if (answers.length > 0) {
        const shown = answers.slice(0, MAX_SHOWN_ANSWERS).join(', ');
        const hidden = answers.length - MAX_SHOWN_ANSWERS;
        return hidden > 0 ? `${shown} +${hidden} more` : shown;
    }
    return rcode === 'NOERROR' ? 'no records' : rcode;
}

export function ruleLabel(rule: VpnDnsQuery['rule']): string | undefined {
    if (rule === 'blocked') return 'Blocked';
    if (rule === 'answered') return 'Answered';
    return undefined;
}

export function describeRule(rule: VpnDnsQuery['rule']): string | undefined {
    if (rule === 'blocked') return 'A DNS rule blocked this name';
    if (rule === 'answered') return 'A DNS rule answered this name with its own address';
    return undefined;
}
