import { expect } from '../../test-setup';

import {
    DEFAULT_TLS_PASSTHROUGH_HOSTNAMES,
    withDefaultTlsPassthrough
} from '../../../src/model/proxy-store';

describe('Default TLS passthrough for pinned Apple services', () => {

    it('adds the defaults after the hostnames the user chose', () => {
        const result = withDefaultTlsPassthrough({ tlsPassthrough: [{ hostname: 'example.com' }] });

        expect(result).to.deep.equal({
            tlsPassthrough: [
                { hostname: 'example.com' },
                ...DEFAULT_TLS_PASSTHROUGH_HOSTNAMES.map((hostname) => ({ hostname }))
            ]
        });
    });

    it("doesn't change the user's own list", () => {
        const config = { tlsPassthrough: [{ hostname: 'example.com' }] };
        withDefaultTlsPassthrough(config);

        expect(config).to.deep.equal({ tlsPassthrough: [{ hostname: 'example.com' }] });
    });

    it("doesn't repeat a hostname the user already has", () => {
        const result = withDefaultTlsPassthrough({ tlsPassthrough: [{ hostname: '*.icloud.com' }] }) as {
            tlsPassthrough: Array<{ hostname: string }>
        };

        expect(result.tlsPassthrough.filter((entry) => entry.hostname === '*.icloud.com')).to.have.lengthOf(1);
    });

    it('covers push, iCloud and location services', () => {
        expect(DEFAULT_TLS_PASSTHROUGH_HOSTNAMES).to.include.members([
            '*.push.apple.com',
            '*.icloud.com',
            'wps.apple.com',
            'iphone-ld.apple.com'
        ]);
    });

    it('leaves "only intercept these hosts" alone', () => {
        const config = { tlsInterceptOnly: [{ hostname: 'example.com' }] };

        expect(withDefaultTlsPassthrough(config)).to.equal(config);
    });
});
