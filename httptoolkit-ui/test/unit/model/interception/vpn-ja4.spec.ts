import { expect } from '../../../test-setup';

import { VpnTlsHello } from '../../../../src/model/interception/vpn-network';
import {
    describeJa4,
    getJa4FromTags,
    groupTlsHellosByJa4,
    parseJa4
} from '../../../../src/model/interception/vpn-ja4';

// The Chrome fingerprints FoxIO publishes, and what curl and Python's ssl module send
const CHROME = 't13d1516h2_8daaf6152771_02713d6af862';
const CHROME_RESUMING = 't13d1517h2_8daaf6152771_b0da82dd1658';
const CURL = 't13d4907h2_0d8feac7bc37_7395dae3b2f3';
const PYTHON = 't13d181100_85036bcba153_d41ae481755e';

const hello = (ja4: string, overrides: Partial<VpnTlsHello> = {}): VpnTlsHello => ({
    peer: 'p1',
    dst: '93.184.216.34:443',
    sni: 'example.com',
    alpn: ['h2', 'http/1.1'],
    ja4,
    at: 1_000,
    ...overrides
});

describe('JA4 fingerprints', () => {

    describe('reading a JA4', () => {

        it('splits out the readable parts of Chrome\'s fingerprint', () => {
            expect(parseJa4(CHROME)).to.deep.equal({
                transport: 'TCP',
                tlsVersion: 'TLS 1.3',
                hasSni: true,
                cipherCount: 15,
                extensionCount: 16,
                alpn: 'HTTP/2'
            });
        });

        it('knows a hello without a name or ALPN, and an older TLS version', () => {
            expect(parseJa4(PYTHON)).to.deep.include({
                tlsVersion: 'TLS 1.3',
                hasSni: true,
                cipherCount: 18,
                extensionCount: 11,
                alpn: undefined
            });
            expect(parseJa4('t12i020100_000000000000_000000000000')).to.deep.include({
                tlsVersion: 'TLS 1.2',
                hasSni: false,
                alpn: undefined
            });
        });

        it('knows QUIC and DTLS, and names ALPN values it recognises', () => {
            expect(parseJa4('q13d0310h3_55b375c5d22e_cd85d2d88918')).to.deep.include({
                transport: 'QUIC',
                alpn: 'HTTP/3'
            });
            expect(parseJa4('d12d0101h1_000000000000_000000000000')).to.deep.include({
                transport: 'DTLS',
                alpn: 'HTTP/1.1'
            });
            expect(parseJa4('t13d0101xy_000000000000_000000000000')!.alpn).to.equal('ALPN xy');
        });

        it('says nothing about strings that are not a JA4', () => {
            expect(parseJa4('')).to.equal(undefined);
            expect(parseJa4('t13d1516h2_8daaf6152771')).to.equal(undefined);
            expect(parseJa4('t13d1516h2_8daaf6152771_02713d6af86')).to.equal(undefined);
            expect(parseJa4('x13d1516h2_8daaf6152771_02713d6af862')).to.equal(undefined);
            expect(parseJa4(`${CHROME} `)).to.equal(undefined);
            expect(describeJa4('hello')).to.equal(undefined);
        });

        it('describes a fingerprint in one line', () => {
            expect(describeJa4(CHROME)).to.equal('TLS 1.3 · 15 cipher suites · 16 extensions · HTTP/2');
            expect(describeJa4(PYTHON)).to.equal('TLS 1.3 · 18 cipher suites · 11 extensions');
            expect(describeJa4('t12d010100_000000000000_000000000000'))
                .to.equal('TLS 1.2 · 1 cipher suite · 1 extension');
        });
    });

    describe('finding the JA4 in a connection\'s tags', () => {

        it('reads the tag the tunnel sets, with or without Mockttp\'s prefix', () => {
            expect(getJa4FromTags([`wirepane-vpn-ja4:${CHROME}`])).to.equal(CHROME);
            expect(getJa4FromTags([`socket-metadata:wirepane-vpn-ja4:${CHROME}`])).to.equal(CHROME);
        });

        it('finds it among the other tags', () => {
            expect(getJa4FromTags([
                'socket-metadata:wirepane-vpn',
                'socket-metadata:wirepane-vpn-peer:p1',
                'socket-metadata:wirepane-vpn-sni:example.com',
                `socket-metadata:wirepane-vpn-ja4:${CURL}`,
                'socket-metadata:wirepane-vpn-endpoint:192.168.1.20'
            ])).to.equal(CURL);
        });

        it('is undefined when the connection has no such tag', () => {
            expect(getJa4FromTags(undefined)).to.equal(undefined);
            expect(getJa4FromTags([])).to.equal(undefined);
            expect(getJa4FromTags(['socket-metadata:wirepane-vpn-peer:p1', 'browser:chrome'])).to.equal(undefined);
        });

        it('ignores a tag that does not hold a JA4', () => {
            expect(getJa4FromTags(['wirepane-vpn-ja4:'])).to.equal(undefined);
            expect(getJa4FromTags(['wirepane-vpn-ja4:<script>'])).to.equal(undefined);
            expect(getJa4FromTags(['other-ja4:' + CHROME])).to.equal(undefined);
            // A good one later in the list still counts
            expect(getJa4FromTags(['wirepane-vpn-ja4:nope', `wirepane-vpn-ja4:${CHROME}`])).to.equal(CHROME);
        });
    });

    describe('grouping hellos by JA4', () => {

        it('makes no groups from no hellos', () => {
            expect(groupTlsHellosByJa4([])).to.deep.equal([]);
        });

        it('counts the hellos of each fingerprint', () => {
            const groups = groupTlsHellosByJa4([
                hello(CHROME), hello(CURL), hello(CHROME), hello(CHROME), hello(CURL)
            ]);

            expect(groups.map((group) => [group.ja4, group.count])).to.deep.equal([
                [CHROME, 3],
                [CURL, 2]
            ]);
        });

        it('lists the names each fingerprint asked for, most often first', () => {
            const [chrome] = groupTlsHellosByJa4([
                hello(CHROME, { sni: 'a.example.com' }),
                hello(CHROME, { sni: 'b.example.com' }),
                hello(CHROME, { sni: 'b.example.com' }),
                hello(CHROME, { sni: 'c.example.com' }),
                hello(CHROME, { sni: 'b.example.com' }),
                hello(CHROME, { sni: 'a.example.com' })
            ]);

            expect(chrome.snis).to.deep.equal([
                { value: 'b.example.com', count: 3 },
                { value: 'a.example.com', count: 2 },
                { value: 'c.example.com', count: 1 }
            ]);
            expect(chrome.withoutSni).to.equal(0);
        });

        it('breaks a tie between names alphabetically', () => {
            const [group] = groupTlsHellosByJa4([
                hello(CHROME, { sni: 'z.example.com' }),
                hello(CHROME, { sni: 'a.example.com' })
            ]);

            expect(group.snis.map((sni) => sni.value)).to.deep.equal(['a.example.com', 'z.example.com']);
        });

        it('counts hellos without a name apart from the names', () => {
            const [group] = groupTlsHellosByJa4([
                hello(PYTHON, { sni: undefined }),
                hello(PYTHON, { sni: '' }),
                hello(PYTHON, { sni: 'api.example.net' })
            ]);

            expect(group.count).to.equal(3);
            expect(group.withoutSni).to.equal(2);
            expect(group.snis).to.deep.equal([{ value: 'api.example.net', count: 1 }]);
        });

        it('lists the devices (by peer id) that sent each fingerprint', () => {
            const groups = groupTlsHellosByJa4([
                hello(CHROME, { peer: 'p1' }),
                hello(CHROME, { peer: 'p2' }),
                hello(CHROME, { peer: 'p2' }),
                hello(CURL, { peer: 'p1' })
            ]);

            expect(groups[0].peers).to.deep.equal([
                { value: 'p2', count: 2 },
                { value: 'p1', count: 1 }
            ]);
            expect(groups[1].peers).to.deep.equal([{ value: 'p1', count: 1 }]);
        });

        it('keeps the first and last time a fingerprint was seen', () => {
            const [group] = groupTlsHellosByJa4([
                hello(CHROME, { at: 5_000 }),
                hello(CHROME, { at: 2_000 }),
                hello(CHROME, { at: 9_000 })
            ]);

            expect(group.firstSeen).to.equal(2_000);
            expect(group.lastSeen).to.equal(9_000);
        });

        it('puts the biggest group first, then the one seen last', () => {
            const groups = groupTlsHellosByJa4([
                hello(CURL, { at: 1_000 }),
                hello(CHROME_RESUMING, { at: 3_000 }),
                hello(PYTHON, { at: 2_000 }),
                hello(CHROME, { at: 4_000 }),
                hello(CHROME, { at: 4_500 })
            ]);

            expect(groups.map((group) => group.ja4)).to.deep.equal([
                CHROME, // two hellos
                CHROME_RESUMING, // one each, but the most recent of those
                PYTHON,
                CURL
            ]);
        });

        it('leaves out hellos that have no JA4', () => {
            const groups = groupTlsHellosByJa4([
                hello(''),
                hello(CHROME),
                { ...hello(CHROME), ja4: undefined as unknown as string }
            ]);

            expect(groups.map((group) => [group.ja4, group.count])).to.deep.equal([[CHROME, 1]]);
        });

        it('does not change the hellos it was given', () => {
            const hellos = [hello(CURL), hello(CHROME), hello(CHROME)];
            const copy = JSON.parse(JSON.stringify(hellos));

            groupTlsHellosByJa4(hellos);

            expect(hellos).to.deep.equal(copy);
        });
    });
});
