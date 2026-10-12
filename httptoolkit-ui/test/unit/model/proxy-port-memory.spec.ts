import { expect } from '../../test-setup';

import {
    forgetProxySessionId,
    getPreferredProxyPort,
    getSessionIdFromUrl,
    parseRememberedPort,
    parseRememberedSession,
    readLastProxyPort,
    readWindowProxySession,
    rememberProxySession
} from '../../../src/model/proxy-port-memory';

describe('Proxy port memory', () => {

    describe('picking the port to ask for', () => {
        it("prefers this window's previous port", () => {
            expect(getPreferredProxyPort([9476, 9473], undefined)).to.equal(9476);
        });

        it("falls back to the app's last port for a new window", () => {
            expect(getPreferredProxyPort([undefined, 9474], undefined)).to.equal(9474);
        });

        it('asks for nothing when no port is remembered', () => {
            expect(getPreferredProxyPort([undefined, undefined], undefined)).to.equal(undefined);
        });

        it('skips ports outside the default range when no range is set', () => {
            // E.g. left over from an old custom range that has since been reset
            expect(getPreferredProxyPort([7000, 9475], undefined)).to.equal(9475);
            expect(getPreferredProxyPort([7000], undefined)).to.equal(undefined);
        });

        it("drops ports from before Wirepane's own default range", () => {
            // Older versions started at 8000, the port many dev servers default to
            expect(getPreferredProxyPort([8000, 8040], undefined)).to.equal(undefined);
            expect(getPreferredProxyPort([8000, 9473], undefined)).to.equal(9473);
        });

        it('only uses remembered ports inside the configured range', () => {
            const range = { startPort: 9000, endPort: 9010 };
            expect(getPreferredProxyPort([8000, 9005], range)).to.equal(9005);
            expect(getPreferredProxyPort([8000, 9011], range)).to.equal(undefined);
        });

        it('ignores values that are not ports', () => {
            expect(getPreferredProxyPort([NaN, 0, 70000, 9473.5, 9477], undefined)).to.equal(9477);
        });
    });

    describe('parsing stored values', () => {
        it('reads a stored session', () => {
            expect(parseRememberedSession('{"port":8000,"id":"3f2b-41aa"}'))
                .to.deep.equal({ port: 8000, id: '3f2b-41aa' });
        });

        it('treats missing or broken data as nothing remembered', () => {
            expect(parseRememberedSession(null)).to.deep.equal({});
            expect(parseRememberedSession('not json')).to.deep.equal({});
            expect(parseRememberedSession('{"port":"8000","id":"../../reset"}'))
                .to.deep.equal({ port: undefined, id: undefined });
        });

        it('reads a stored port', () => {
            expect(parseRememberedPort('8005')).to.equal(8005);
            expect(parseRememberedPort('nope')).to.equal(undefined);
            expect(parseRememberedPort(null)).to.equal(undefined);
        });

        it("gets the session id from the admin client's session URL", () => {
            expect(getSessionIdFromUrl('http://127.0.0.1:45456/session/0d4e-77ab'))
                .to.equal('0d4e-77ab');
            expect(getSessionIdFromUrl('http://127.0.0.1:45456/')).to.equal(undefined);
            expect(getSessionIdFromUrl(undefined)).to.equal(undefined);
        });
    });

    describe('storage', () => {
        let storedSession: string | null;
        let storedPort: string | null;

        beforeEach(() => {
            storedSession = sessionStorage.getItem('wirepane:proxy-session');
            storedPort = localStorage.getItem('wirepane:last-proxy-port');
        });

        afterEach(() => {
            const restore = (storage: Storage, key: string, value: string | null) =>
                value === null ? storage.removeItem(key) : storage.setItem(key, value);
            restore(sessionStorage, 'wirepane:proxy-session', storedSession);
            restore(localStorage, 'wirepane:last-proxy-port', storedPort);
        });

        it('remembers the session for this window and the port for next time', () => {
            rememberProxySession({ port: 8007, id: 'abc-123' });

            expect(readWindowProxySession()).to.deep.equal({ port: 8007, id: 'abc-123' });
            expect(readLastProxyPort()).to.equal(8007);
        });

        it('keeps only the port once the page stops its own session', () => {
            rememberProxySession({ port: 8007, id: 'abc-123' });
            forgetProxySessionId();

            expect(readWindowProxySession()).to.deep.equal({ port: 8007, id: undefined });
            expect(readLastProxyPort()).to.equal(8007);
        });
    });
});
