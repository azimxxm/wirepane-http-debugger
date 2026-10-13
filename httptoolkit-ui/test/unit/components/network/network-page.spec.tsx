import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { Provider } from 'mobx-react';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import { VpnNetworkApi, VpnNetworkStore } from '../../../../src/model/interception/vpn-network';
import { NetworkPage } from '../../../../src/components/network/network-page';

const TAB_IDS = ['dns', 'udp', 'tls', 'conditions', 'capture'];

const metadata = (running: boolean) => ({
    available: true,
    running,
    peers: [],
    settings: { conditions: {}, dnsRules: [], quic: 'block' },
    capture: { running: false },
    capabilities: { quicDecrypt: false, ikev2: false }
});

describe('The Network page', () => {

    let container: HTMLDivElement;
    let store: VpnNetworkStore;
    // What the fake server answers to the next reads of the VPN's metadata
    let readMetadata: () => Promise<unknown>;

    const api: VpnNetworkApi = {
        activate: async () => ({}),
        getMetadata: () => readMetadata(),
        getEvents: async () => ({ seq: 1, events: [] })
    };

    beforeEach(() => {
        container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: 0; top: 0; width: 1100px; height: 800px;';
        document.body.appendChild(container);

        // Polls fast, so the tests don't wait a second for each read
        store = new VpnNetworkStore(api, Date.now, 15);
        readMetadata = async () => metadata(true);
    });

    afterEach(() => {
        // Closing the page also stops its polling
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
    });

    // Long enough for a few polls
    const settle = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 80)); });

    const render = async () => {
        act(() => {
            ReactDOM.render(<ThemeProvider theme={lightTheme}>
                <Provider vpnNetworkStore={store}><NetworkPage /></Provider>
            </ThemeProvider>, container);
        });
        await settle();
    };

    const text = () => container.textContent ?? '';
    const notRunningNotice = () => container.querySelector('[role="status"]');
    const errorNotice = () => container.querySelector('[role="alert"]');
    const tab = (id: string) => container.querySelector(`#network-tab-${id}`) as HTMLElement;
    const selectedTab = () => container.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;

    const press = (target: HTMLElement, key: string) => act(() => {
        target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
    });

    describe("the notice that the VPN isn't running", () => {

        it('is shown when the server says the VPN is off', async () => {
            readMetadata = async () => metadata(false);
            await render();

            expect(text()).to.contain("The VPN isn't running");
            expect(errorNotice()).to.equal(null);
        });

        it('is not shown while the VPN runs', async () => {
            await render();

            expect(notRunningNotice()).to.equal(null);
            expect(errorNotice()).to.equal(null);
        });

        it("is not shown before the server has answered, as the VPN may well be running", async () => {
            readMetadata = () => new Promise<unknown>(() => {}); // never answers
            await render();

            expect(text()).not.to.contain("isn't running");
            expect(errorNotice()).to.equal(null);
        });

        it("is not shown when the server could not be read: that says nothing about the VPN, so the error is", async () => {
            readMetadata = async () => { throw new Error('API error during GET /metadata: unexpected 500 -'); };
            await render();

            expect(text()).not.to.contain("isn't running");
            expect(text()).to.contain("Couldn't read the VPN's network data");
            // The server's own words are for the tooltip
            expect(errorNotice()!.querySelector('p')!.title).to.contain('unexpected 500');
            expect(text()).not.to.contain('unexpected 500');
        });

        it('comes back with what the server says once it can be read again', async () => {
            readMetadata = async () => { throw new Error('offline'); };
            await render();
            expect(errorNotice()).to.not.equal(null);

            readMetadata = async () => metadata(false);
            await settle();

            expect(errorNotice()).to.equal(null);
            expect(text()).to.contain("The VPN isn't running");
        });

        it('does not take back that the VPN is running when a later read fails', async () => {
            await render();
            readMetadata = async () => { throw new Error('offline'); };
            // Reads of a running VPN's metadata come every few polls
            await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 200)); });

            expect(errorNotice()).to.not.equal(null);
            expect(text()).not.to.contain("isn't running");
        });
    });

    describe('the tab bar', () => {

        it('starts on DNS, and Home and End go to the first and last tab', async () => {
            await render();
            expect(selectedTab().id).to.equal('network-tab-dns');

            press(tab('dns'), 'End');
            expect(selectedTab().id).to.equal('network-tab-capture');
            expect(document.activeElement).to.equal(tab('capture'));

            press(tab('capture'), 'Home');
            expect(selectedTab().id).to.equal('network-tab-dns');
            expect(document.activeElement).to.equal(tab('dns'));

            // From the middle too
            press(tab('dns'), 'ArrowRight');
            press(tab('udp'), 'ArrowRight');
            press(tab('tls'), 'End');
            expect(selectedTab().id).to.equal('network-tab-capture');
        });

        it('still moves with the arrow keys, around the ends, and ignores other keys', async () => {
            await render();

            press(tab('dns'), 'ArrowLeft');
            expect(selectedTab().id).to.equal('network-tab-capture');
            press(tab('capture'), 'ArrowRight');
            expect(selectedTab().id).to.equal('network-tab-dns');

            press(tab('dns'), 'a');
            press(tab('dns'), 'PageDown');
            expect(selectedTab().id).to.equal('network-tab-dns');
        });

        it('only points aria-controls at a panel that is on the page', async () => {
            await render();

            for (const id of TAB_IDS) {
                const controls = tab(id).getAttribute('aria-controls');
                if (id === 'dns') {
                    expect(controls).to.equal('network-panel-dns');
                    expect(container.querySelector(`#${controls}`)).to.not.equal(null);
                } else {
                    expect(controls, `the ${id} tab`).to.equal(null);
                }
            }

            // The selected tab's panel comes with it
            press(tab('dns'), 'End');
            expect(tab('capture').getAttribute('aria-controls')).to.equal('network-panel-capture');
            expect(container.querySelector('#network-panel-capture')).to.not.equal(null);
            expect(tab('dns').hasAttribute('aria-controls')).to.equal(false);
        });
    });
});
