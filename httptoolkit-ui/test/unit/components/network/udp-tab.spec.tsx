import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme, darkTheme, Theme } from '../../../../src/styles';
import {
    DEFAULT_VPN_SETTINGS,
    VpnNetworkStore,
    VpnSettings,
    VpnUdpFlow
} from '../../../../src/model/interception/vpn-network';
import { UdpTab } from '../../../../src/components/network/udp-tab';

// The parts of the Network page's store that the UDP tab uses
class FakeNetworkStore {
    @observable.shallow udpFlows: VpnUdpFlow[] = [];
    @observable.ref settings: VpnSettings = DEFAULT_VPN_SETTINGS;
    // What the polling store knows about the helper: it can't decrypt HTTP/3 by default
    @observable.ref capabilities = { quicDecrypt: false, ikev2: false };
    @observable running = true;

    saved: Array<Partial<VpnSettings>> = [];
    saveError: Error | undefined;

    async configure(patch: Partial<VpnSettings>) {
        this.saved.push(patch);
        if (this.saveError) throw this.saveError;
        runInAction(() => { this.settings = { ...this.settings, ...patch }; });
    }
}

const flow = (id: string, overrides: Partial<VpnUdpFlow> = {}): VpnUdpFlow => ({
    flow: id,
    peer: 'p1',
    src: '10.73.0.2:40003',
    dst: '1.2.3.4:5000',
    bytesUp: 0,
    bytesDown: 0,
    packetsUp: 0,
    packetsDown: 0,
    openedAt: 1_000,
    ...overrides
});

