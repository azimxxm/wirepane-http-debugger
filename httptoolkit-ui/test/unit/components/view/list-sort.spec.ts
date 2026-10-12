import { expect } from '../../../test-setup';
import { getExchangeData } from '../../unit-test-helpers';

import { HttpExchange } from '../../../../src/model/http/http-exchange';
import { getNextSort, ListSort } from '../../../../src/model/ui/list-columns-store';
import { getSortKey, sortEvents } from '../../../../src/components/view/list-sort';

const ids = (events: ReadonlyArray<HttpExchange>) => events.map((event) => event.id);

describe('List sorting', () => {

    describe('clicking a header', () => {
        it('goes ascending, descending, then back to the time order', () => {
            const asc = getNextSort(undefined, 'status');
            expect(asc).to.deep.equal({ column: 'status', direction: 'asc' });

            const desc = getNextSort(asc, 'status');
            expect(desc).to.deep.equal({ column: 'status', direction: 'desc' });

            expect(getNextSort(desc, 'status')).to.equal(undefined);
        });

        it('starts another column ascending', () => {
            const sortedByStatus: ListSort = { column: 'status', direction: 'desc' };
            expect(getNextSort(sortedByStatus, 'host')).to.deep.equal({ column: 'host', direction: 'asc' });
        });
    });

    describe('sorting events', () => {

        it('keeps the same array without a sort, so live traffic costs nothing', () => {
            const events = [getExchangeData(), getExchangeData()];
            expect(sortEvents(events, undefined)).to.equal(events);
        });

        it('sorts by method and leaves the input alone', () => {
            const events = ['POST', 'GET', 'PUT', 'GET'].map((method) => getExchangeData({ method }));
            const before = ids(events);

            const asc = sortEvents(events, { column: 'method', direction: 'asc' });
            expect(asc.map((e) => e.request.method)).to.deep.equal(['GET', 'GET', 'POST', 'PUT']);

            const desc = sortEvents(events, { column: 'method', direction: 'desc' });
            expect(desc.map((e) => e.request.method)).to.deep.equal(['PUT', 'POST', 'GET', 'GET']);

            expect(ids(events)).to.deep.equal(before);
        });

        it('keeps the time order between equal values, in both directions', () => {
            const events = ['GET', 'POST', 'GET', 'POST', 'GET'].map((method) => getExchangeData({ method }));

            const asc = sortEvents(events, { column: 'method', direction: 'asc' });
            expect(ids(asc)).to.deep.equal([events[0], events[2], events[4], events[1], events[3]].map((e) => e.id));

            const desc = sortEvents(events, { column: 'method', direction: 'desc' });
            expect(ids(desc)).to.deep.equal([events[1], events[3], events[0], events[2], events[4]].map((e) => e.id));
        });

        it('sorts statuses as numbers, and puts pending & aborted requests last either way', () => {
            const ok = getExchangeData({ statusCode: 200 });
            const notFound = getExchangeData({ statusCode: 404 });
            const serverError = getExchangeData({ statusCode: 500 });
            const pending = getExchangeData({ responseState: 'pending' });
            const aborted = getExchangeData({ responseState: 'aborted' });
            const events = [serverError, pending, notFound, aborted, ok];

            const asc = sortEvents(events, { column: 'status', direction: 'asc' });
            expect(ids(asc)).to.deep.equal([ok, notFound, serverError, pending, aborted].map((e) => e.id));

            const desc = sortEvents(events, { column: 'status', direction: 'desc' });
            expect(ids(desc)).to.deep.equal([serverError, notFound, ok, pending, aborted].map((e) => e.id));
        });

        it('sorts hosts and paths without minding the case', () => {
            const events = [
                getExchangeData({ hostname: 'b.example.com', path: '/Zed', query: '?a=1' }),
                getExchangeData({ hostname: 'A.example.com', path: '/alpha', query: '?b=2' }),
                getExchangeData({ hostname: 'c.example.com', path: '/alpha', query: '?a=1' })
            ];

            const byHost = sortEvents(events, { column: 'host', direction: 'asc' });
            expect(byHost.map((e) => e.request.parsedUrl.host)).to.deep.equal([
                'a.example.com', 'b.example.com', 'c.example.com'
            ]);

            const byPath = sortEvents(events, { column: 'path', direction: 'asc' });
            expect(ids(byPath)).to.deep.equal([events[2], events[1], events[0]].map((e) => e.id));
        });

        it('sorts by the type the Type column shows', () => {
            const image = getExchangeData({ responseHeaders: { 'content-type': 'image/png' } });
            const script = getExchangeData({ responseHeaders: { 'content-type': 'application/javascript' } });
            const document = getExchangeData({ responseHeaders: { 'content-type': 'text/html' } });

            const sorted = sortEvents([image, script, document], { column: 'type', direction: 'asc' });
            expect(ids(sorted)).to.deep.equal([document, image, script].map((e) => e.id));
        });

        it('sorts by the time, duration & size of a request', () => {
            const slow = Object.assign(getExchangeData(), {
                timingEvents: { startTime: 3, startTimestamp: 0, responseSentTimestamp: 900 }
            });
            const fast = Object.assign(getExchangeData(), {
                timingEvents: { startTime: 1, startTimestamp: 0, responseSentTimestamp: 20 }
            });
            const pending = Object.assign(getExchangeData({ responseState: 'pending' }), {
                timingEvents: { startTime: 2, startTimestamp: 0 }
            });
            const events = [slow, fast, pending] as HttpExchange[];

            expect(ids(sortEvents(events, { column: 'time', direction: 'desc' })))
                .to.deep.equal([slow, pending, fast].map((e) => e.id));
            expect(ids(sortEvents(events, { column: 'duration', direction: 'asc' })))
                .to.deep.equal([fast, slow, pending].map((e) => e.id));

            const small = getExchangeData({ responseBody: 'a' });
            const big = getExchangeData({ responseBody: 'a'.repeat(500) });
            expect(ids(sortEvents([big, small], { column: 'size', direction: 'asc' })))
                .to.deep.equal([small, big].map((e) => e.id));
        });

        it('gives events that are not requests no key, so they go last', () => {
            const exchange = getExchangeData();
            expect(getSortKey(exchange, 'method')).to.equal('GET');
            expect(getSortKey({ isHttp: () => false, isRTC: () => false } as any, 'host')).to.equal(undefined);
        });

        it('sorts thousands of events quickly', () => {
            const methods = ['GET', 'POST', 'PUT', 'DELETE'];
            const events = Array.from({ length: 5000 }, (_, i) => getExchangeData({
                method: methods[i % methods.length],
                hostname: `host-${i % 97}.example.com`,
                statusCode: 200 + (i % 5) * 100,
                path: `/item/${i}`
            }));

            const start = performance.now();
            for (const column of ['method', 'status', 'host', 'path'] as const) {
                sortEvents(events, { column, direction: 'asc' });
            }
            const elapsed = performance.now() - start;

            // Four sorts of 5000 rows take a few milliseconds each. The limit is generous for slow CI.
            expect(elapsed).to.be.lessThan(2000);
        });
    });
});
