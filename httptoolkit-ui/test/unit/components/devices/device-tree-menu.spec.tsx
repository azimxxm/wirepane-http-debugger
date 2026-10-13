import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';
import { IObservableArray, ObservableSet, observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme } from '../../../../src/styles';
import { CollectedEvent } from '../../../../src/types';
import { ContextMenuItem, ContextMenuOption } from '../../../../src/model/ui/context-menu';
import { UiStore } from '../../../../src/model/ui/ui-store';
import { DEVICES_STORE_KEY, DevicesStore } from '../../../../src/model/devices/devices-store';
import { DeviceTree } from '../../../../src/components/devices/device-tree';

import { MemoryStorage, UA, deviceExchange } from '../../model/devices/device-test-helpers';

const IPHONE = '192.168.0.23';
const ANDROID = '192.168.0.42';
const CLEAR = "Clear this device's traffic";

describe("The Devices panel's device menu", () => {

    let container: HTMLDivElement;
    let events: IObservableArray<CollectedEvent>;
    let store: DevicesStore;
    let menu: readonly ContextMenuItem<void>[];
    let closeMenu: () => void;
    // View's selection, and the right-click menus, which the tree hands to the UI store
    let uiStore: {
        selectedEventIds: ObservableSet<string>,
        activeEventId: string | undefined,
        handleContextMenuEvent(event: React.MouseEvent, items: readonly ContextMenuItem<void>[]): Promise<void>
    };

    const iphoneSafari = deviceExchange({ ip: IPHONE, ua: UA.iphoneSafari });
    const iphoneApp = deviceExchange({ ip: IPHONE, ua: UA.iosApp });
    const android = deviceExchange({ ip: ANDROID, ua: UA.androidChrome });

    beforeEach(async () => {
        container = document.createElement('div');
        document.body.appendChild(container);
        localStorage.removeItem(DEVICES_STORE_KEY);

        events = observable.array<CollectedEvent>([], { deep: false });
        store = new DevicesStore({
            events,
            // One change to the list, like the events store
            deleteEvents: (deleted) => runInAction(() => {
                events.replace(events.filter((event) => !deleted.includes(event)));
            })
        }, { nameStorage: new MemoryStorage(), thisMachineType: 'mac' });
        await store.initialized;
        runInAction(() => { events.push(iphoneSafari, android, iphoneApp); });

        menu = [];
        uiStore = {
            selectedEventIds: observable.set<string>(),
            activeEventId: undefined,
            handleContextMenuEvent(event, items) {
                event.preventDefault();
                menu = items;
                // Settles once the menu has closed, like the UI store's
                return new Promise<void>((resolve) => { closeMenu = resolve; });
            }
        };

        act(() => {
            ReactDOM.render(<ThemeProvider theme={lightTheme}>
                <DeviceTree devicesStore={store} uiStore={uiStore as unknown as UiStore} />
            </ThemeProvider>, container);
        });
    });

    afterEach(() => {
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
        store.dispose();
        localStorage.removeItem(DEVICES_STORE_KEY);
    });

    const tree = () => container.querySelector<HTMLElement>('[role="tree"]')!;
    const rows = () => Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]'));
    // Device rows show the device's address, or localhost for this machine
    const rowOf = (address: string) => rows().find((row) => row.textContent!.includes(address));
    const rowLabels = () => rows().map((row) => row.getAttribute('aria-label')!.split(',')[0]);

    // The pin sits next to the name, in the name's line
    const pinIcon = (row: HTMLElement, name: string) => {
        const label = Array.from(row.querySelectorAll('span')).find((span) => span.textContent === name)!;
        return label.parentElement!.querySelector('svg');
    };

    const openMenu = (row: HTMLElement) => {
        act(() => { row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })); });
        return menu;
    };
    const menuLabels = (items: readonly ContextMenuItem<void>[]) =>
        items.map((item) => item.type === 'separator' ? '-' : item.label);
    const option = (items: readonly ContextMenuItem<void>[], label: string) =>
        items.find((item): item is ContextMenuOption<void> => item.type === 'option' && item.label === label)!;
    const choose = (row: HTMLElement, label: string) => {
        const item = option(openMenu(row), label);
        act(() => { item.callback(); });
    };

    it('offers pinning with the other options, and clearing apart at the end', () => {
        expect(menuLabels(openMenu(rowOf(IPHONE)!))).to.deep.equal([
            'Rename',
            'Show only this device',
            'Pin to top',
            'Forget name',
            '-',
            'Copy IP address',
            '-',
            CLEAR
        ]);
        expect(option(menu, CLEAR).enabled).to.equal(true);

        // This machine has no address to copy, and here no traffic to clear
        expect(menuLabels(openMenu(rowOf('localhost')!))).to.deep.equal([
            'Rename',
            'Show only this device',
            'Pin to top',
            'Forget name',
            '-',
            CLEAR
        ]);
        expect(option(menu, CLEAR).enabled).to.equal(false);
    });

    it('pins a device right under All devices, with a pin next to its name', () => {
        expect(rowLabels()).to.deep.equal(['All devices', 'This Mac', 'iPhone', 'Pixel 8']);

        choose(rowOf(ANDROID)!, 'Pin to top');
        expect(rowLabels()).to.deep.equal(['All devices', 'Pixel 8', 'This Mac', 'iPhone']);

        const pinned = rowOf(ANDROID)!;
        expect(pinned.getAttribute('aria-label')).to.match(/^Pixel 8, pinned, 192\.168\.0\.42, 1 request/);
        expect(pinned.title).to.match(/^Pixel 8 · pinned · 192\.168\.0\.42 · /);
        expect(pinIcon(pinned, 'Pixel 8')).not.to.equal(null);
        expect(pinIcon(rowOf(IPHONE)!, 'iPhone')).to.equal(null);

        // This machine can be pinned too, after it
        choose(rowOf('localhost')!, 'Pin to top');
        expect(rowLabels()).to.deep.equal(['All devices', 'Pixel 8', 'This Mac', 'iPhone']);
        expect(rowOf('localhost')!.getAttribute('aria-label')).to.match(/^This Mac, pinned, /);

        choose(rowOf(ANDROID)!, 'Unpin');
        expect(rowLabels()).to.deep.equal(['All devices', 'This Mac', 'iPhone', 'Pixel 8']);
        expect(pinIcon(rowOf(ANDROID)!, 'Pixel 8')).to.equal(null);
        expect(menuLabels(openMenu(rowOf('localhost')!))).to.include('Unpin');
    });

    it("clears one device's traffic straight away, and takes its requests out of View's selection", () => {
        runInAction(() => {
            uiStore.selectedEventIds.add(iphoneSafari.id);
            uiStore.selectedEventIds.add(android.id);
            uiStore.activeEventId = iphoneSafari.id;
        });

        choose(rowOf(IPHONE)!, CLEAR);

        expect(events.map((event) => event.id)).to.deep.equal([android.id]);
        expect([...uiStore.selectedEventIds]).to.deep.equal([android.id]);
        expect(uiStore.activeEventId).to.equal(undefined);
        expect(rowOf(IPHONE)).to.equal(undefined);
        expect(rowLabels()).to.deep.equal(['All devices', 'This Mac', 'Pixel 8']);
    });

    it('marks the row whose menu is open, until the menu closes', async () => {
        const isMarked = (row: HTMLElement) => getComputedStyle(row).outlineStyle === 'solid';

        openMenu(rowOf(IPHONE)!);
        expect(rows().filter(isMarked)).to.deep.equal([rowOf(IPHONE)]);

        await act(async () => {
            closeMenu();
            await new Promise((resolve) => setTimeout(resolve, 0));
        });
        expect(rows().filter(isMarked)).to.deep.equal([]);

        // The focused selection stands out already
        act(() => { store.select({ deviceKey: ANDROID }); });
        tree().focus();
        openMenu(rowOf(ANDROID)!);
        expect(rows().filter(isMarked)).to.deep.equal([]);
    });

    it("keeps a placeholder's muted name readable in the focused selection", () => {
        choose(rowOf(ANDROID)!, 'Pin to top');
        choose(rowOf(ANDROID)!, CLEAR);
        // The name itself, not the line it's in
        const nameColor = () => getComputedStyle(Array.from(rowOf(ANDROID)!.querySelectorAll('span'))
            .find((span) => span.children.length === 0 && span.textContent === 'Pixel 8')!
        ).color;
        const mutedColor = nameColor();

        act(() => { store.select({ deviceKey: ANDROID }); });
        tree().focus();
        // The selection's own text colour, like the address next to it
        expect(nameColor()).to.equal(getComputedStyle(rowOf(ANDROID)!).color);
        expect(nameColor()).not.to.equal(mutedColor);
    });

    it('keeps a pinned device listed after its traffic is cleared, as a muted row with no requests', () => {
        choose(rowOf(ANDROID)!, 'Pin to top');
        choose(rowOf(ANDROID)!, CLEAR);

        const placeholder = rowOf(ANDROID)!;
        expect(placeholder.getAttribute('aria-label')).to.match(/^Pixel 8, pinned, 192\.168\.0\.42, 0 requests/);
        expect(placeholder.textContent).to.match(/0$/);
        expect(option(openMenu(placeholder), CLEAR).enabled).to.equal(false);

        // Unpinned without traffic, it's gone
        choose(placeholder, 'Unpin');
        expect(rowOf(ANDROID)).to.equal(undefined);
    });
});
