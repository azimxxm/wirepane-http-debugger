import { expect } from '../../../test-setup';

import type { VpnDnsQuery } from '../../../../src/model/interception/vpn-network';
import {
    ALL_DEVICES,
    NO_DNS_FILTER,
    buildDnsView,
    countQueries,
    describeAnswers,
    describeCounts,
    deviceLabel,
    formatDuration,
    formatQueryTime,
    getEmptyReason,
    isFiltering,
    newestFirst,
    normalizeSearch,
    peerNamesFromStats,
    ruleLabel
} from '../../../../src/components/network/dns-tab-model';

const query = (overrides: Partial<VpnDnsQuery> = {}): VpnDnsQuery => ({
    peer: 'p1',
    name: 'api.example.com',
    qtype: 'A',
    rcode: 'NOERROR',
    answers: ['93.184.216.34'],
    ms: 12,
    at: 1_000,
    ...overrides
});

const names: { [peer: string]: string } = { p1: 'iPhone', p2: 'iPad' };
const nameOf = (peer: string) => names[peer];

describe('The DNS tab model', () => {

    describe('newest first', () => {

        it('reverses a list in arrival order', () => {
            const queries = [1, 2, 3].map((at) => query({ at, name: `n${at}` }));
            expect(newestFirst(queries).map((q) => q.name)).to.deep.equal(['n3', 'n2', 'n1']);
        });

        it('does not change the list it is given', () => {
            const queries = [1, 2, 3].map((at) => query({ at }));
            newestFirst(queries);
            expect(queries.map((q) => q.at)).to.deep.equal([1, 2, 3]);
        });

        it('sorts a list that is out of order by time', () => {
            const queries = [5, 1, 9, 3].map((at) => query({ at, name: `n${at}` }));
            expect(newestFirst(queries).map((q) => q.name)).to.deep.equal(['n9', 'n5', 'n3', 'n1']);
        });

        it('keeps the arrival order of queries with the same time, the last one first', () => {
            const queries = [
                query({ at: 5, name: 'late' }),
                query({ at: 1, name: 'early' }),
                query({ at: 5, name: 'same-a' }),
                query({ at: 5, name: 'same-b' })
            ];
            expect(newestFirst(queries).map((q) => q.name))
                .to.deep.equal(['same-b', 'same-a', 'late', 'early']);
        });

        it('handles an empty list', () => {
            expect(newestFirst([])).to.deep.equal([]);
        });
    });

    describe('searching', () => {

        const queries = [
            query({ at: 1, name: 'api.example.com' }),
            query({ at: 2, name: 'cdn.Example.org', answers: ['10.0.0.7'] }),
            query({ at: 3, name: 'tracker.test', answers: [], rcode: 'NXDOMAIN' })
        ];
        const search = (text: string) =>
            buildDnsView(queries, { search: text, device: ALL_DEVICES }, nameOf).rows.map((q) => q.name);

        it('shows everything for an empty search, newest first', () => {
            expect(search('')).to.deep.equal(['tracker.test', 'cdn.Example.org', 'api.example.com']);
        });

        it('matches part of a name, ignoring case', () => {
            expect(search('EXAMPLE')).to.deep.equal(['cdn.Example.org', 'api.example.com']);
        });

        it('ignores spaces around the text', () => {
            expect(search('  tracker ')).to.deep.equal(['tracker.test']);
        });

        it('matches an address in the answers', () => {
            expect(search('10.0.0')).to.deep.equal(['cdn.Example.org']);
        });

        it('shows nothing when nothing matches', () => {
            expect(search('nope')).to.deep.equal([]);
        });

        it('normalizes what was typed', () => {
            expect(normalizeSearch('  Api.Example.COM ')).to.equal('api.example.com');
        });
    });

    describe('filtering by device', () => {

        const queries = [
            query({ at: 1, peer: 'p1', name: 'a.test' }),
            query({ at: 2, peer: 'p2', name: 'b.test' }),
            query({ at: 3, peer: 'p1', name: 'c.test' }),
            query({ at: 4, peer: 'p3', name: 'd.test' })
        ];

        it('shows only the queries of one device', () => {
            const view = buildDnsView(queries, { search: '', device: 'p1' }, nameOf);
            expect(view.rows.map((q) => q.name)).to.deep.equal(['c.test', 'a.test']);
            expect(view.totalCount).to.equal(4);
        });

        it('combines the device with the search', () => {
            const view = buildDnsView(queries, { search: 'c.', device: 'p1' }, nameOf);
            expect(view.rows.map((q) => q.name)).to.deep.equal(['c.test']);
        });

        it('lists every device with its number of queries, by name, whatever the filter is', () => {
            const view = buildDnsView(queries, { search: 'a.test', device: 'p1' }, nameOf);
            expect(view.devices).to.deep.equal([
                { peer: 'p2', label: 'iPad', count: 1 },
                { peer: 'p1', label: 'iPhone', count: 2 },
                // Not named yet: its id is its label
                { peer: 'p3', label: 'p3', count: 1 }
            ].sort((a, b) => a.label.localeCompare(b.label)));
        });

        it('keeps the selected device in the list when it has no queries', () => {
            const view = buildDnsView(queries.slice(0, 1), { search: '', device: 'p2' }, nameOf);
            expect(view.rows).to.deep.equal([]);
            expect(view.devices.find((d) => d.peer === 'p2')).to.deep.equal({ peer: 'p2', label: 'iPad', count: 0 });
        });
    });

    describe('counts', () => {

        const queries = [
            query({ rule: 'blocked', rcode: 'NXDOMAIN', answers: [] }),
            query({ rule: 'blocked', rcode: 'NXDOMAIN', answers: [] }),
            query({ rule: 'answered', answers: ['192.168.0.10'] }),
            query({ rcode: 'NXDOMAIN', answers: [] }),
            query({ rcode: 'SERVFAIL', answers: [] }),
            query()
        ];

        it('counts blocked, answered and failed queries, and a failure caused by a rule is not one', () => {
            expect(countQueries(queries)).to.deep.equal({ total: 6, blocked: 2, answered: 1, failed: 2 });
        });

        it('counts the queries that pass the filter', () => {
            const view = buildDnsView(queries, { search: '', device: ALL_DEVICES }, nameOf);
            expect(view.counts.total).to.equal(6);
            const none = buildDnsView(queries, { search: 'nothing-like-this', device: ALL_DEVICES }, nameOf);
            expect(none.counts).to.deep.equal({ total: 0, blocked: 0, answered: 0, failed: 0 });
            expect(none.totalCount).to.equal(6);
        });

        it('says them in a line', () => {
            expect(describeCounts({ total: 6, blocked: 2, answered: 1, failed: 2 }, 6, false))
                .to.equal('6 queries · 2 blocked · 1 answered by a rule · 2 failed');
        });

        it('says how many pass the filter', () => {
            expect(describeCounts({ total: 37, blocked: 0, answered: 0, failed: 0 }, 1204, true))
                .to.equal('37 of 1,204 queries');
        });

        it('says one query in the singular', () => {
            expect(describeCounts({ total: 1, blocked: 0, answered: 0, failed: 0 }, 1, false)).to.equal('1 query');
            expect(describeCounts({ total: 0, blocked: 0, answered: 0, failed: 0 }, 0, false)).to.equal('0 queries');
        });
    });

    describe('the empty states', () => {

        it('is "no queries" when nothing was captured', () => {
            const view = buildDnsView([], NO_DNS_FILTER, nameOf);
            expect(getEmptyReason(view)).to.equal('no-queries');
        });

        it('is "no matches" when the filter hides everything', () => {
            const view = buildDnsView([query()], { search: 'zzz', device: ALL_DEVICES }, nameOf);
            expect(getEmptyReason(view)).to.equal('no-matches');
        });

        it('is nothing when there are rows', () => {
            expect(getEmptyReason(buildDnsView([query()], NO_DNS_FILTER, nameOf))).to.equal(undefined);
        });

        it('knows when a filter is on', () => {
            expect(isFiltering(NO_DNS_FILTER)).to.equal(false);
            expect(isFiltering({ search: '   ', device: ALL_DEVICES })).to.equal(false);
            expect(isFiltering({ search: 'a', device: ALL_DEVICES })).to.equal(true);
            expect(isFiltering({ search: '', device: 'p1' })).to.equal(true);
        });
    });

    describe('the text of the cells', () => {

        it('lists the answers', () => {
            expect(describeAnswers(query({ answers: ['1.1.1.1', '2.2.2.2'] }))).to.equal('1.1.1.1, 2.2.2.2');
        });

        it('cuts a long list of answers', () => {
            const answers = ['1.1.1.1', '2.2.2.2', '3.3.3.3', '4.4.4.4', '5.5.5.5'];
            expect(describeAnswers(query({ answers }))).to.equal('1.1.1.1, 2.2.2.2 +3 more');
        });

        it('says why there are no answers', () => {
            expect(describeAnswers(query({ answers: [], rcode: 'NXDOMAIN' }))).to.equal('NXDOMAIN');
            expect(describeAnswers(query({ answers: [], rcode: 'NOERROR', qtype: 'AAAA' }))).to.equal('no records');
        });

        it('formats how long a lookup took', () => {
            expect(formatDuration(0)).to.equal('<1 ms');
            expect(formatDuration(0.4)).to.equal('<1 ms');
            expect(formatDuration(12)).to.equal('12 ms');
            expect(formatDuration(12.6)).to.equal('13 ms');
            expect(formatDuration(999.7)).to.equal('1.0 s');
            expect(formatDuration(1530)).to.equal('1.5 s');
            expect(formatDuration(-1)).to.equal('');
            expect(formatDuration(NaN)).to.equal('');
        });

        it('formats the time of day in the local time zone', () => {
            const at = new Date(2026, 9, 13, 14, 3, 7).getTime();
            expect(formatQueryTime(at)).to.equal('14:03:07');
            expect(formatQueryTime(new Date(2026, 9, 13, 0, 5, 0).getTime())).to.equal('00:05:00');
        });

        it('labels the rules', () => {
            expect(ruleLabel('blocked')).to.equal('Blocked');
            expect(ruleLabel('answered')).to.equal('Answered');
            expect(ruleLabel(undefined)).to.equal(undefined);
        });
    });

    describe('device names', () => {

        it('reads them from the stats event', () => {
            const stats = {
                event: 'stats',
                peers: [{ peer: 'p1', name: 'iPhone' }, { peer: 'p2', name: '' }, { peer: 3 }, null, 'x']
            };
            expect(Array.from(peerNamesFromStats(stats))).to.deep.equal([['p1', 'iPhone']]);
        });

        it('copes with stats that are missing or odd', () => {
            expect(peerNamesFromStats(undefined).size).to.equal(0);
            expect(peerNamesFromStats(null).size).to.equal(0);
            expect(peerNamesFromStats({ peers: 'nope' }).size).to.equal(0);
        });

        it('labels a device with its name, or with its id until it has one', () => {
            expect(deviceLabel('p1', nameOf)).to.equal('iPhone');
            expect(deviceLabel('p9', nameOf)).to.equal('p9');
        });
    });

    describe('with many queries', () => {

        // The store keeps the last few thousand queries, and the tab asks again after every poll
        const many = (count: number) => Array.from({ length: count }, (_, i) => query({
            at: 1_000 + i,
            peer: i % 3 === 0 ? 'p1' : 'p2',
            name: `host-${i % 400}.example.${i % 2 ? 'com' : 'org'}`,
            answers: i % 7 === 0 ? [] : [`10.0.${i % 250}.${i % 200}`],
            rcode: i % 7 === 0 ? 'NXDOMAIN' : 'NOERROR',
            rule: i % 50 === 0 ? 'blocked' : undefined
        }));

        it('builds the view of 5000 queries (the most the store keeps) well within a frame, for every kind of filter', () => {
            const queries = many(5000);
            const filters = [
                NO_DNS_FILTER,
                { search: 'host-1', device: ALL_DEVICES },
                { search: '', device: 'p2' },
                { search: 'example.org', device: 'p1' },
                { search: 'no-such-name', device: ALL_DEVICES }
            ];

            const runs = 20;
            const start = performance.now();
            for (let run = 0; run < runs; run++) {
                for (const filter of filters) buildDnsView(queries, filter, nameOf);
            }
            const perView = (performance.now() - start) / (runs * filters.length);

            // A few milliseconds at most when this was written; the bound is loose for slow machines
            expect(perView).to.be.lessThan(16);
        });

        it('shows 2000 queries newest first', () => {
            const view = buildDnsView(many(2000), NO_DNS_FILTER, nameOf);
            expect(view.rows).to.have.length(2000);
            expect(view.rows[0].at).to.equal(1_000 + 1999);
            expect(view.rows[1999].at).to.equal(1_000);
            expect(view.counts.blocked).to.equal(40);
        });
    });
});
