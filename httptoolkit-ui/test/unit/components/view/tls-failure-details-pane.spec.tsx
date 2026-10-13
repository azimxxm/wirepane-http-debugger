import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { Provider } from 'mobx-react';
import { observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import { FailedTlsConnection } from '../../../../src/model/tls/failed-tls-connection';
import { VpnTlsHello } from '../../../../src/model/interception/vpn-network';
import { TlsFailureDetailsPane } from '../../../../src/components/view/tls/tls-failure-details-pane';

const JA4 = 't13d1517h2_8daaf6152771_cb7bf5808d99';
const PINNED_APP_JA4 = 't13d181100_85036bcba153_d41ae481755e';

const STARTED = 1_760_000_000_000;

// The part of the Network page's store that the pane uses
class FakeNetworkStore {
    @observable.shallow tlsHellos: VpnTlsHello[] = [];

    started = 0;
    stopped = 0;

    startPolling() {
        this.started += 1;
        return () => { this.stopped += 1; };
    }
}

const hello = (overrides: Partial<VpnTlsHello> = {}): VpnTlsHello => ({
    peer: 'p1',
    dst: '93.184.216.34:443',
    sni: 'pinned.example.org',
    alpn: [],
    ja4: PINNED_APP_JA4,
    at: STARTED - 20,
    ...overrides
});

// The parts of Mockttp's TLS failure event that the pane reads. Mockttp's events for connections
// through the VPN have no SOCKS tags, which is why `tags` is empty unless a test says otherwise.
const failureEvent = (tags: string[], sniHostname = 'example.com', startTime = 1) => ({
    failureCause: 'closed',
    hostname: sniHostname,
    remoteIpAddress: '::ffff:192.168.1.50',
    remotePort: 51234,
    tags,
    timingEvents: { startTime, connectTimestamp: 2, tunnelTimestamp: 3 },
    tlsMetadata: { sniHostname }
}) as unknown as ConstructorParameters<typeof FailedTlsConnection>[0];

describe('The failed TLS connection pane', () => {

    let container: HTMLDivElement;
    let store: FakeNetworkStore;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
        store = new FakeNetworkStore();
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
    });

    const renderFailure = (event: ReturnType<typeof failureEvent>) => {
        const failure = new FailedTlsConnection(event);
        act(() => {
            ReactDOM.render(
                <Provider vpnNetworkStore={store}>
                    <ThemeProvider theme={lightTheme}>
                        <TlsFailureDetailsPane failure={failure} certPath='/certs/wirepane-ca.pem' />
                    </ThemeProvider>
                </Provider>,
                container
            );
        });
    };

    const render = (tags: string[]) => renderFailure(failureEvent(tags));

    it('shows the JA4 fingerprint when the VPN tunnel tagged the connection with it', () => {
        render(['socket-metadata:wirepane-vpn-peer:p1', `socket-metadata:wirepane-vpn-ja4:${JA4}`]);

        expect(container.textContent).to.contain("The client's TLS fingerprint (JA4) is");
        expect(container.textContent).to.contain(JA4);
    });

    it('says nothing about a fingerprint when the tags have none', () => {
        render(['socket-metadata:wirepane-vpn-peer:p1']);

        expect(container.textContent).to.contain('Failed HTTPS request');
        expect(container.textContent).to.not.contain('fingerprint');
    });

    it('ignores a tag that is not a JA4', () => {
        render(['socket-metadata:wirepane-vpn-ja4:something else']);

        expect(container.textContent).to.not.contain('fingerprint');
    });

    describe('for a connection with no tags, like every failure Mockttp reports', () => {

        it('shows the fingerprint of the hello the VPN reported for that name just before', () => {
            store.tlsHellos.push(
                hello({ sni: 'other.example.org', ja4: JA4 }),
                hello()
            );
            renderFailure(failureEvent([], 'pinned.example.org', STARTED));

            expect(container.textContent).to.contain("The client's TLS fingerprint (JA4) is");
            expect(container.textContent).to.contain(PINNED_APP_JA4);
            expect(container.textContent).to.not.contain(JA4);
        });

        it('prefers the tag when there is one', () => {
            store.tlsHellos.push(hello());
            renderFailure(failureEvent(
                [`socket-metadata:wirepane-vpn-ja4:${JA4}`], 'pinned.example.org', STARTED
            ));

            expect(container.textContent).to.contain(JA4);
            expect(container.textContent).to.not.contain(PINNED_APP_JA4);
        });

        it('says nothing when the hellos are for another name or from another time', () => {
            store.tlsHellos.push(
                hello({ sni: 'other.example.org' }),
                hello({ at: STARTED - 60_000 })
            );
            renderFailure(failureEvent([], 'pinned.example.org', STARTED));

            expect(container.textContent).to.contain('Failed HTTPS request');
            expect(container.textContent).to.not.contain('fingerprint');
        });

        it('shows the fingerprint as soon as the hello arrives', () => {
            renderFailure(failureEvent([], 'pinned.example.org', STARTED));
            expect(container.textContent).to.not.contain('fingerprint');

            act(() => { runInAction(() => { store.tlsHellos.push(hello()); }); });

            expect(container.textContent).to.contain(PINNED_APP_JA4);
        });

        it('has the store read the VPN\'s events while it is open, and only then', () => {
            renderFailure(failureEvent([], 'pinned.example.org', STARTED));
            expect([store.started, store.stopped]).to.deep.equal([1, 0]);

            act(() => { ReactDOM.unmountComponentAtNode(container); });
            expect([store.started, store.stopped]).to.deep.equal([1, 1]);
        });
    });
});
