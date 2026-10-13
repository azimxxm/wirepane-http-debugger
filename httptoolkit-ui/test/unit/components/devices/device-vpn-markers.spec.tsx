import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { Provider } from 'mobx-react';
import { IObservableArray, observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import { CollectedEvent } from '../../../../src/types';
import { DevicesStore } from '../../../../src/model/devices/devices-store';
import { VpnPeerNames } from '../../../../src/model/devices/vpn-peer-names';
import { UiStore } from '../../../../src/model/ui/ui-store';
import { DeviceCell } from '../../../../src/components/devices/device-marker';
import { DeviceTree } from '../../../../src/components/devices/device-tree';

import { MemoryStorage, UA, deviceExchange } from '../../model/devices/device-test-helpers';

const PHONE = '192.168.0.199';
const VPN_TAGS = ['wirepane-vpn', 'wirepane-vpn-peer:p1', `wirepane-vpn-endpoint:${PHONE}`]
    .map((tag) => `socket-metadata:${tag}`);

describe('VPN in the Devices panel and the list', () => {

    let container: HTMLDivElement;
    let events: IObservableArray<CollectedEvent>;
    let store: DevicesStore;
    let sendNames: () => void;

    // The fake server answers when the test says so, to see the components before and after
    const loadNames = async () => {
        sendNames();
        await act(async () => { await new Promise<void>((resolve) => setTimeout(resolve, 0)); });
    };

    const viaVpn = deviceExchange({ ip: '127.0.0.1', ua: UA.iphoneSafari, tags: VPN_TAGS });
    // The same phone, using the proxy directly
    const direct = deviceExchange({ ip: PHONE, ua: UA.iosApp });
    const local = deviceExchange({ ip: '127.0.0.1', ua: UA.curl });

    beforeEach(async () => {
        container = document.createElement('div');
        document.body.appendChild(container);

        events = observable.array<CollectedEvent>([], { deep: false });
        const namesSent = new Promise<void>((resolve) => { sendNames = resolve; });
        store = new DevicesStore({ events }, {
            nameStorage: new MemoryStorage(),
            thisMachineType: 'mac',
            vpnPeerNames: new VpnPeerNames(async () => {
                await namesSent;
                return { available: true, running: true, peers: [{ peer: 'p1', name: 'iPhone 2' }] };
            })
        });
        await store.initialized;
        runInAction(() => { events.push(viaVpn, direct, local); });
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
        store.dispose();
    });

    const render = (element: React.ReactElement) => act(() => {
        ReactDOM.render(<ThemeProvider theme={lightTheme}>
            <Provider devicesStore={store}>{ element }</Provider>
        </ThemeProvider>, container);
    });

    describe('the list\'s Device cell', () => {
        const cell = () => container.querySelector('[role="gridcell"]') as HTMLElement;
        const shield = () => cell().querySelector('svg[aria-label="VPN"]');

        it('shows a VPN marker on a request that came through the VPN', async () => {
            render(<DeviceCell event={viaVpn} />);

            expect(cell().textContent).to.equal('iPhone');
            expect(shield()).not.to.equal(null);
            expect(cell().title).to.equal(`From iPhone (${PHONE}) · through the VPN`);

            // Once the server has said what the peer is called
            await loadNames();
            expect(cell().title).to.equal(`From iPhone (${PHONE}) · through the VPN (iPhone 2)`);
            expect(cell().title).not.to.contain('p1');
        });

        it("has no marker on the same phone's request that used the proxy directly", async () => {
            render(<DeviceCell event={direct} />);
            await loadNames();

            expect(cell().textContent).to.equal('iPhone');
            expect(shield()).to.equal(null);
            expect(cell().title).to.equal(`From iPhone (${PHONE})`);
        });

        it('has no marker on requests from this machine', () => {
            render(<DeviceCell event={local} />);

            expect(cell().textContent).to.equal('This Mac');
            expect(shield()).to.equal(null);
            expect(cell().title).to.equal('From This Mac');
        });
    });

    describe('the Devices panel', () => {
        const phoneRow = () => Array.from(container.querySelectorAll('[role="treeitem"]'))
            .find((row) => row.textContent!.includes(PHONE)) as HTMLElement;
        const badge = () => Array.from(phoneRow().querySelectorAll('span'))
            .find((span) => span.textContent === 'VPN') as HTMLElement;

        it('names the VPN device instead of showing its peer id', async () => {
            render(<DeviceTree devicesStore={store} uiStore={{} as UiStore} />);

            expect(badge().title).to.equal('Connected through the VPN');

            await loadNames();
            expect(badge().title).to.equal('Connected through the VPN (iPhone 2)');
            expect(badge().title).not.to.contain('p1');
        });
    });
});