// A game that ended, a call that is still going, and a QUIC flow Wirepane refused
const GAME = flow('1', {
    dst: '35.186.224.25:3074',
    name: 'game.example.com',
    bytesUp: 1_400,
    bytesDown: 52_000,
    packetsUp: 12,
    packetsDown: 1,
    openedAt: 10_000,
    closedAt: 72_000
});
const CALL = flow('2', {
    peer: 'p2',
    dst: '203.0.113.9:3478',
    bytesUp: 800,
    bytesDown: 700,
    packetsUp: 4,
    packetsDown: 3,
    openedAt: 20_000
});
const BLOCKED_QUIC = flow('3', {
    dst: '142.250.74.46:443',
    openedAt: 30_000,
    closedAt: 30_000,
    quic: 'blocked'
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// What the server says about the devices, for their names
const METADATA = {
    available: true,
    running: true,
    peers: [{ peer: 'p1', name: 'iPhone' }, { peer: 'p2', name: 'iPad' }]
};

describe('UDP tab', () => {

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

    // Waits for the answers of the fake server
    const settle = () => act(async () => { await sleep(0); await sleep(0); });

    const render = async (
        metadata: unknown = METADATA,
        theme: Theme = lightTheme
    ) => {
        // One loader for the whole test: the tab reads it again when it gets another one
        const loadMetadata = async () => metadata;
        const element = <ThemeProvider theme={theme}>
            <UdpTab store={store as unknown as VpnNetworkStore} loadMetadata={loadMetadata} />
        </ThemeProvider>;

        act(() => { ReactDOM.render(element, container); });
        await settle();
    };

    const radio = (mode: string) =>
        container.querySelector(`#udp-quic-mode-${mode}`) as HTMLInputElement;
    const rows = () => Array.from(container.querySelectorAll('tbody tr'));
    const cells = (row: Element) => Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent);
    const rowCells = () => rows().map(cells);
    const sortButton = (label: string) =>
        Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label) as HTMLButtonElement;

    describe('without flows', () => {

        it('says there is no UDP traffic yet, and has no table', async () => {
            await render();

            expect(container.textContent).to.contain('No UDP traffic yet');
            expect(container.querySelector('table')).to.equal(null);
            expect(container.querySelector('[aria-label="Sort the flows"]')).to.equal(null);
        });

        it('still shows the QUIC mode', async () => {
            await render();

            expect(container.querySelectorAll('input[type="radio"]').length).to.equal(3);
        });
    });

    describe('the QUIC mode', () => {

        it('offers Block, Let through and Decrypt (beta), with Block recommended', async () => {
            await render();

            const labels = Array.from(container.querySelectorAll('label')).map((label) => label.textContent);
            expect(labels[0]).to.contain('Block (recommended: apps fall back to HTTPS Wirepane can read)');
            expect(labels[1]).to.contain('Let through');
            expect(labels[2]).to.contain('Decrypt (beta)');
        });

        it('shows the saved mode', async () => {
            store.settings = { ...DEFAULT_VPN_SETTINGS, quic: 'relay' };
            await render();

            expect(radio('block').checked).to.equal(false);
            expect(radio('relay').checked).to.equal(true);
        });

        it('saves a new choice through configure({ quic })', async () => {
            await render();
            expect(radio('block').checked).to.equal(true);

            await act(async () => { radio('relay').click(); });
            await settle();

            expect(store.saved).to.deep.equal([{ quic: 'relay' }]);
            expect(radio('relay').checked).to.equal(true);
            expect(radio('block').checked).to.equal(false);
        });

        it('says so, and goes back to the saved mode, when saving fails', async () => {
            store.saveError = new Error('The VPN is not running');
            await render();

            await act(async () => { radio('relay').click(); });
            await settle();

            const alert = container.querySelector('[role="alert"]')!;
            expect(alert.textContent).to.contain("Couldn't save the QUIC mode");
            expect(alert.textContent).to.contain('The VPN is not running');
            expect(radio('block').checked).to.equal(true);
        });

        it('disables Decrypt with a reason when this build cannot decrypt', async () => {
            await render();

            expect(radio('decrypt').disabled).to.equal(true);
            expect(radio('block').disabled).to.equal(false);
            expect(radio('relay').disabled).to.equal(false);
            expect(container.textContent).to.contain("This build's VPN helper can't decrypt HTTP/3 yet.");

            await act(async () => { radio('decrypt').click(); });
            expect(store.saved).to.deep.equal([]);
        });

        it('tells the user to start the VPN when no helper is running to ask', async () => {
            runInAction(() => { store.running = false; });
            await render();

            expect(radio('decrypt').disabled).to.equal(true);
            expect(container.textContent).to.contain('Start the VPN to check');
            expect(container.textContent).not.to.contain("can't decrypt HTTP/3 yet");
        });

        it('lets Decrypt be chosen when capabilities.quicDecrypt is true', async () => {
            runInAction(() => { store.capabilities = { quicDecrypt: true, ikev2: false }; });
            await render();

            expect(radio('decrypt').disabled).to.equal(false);
            expect(container.textContent).not.to.contain("can't decrypt HTTP/3");

            await act(async () => { radio('decrypt').click(); });
            await settle();

            expect(store.saved).to.deep.equal([{ quic: 'decrypt' }]);
            expect(radio('decrypt').checked).to.equal(true);
        });
    });

    describe('with flows', () => {

        beforeEach(() => {
            runInAction(() => { store.udpFlows = [GAME, CALL, BLOCKED_QUIC]; });
        });

        it('shows a row per flow, newest first', async () => {
            await render();

            expect(rows().length).to.equal(3);
            expect(rowCells().map((row) => row[1])).to.deep.equal([
                '142.250.74.46:443',
                '203.0.113.9:3478',
                '35.186.224.25:3074'
            ]);
        });

        it('names the device of each flow', async () => {
            await render();

            expect(rowCells().map((row) => row[0])).to.deep.equal(['iPhone', 'iPad', 'iPhone']);
        });

        it('cuts a long device name, destination and DNS name short, with the whole text in a tooltip', async () => {
            const longName = `${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.example.com`;
            const longDestination = '[2001:db8:1234:5678:9abc:def0:1234:5678]:443';
            const longDevice = 'Pixel 8 Pro with a really long device name that keeps going and going';
            runInAction(() => {
                store.udpFlows = [flow('9', { peer: 'p9', dst: longDestination, name: longName })];
            });
            await render({ available: true, running: true, peers: [{ peer: 'p9', name: longDevice }] });

            const [device, destination, name] = Array.from(rows()[0].querySelectorAll('td'));
            for (const [cell, fullText] of [[device, longDevice], [destination, longDestination], [name, longName]] as const) {
                const clipped = cell.firstElementChild as HTMLElement;
                expect(clipped.title).to.contain(fullText);
                expect(getComputedStyle(clipped).textOverflow).to.equal('ellipsis');
                expect(getComputedStyle(clipped).overflow).to.equal('hidden');
                expect(clipped.scrollWidth, 'it was cut').to.be.greaterThan(clipped.clientWidth);
                // Not hundreds of pixels wide (the longest limit is 240)
                expect(clipped.getBoundingClientRect().width).to.be.at.most(240);
            }
            // So the row keeps its height instead of wrapping the long names over many lines
            expect(rows()[0].getBoundingClientRect().height).to.be.lessThan(80);

            // The device cell's tooltip keeps what it said before: where the flow came from
            expect((device.firstElementChild as HTMLElement).title).to.equal(`${longDevice} (10.73.0.2:40003)`);
        });

        it('shows the DNS name, packets and bytes both ways, and how long it lasted', async () => {
            await render();

            // The game: closed after 62 s
            const game = rowCells()[2];
            expect(game[2]).to.equal('game.example.com');
            expect(game[3]).to.equal('1.4 kB12 packets');
            expect(game[4]).to.equal('52 kB1 packet');
            expect(game[5]).to.equal('1 min 2 s');
            expect(game[6]).to.equal('Closed');
        });

        it('shows a flow that is still going as open', async () => {
            await render();

            const call = rowCells()[1];
            expect(call[6]).to.equal('Open');
            expect(call[5]).to.match(/^\d+ (ms|s|min|h)/);
        });

        it('marks QUIC: blocked here, nothing on other UDP', async () => {
            await render();

            const blocked = rows()[0];
            const badge = blocked.querySelector('td:last-child span')!;
            expect(badge.textContent).to.equal('Blocked');
            expect(badge.getAttribute('title')).to.contain('falls back to HTTPS');
            // A blocked flow never connected: no counts, no duration, no open or closed
            expect(cells(blocked).slice(3, 7)).to.deep.equal(['-', '-', '-', '-']);

            expect(cells(rows()[2])[7]).to.equal('-');
        });

        it('marks QUIC that was let through and QUIC that was decrypted', async () => {
            runInAction(() => {
                store.udpFlows = [
                    flow('4', { quic: 'relayed', openedAt: 1_000 }),
                    flow('5', { quic: 'decrypted', openedAt: 2_000, closedAt: 3_000 })
                ];
            });
            await render();

            expect(rowCells().map((row) => row[7])).to.deep.equal(['Decrypted', 'Let through']);
        });

        it('summarises the flows', async () => {
            await render();

            expect(container.textContent).to.contain('3 flows, 1 open');
            expect(container.textContent).to.contain('1 QUIC blocked');
        });

        it('sorts by bytes when asked', async () => {
            await render();
            expect(sortButton('Newest first').getAttribute('aria-pressed')).to.equal('true');

            await act(async () => { sortButton('Most data first').click(); });

            expect(sortButton('Most data first').getAttribute('aria-pressed')).to.equal('true');
            expect(sortButton('Newest first').getAttribute('aria-pressed')).to.equal('false');
            expect(rowCells().map((row) => row[1])).to.deep.equal([
                '35.186.224.25:3074', // 53.4 kB
                '203.0.113.9:3478', // 1.5 kB
                '142.250.74.46:443' // nothing
            ]);
        });

        it('shows flows that arrive after it opened', async () => {
            await render();
            expect(rows().length).to.equal(3);

            await act(async () => {
                runInAction(() => { store.udpFlows = [...store.udpFlows, flow('9', { dst: '9.9.9.9:53000', openedAt: 99_000 })]; });
            });

            expect(rows().length).to.equal(4);
            expect(rowCells()[0][1]).to.equal('9.9.9.9:53000');
        });

        it('falls back to a plain name until the server answers about the device', async () => {
            const answer = { resolve: (_metadata: unknown) => {} };
            const loadMetadata = () => new Promise<unknown>((resolve) => { answer.resolve = resolve; });
            act(() => {
                ReactDOM.render(<ThemeProvider theme={lightTheme}>
                    <UdpTab store={store as unknown as VpnNetworkStore} loadMetadata={loadMetadata} />
                </ThemeProvider>, container);
            });
            await settle();

            // Not called removed while the server is still being asked
            expect(rowCells()[0][0]).to.equal('VPN device');

            answer.resolve(METADATA);
            await settle();
            expect(rowCells()[0][0]).to.equal('iPhone');
        });

        it('calls a device the server does not know any more a removed device, with its id', async () => {
            await render({ available: true, running: true, peers: [{ peer: 'p2', name: 'iPad' }] });

            expect(rowCells().map((row) => row[0])).to.deep.equal([
                'Removed device (p1)',
                'iPad',
                'Removed device (p1)'
            ]);
        });

        it('enables Decrypt when the helper reports it after the tab opened', async () => {
            await render();
            expect(radio('decrypt').disabled).to.equal(true);

            await act(async () => {
                runInAction(() => { store.capabilities = { quicDecrypt: true, ikev2: false }; });
            });

            expect(radio('decrypt').disabled).to.equal(false);
        });

        it('has a table with column headers, for screen readers', async () => {
            await render();

            const headers = Array.from(container.querySelectorAll('th')).map((th) => th.textContent);
            expect(headers).to.deep.equal([
                'Device', 'Destination', 'Name', 'Sent', 'Received', 'Duration', 'Status', 'QUIC'
            ]);
        });
    });

    describe('in both themes', () => {

        [['light', lightTheme], ['dark', darkTheme]].forEach(([name, theme]) => {
            it(`draws the empty tab and a full one in the ${name} theme`, async () => {
                await render(METADATA, theme as Theme);
                expect(container.textContent).to.contain('No UDP traffic yet');

                await act(async () => {
                    runInAction(() => { store.udpFlows = [GAME, CALL, BLOCKED_QUIC]; });
                });
                expect(rows().length).to.equal(3);
            });
        });
    });
});
