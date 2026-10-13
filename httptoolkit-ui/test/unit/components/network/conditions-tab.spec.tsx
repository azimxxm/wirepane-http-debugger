import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import {
    DEFAULT_VPN_SETTINGS,
    VpnConditions,
    VpnNetworkStore,
    VpnSettings
} from '../../../../src/model/interception/vpn-network';
import { ConditionsPanel } from '../../../../src/components/network/conditions-tab';
import {
    CONDITIONS_PRESETS,
    ConditionsDevice
} from '../../../../src/components/network/conditions-model';

// The parts of the Network page's store that the Conditions tab uses. Like the real one, it
// takes the saved settings back after a save: a null removes the device's conditions.
class FakeNetworkStore {
    @observable.ref settings: VpnSettings = DEFAULT_VPN_SETTINGS;

    saved: Array<Partial<VpnSettings>> = [];
    saveError: Error | undefined;
    // When set, a save waits for this before it finishes
    holdSaves: Promise<void> | undefined;

    async configure(patch: Partial<VpnSettings>) {
        this.saved.push(patch);
        if (this.holdSaves) await this.holdSaves;
        if (this.saveError) throw this.saveError;

        runInAction(() => {
            const conditions = { ...this.settings.conditions };
            Object.entries(patch.conditions ?? {}).forEach(([peer, value]) => {
                if (value) conditions[peer] = value;
                else delete conditions[peer];
            });
            this.settings = { ...this.settings, conditions };
        });
    }

    setConditions(conditions: VpnSettings['conditions']) {
        runInAction(() => { this.settings = { ...this.settings, conditions }; });
    }
}

