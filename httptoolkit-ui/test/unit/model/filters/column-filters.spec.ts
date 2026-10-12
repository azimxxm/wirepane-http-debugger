import { expect } from '../../../test-setup';
import { getExchangeData } from '../../unit-test-helpers';

import { emptyFilterSet, FilterSet } from '../../../../src/model/filters/search-filters';
import { matchFilters } from '../../../../src/model/filters/filter-matching';
import {
    createColumnFilter,
    getAppFilterString,
    getColumnFilterOptions,
    getEventsForColumnMenu,
    getFilterColumn,
    getHostContainsFilterString,
    toggleColumnFilter
} from '../../../../src/model/filters/column-filters';
import { SelectableSearchFilterClasses } from '../../../../src/model/filters/search-filters';

const serialized = (filterSet: FilterSet) => filterSet.slice(1).map((filter) => filter.serialize());

describe('Column filters', () => {

    describe('the status class and type filters', () => {

        it('match a whole class of status codes', () => {
            const filter = createColumnFilter('status=4xx')!;

            expect(filter.matches(getExchangeData({ statusCode: 404 }))).to.equal(true);
            expect(filter.matches(getExchangeData({ statusCode: 499 }))).to.equal(true);
            expect(filter.matches(getExchangeData({ statusCode: 200 }))).to.equal(false);
            expect(filter.matches(getExchangeData({ statusCode: 500 }))).to.equal(false);
            expect(filter.matches(getExchangeData({ responseState: 'pending' }))).to.equal(false);
            expect(filter.matches(getExchangeData({ responseState: 'aborted' }))).to.equal(false);
            expect(filter.toString()).to.equal('Status = 4xx');
        });

        it('can exclude a class of status codes', () => {
            const filter = createColumnFilter('status!=2xx')!;
            expect(filter.matches(getExchangeData({ statusCode: 200 }))).to.equal(false);
            expect(filter.matches(getExchangeData({ statusCode: 302 }))).to.equal(true);
        });

        it('match the type the Type column shows', () => {
            const filter = createColumnFilter('type=image')!;

            expect(filter.matches(getExchangeData({ responseHeaders: { 'content-type': 'image/png' } }))).to.equal(true);
            expect(filter.matches(getExchangeData({ responseHeaders: { 'content-type': 'application/json' } }))).to.equal(false);
            expect(filter.toString()).to.equal('Type = Image');
            expect(createColumnFilter('type!=image')!.matches(getExchangeData())).to.equal(true);
        });

        it('describe themselves in the chip\'s tooltip', () => {
            expect(createColumnFilter('status=5xx')!.filterDescription).to.equal('server error (5xx) responses');
            expect(createColumnFilter('status!=2xx')!.filterDescription).to.equal('responses that are not successful (2xx)');
            expect(createColumnFilter('type=font')!.filterDescription).to.equal('Font requests, as the Type column shows them');
        });
    });

    describe('creating filters', () => {
        it('uses the existing filters, so the chips read as normal syntax', () => {
            expect(createColumnFilter('method=POST')!.toString()).to.equal('Method = POST');
            expect(createColumnFilter('status>=400')!.toString()).to.equal('Status >= 400');
            expect(createColumnFilter('hostname=odtv.uz')!.toString()).to.equal('Hostname = odtv.uz');
            expect(createColumnFilter('hostname*=odtv')!.toString()).to.equal('Hostname *= odtv');
            expect(createColumnFilter('pending')!.toString()).to.equal('Pending');
        });

        it('refuses text that is not exactly one filter', () => {
            expect(createColumnFilter('method=')).to.equal(undefined);
            expect(createColumnFilter('not a filter')).to.equal(undefined);
            expect(createColumnFilter('method=GET status=4xx')).to.equal(undefined);
        });

        it('says which column a filter belongs to, whoever created it', () => {
            const columnOf = (text: string) => getFilterColumn(createColumnFilter(text)!);

            expect(columnOf('method=GET')).to.equal('method');
            expect(columnOf('method!=GET')).to.equal('method');
            expect(columnOf('status>=500')).to.equal('status');
            expect(columnOf('status=2xx')).to.equal('status');
            expect(columnOf('pending')).to.equal('status');
            expect(columnOf('aborted')).to.equal('status');
            expect(columnOf('type=media')).to.equal('type');
            expect(columnOf('app=Safari')).to.equal('source');
            expect(columnOf('hostname*=odtv')).to.equal('host');
            expect(columnOf('path=/index')).to.equal(undefined);
            expect(columnOf('port=443')).to.equal(undefined);
        });
    });

    describe('picking a value in a menu', () => {

        it('adds a filter after the text filter', () => {
            const result = toggleColumnFilter(emptyFilterSet(), 'method', 'method=POST');
            expect(result[0].filter).to.equal('');
            expect(serialized(result)).to.deep.equal(['method=POST']);
        });

        it('replaces what the column had, and keeps the other columns and the text', () => {
            const start = matchFilters(SelectableSearchFilterClasses, 'method=GET hostname=odtv.uz');
            expect(serialized(start)).to.have.members(['method=GET', 'hostname=odtv.uz']);

            const result = toggleColumnFilter(start, 'method', 'method=POST');
            expect(serialized(result)).to.have.members(['method=POST', 'hostname=odtv.uz']);
            expect(serialized(result).length).to.equal(2);
        });

        it('replaces a filter typed in the filter box, like status>=500', () => {
            const start = matchFilters(SelectableSearchFilterClasses, 'status>=500');
            const result = toggleColumnFilter(start, 'status', 'status=2xx');
            expect(serialized(result)).to.deep.equal(['status=2xx']);
        });

        it('removes the filter when the same value is picked again', () => {
            const picked = toggleColumnFilter(emptyFilterSet(), 'host', 'hostname=odtv.uz');
            const removed = toggleColumnFilter(picked, 'host', 'hostname=odtv.uz');
            expect(serialized(removed)).to.deep.equal([]);
        });

        it('removes only that column\'s filter on Clear', () => {
            const start = matchFilters(SelectableSearchFilterClasses, 'method=POST hostname=odtv.uz');
            const result = toggleColumnFilter(start, 'method', undefined);
            expect(serialized(result)).to.deep.equal(['hostname=odtv.uz']);
        });

        it('leaves the filters alone when the value is not a filter', () => {
            const start = toggleColumnFilter(emptyFilterSet(), 'method', 'method=GET');
            expect(toggleColumnFilter(start, 'method', 'method=')).to.equal(start);
        });
    });

    describe('the values a menu lists', () => {

        const events = [
            getExchangeData({ method: 'GET', hostname: 'odtv.uz', statusCode: 200, responseHeaders: { 'content-type': 'video/mp2t' } }),
            getExchangeData({ method: 'GET', hostname: 'odtv.uz', statusCode: 200, responseHeaders: { 'content-type': 'video/mp2t' } }),
            getExchangeData({ method: 'GET', hostname: 'odtv.uz', statusCode: 200, responseHeaders: { 'content-type': 'video/mp2t' } }),
            getExchangeData({ method: 'POST', hostname: 'api.example.com', statusCode: 404, responseHeaders: { 'content-type': 'application/json' } }),
            getExchangeData({ method: 'POST', hostname: 'api.example.com', statusCode: 503, responseHeaders: { 'content-type': 'application/json' } }),
            getExchangeData({ method: 'GET', hostname: 'api.example.com', responseState: 'pending' }),
            getExchangeData({ method: 'GET', hostname: 'api.example.com', responseState: 'aborted' })
        ];

        const summary = (column: Parameters<typeof getColumnFilterOptions>[0]) =>
            getColumnFilterOptions(column, events).map((o) => `${o.label} ${o.count}`);

        it('count methods, most used first', () => {
            expect(summary('method')).to.deep.equal(['GET 5', 'POST 2']);
        });

        it('count hosts, most used first', () => {
            expect(summary('host')).to.deep.equal(['odtv.uz 3', 'api.example.com 4'].sort((a, b) => Number(b.split(' ')[1]) - Number(a.split(' ')[1])));
        });

        it('count status classes and the failed & pending requests, hiding empty ones', () => {
            expect(summary('status')).to.deep.equal([
                '2xx 3',
                '4xx 1',
                '5xx 1',
                '400 and above 2',
                'Failed or aborted 1',
                'Pending 1'
            ]);
        });

        it('count types by what the Type column shows', () => {
            const options = getColumnFilterOptions('type', events);
            expect(options.find((o) => o.filterString === 'type=media')!.count).to.equal(3);
            expect(options.find((o) => o.filterString === 'type=fetch')!.count).to.equal(2);
        });

        it('give a count that is what picking the value shows', () => {
            for (const column of ['method', 'status', 'type', 'host'] as const) {
                for (const option of getColumnFilterOptions(column, events)) {
                    const filter = createColumnFilter(option.filterString)!;
                    expect(
                        events.filter((event) => filter.matches(event)).length,
                        option.filterString
                    ).to.equal(option.count);
                }
            }
        });

        it('limit hosts to the top few', () => {
            const many = Array.from({ length: 40 }, (_, i) => getExchangeData({ hostname: `host-${i}.example.com` }));
            expect(getColumnFilterOptions('host', many).length).to.equal(12);
        });

        it('count what the other columns\' filters keep, not the column\'s own', () => {
            const filterSet = matchFilters(SelectableSearchFilterClasses, 'method=POST hostname=odtv.uz');

            // Method's own filter doesn't hide GET, but the host filter does hide api.example.com
            const forMethod = getEventsForColumnMenu(events, filterSet, 'method');
            expect(getColumnFilterOptions('method', forMethod).map((o) => `${o.label} ${o.count}`))
                .to.deep.equal(['GET 3']);

            const forHost = getEventsForColumnMenu(events, filterSet, 'host');
            expect(getColumnFilterOptions('host', forHost).map((o) => `${o.label} ${o.count}`))
                .to.deep.equal(['api.example.com 2']);
        });
    });

    describe('text for the other filters', () => {
        it('puts app names with spaces in brackets, and skips ones the syntax cannot hold', () => {
            expect(getAppFilterString('Safari')).to.equal('app=Safari');
            expect(getAppFilterString('io.appmetrica.analytics')).to.equal('app=io.appmetrica.analytics');
            expect(getAppFilterString('Road 24')).to.equal('app=[Road 24]');
            expect(getAppFilterString('Odd ] name')).to.equal(undefined);

            expect(createColumnFilter(getAppFilterString('Road 24')!)).not.to.equal(undefined);
        });

        it('only takes hostname characters for "host contains"', () => {
            expect(getHostContainsFilterString(' ODTV ')).to.equal('hostname*=odtv');
            expect(getHostContainsFilterString('api.example-1.com')).to.equal('hostname*=api.example-1.com');
            expect(getHostContainsFilterString('a b')).to.equal(undefined);
            expect(getHostContainsFilterString('')).to.equal(undefined);
            expect(createColumnFilter(getHostContainsFilterString('odtv')!)).not.to.equal(undefined);
        });
    });
});
