import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme, darkTheme, Theme } from '../../../../src/styles';
import { VpnNetworkStore, VpnTlsHello } from '../../../../src/model/interception/vpn-network';
import { TlsTab } from '../../../../src/components/network/tls-tab';

// The part of the Network page's store that the TLS tab uses
class FakeNetworkStore {
    @observable.shallow tlsHellos: VpnTlsHello[] = [];
}

const CHROME = 't13d1516h2_8daaf6152771_02713d6af862';
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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const METADATA = {
    available: true,
    running: true,
    peers: [{ peer: 'p1', name: 'iPhone' }, { peer: 'p2', name: 'iPad' }]
};

describe('TLS tab', () => {

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

    // Waits for the answer of the fake server
    const settle = () => act(async () => { await sleep(0); await sleep(0); });

    const render = async (theme: Theme = lightTheme) => {
        const loadMetadata = async () => METADATA;
        const element = <ThemeProvider theme={theme}>
            <TlsTab store={store as unknown as VpnNetworkStore} loadMetadata={loadMetadata} />
        </ThemeProvider>;

        act(() => { ReactDOM.render(element, container); });
        await settle();
    };

    const cards = () => Array.from(container.querySelectorAll('ul > li'));
    const fact = (card: Element, label: string) => {
        const term = Array.from(card.querySelectorAll('dt')).find((dt) => dt.textContent === label)!;
        return term.nextElementSibling!.textContent;
    };

    it('explains what it is for while there are no handshakes', async () => {
        await render();

        expect(container.textContent).to.contain('TLS fingerprints (JA4)');
        expect(container.textContent).to.contain('No TLS handshakes yet.');
        expect(container.textContent).to.contain('pin their certificates');
        expect(cards()).to.have.length(0);
    });

    it('shows one card per fingerprint, the most common first', async () => {
        store.tlsHellos = [
            hello(CURL, { at: 3_000 }), hello(CHROME), hello(CHROME), hello(PYTHON, { at: 2_000 }), hello(CHROME)
        ];
        await render();

        const ja4s = cards().map((card) => card.querySelector('span')!.textContent);
        expect(ja4s).to.deep.equal([CHROME, CURL, PYTHON]);
        expect(container.textContent).to.contain('5 handshakes from 3 fingerprints');
    });

    it('says what a fingerprint stands for, and how many handshakes it had', async () => {
        store.tlsHellos = [hello(CHROME), hello(CHROME)];
        await render();

        const [card] = cards();
        expect(card.textContent).to.contain('2 handshakes');
        expect(card.textContent).to.contain('TLS 1.3 · 15 cipher suites · 16 extensions · HTTP/2');
    });

    it('lists the names with their counts, and hellos that had no name', async () => {
        store.tlsHellos = [
            hello(PYTHON, { sni: 'api.example.net' }),
            hello(PYTHON, { sni: 'api.example.net' }),
            hello(PYTHON, { sni: 'cdn.example.net' }),
            hello(PYTHON, { sni: undefined })
        ];
        await render();

        const [card] = cards();
        const names = fact(card, 'Names')!;
        expect(names).to.contain('api.example.net2');
        expect(names).to.contain('cdn.example.net1');
        expect(names).to.contain('no name1');
    });

    it('shows the devices by the names the server gave them', async () => {
        store.tlsHellos = [
            hello(CHROME, { peer: 'p1' }),
            hello(CHROME, { peer: 'p2' }),
            hello(CHROME, { peer: 'p2' })
        ];
        await render();

        const devices = fact(cards()[0], 'Devices')!;
        expect(devices).to.contain('iPad2');
        expect(devices).to.contain('iPhone1');
    });

    it('cuts a long list of names short, and shows the rest on request', async () => {
        store.tlsHellos = Array.from({ length: 9 }, (_, i) => hello(CHROME, { sni: `host${i}.example.com` }));
        await render();

        const names = () => Array.from(cards()[0].querySelectorAll('dd')[0].querySelectorAll('span'))
            .filter((chip) => chip.textContent!.includes('.example.com')).length;
        expect(names()).to.equal(6);

        const showMore = Array.from(container.querySelectorAll('button'))
            .find((button) => button.textContent!.includes('3 more')) as HTMLButtonElement;
        expect(showMore).to.not.equal(undefined);

        act(() => { showMore.click(); });

        expect(names()).to.equal(9);
        expect(container.textContent).to.not.contain('more');
    });

    it('follows the store as new handshakes come in', async () => {
        await render();
        expect(cards()).to.have.length(0);

        await act(async () => {
            runInAction(() => { store.tlsHellos = [hello(CHROME)]; });
        });
        expect(cards()).to.have.length(1);
        expect(container.textContent).to.contain('1 handshake from 1 fingerprint');

        await act(async () => {
            runInAction(() => { store.tlsHellos = [...store.tlsHellos, hello(CURL), hello(CURL)]; });
        });
        expect(cards()).to.have.length(2);
        expect(cards()[0].querySelector('span')!.textContent).to.equal(CURL);
        expect(container.textContent).to.contain('3 handshakes from 2 fingerprints');
    });

    it('renders in the dark theme too', async () => {
        store.tlsHellos = [hello(CHROME)];
        await render(darkTheme);

        expect(cards()).to.have.length(1);
    });
});