const DEVICES: ConditionsDevice[] = [
    { peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2', lastHandshake: 9_000 },
    { peer: 'p2', name: 'iPad', tunnelIp: '10.73.0.3', lastHandshake: 4_000 }
];

const preset = (id: string): VpnConditions => CONDITIONS_PRESETS.find((candidate) => candidate.id === id)!.conditions!;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('Network conditions tab', () => {

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

    const render = (devices: ReadonlyArray<ConditionsDevice> = DEVICES) => act(() => {
        ReactDOM.render(<ThemeProvider theme={lightTheme}>
            <ConditionsPanel store={store as unknown as VpnNetworkStore} devices={devices} />
        </ThemeProvider>, container);
    });

    const settle = () => act(async () => { await sleep(0); });

    // --- Finding & using the controls ---

    const presetButton = (label: string) => Array.from(container.querySelectorAll('button[aria-pressed]'))
        .find((button) => button.querySelector('strong')?.textContent === label) as HTMLButtonElement;

    const buttonWithText = (text: string) => Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent?.trim() === text) as HTMLButtonElement | undefined;

    const input = (field: string) => container.querySelector(`#conditions-field-${field}`) as HTMLInputElement;
    const deviceSelect = () => container.querySelector('#conditions-device') as HTMLSelectElement;
    const status = () => container.querySelector('[role="status"]')!.textContent!;
    const alerts = () => Array.from(container.querySelectorAll('[role="alert"]')).map((alert) => alert.textContent);

    const click = async (element: HTMLElement | undefined) => {
        if (!element) throw new Error('No such button');
        act(() => { element.click(); });
        await settle();
    };

    const type = (field: string, value: string) => act(() => {
        const field_ = input(field);
        // React watches the value through the prototype's setter, so go through it
        const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
        setValue.call(field_, value);
        field_.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const chooseDevice = (peer: string) => act(() => {
        const select = deviceSelect();
        select.value = peer;
        select.dispatchEvent(new Event('change', { bubbles: true }));
    });

    // --- The tests ---

    it('says how to get a device when none is on the VPN', () => {
        render([]);

        expect(container.textContent).to.contain('No phone is on Wirepane\'s VPN yet');
        expect(container.querySelectorAll('button').length).to.equal(0);
    });

    it('shows the presets, the custom fields and what the conditions do', () => {
        render();

        expect(Array.from(container.querySelectorAll('button[aria-pressed] strong')).map((name) => name.textContent))
            .to.deep.equal(['Off', '3G', 'Edge', 'LTE', 'Lossy Wi-Fi', 'Offline']);
        expect(Array.from(container.querySelectorAll('label')).map((label) => label.textContent))
            .to.deep.equal(['Device', 'Latency', 'Jitter', 'Download', 'Upload', 'Packet loss']);
        expect(container.textContent).to.contain('slows every app on that phone');
    });

    it('lists the devices and marks the ones that have conditions on', () => {
        store.setConditions({ p2: preset('edge') });
        render();

        const options = Array.from(deviceSelect().options).map((option) => option.textContent);
        expect(options).to.deep.equal(['iPhone (10.73.0.2)', 'iPad (10.73.0.3), Edge']);
    });

    it('starts on the device that has conditions and shows what is active there', () => {
        store.setConditions({ p2: preset('3g') });
        render();

        expect(deviceSelect().value).to.equal('p2');
        expect(status()).to.equal('3G on iPad: 750 kbps down, 250 kbps up, 200 ms latencyTurn off');
        expect(presetButton('3G').getAttribute('aria-pressed')).to.equal('true');
        expect(presetButton('Off').getAttribute('aria-pressed')).to.equal('false');

        // The custom fields start from what is active
        expect(input('latencyMs').value).to.equal('200');
        expect(input('downKbps').value).to.equal('750');
        expect(input('upKbps').value).to.equal('250');
    });

    it('says the network is normal when nothing is on', () => {
        render();

        expect(deviceSelect().value).to.equal('p1'); // The one that connected last
        expect(status()).to.equal('Off. iPhone uses its normal network.');
        expect(presetButton('Off').getAttribute('aria-pressed')).to.equal('true');
        expect(buttonWithText('Turn off')).to.equal(undefined);
    });

    it('applies a preset to the chosen device', async () => {
        render();
        await click(presetButton('LTE'));

        expect(store.saved).to.deep.equal([{ conditions: { p1: preset('lte') } }]);
        expect(status()).to.contain('LTE on iPhone: 12 Mbps down, 5 Mbps up, 50 ms latency');
        expect(presetButton('LTE').getAttribute('aria-pressed')).to.equal('true');
        // ...and the fields follow
        expect(input('downKbps').value).to.equal('12000');
    });

    it('sends the offline preset as every packet lost', async () => {
        render();
        await click(presetButton('Offline'));

        expect(store.saved).to.deep.equal([{
            conditions: { p1: { latencyMs: 0, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 100 } }
        }]);
        expect(status()).to.contain('Offline on iPhone: All packets are dropped');
    });

    it('turns conditions off with Turn off and with the Off preset', async () => {
        store.setConditions({ p1: preset('3g') });
        render();

        await click(buttonWithText('Turn off'));
        expect(store.saved).to.deep.equal([{ conditions: { p1: null } }]);
        expect(status()).to.equal('Off. iPhone uses its normal network.');
        expect(input('downKbps').value).to.equal('0');

        await click(presetButton('Edge'));
        await click(presetButton('Off'));
        expect(store.saved[2]).to.deep.equal({ conditions: { p1: null } });
    });

    it('applies the numbers typed in the custom fields', async () => {
        render();
        type('latencyMs', '120');
        type('jitterMs', '30');
        type('downKbps', '2000');
        type('upKbps', '500');
        type('lossPct', '1.5');
        await click(buttonWithText('Apply to iPhone'));

        expect(store.saved).to.deep.equal([{
            conditions: { p1: { latencyMs: 120, jitterMs: 30, downKbps: 2000, upKbps: 500, lossPct: 1.5 } }
        }]);
        expect(status()).to.contain(
            'Custom on iPhone: 2 Mbps down, 500 kbps up, 120 ms latency ± 30 ms jitter, 1.5% packet loss'
        );
        expect(Array.from(container.querySelectorAll('button[aria-pressed="true"]'))).to.have.length(0);
    });

    it('applies from a field when Enter is pressed', async () => {
        render();
        type('latencyMs', '75');
        act(() => {
            input('latencyMs').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        });
        await settle();

        expect(store.saved).to.deep.equal([{
            conditions: { p1: { latencyMs: 75, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 0 } }
        }]);
    });

    it('treats custom numbers that are all zero as turning conditions off', async () => {
        store.setConditions({ p1: preset('3g') });
        render();
        type('latencyMs', '0');
        type('downKbps', '');
        type('upKbps', '0');
        await click(buttonWithText('Apply to iPhone'));

        expect(store.saved).to.deep.equal([{ conditions: { p1: null } }]);
    });

    it('sends nothing for wrong numbers, says what is wrong, and clears the note when it is fixed', async () => {
        render();
        type('latencyMs', 'fast');
        type('lossPct', '150');
        type('downKbps', '10.5');
        await click(buttonWithText('Apply to iPhone'));

        expect(store.saved).to.deep.equal([]);
        expect(alerts()).to.deep.equal(['Enter a number', 'Use a whole number', 'At most 100']);
        expect(input('latencyMs').getAttribute('aria-invalid')).to.equal('true');
        expect(input('jitterMs').getAttribute('aria-invalid')).to.equal('false');

        type('latencyMs', '80');
        expect(alerts()).to.deep.equal(['Use a whole number', 'At most 100']);
        expect(input('latencyMs').getAttribute('aria-invalid')).to.equal('false');
    });

    it('sends the next preset to the device picked in the list', async () => {
        render();
        chooseDevice('p2');
        expect(status()).to.equal('Off. iPad uses its normal network.');

        await click(presetButton('Edge'));
        expect(store.saved).to.deep.equal([{ conditions: { p2: preset('edge') } }]);
        expect(status()).to.contain('Edge on iPad');
    });

    it('keeps the picked device when its conditions are turned off', async () => {
        store.setConditions({ p2: preset('3g') });
        render();
        expect(deviceSelect().value).to.equal('p2');

        await click(buttonWithText('Turn off'));

        expect(deviceSelect().value).to.equal('p2');
        expect(status()).to.equal('Off. iPad uses its normal network.');
    });

    it('shows the numbers of the device picked, not the previous one', async () => {
        store.setConditions({ p1: preset('lte'), p2: preset('edge') });
        render();
        expect(deviceSelect().value).to.equal('p1');
        expect(input('latencyMs').value).to.equal('50');

        chooseDevice('p2');
        expect(input('latencyMs').value).to.equal('400');
        expect(status()).to.contain('Edge on iPad');
    });

    it('keeps what the user is typing when the settings change underneath', () => {
        render();
        type('latencyMs', '33');

        // Another device is changed, e.g. from another window
        act(() => { store.setConditions({ p2: preset('3g') }); });

        expect(input('latencyMs').value).to.equal('33');
    });

    it('follows the settings when the user has not typed anything', () => {
        render();
        expect(input('latencyMs').value).to.equal('0');

        act(() => { store.setConditions({ p1: preset('edge') }); });

        expect(input('latencyMs').value).to.equal('400');
        expect(status()).to.contain('Edge on iPhone');
    });

    it('shows why a save failed and lets the user try again', async () => {
        store.saveError = new Error('The VPN is not running');
        render();
        await click(presetButton('3G'));

        expect(alerts()).to.deep.equal(['The VPN is not running']);
        expect(presetButton('3G').disabled).to.equal(false);
        expect(status()).to.equal('Off. iPhone uses its normal network.');

        store.saveError = undefined;
        await click(presetButton('3G'));
        expect(alerts()).to.deep.equal([]);
        expect(status()).to.contain('3G on iPhone');
    });

    it('does not send a second save while one is running', async () => {
        let finish!: () => void;
        store.holdSaves = new Promise<void>((resolve) => { finish = resolve; });
        render();

        act(() => { presetButton('3G').click(); });
        expect(presetButton('LTE').disabled).to.equal(true);
        act(() => { presetButton('LTE').click(); });
        expect(store.saved).to.have.length(1);

        finish();
        await settle();
        expect(presetButton('LTE').disabled).to.equal(false);
        expect(status()).to.contain('3G on iPhone');
    });
});
