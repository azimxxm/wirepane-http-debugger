import { expect } from '../../../test-setup';

import { VpnDnsRule } from '../../../../src/model/interception/vpn-network';
import {
    checkDnsAddress,
    checkDnsPattern,
    checkDnsRuleDraft,
    describeDnsAction,
    findShadowingRule,
    normalizeDnsPattern,
    patternCovers
} from '../../../../src/model/interception/vpn-dns-rules';

const block = (pattern: string): VpnDnsRule => ({ pattern, action: 'block' });
const answer = (pattern: string, ipv4: string): VpnDnsRule => ({ pattern, action: 'answer', ipv4 });

describe('DNS rule checks', () => {

    describe('normalizeDnsPattern', () => {
        it('trims, drops one trailing dot and lowercases', () => {
            expect(normalizeDnsPattern('  API.Example.COM. ')).to.equal('api.example.com');
            expect(normalizeDnsPattern('*.Example.com')).to.equal('*.example.com');
        });

        it('keeps a second trailing dot, so it is reported as a problem', () => {
            expect(normalizeDnsPattern('example.com..')).to.equal('example.com.');
        });
    });

    describe('checkDnsPattern', () => {
        it('accepts exact names and wildcards', () => {
            [
                'example.com',
                'API.example.com',
                'api.example.com.',
                '*.example.com',
                '*.Example.COM.',
                'localhost',
                '*.com',
                '_acme-challenge.example.com',
                'cdn-1.example.com',
                '192.168.0.1',
                '  example.com  ',
                `${'a'.repeat(63)}.com`,
                'xn--mnchen-3ya.de'
            ].forEach((pattern) => {
                expect(checkDnsPattern(pattern), pattern).to.equal(undefined);
            });
        });

        it('asks for a name when there is none', () => {
            ['', '   ', '.'].forEach((pattern) => {
                expect(checkDnsPattern(pattern), pattern).to.contain('Enter a name');
            });
        });

        it('refuses a lone *, which would match every name', () => {
            ['*', '*.'].forEach((pattern) => {
                expect(checkDnsPattern(pattern), pattern).to.contain('every name');
            });
        });

        it('points at the host name when a URL or a port is pasted', () => {
            [
                'https://example.com',
                'example.com/path',
                'example.com:8080',
                '*.example.com/'
            ].forEach((pattern) => {
                expect(checkDnsPattern(pattern), pattern).to.contain('just the host name');
            });
        });

        it('allows the * only as the whole first part', () => {
            ['a*.example.com', 'api.*.example.com', '*.*.example.com', '**.example.com', 'example.*'].forEach((pattern) => {
                expect(checkDnsPattern(pattern), pattern).to.contain('first part');
            });
        });

        it('refuses empty parts', () => {
            ['.example.com', 'a..example.com', 'example.com..'].forEach((pattern) => {
                expect(checkDnsPattern(pattern), pattern).to.contain('extra dot');
            });
        });

        it('refuses spaces and characters a name cannot have', () => {
            expect(checkDnsPattern('my host.com')).to.contain('spaces');
            expect(checkDnsPattern('exa$mple.com')).to.contain('"$" isn\'t allowed');
            expect(checkDnsPattern('exa mple.com')).to.contain('spaces');
        });

        it('asks for the xn-- form of an international name', () => {
            expect(checkDnsPattern('münchen.de')).to.contain('xn--');
        });

        it('refuses names and parts that are too long', () => {
            expect(checkDnsPattern(`${'a'.repeat(64)}.com`)).to.contain('at most 63');

            const part = 'b'.repeat(62);
            const longest = `${part}.${part}.${part}.${part}.c`;
            expect(longest.length).to.equal(253);
            expect(checkDnsPattern(longest)).to.equal(undefined);
            expect(checkDnsPattern(`${longest}x`)).to.contain('at most 253');
        });
    });

    describe('checkDnsAddress', () => {
        it('accepts IPv4 addresses', () => {
            ['192.168.0.10', '0.0.0.0', '255.255.255.255', '10.73.0.2', ' 1.2.3.4 '].forEach((address) => {
                expect(checkDnsAddress(address), address).to.equal(undefined);
            });
        });

        it('asks for an address when there is none', () => {
            expect(checkDnsAddress('')).to.contain('Enter the IPv4 address');
            expect(checkDnsAddress('  ')).to.contain('Enter the IPv4 address');
        });

        it('says IPv6 does not work yet', () => {
            expect(checkDnsAddress('::1')).to.contain('Only IPv4');
            expect(checkDnsAddress('fe80::1')).to.contain('Only IPv4');
        });

        it('refuses leading zeros, like the sidecar does', () => {
            ['10.0.0.05', '010.0.0.1', '00.0.0.0'].forEach((address) => {
                expect(checkDnsAddress(address), address).to.contain('leading zeros');
            });
        });

        it('refuses anything that is not four numbers from 0 to 255', () => {
            ['1.2.3', '1.2.3.4.5', '1.2.3.256', '999.1.1.1', 'a.b.c.d', 'example.com', '1.2.3.-4', '1,2,3,4'].forEach((address) => {
                expect(checkDnsAddress(address), address).to.contain('not an IPv4 address');
            });
        });
    });

    describe('checkDnsRuleDraft', () => {
        it('builds a block rule with the name in its normal form', () => {
            expect(checkDnsRuleDraft({ pattern: ' Ads.Example.COM. ', action: 'block', ipv4: '' }, []))
                .to.deep.equal({ rule: block('ads.example.com') });
        });

        it('builds an answer rule with the trimmed address', () => {
            expect(checkDnsRuleDraft({ pattern: '*.test', action: 'answer', ipv4: ' 192.168.0.10 ' }, []))
                .to.deep.equal({ rule: answer('*.test', '192.168.0.10') });
        });

        it('ignores a leftover address while the rule only blocks', () => {
            const check = checkDnsRuleDraft({ pattern: 'a.test', action: 'block', ipv4: 'not an address' }, []);
            expect(check.rule).to.deep.equal(block('a.test'));
            expect(check.addressProblem).to.equal(undefined);
        });

        it('reports the problem of each field', () => {
            const check = checkDnsRuleDraft({ pattern: 'a b', action: 'answer', ipv4: '1.2.3' }, []);
            expect(check.rule).to.equal(undefined);
            expect(check.patternProblem).to.contain('spaces');
            expect(check.addressProblem).to.contain('not an IPv4 address');
        });

        it('needs an address for an answer rule', () => {
            const check = checkDnsRuleDraft({ pattern: 'a.test', action: 'answer', ipv4: '' }, []);
            expect(check.rule).to.equal(undefined);
            expect(check.patternProblem).to.equal(undefined);
            expect(check.addressProblem).to.contain('Enter the IPv4 address');
        });

        it('refuses a name that already has a rule, whatever its case', () => {
            const existing = [block('ads.example.com'), answer('*.test', '10.0.0.1')];

            ['ADS.example.com', 'ads.example.com.', ' ads.example.com '].forEach((pattern) => {
                const check = checkDnsRuleDraft({ pattern, action: 'block', ipv4: '' }, existing);
                expect(check.rule, pattern).to.equal(undefined);
                expect(check.patternProblem, pattern).to.contain('already in the list');
            });

            // The same name with another action is still the same name
            expect(checkDnsRuleDraft({ pattern: '*.test', action: 'block', ipv4: '' }, existing).patternProblem)
                .to.contain('already in the list');
        });

        it('allows the bare name next to its wildcard', () => {
            const check = checkDnsRuleDraft({ pattern: 'example.com', action: 'block', ipv4: '' }, [block('*.example.com')]);
            expect(check.rule).to.deep.equal(block('example.com'));
        });
    });

    describe('patternCovers', () => {
        it('covers the same pattern, in any spelling', () => {
            expect(patternCovers('example.com', 'EXAMPLE.com.')).to.equal(true);
            expect(patternCovers('*.example.com', '*.example.com')).to.equal(true);
        });

        it('lets a wildcard cover the names and wildcards below it, but not the bare name', () => {
            expect(patternCovers('*.example.com', 'api.example.com')).to.equal(true);
            expect(patternCovers('*.example.com', 'a.b.example.com')).to.equal(true);
            expect(patternCovers('*.example.com', '*.api.example.com')).to.equal(true);
            expect(patternCovers('*.example.com', 'example.com')).to.equal(false);
            expect(patternCovers('*.example.com', 'badexample.com')).to.equal(false);
            expect(patternCovers('*.example.com', '*.com')).to.equal(false);
            expect(patternCovers('*.example.com', 'api.example.org')).to.equal(false);
        });

        it('lets an exact name cover only itself', () => {
            expect(patternCovers('api.example.com', '*.example.com')).to.equal(false);
            expect(patternCovers('api.example.com', 'www.api.example.com')).to.equal(false);
            expect(patternCovers('example.com', 'api.example.com')).to.equal(false);
        });
    });

    describe('findShadowingRule', () => {
        const rules = [
            block('*.example.com'),
            answer('api.example.com', '10.0.0.1'),
            block('example.com'),
            block('other.test')
        ];

        it('finds the earlier rule that already catches the name', () => {
            expect(findShadowingRule(rules, 1)).to.deep.equal(block('*.example.com'));
        });

        it('finds nothing for rules that still fire', () => {
            expect(findShadowingRule(rules, 0)).to.equal(undefined);
            expect(findShadowingRule(rules, 2)).to.equal(undefined);
            expect(findShadowingRule(rules, 3)).to.equal(undefined);
        });

        it('does not look at the rules below, since the first match wins', () => {
            const specificFirst = [answer('api.example.com', '10.0.0.1'), block('*.example.com')];
            expect(findShadowingRule(specificFirst, 0)).to.equal(undefined);
            expect(findShadowingRule(specificFirst, 1)).to.equal(undefined);
        });

        it('copes with an index outside the list', () => {
            expect(findShadowingRule(rules, 9)).to.equal(undefined);
            expect(findShadowingRule([], 0)).to.equal(undefined);
        });
    });

    describe('describeDnsAction', () => {
        it('says what a rule does', () => {
            expect(describeDnsAction(block('a.test'))).to.equal('Block');
            expect(describeDnsAction(answer('a.test', '192.168.0.10'))).to.equal('Answer 192.168.0.10');
        });
    });
});
