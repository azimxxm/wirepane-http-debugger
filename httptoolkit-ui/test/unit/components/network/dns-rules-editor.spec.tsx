import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import {
    DEFAULT_VPN_SETTINGS,
    VpnDnsRule,
    VpnNetworkStore,
    VpnSettings
} from '../../../../src/model/interception/vpn-network';
import { DnsRulesEditor } from '../../../../src/components/network/dns-rules-editor';

const block = (pattern: string): VpnDnsRule => ({ pattern, action: 'block' });
const answer = (pattern: string, ipv4: string): VpnDnsRule => ({ pattern, action: 'answer', ipv4 });

// Stands in for the real store: keeps what configure() was asked to save, like the server does
class FakeStore {

    state = observable({ settings: DEFAULT_VPN_SETTINGS }, { settings: observable.ref });

    calls: Array<Partial<VpnSettings>> = [];
    failWith: Error | undefined;

    constructor(dnsRules: VpnDnsRule[] = []) {
        runInAction(() => { this.state.settings = { ...DEFAULT_VPN_SETTINGS, dnsRules }; });
    }

    get settings() {
        return this.state.settings;
    }

    async configure(patch: Partial<VpnSettings>) {
        this.calls.push(patch);
        if (this.failWith) throw this.failWith;
        runInAction(() => { this.state.settings = { ...this.state.settings, ...patch }; });
    }
}

