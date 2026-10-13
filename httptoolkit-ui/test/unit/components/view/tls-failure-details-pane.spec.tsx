import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import { FailedTlsConnection } from '../../../../src/model/tls/failed-tls-connection';
import { TlsFailureDetailsPane } from '../../../../src/components/view/tls/tls-failure-details-pane';

const JA4 = 't13d1517h2_8daaf6152771_cb7bf5808d99';

// The parts of Mockttp's TLS failure event that the pane reads
const failureWithTags = (tags: string[]) => ({
    failureCause: 'closed',
    hostname: 'example.com',
    remoteIpAddress: '::ffff:192.168.1.50',
    remotePort: 51234,
    tags,
    timingEvents: { startTime: 1, connectTimestamp: 2, tunnelTimestamp: 3 },
    tlsMetadata: { sniHostname: 'example.com' }
}) as unknown as ConstructorParameters<typeof FailedTlsConnection>[0];

describe('The failed TLS connection pane', () => {

    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
    });

    const render = (tags: string[]) => {
        const failure = new FailedTlsConnection(failureWithTags(tags));
        act(() => {
            ReactDOM.render(
                <ThemeProvider theme={lightTheme}>
                    <TlsFailureDetailsPane failure={failure} certPath='/certs/wirepane-ca.pem' />
                </ThemeProvider>,
                container
            );
        });
    };

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
});
