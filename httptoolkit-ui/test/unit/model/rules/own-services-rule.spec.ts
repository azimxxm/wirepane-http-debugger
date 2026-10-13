import { matchers } from 'mockttp';

import { expect } from '../../../test-setup';

import { RulesStore } from '../../../../src/model/rules/rules-store';
import {
    buildDefaultGroupRules,
    buildDefaultRulesRoot,
    buildOwnServicesUrlRegex
} from '../../../../src/model/rules/rule-creation';
import { serializeRules, deserializeRules } from '../../../../src/model/rules/rule-serialization';
import { RulePriority } from '../../../../src/model/rules/rules';
import { getAdminServerUrl } from '../../../../src/model/proxy-store';

// Server API, Mockttp admin API, proxy
const PORTS = [45457, 45456, 8123];

describe("The built-in rule for Wirepane's own services", () => {

    const regex = buildOwnServicesUrlRegex(PORTS);

    [
        'http://127.0.0.1:45456/start',
        'http://127.0.0.1:45456/reset',
        'http://127.0.0.1:45456',
        'http://localhost:45457/version',
        'http://LOCALHOST:45456/',
        'http://app.localhost:45456/',
        'http://127.0.0.2:45456/',
        'http://127.255.255.254:45457/',
        'http://0.0.0.0:45457/',
        'http://[::1]:45456/',
        'http://[0:0:0:0:0:0:0:1]:45456/',
        'http://[::]:8123/',
        'http://[::ffff:127.0.0.1]:45456/',
        'http://[::ffff:7f00:1]:45456/',
        'https://127.0.0.1:45457/',
        'ws://127.0.0.1:45456/session/abc/stream',
        'wss://localhost:45456/session/abc/subscription',
        // How Mockttp hands WebSocket URLs to matchers
        'ws//127.0.0.1:45456/session/abc/stream',
        'wss//localhost.:45456/session/abc/stream',
        'http://127.0.0.1:8123/',
        // Other spellings of 127.0.0.1 & 0.0.0.0 that the OS still connects to
        'http://127.1:45456/',
        'http://2130706433:45456/',
        'http://0x7f000001:45456/',
        'http://0177.0.0.1:45456/',
        'http://127.0.0.0x1:45456/',
        'http://0:45456/',
        'http://user@127.0.0.1:45456/',
        'http://127.0.0.1:045456/'
    ].forEach((url) => {
        it(`matches ${url}`, () => {
            expect(regex.test(url)).to.equal(true);
        });
    });

    [
        'http://localhost:3000/',
        'http://127.0.0.1:8080/api',
        'http://127.0.0.1:45458/', // The UI's dev server
        'http://127.0.0.1:454560/',
        'http://127.0.0.1:4545/',
        'http://192.168.1.10:45456/',
        'http://10.0.0.1:45457/',
        'http://example.com:45456/',
        'http://localhost.example.com:45456/',
        'http://127.0.0.1.nip.io:45456/',
        'http://127.0.0.1:45457@example.com/',
        'https://example.com/?next=http://127.0.0.1:45456/',
        'http://[::2]:45456/',
        'http://[fe80::1]:45456/',
        'ws//localhost:3000/socket'
    ].forEach((url) => {
        it(`doesn't match ${url}`, () => {
            expect(regex.test(url)).to.equal(false);
        });
    });

    it("matches like the proxy does, after Mockttp normalizes the URL", () => {
        const matcher = new matchers.RegexUrlMatcher(regex);
        const matches = (url: string) => matcher.matches({ url } as any);

        expect(matches('http://localhost.:45456/start')).to.equal(true);
        expect(matches('HTTP://127.0.0.1:45456/start?x=1')).to.equal(true);
        expect(matches('http://localhost:3000/start')).to.equal(false);
        expect(matches('ws://127.0.0.1:45456/session/abc/stream')).to.equal(true);
        expect(matches('ws://localhost:3000/socket')).to.equal(false);
    });

    describe("in the default rules", () => {
        let store: RulesStore;
        const proxyStore = {
            serverVersion: '1.0.0',
            dnsServers: [],
            httpProxyPort: 8123,
            ruleParameterKeys: []
        };

        beforeEach(() => {
            store = new RulesStore({ featureFlags: [] } as any, proxyStore as any, null as any);
        });

        it("come first, override every other rule and close the connection", () => {
            const [httpRule, wsRule] = buildDefaultGroupRules(store, proxyStore as any) as any[];

            expect(httpRule.id).to.equal('default-block-own-services');
            expect(httpRule.type).to.equal('http');
            expect(httpRule.priority).to.equal(RulePriority.OVERRIDE);
            expect(httpRule.steps.map((s: any) => s.type)).to.deep.equal(['close-connection']);

            expect(wsRule.id).to.equal('default-block-own-services-ws');
            expect(wsRule.type).to.equal('websocket');
            expect(wsRule.priority).to.equal(RulePriority.OVERRIDE);
            expect(wsRule.steps.map((s: any) => s.type)).to.deep.equal(['close-connection']);

            // The admin & server API ports (desktop defaults in tests) and the proxy's own port
            const urlMatcher = new RegExp(httpRule.matchers[1].regexSource, httpRule.matchers[1].regexFlags);
            expect(urlMatcher.test('http://127.0.0.1:45456/start')).to.equal(true);
            expect(urlMatcher.test('http://127.0.0.1:45457/version')).to.equal(true);
            expect(urlMatcher.test('http://127.0.0.1:8123/')).to.equal(true);
            expect(urlMatcher.test('http://127.0.0.1:3000/')).to.equal(false);
        });

        it("still cover the APIs when the proxy port isn't known yet", () => {
            // Like ProxyStore.httpProxyPort, which throws until the proxy has started
            const notRunning = Object.defineProperty({ ...proxyStore }, 'httpProxyPort', {
                get() { throw new Error('Not running'); }
            });
            const [httpRule] = buildDefaultGroupRules(store, notRunning as any) as any[];

            const urlMatcher = new RegExp(httpRule.matchers[1].regexSource, httpRule.matchers[1].regexFlags);
            expect(urlMatcher.test('http://127.0.0.1:45456/start')).to.equal(true);
            expect(urlMatcher.test('http://127.0.0.1:8123/')).to.equal(false);
        });

        it("survive saving and loading the rules", () => {
            const saved = serializeRules(buildDefaultRulesRoot(store, proxyStore as any));
            const loaded = deserializeRules(JSON.parse(JSON.stringify(saved)), { rulesStore: store });

            const [httpRule, wsRule] = (loaded.items[0] as any).items;
            expect(httpRule.id).to.equal('default-block-own-services');
            expect(httpRule.matchers[1].matches({ url: 'http://127.0.0.1:45456/reset' })).to.equal(true);
            expect(wsRule.id).to.equal('default-block-own-services-ws');
            expect(wsRule.steps[0].type).to.equal('close-connection');
        });
    });
});

describe("The admin API URL", () => {
    it("is the plain address without a token", () => {
        expect(getAdminServerUrl(45456, undefined)).to.equal('http://127.0.0.1:45456');
    });

    it("carries the token in front of every path", () => {
        expect(getAdminServerUrl(45456, 'abc_DEF-123')).to.equal('http://127.0.0.1:45456/token/abc_DEF-123');
        expect(getAdminServerUrl(45456, 'a/b c')).to.equal('http://127.0.0.1:45456/token/a%2Fb%20c');
    });
});
