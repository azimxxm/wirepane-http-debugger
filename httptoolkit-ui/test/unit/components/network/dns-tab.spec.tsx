import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import { VpnDnsQuery, VpnNetworkStore } from '../../../../src/model/interception/vpn-network';
import { DnsTab } from '../../../../src/components/network/dns-tab';

const query = (overrides: Partial<VpnDnsQuery> = {}): VpnDnsQuery => ({
    peer: 'p1',
    name: 'api.example.com',
    qtype: 'A',
    rcode: 'NOERROR',
    answers: ['93.184.216.34'],
    ms: 12,
    at: 1_000,
    ...overrides
});

describe('The DNS tab', () => {

    let container: HTMLDivElement;
    let store: VpnNetworkStore;

    beforeEach(() => {
        // A real size: the list measures the space it is given
        container = document.createElement('div');
        container.style.cssText = 'position: absolute; left: 0; top: 0; width: 1000px; height: 700px;';
        document.body.appendChild(container);

        store = new VpnNetworkStore();
        // Names from the stats, so the tab doesn't ask the server for them
        runInAction(() => {
            store.stats = { peers: [{ peer: 'p1', name: 'iPhone' }, { peer: 'p2', name: 'iPad' }] };
        });
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
    });

    const setQueries = (queries: VpnDnsQuery[]) => act(() => {
        runInAction(() => { store.dnsQueries = queries; });
    });

    const render = () => act(() => {
        ReactDOM.render(<ThemeProvider theme={lightTheme}><DnsTab store={store} /></ThemeProvider>, container);
    });

    const bodyRows = () => Array.from(container.querySelectorAll('[role="row"][aria-rowindex]'))
        .filter((row) => row.getAttribute('aria-rowindex') !== '1')
        .map((row) => Array.from(row.querySelectorAll('[role="cell"]')).map((cell) => cell.textContent));

    // The rules editor above the list has its own inputs, so these look for the tab's own by label
    const searchBox = () => container.querySelector(
        'input[aria-label="Search DNS queries by name or address"]'
    ) as HTMLInputElement;
    const deviceSelect = () => container.querySelector('select[aria-label="Show queries from"]') as HTMLSelectElement;
    // The counts are the paragraph in the toolbar, next to the search box
    const counts = () => searchBox().parentElement!.parentElement!.querySelector('p')!.textContent;

    const typeSearch = (value: string) => act(() => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setValue.call(searchBox(), value);
        searchBox().dispatchEvent(new Event('input', { bubbles: true }));
    });

    const pickDevice = (peer: string) => act(() => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
        setValue.call(deviceSelect(), peer);
        deviceSelect().dispatchEvent(new Event('change', { bubbles: true }));
    });

    const clickButton = (label: string) => act(() => {
        const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === label);
        if (!button) throw new Error(`No button called ${label}`);
        button.click();
    });

    it('tells the person to start VPN capture when nothing was captured', () => {
        render();

        expect(container.textContent).to.contain('No DNS queries yet');
        expect(container.textContent).to.contain('Start VPN capture');
        expect(Array.from(container.querySelectorAll('button')).map((b) => b.textContent))
            .to.include('Open the iPhone page');
        expect(counts()).to.equal('0 queries');
    });

    it('lists the queries newest first, with the device name, answers, time and counts', () => {
        setQueries([
            query({ at: 1_000, name: 'old.example.com', answers: ['1.1.1.1'], ms: 3 }),
            query({ at: 2_000, name: 'new.example.com', peer: 'p2', answers: ['2.2.2.2', '3.3.3.3'], ms: 250 }),
            query({ at: 3_000, name: 'missing.example.com', answers: [], rcode: 'NXDOMAIN', ms: 1500 })
        ]);
        render();

        const rows = bodyRows();
        expect(rows).to.have.length(3);
        expect(rows.map((cells) => cells[2])).to.deep.equal(['missing.example.com', 'new.example.com', 'old.example.com']);
        // Device, type, answers and how long it took
        expect(rows[0].slice(1)).to.deep.equal(['iPhone', 'missing.example.com', 'A', 'NXDOMAIN', '1.5 s', '']);
        expect(rows[1].slice(1)).to.deep.equal(['iPad', 'new.example.com', 'A', '2.2.2.2, 3.3.3.3', '250 ms', '']);
        expect(counts()).to.equal('3 queries · 1 failed');
    });

    it('marks the queries a rule blocked or answered', () => {
        setQueries([
            query({ name: 'ads.test', rule: 'blocked', rcode: 'NXDOMAIN', answers: [], ms: 0, at: 1 }),
            query({ name: 'api.test', rule: 'answered', answers: ['192.168.0.10'], ms: 0, at: 2 })
        ]);
        render();

        const rows = bodyRows();
        expect(rows[0][6]).to.equal('Answered');
        expect(rows[1][6]).to.equal('Blocked');
        expect(counts()).to.equal('2 queries · 1 blocked · 1 answered by a rule');
    });

    it('searches by name (and by answer), and clears the search again', () => {
        setQueries([
            query({ at: 1, name: 'api.example.com' }),
            query({ at: 2, name: 'cdn.example.org', answers: ['10.0.0.7'] }),
            query({ at: 3, name: 'tracker.test' })
        ]);
        render();

        typeSearch('EXAMPLE');
        expect(bodyRows().map((cells) => cells[2])).to.deep.equal(['cdn.example.org', 'api.example.com']);
        expect(counts()).to.equal('2 of 3 queries');

        typeSearch('10.0.0');
        expect(bodyRows().map((cells) => cells[2])).to.deep.equal(['cdn.example.org']);

        typeSearch('nothing-like-this');
        expect(bodyRows()).to.deep.equal([]);
        expect(container.textContent).to.contain('No queries match');
        expect(container.textContent).to.contain('nothing-like-this');

        clickButton('Clear filters');
        expect(bodyRows()).to.have.length(3);
        expect(searchBox().value).to.equal('');
        expect(counts()).to.equal('3 queries');
    });

    it('shows one device at a time, with a count for each in the list of devices', () => {
        setQueries([
            query({ at: 1, peer: 'p1', name: 'a.test' }),
            query({ at: 2, peer: 'p2', name: 'b.test' }),
            query({ at: 3, peer: 'p1', name: 'c.test' })
        ]);
        render();

        expect(Array.from(deviceSelect().options).map((option) => option.textContent))
            .to.deep.equal(['All devices', 'iPad (1)', 'iPhone (2)']);

        pickDevice('p1');
        expect(bodyRows().map((cells) => cells[2])).to.deep.equal(['c.test', 'a.test']);
        expect(counts()).to.equal('2 of 3 queries');

        pickDevice('p2');
        expect(bodyRows().map((cells) => cells[2])).to.deep.equal(['b.test']);
    });

    it('shows new queries as they arrive, at the top', () => {
        setQueries([query({ at: 1, name: 'first.test' })]);
        render();
        expect(bodyRows().map((cells) => cells[2])).to.deep.equal(['first.test']);

        setQueries([query({ at: 1, name: 'first.test' }), query({ at: 2, name: 'second.test' })]);
        expect(bodyRows().map((cells) => cells[2])).to.deep.equal(['second.test', 'first.test']);
    });

    describe('naming the devices', () => {

        const settle = () => act(async () => {
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
        });

        // The tab asks the server about devices that the stats don't name
        const renderWithServer = (loadMetadata: () => Promise<unknown>) => act(() => {
            ReactDOM.render(<ThemeProvider theme={lightTheme}>
                <DnsTab store={store} loadMetadata={loadMetadata} />
            </ThemeProvider>, container);
        });

        it('calls a device the server does not know any more a removed device, in the rows and in the list of devices', async () => {
            setQueries([
                query({ at: 1, peer: 'p1', name: 'a.test' }),
                query({ at: 2, peer: 'p9', name: 'b.test' }),
                query({ at: 3, peer: 'p10', name: 'c.test' })
            ]);
            // p1 is named by the stats; p9 and p10 are neither in the stats nor in the server's list
            renderWithServer(async () => ({ available: true, running: true, peers: [{ peer: 'p1', name: 'iPhone' }] }));
            await settle();

            expect(bodyRows().map((cells) => cells[1])).to.deep.equal([
                'Removed device (p10)',
                'Removed device (p9)',
                'iPhone'
            ]);
            expect(Array.from(deviceSelect().options).map((option) => option.textContent)).to.deep.equal([
                'All devices',
                'iPhone (1)',
                'Removed device (p10) (1)',
                'Removed device (p9) (1)'
            ]);
        });

        it('does not call a device removed while the server is still being asked about it', async () => {
            setQueries([query({ at: 1, peer: 'p9', name: 'a.test' })]);
            const answer = { resolve: (_metadata: unknown) => {} };
            renderWithServer(() => new Promise<unknown>((resolve) => { answer.resolve = resolve; }));
            await settle();

            expect(bodyRows()[0][1]).to.equal('VPN device');

            answer.resolve({ available: true, running: true, peers: [{ peer: 'p9', name: 'Pixel' }] });
            await settle();
            expect(bodyRows()[0][1]).to.equal('Pixel');
        });
    });

    it('has a list that is a named stop for the keyboard, so it can be scrolled without a mouse', () => {
        setQueries(Array.from({ length: 200 }, (_, i) => query({ at: i, name: `host-${i}.example.com` })));
        render();

        const scroller = container.querySelector('[aria-label="DNS queries, scrollable"]') as HTMLElement;
        expect(scroller).to.not.equal(null);
        expect(scroller.tabIndex).to.equal(0);
        // It is the box that scrolls, and it holds the rows (the role keeps them in the table)
        expect(getComputedStyle(scroller).overflowY).to.equal('auto');
        expect(scroller.scrollHeight).to.be.greaterThan(scroller.clientHeight);
        expect(scroller.getAttribute('role')).to.equal('rowgroup');
        expect(scroller.querySelector('[role="row"]')).to.not.equal(null);

        scroller.focus();
        expect(document.activeElement).to.equal(scroller);
    });

    it('only puts the rows in view in the page, however many queries there are', () => {
        setQueries(Array.from({ length: 2000 }, (_, i) => query({ at: i, name: `host-${i}.example.com` })));
        render();

        const rows = bodyRows();
        expect(rows.length).to.be.greaterThan(5);
        expect(rows.length).to.be.lessThan(60);
        expect(rows[0][2]).to.equal('host-1999.example.com');
        expect(counts()).to.equal('2,000 queries');
    });
});