describe('DNS rules editor', () => {

    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
    });

    const render = (store: FakeStore) => act(() => {
        ReactDOM.render(<ThemeProvider theme={lightTheme}>
            <DnsRulesEditor store={store as unknown as VpnNetworkStore} />
        </ThemeProvider>, container);
    });

    // Lets the promise callbacks of a save run, inside act so React applies their updates
    const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

    const byLabel = <T extends Element>(tag: string, label: string) =>
        container.querySelector(`${tag}[aria-label="${label}"]`) as T | null;
    const patternInput = () => byLabel<HTMLInputElement>('input', 'Name to match')!;
    const addressInput = () => byLabel<HTMLInputElement>('input', 'IPv4 address to answer with');
    const actionSelect = () => byLabel<HTMLSelectElement>('select', 'What to do with it')!;
    const addButton = () => Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent!.includes('Add rule'))!;
    const removeButton = (pattern: string) =>
        byLabel<HTMLButtonElement>('button', `Remove the rule for ${pattern}`)!;
    const ruleRows = () => Array.from(container.querySelectorAll('ul[aria-label="DNS rules"] > li'))
        .map((row) => row.textContent!);

    const type = (input: HTMLInputElement, value: string) => act(() => {
        // React tracks the value itself, so it has to be set through the prototype
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setValue.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const choose = (select: HTMLSelectElement, value: string) => act(() => {
        const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!;
        setValue.call(select, value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    const click = async (button: HTMLButtonElement) => {
        act(() => { button.click(); });
        await settle();
    };

    it('says the rules apply to every app on VPN-connected phones', () => {
        render(new FakeStore());
        expect(container.textContent).to.contain('apply to every app on phones connected through the VPN');
    });

    it('shows a hint instead of a list while there are no rules', () => {
        render(new FakeStore());
        expect(ruleRows()).to.deep.equal([]);
        expect(container.textContent).to.contain('No rules yet');
    });

    it('lists the saved rules with what each one does', () => {
        render(new FakeStore([block('ads.example.com'), answer('*.test', '192.168.0.10')]));

        const rows = ruleRows();
        expect(rows).to.have.length(2);
        expect(rows[0]).to.contain('ads.example.com').and.to.contain('Block');
        expect(rows[1]).to.contain('*.test').and.to.contain('Answer 192.168.0.10');
        expect(container.textContent).to.contain('2 rules');
    });

    it('saves a new block rule through configure and clears the form', async () => {
        const store = new FakeStore([answer('api.test', '10.0.0.1')]);
        render(store);

        type(patternInput(), '  Ads.Example.COM. ');
        await click(addButton());

        expect(store.calls).to.deep.equal([{
            dnsRules: [answer('api.test', '10.0.0.1'), block('ads.example.com')]
        }]);
        expect(ruleRows()).to.have.length(2);
        expect(patternInput().value).to.equal('');
    });

    it('saves an answer rule once an address is given', async () => {
        const store = new FakeStore();
        render(store);

        expect(addressInput()).to.equal(null);
        choose(actionSelect(), 'answer');
        type(patternInput(), '*.mock.test');
        type(addressInput()!, '192.168.0.10');
        await click(addButton());

        expect(store.calls).to.deep.equal([{ dnsRules: [answer('*.mock.test', '192.168.0.10')] }]);
        expect(ruleRows()[0]).to.contain('*.mock.test').and.to.contain('Answer 192.168.0.10');
    });

    it('adds the rule when Enter is pressed in the name field', async () => {
        const store = new FakeStore();
        render(store);

        type(patternInput(), 'tracker.test');
        act(() => {
            patternInput().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
        });
        await settle();

        expect(store.calls).to.deep.equal([{ dnsRules: [block('tracker.test')] }]);
    });

    it('explains what is wrong with a name and does not save it', async () => {
        const store = new FakeStore();
        render(store);

        type(patternInput(), 'not a name');
        await click(addButton());

        expect(container.querySelector('#dns-rule-pattern-problem')!.textContent).to.contain("can't have spaces");
        expect(patternInput().getAttribute('aria-invalid')).to.equal('true');
        expect(store.calls).to.deep.equal([]);
    });

    it('asks for the name when Add is pressed on an empty form', async () => {
        const store = new FakeStore();
        render(store);

        await click(addButton());

        expect(container.querySelector('#dns-rule-pattern-problem')!.textContent).to.contain('Enter a name');
        expect(store.calls).to.deep.equal([]);
    });

    it('asks for a valid address when the rule answers', async () => {
        const store = new FakeStore();
        render(store);

        choose(actionSelect(), 'answer');
        type(patternInput(), 'api.test');
        type(addressInput()!, '10.0.0');
        await click(addButton());

        expect(container.querySelector('#dns-rule-address-problem')!.textContent).to.contain('not an IPv4 address');
        expect(store.calls).to.deep.equal([]);

        type(addressInput()!, '10.0.0.7');
        expect(container.querySelector('#dns-rule-address-problem')).to.equal(null);
    });

    it('refuses a name that already has a rule', async () => {
        const store = new FakeStore([block('ads.example.com')]);
        render(store);

        type(patternInput(), 'ADS.example.com');
        await click(addButton());

        expect(container.querySelector('#dns-rule-pattern-problem')!.textContent).to.contain('already in the list');
        expect(store.calls).to.deep.equal([]);
    });

    it('removes a rule through configure', async () => {
        const store = new FakeStore([block('a.test'), answer('b.test', '10.0.0.2'), block('c.test')]);
        render(store);

        await click(removeButton('b.test'));

        expect(store.calls).to.deep.equal([{ dnsRules: [block('a.test'), block('c.test')] }]);
        expect(ruleRows()).to.have.length(2);
        expect(ruleRows().join(' ')).not.to.contain('b.test');
    });

    it('shows why a save failed and keeps what was typed', async () => {
        const store = new FakeStore();
        store.failWith = new Error('The VPN is not running');
        render(store);

        type(patternInput(), 'ads.example.com');
        await click(addButton());

        const alert = container.querySelector('[role="alert"]')!;
        expect(alert.textContent).to.contain('The DNS rules were not saved: The VPN is not running');
        expect(patternInput().value).to.equal('ads.example.com');
        expect(ruleRows()).to.have.length(0);
    });

    it('points out a rule that an earlier rule already covers', () => {
        render(new FakeStore([block('*.example.com'), answer('api.example.com', '10.0.0.1'), block('example.com')]));

        const rows = ruleRows();
        expect(rows[0]).not.to.contain('Never used');
        expect(rows[1]).to.contain('Never used').and.to.contain('*.example.com');
        expect(rows[2]).not.to.contain('Never used');
    });
});
