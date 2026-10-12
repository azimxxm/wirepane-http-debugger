import { expect } from '../../../test-setup';

import {
    describeOpenEvent,
    describeOpenEventUrl,
    describeSelection
} from '../../../../src/components/view/open-event-title';

import { deviceExchange, failedTls } from '../../model/devices/device-test-helpers';

const TOKEN = '0ff5151d' + 'a'.repeat(56);

describe('The open request in the toolbar breadcrumb', () => {

    it('names a request by its method and path', () => {
        expect(describeOpenEvent(deviceExchange({ path: '/todos/1' }))).to.equal('GET /todos/1');
    });

    it('leaves the query string out, as it can be hundreds of characters of tokens', () => {
        const event = deviceExchange({ host: 'odtv.uz', path: `/Setanta_1_HD/tracks-v1a1/2026/10/12/38-06000.ts?token=${TOKEN}` });

        expect(describeOpenEvent(event)).to.equal('GET /Setanta_1_HD/tracks-v1a1/2026/10/12/38-06000.ts');
    });

    it('keeps the whole URL for the tooltip', () => {
        const event = deviceExchange({ host: 'odtv.uz', path: `/segment.ts?token=${TOKEN}` });

        expect(describeOpenEventUrl(event)).to.equal(`GET https://odtv.uz/segment.ts?token=${TOKEN}`);
    });

    it('has nothing nonsensical to say about a request that broke before it was read', () => {
        const broken = deviceExchange({ ip: '192.168.0.23', tags: ['client-error:EPIPE'] });
        Object.assign(broken.request, {
            method: '',
            url: 'http://',
            parsedUrl: Object.assign(new URL('unknown://unparseable.invalid/'), { parseable: false })
        });

        expect(describeOpenEvent(broken)).to.equal('Broken request');
        expect(describeOpenEventUrl(broken)).to.equal(undefined);

        broken.request.method = 'GET';
        expect(describeOpenEvent(broken)).to.equal('GET (unreadable URL)');
    });

    it('names other kinds of events', () => {
        expect(describeOpenEvent(failedTls('192.168.0.23', 'api.example.com')))
            .to.equal('Failed TLS connection to api.example.com');
        expect(describeOpenEventUrl(failedTls('192.168.0.23'))).to.equal(undefined);
        expect(describeSelection(1200)).to.equal('1,200 selected');
    });
});
