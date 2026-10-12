import { expect } from '../../../test-setup';
import { getExchangeData } from '../../unit-test-helpers';

import { HttpExchange } from '../../../../src/model/http/http-exchange';
import {
    formatCompactDuration,
    formatCompactSize,
    getEventDuration,
    getResponseBodySize
} from '../../../../src/components/view/event-rows/list-columns';

const withTimings = (exchange: HttpExchange, timingEvents: Partial<HttpExchange['timingEvents']>) =>
    Object.assign(exchange, { timingEvents: { startTime: Date.now(), ...timingEvents } }) as HttpExchange;

describe('List column values', () => {

    it('formats sizes to fit a narrow column', () => {
        const cases: Array<[number, string]> = [
            [0, '0 B'],
            [512, '512 B'],
            [999, '999 B'],
            [1000, '1.0 kB'],
            [1234, '1.2 kB'],
            [12_345, '12 kB'],
            [999_499, '999 kB'],
            [999_500, '1.0 MB'],
            [3_400_000, '3.4 MB'],
            [7_000_000_000, '7.0 GB']
        ];
        for (const [bytes, expected] of cases) {
            expect(formatCompactSize(bytes), String(bytes)).to.equal(expected);
        }
    });

    it('formats durations to fit a narrow column', () => {
        const cases: Array<[number, string]> = [
            [0.4, '<1 ms'],
            [22.3, '22 ms'],
            [999.4, '999 ms'],
            [1203, '1.20 s'],
            [12_500, '12.5 s'],
            [125_000, '2.1 min'],
            [7_200_000, '2.0 h']
        ];
        for (const [ms, expected] of cases) {
            expect(formatCompactDuration(ms), String(ms)).to.equal(expected);
        }
    });

    it('measures a response from the request starting until it was sent', () => {
        expect(getEventDuration(withTimings(getExchangeData(), {
            startTimestamp: 100,
            responseSentTimestamp: 345.5
        }))).to.equal(245.5);

        expect(getEventDuration(withTimings(getExchangeData({ responseState: 'aborted' }), {
            startTimestamp: 100,
            abortedTimestamp: 160
        }))).to.equal(60);

        // Still waiting: no duration, rather than one that's out of date
        expect(getEventDuration(withTimings(getExchangeData({ responseState: 'pending' }), {
            startTimestamp: 100
        }))).to.equal(undefined);
    });

    it('sizes the response body as sent', () => {
        expect(getResponseBodySize(getExchangeData({ responseBody: 'x'.repeat(1500) }))).to.equal(1500);
        expect(getResponseBodySize(getExchangeData({ responseState: 'pending' }))).to.equal(undefined);
        expect(getResponseBodySize(getExchangeData({ responseState: 'aborted' }))).to.equal(undefined);
    });
});
