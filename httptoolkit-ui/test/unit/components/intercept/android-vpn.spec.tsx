import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme, darkTheme, Theme } from '../../../../src/styles';
import {
    FRESH_HANDSHAKE_MS,
    VpnModeStore,
    VpnServerApi
} from '../../../../src/model/interception/vpn-mode';
import { AndroidVpnStatus } from '../../../../src/components/intercept/phone/android-vpn-status';
import { AndroidModeChoice } from '../../../../src/components/intercept/phone/android-vpn-mode-choice';
import type { AndroidConnectionMode } from '../../../../src/model/interception/android-vpn';

const NOW = 1_800_000_000_000;

type FakePeer = { peer: string, name: string, tunnelIp?: string, endpoint?: string, lastHandshake?: number };

// A store that has read what the server says: the tunnel runs (or not) with these devices
async function storeWith(peers: FakePeer[], running = true) {
    const api: VpnServerApi = {
        activate: async () => ({}),
        getMetadata: async () => ({
            available: true,
            running,
            listen: '0.0.0.0:51873',
            endpointHost: '192.168.0.10',
            peers
        })
    };
    const store = new VpnModeStore(api, () => NOW, 5);
    await store.refresh();
    return store;
}

describe('Android page, VPN mode', () => {

    let container: HTMLDivElement;

    beforeEach(() => {
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
    });

    const render = (element: React.ReactElement, theme: Theme = lightTheme) => act(() => {
        ReactDOM.render(<ThemeProvider theme={theme}>{ element }</ThemeProvider>, container);
    });

    const text = () => container.textContent ?? '';

    describe('the status', () => {

        const renderStatus = (store: VpnModeStore, onViewRequests = () => {}) =>
            render(<AndroidVpnStatus store={store} onViewRequests={onViewRequests} />);

        it('says the VPN is off while the tunnel is not running', async () => {
            renderStatus(await storeWith([], false));

            expect(text()).to.contain('VPN capture is off');
        });

        it('waits for the phone when it has not done a handshake yet', async () => {
            renderStatus(await storeWith([{ peer: 'p2', name: 'Android', tunnelIp: '10.73.0.3' }]));

            expect(text()).to.contain('Waiting for the Android phone');
            expect(text()).to.not.contain('connected over VPN');
        });

        it('is connected once the Android phone has done a handshake, and says how long ago', async () => {
            renderStatus(await storeWith([
                { peer: 'p2', name: 'Android', endpoint: '192.168.0.50:51822', lastHandshake: NOW - 12_000 }
            ]));

            expect(text()).to.contain('Android connected over VPN');
            expect(text()).to.contain('last handshake 12 s ago');
            expect(text()).to.contain('192.168.0.50');
        });

        it('goes to the requests from the button, shown once the phone is connected', async () => {
            let opened = 0;
            renderStatus(
                await storeWith([{ peer: 'p2', name: 'Android', lastHandshake: NOW - 1_000 }]),
                () => { opened += 1; }
            );

            const button = Array.from(container.querySelectorAll('button'))
                .find((candidate) => /View requests/.test(candidate.textContent ?? ''));
            expect(button).to.not.equal(undefined);

            act(() => { button!.click(); });
            expect(opened).to.equal(1);
        });

        it('has no button before the phone is connected', async () => {
            renderStatus(await storeWith([{ peer: 'p2', name: 'Android' }]));

            expect(container.querySelectorAll('button').length).to.equal(0);
        });

        it('says the phone has gone quiet when its handshake is old', async () => {
            renderStatus(await storeWith([
                { peer: 'p2', name: 'Android', lastHandshake: NOW - FRESH_HANDSHAKE_MS - 60_000 }
            ]));

            expect(text()).to.contain('Android has gone quiet');
            expect(text()).to.contain('same Wi-Fi');
        });

        it('keeps waiting for the Android phone while only the iPhone is connected', async () => {
            renderStatus(await storeWith([
                { peer: 'p1', name: 'iPhone', lastHandshake: NOW - 2_000 },
                { peer: 'p2', name: 'Android' }
            ]));

            expect(text()).to.contain('Waiting for the Android phone');
            expect(text()).to.not.contain('iPhone');
        });

        it('keeps waiting when there is only an iPhone on the tunnel', async () => {
            renderStatus(await storeWith([{ peer: 'p1', name: 'iPhone', lastHandshake: NOW - 2_000 }]));

            expect(text()).to.contain('Waiting for the Android phone');
        });

        it('follows the Android phone seen most recently', async () => {
            renderStatus(await storeWith([
                { peer: 'p2', name: 'Android', lastHandshake: NOW - 100_000 },
                { peer: 'p3', name: 'Android 2', lastHandshake: NOW - 4_000 }
            ]));

            expect(text()).to.contain('Android 2 connected over VPN');
            expect(text()).to.contain('last handshake 4 s ago');
        });

        it('draws in the dark theme too', async () => {
            render(
                <AndroidVpnStatus
                    store={await storeWith([{ peer: 'p2', name: 'Android', lastHandshake: NOW - 3_000 }])}
                    onViewRequests={() => {}}
                />,
                darkTheme
            );

            expect(text()).to.contain('Android connected over VPN');
        });
    });

    describe('the choice between the VPN and the other ways', () => {

        const renderChoice = (
            mode: AndroidConnectionMode | undefined,
            vpnAvailable: boolean | undefined,
            onChange: (mode: AndroidConnectionMode) => void = () => {}
        ) => render(<AndroidModeChoice mode={mode} vpnAvailable={vpnAvailable} onChange={onChange} />);

        const radio = (value: string) =>
            container.querySelector(`input[type=radio][value=${value}]`) as HTMLInputElement;

        it('is a radio group with the two ways', () => {
            renderChoice('vpn', true);

            expect(container.querySelector('[role=radiogroup]')?.getAttribute('aria-label'))
                .to.equal('How to connect the Android phone');
            expect(container.querySelectorAll('input[type=radio]').length).to.equal(2);
            expect(text()).to.contain('Capture all apps (VPN)');
            expect(text()).to.contain('App, ADB or proxy');
        });

        it('checks the picked way', () => {
            renderChoice('apps', true);

            expect(radio('apps').checked).to.equal(true);
            expect(radio('vpn').checked).to.equal(false);
        });

        it('has nothing picked until a way is known', () => {
            renderChoice(undefined, undefined);

            expect(radio('apps').checked).to.equal(false);
            expect(radio('vpn').checked).to.equal(false);
        });

        it('reports the way that was picked', () => {
            const picked: AndroidConnectionMode[] = [];
            renderChoice('vpn', true, (mode) => picked.push(mode));

            act(() => { radio('apps').click(); });

            expect(picked).to.deep.equal(['apps']);
        });

        it('says when the build has no VPN', () => {
            renderChoice('apps', false);

            expect(text()).to.contain('Not in this build');
            expect(text()).to.not.contain('New');
        });

        it('marks the VPN as new when the build has it', () => {
            renderChoice('vpn', true);

            expect(text()).to.contain('New');
            expect(text()).to.not.contain('Not in this build');
        });
    });
});
