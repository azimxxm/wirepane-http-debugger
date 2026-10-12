import { expect } from '../../../test-setup';
import { getExchangeData, getFailedTls } from '../../unit-test-helpers';

import { HttpExchange } from '../../../../src/model/http/http-exchange';
import { describeRowAttention, getRowAttention } from '../../../../src/model/events/row-attention';

// The helper builds exchanges without their constructor, so `downstream` (normally the
// exchange itself) is set by hand, with just the breakpoint state the marker reads.
function exchange(
    options: Parameters<typeof getExchangeData>[0] & {
        breakpointed?: boolean,
        matchedRule?: HttpExchange['matchedRule']
    } = {}
): HttpExchange {
    const { breakpointed, matchedRule, ...exchangeOptions } = options;
    return Object.assign(getExchangeData(exchangeOptions), {
        downstream: { isBreakpointed: !!breakpointed },
        matchedRule: matchedRule ?? false
    }) as unknown as HttpExchange;
}

describe('Row attention markers', () => {
    it('stays empty for ordinary requests', () => {
        expect(getRowAttention(exchange({ statusCode: 200 }))).to.equal(undefined);
        expect(getRowAttention(exchange({ statusCode: 404 }))).to.equal(undefined);
        expect(getRowAttention(exchange({ responseState: 'pending' }))).to.equal(undefined);
        // A rule that only passes traffic through changes nothing
        expect(getRowAttention(exchange({
            matchedRule: { id: 'default', stepTypes: ['passthrough'] }
        }))).to.equal(undefined);
    });

    it('marks failed requests: aborted, or a 5xx response', () => {
        expect(getRowAttention(exchange({ responseState: 'aborted' }))).to.equal('failed');
        expect(getRowAttention(exchange({ statusCode: 500 }))).to.equal('failed');
        expect(getRowAttention(exchange({ statusCode: 503 }))).to.equal('failed');
    });

    it('marks requests a rule changed', () => {
        expect(getRowAttention(exchange({
            matchedRule: { id: 'mock', stepTypes: ['simple'] }
        }))).to.equal('modified');
    });

    it('marks paused requests above everything else', () => {
        expect(getRowAttention(exchange({ breakpointed: true, responseState: 'pending' }))).to.equal('breakpoint');
        expect(getRowAttention(exchange({
            breakpointed: true,
            statusCode: 502,
            matchedRule: { id: 'pause', stepTypes: ['request-breakpoint'] }
        }))).to.equal('breakpoint');

        // ...and failures above rule changes
        expect(getRowAttention(exchange({
            responseState: 'aborted',
            matchedRule: { id: 'close', stepTypes: ['close-connection'] }
        }))).to.equal('failed');
    });

    it('has no marker for non-HTTP rows', () => {
        expect(getRowAttention(getFailedTls())).to.equal(undefined);
    });

    it('explains each marker in words', () => {
        expect(describeRowAttention('failed'))
            .to.equal('Failed: the request was aborted, or the server answered with a 5xx error');
        expect(describeRowAttention('modified')).to.match(/^Changed by a rule: /);
        expect(describeRowAttention('breakpoint')).to.match(/^Paused at a breakpoint: /);
    });
});
