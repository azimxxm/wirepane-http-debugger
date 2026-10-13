import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { observable, runInAction, IObservableValue } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import type { VpnCaptureState, VpnNetworkStore } from '../../../../src/model/interception/vpn-network';
import { CaptureTab } from '../../../../src/components/network/capture-tab';

const PATH = '/Users/me/Library/Preferences/httptoolkit/captures/wirepane-20261013-120000.pcapng';

const deferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
};

describe('Capture tab', () => {

    let container: HTMLDivElement;
    let capture: IObservableValue<VpnCaptureState>;
    let startCalls: number;
    let stopCalls: number;
    let onStart: () => Promise<VpnCaptureState>;
    let onStop: () => Promise<VpnCaptureState>;
    let copied: string[];
    let clipboardDescriptor: PropertyDescriptor | undefined;

    const setCapture = (state: VpnCaptureState) => runInAction(() => capture.set(state));

    // The tab only reads `capture` and calls the two actions, so a small fake stands in for the real
    // store (which polls a server)
    const fakeStore = () => ({
        get capture() { return capture.get(); },
        startCapture: () => { startCalls += 1; return onStart(); },
        stopCapture: () => { stopCalls += 1; return onStop(); }
    }) as unknown as VpnNetworkStore;

    const render = () => act(() => {
        ReactDOM.render(<ThemeProvider theme={lightTheme}>
            <CaptureTab store={fakeStore()} />
        </ThemeProvider>, container);
    });

    const flush = () => act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });

    const text = () => container.textContent ?? '';
    const button = (label: string) => Array.from(container.querySelectorAll('button'))
        .find((candidate) => candidate.textContent?.includes(label)) as HTMLButtonElement | undefined;
    const counter = (label: string) => Array.from(container.querySelectorAll('dt'))
        .find((term) => term.textContent === label)?.nextElementSibling?.textContent;

    const click = async (label: string) => {
        const target = button(label);
        expect(target, `a "${label}" button in: ${text()}`).to.not.equal(undefined);
        await act(async () => { target!.click(); });
    };

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);

        capture = observable.box<VpnCaptureState>({ running: false }, { deep: false });
        startCalls = 0;
        stopCalls = 0;
        onStart = async () => {
            const state = { running: true, path: PATH };
            setCapture(state);
            return state;
        };
        onStop = async () => {
            const state = { running: false, path: PATH, packets: 2, bytes: 1500 };
            setCapture(state);
            return state;
        };

        // The copy button writes to the clipboard, which headless Chrome may not allow
        copied = [];
        clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
        Object.defineProperty(navigator, 'clipboard', {
            configurable: true,
            value: { writeText: async (value: string) => { copied.push(value); } }
        });
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();

        if (clipboardDescriptor) {
            Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
        } else {
            delete (navigator as { clipboard?: unknown }).clipboard;
        }
    });

    it('offers to start a capture, and explains what it saves', () => {
        render();

        expect(text()).to.contain("Save the phone's packets to a file");
        expect(button('Start capture')).to.not.equal(undefined);
        expect(button('Stop capture')).to.equal(undefined);
        expect(text()).to.contain('HTTPS stays encrypted in the file');
        // No counters before there is a capture
        expect(container.querySelector('dl')).to.equal(null);
    });

    it('starts a capture through the store and then shows it running with its file', async () => {
        render();
        await click('Start capture');

        expect(startCalls).to.equal(1);
        expect(text()).to.contain('Capturing packets');
        expect(button('Stop capture')).to.not.equal(undefined);
        expect(button('Start capture')).to.equal(undefined);
        expect(text()).to.contain('Saving to');
        expect(text()).to.contain(PATH);
        // The first count has not arrived yet
        expect(counter('Packets')).to.equal('–');
        expect(counter('Size')).to.equal('–');
    });

    it('disables the button while the start request is on its way, so a double click starts once', async () => {
        const pending = deferred<VpnCaptureState>();
        onStart = () => pending.promise;
        render();

        await click('Start capture');
        const waiting = button('Starting');
        expect(waiting, text()).to.not.equal(undefined);
        expect(waiting!.disabled).to.equal(true);

        await act(async () => { waiting!.click(); });
        expect(startCalls).to.equal(1);

        await act(async () => {
            setCapture({ running: true, path: PATH });
            pending.resolve({ running: true, path: PATH });
        });
        expect(button('Stop capture')).to.not.equal(undefined);
    });

    it('counts up live while the capture runs', async () => {
        setCapture({ running: true, path: PATH, packets: 12, bytes: 1_200 });
        render();

        expect(counter('Packets')).to.equal('12');
        expect(counter('Size')).to.equal('1.2 kB');

        await act(async () => { setCapture({ running: true, path: PATH, packets: 12345, bytes: 4_200_000 }); });

        expect(counter('Packets')).to.equal('12,345');
        expect(counter('Size')).to.equal('4.2 MB');
    });

    it('stops the capture and shows the saved path with a button that copies it', async () => {
        setCapture({ running: true, path: PATH, packets: 2, bytes: 1500 });
        render();

        await click('Stop capture');

        expect(stopCalls).to.equal(1);
        expect(text()).to.contain('Capture saved');
        expect(text()).to.contain('Saved to');
        expect(text()).to.contain(PATH);
        expect(counter('Packets')).to.equal('2');
        expect(counter('Size')).to.equal('1.5 kB');
        expect(button('Start a new capture')).to.not.equal(undefined);

        await click('Copy path');
        expect(copied).to.deep.equal([PATH]);
        expect(button('Copied'), text()).to.not.equal(undefined);
    });

    it('tells an empty capture apart from one with packets', async () => {
        onStop = async () => {
            const state = { running: false, path: PATH, packets: 0, bytes: 0 };
            setCapture(state);
            return state;
        };
        setCapture({ running: true, path: PATH, packets: 0, bytes: 0 });
        render();

        await click('Stop capture');

        expect(text()).to.contain('No packets were captured');
    });

    it('shows the server\'s reason when the capture can not start, and lets the user try again', async () => {
        onStart = async () => { throw new Error('The VPN is not running'); };
        render();

        await click('Start capture');

        const alert = container.querySelector('[role="alert"]');
        expect(alert?.textContent).to.equal("Couldn't start the capture: The VPN is not running.");
        expect(startCalls).to.equal(1);
        expect(button('Start capture')!.disabled).to.equal(false);

        // The next try clears the message
        onStart = async () => {
            setCapture({ running: true, path: PATH });
            return { running: true, path: PATH };
        };
        await click('Start capture');
        expect(container.querySelector('[role="alert"]')).to.equal(null);
        expect(text()).to.contain('Capturing packets');
    });

    it('shows the reason when the capture can not be stopped, and stays running', async () => {
        onStop = async () => { throw new Error('the capture file is incomplete'); };
        setCapture({ running: true, path: PATH, packets: 5, bytes: 500 });
        render();

        await click('Stop capture');

        expect(container.querySelector('[role="alert"]')?.textContent)
            .to.equal("Couldn't stop the capture: the capture file is incomplete.");
        expect(text()).to.contain('Capturing packets');
        expect(button('Stop capture')!.disabled).to.equal(false);
    });

    it('shows a running capture it did not start (the page was reloaded during one)', () => {
        setCapture({ running: true, path: PATH, packets: 7, bytes: 700 });
        render();

        expect(text()).to.contain('Capturing packets');
        expect(counter('Packets')).to.equal('7');
        expect(button('Stop capture')).to.not.equal(undefined);
    });

    it('survives being closed while a request is still on its way', async () => {
        const pending = deferred<VpnCaptureState>();
        onStart = () => pending.promise;
        render();
        await click('Start capture');

        act(() => { ReactDOM.unmountComponentAtNode(container); });
        // Settling after the tab is gone must not throw or log into a dead component
        await act(async () => { pending.reject(new Error('late failure')); });
        await flush();
    });
});
