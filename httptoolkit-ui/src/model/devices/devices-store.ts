import * as _ from 'lodash';
import {
    action,
    comparer,
    computed,
    IObservableArray,
    isObservableArray,
    IReactionDisposer,
    Lambda,
    observable,
    observe,
    reaction,
    runInAction
} from 'mobx';
import { now } from 'mobx-utils';

import type { CollectedEvent, ViewableEvent } from '../../types';
import { lazyObservablePromise } from '../../util/observable';
import { persist, hydrate } from '../../util/mobx-persist/persist';

import { AppCount, DeviceStats, DeviceTracker } from './device-tracker';
import {
    DeviceType,
    THIS_MACHINE_KEY,
    detectDeviceType,
    getClientEvent,
    getDeviceTypeLabel,
    getEventDeviceKey,
    getThisMachineName
} from './device-model';
import { DeviceDirectory, EventDevice, THIS_MACHINE_TYPE, setDeviceDirectory } from './device-directory';
import { NameStorage, cleanDeviceName, loadDeviceNames, saveDeviceNames } from './device-names';
import { DeviceSelection, DeviceSelectionFilter, isSameSelection } from './device-selection-filter';

export const DEFAULT_DEVICES_PANEL_WIDTH = 216;
export const MIN_DEVICES_PANEL_WIDTH = 180;
export const MAX_DEVICES_PANEL_WIDTH = 440;

// A device is shown as active if it sent something in the last minute
export const ACTIVE_WINDOW_MS = 60_000;
const ACTIVE_CHECK_INTERVAL_MS = 5_000;

export interface DeviceHost {
    host: string;
    count: number;
}

export interface DeviceSummary {
    key: string; // THIS_MACHINE_KEY, or the device's IP
    isThisMachine: boolean;
    type: DeviceType;
    name: string; // The user's name for it, or the default one
    defaultName: string; // "This Mac", or the type or model: "iPhone", "Pixel 8"
    hasCustomName: boolean;
    // The name, plus the end of the IP when another device has the same name
    shortName: string;
    // Shown under the name: the device's IP (none for this machine)
    address: string | undefined;
    // Every address its traffic came from (this machine's loopback addresses)
    addresses: string[];
    eventCount: number;
    firstSeen: number;
    lastSeen: number;
    apps: AppCount[]; // Most requests first
    hosts: DeviceHost[]; // Most requests first
}

// What a request row's device marker shows. Unlike DeviceSummary it doesn't change with
// every request, so the rows only re-render when a name or type changes.
export interface DeviceMarker {
    name: string;
    title: string;
    type: DeviceType;
}

interface DevicesStoreOptions {
    nameStorage?: NameStorage;
    thisMachineType?: DeviceType;
}

// The end of an address, to tell apart devices with the same name: ".23" or ":5a2f"
function addressSuffix(address: string) {
    const ipv4End = /\.(\d+)$/.exec(address);
    if (ipv4End) return `.${ipv4End[1]}`;
    return `:${_.last(address.split(':'))}`;
}

const byCount = <T extends { count: number }>(items: T[], getName: (item: T) => string) =>
    _.orderBy(items, [(item) => item.count, getName], ['desc', 'asc']);

/**
 * The devices that sent the captured traffic, told apart by their IP address: this
 * machine (loopback & the Send page) and each phone or computer on the network.
 * It also keeps the Devices panel's state: what's selected, names, width & visibility.
 */
export class DevicesStore implements DeviceDirectory {

    private readonly tracker = new DeviceTracker();
    private readonly thisMachineType: DeviceType;
    private disposers: Array<Lambda | IReactionDisposer> = [];

    constructor(
        private readonly eventsSource: { readonly events: ReadonlyArray<CollectedEvent> },
        private readonly options: DevicesStoreOptions = {}
    ) {
        this.thisMachineType = options.thisMachineType ?? THIS_MACHINE_TYPE;
        this.customNames = loadDeviceNames(options.nameStorage);
    }

    readonly initialized = lazyObservablePromise(async () => {
        try {
            await hydrate({ key: 'devices-store', store: this });
        } catch (e) {
            // Only the panel's width & visibility are saved, so the defaults are fine
            console.warn("Couldn't restore the Devices panel layout", e);
        }

        this.startTracking();
        this.watchSelection();
        setDeviceDirectory(this);

        console.log('Devices store initialized');
    });

    dispose() {
        this.disposers.forEach((dispose) => dispose());
        this.disposers = [];
        setDeviceDirectory(undefined);
    }

    // --- Panel state ---

    @persist @observable
    panelOpen = true;

    @persist @observable
    panelWidth = DEFAULT_DEVICES_PANEL_WIDTH;

    @action.bound
    togglePanel() {
        this.panelOpen = !this.panelOpen;
    }

    @action.bound
    showPanel() {
        this.panelOpen = true;
    }

    @action.bound
    setPanelWidth(width: number) {
        this.panelWidth = _.clamp(Math.round(width), MIN_DEVICES_PANEL_WIDTH, MAX_DEVICES_PANEL_WIDTH);
    }

    private readonly expandedKeys = observable.set<string>();

    isExpanded(key: string) {
        return this.expandedKeys.has(key);
    }

    @action.bound
    setExpanded(key: string, expanded: boolean) {
        if (expanded) this.expandedKeys.add(key);
        else this.expandedKeys.delete(key);
    }

    // --- Tracking the captured traffic ---

    // Bumped on every change to the tracker, which is plain data, so computeds re-run
    @observable
    private revision = 0;

    private startTracking() {
        const { events } = this.eventsSource;
        if (!isObservableArray(events)) {
            console.warn("Devices can't follow traffic without an observable events list");
            return;
        }

        runInAction(() => {
            events.forEach((event) => this.tracker.add(event));
            this.revision += 1;
        });

        // The events list only changes by splicing (push, remove & clear all splice)
        this.disposers.push(observe(events as IObservableArray<CollectedEvent>, (change) => {
            runInAction(() => {
                if (change.type === 'splice') {
                    change.removed.forEach((event) => this.tracker.remove(event));
                    change.added.forEach((event) => this.tracker.add(event));
                } else {
                    this.tracker.remove(change.oldValue);
                    this.tracker.add(change.newValue);
                }
                this.revision += 1;
            });
        }));
    }

    // --- Names ---

    @observable.ref
    private customNames: ReadonlyMap<string, string>;

    @action.bound
    rename(deviceKey: string, name: string) {
        const cleanName = cleanDeviceName(name);
        const device = this.getDevice(deviceKey);
        // Renaming to the default name (or to nothing) forgets the custom one
        if (!cleanName || cleanName === (device?.defaultName ?? this.defaultNameFor(deviceKey))) {
            this.forgetName(deviceKey);
            return;
        }

        const names = new Map(this.customNames);
        names.set(deviceKey, cleanName);
        this.customNames = names;
        saveDeviceNames(names, this.options.nameStorage);
    }

    @action.bound
    forgetName(deviceKey: string) {
        if (!this.customNames.has(deviceKey)) return;
        const names = new Map(this.customNames);
        names.delete(deviceKey);

        this.customNames = names;
        saveDeviceNames(names, this.options.nameStorage);
    }

    private defaultNameFor(deviceKey: string) {
        return deviceKey === THIS_MACHINE_KEY ? getThisMachineName(this.thisMachineType) : undefined;
    }

    // --- The devices ---

    /**
     * Every device with captured traffic: this machine first, then the others in the
     * order they first sent something (so rows don't jump around).
     */
    @computed
    get devices(): ReadonlyArray<DeviceSummary> {
        this.revision; // Re-derived whenever the tracked traffic changes

        const devices = _.sortBy(
            [...this.tracker.devices.values()].map((stats) => this.summarise(stats)),
            [(device) => device.isThisMachine ? 0 : 1, (device) => device.firstSeen]
        );

        // Devices with the same name get the end of their IP added
        const sharedNames = _(devices)
            .filter((device) => !device.isThisMachine)
            .countBy((device) => device.name)
            .pickBy((count) => count > 1)
            .valueOf();

        return devices.map((device) =>
            sharedNames[device.name] && device.address
                ? { ...device, shortName: `${device.name} · ${addressSuffix(device.address)}` }
                : device
        );
    }

    private summarise(stats: DeviceStats): DeviceSummary {
        const { key } = stats;
        const isThisMachine = key === THIS_MACHINE_KEY;
        const type: DeviceType = isThisMachine ? this.thisMachineType : (stats.type ?? 'other');
        const defaultName = isThisMachine
            ? getThisMachineName(type)
            : (type === 'android' && stats.androidModel) || getDeviceTypeLabel(type);
        const customName = this.customNames.get(key);
        const name = customName ?? defaultName;

        return {
            key,
            isThisMachine,
            type,
            name,
            defaultName,
            hasCustomName: !!customName,
            shortName: name,
            address: isThisMachine ? undefined : key,
            addresses: _.sortBy([...stats.addresses.keys()].filter((address) => address !== THIS_MACHINE_KEY)),
            eventCount: stats.eventCount,
            firstSeen: stats.firstSeen,
            lastSeen: stats.lastSeen,
            apps: byCount([...stats.apps.values()].map((app) => ({ ...app })), (app) => app.name),
            hosts: byCount(
                [...stats.hosts.entries()].map(([host, count]) => ({ host, count })),
                (host) => host.host
            )
        };
    }

    @computed
    private get devicesByKey(): ReadonlyMap<string, DeviceSummary> {
        return new Map(this.devices.map((device) => [device.key, device]));
    }

    getDevice(deviceKey: string): DeviceSummary | undefined {
        return this.devicesByKey.get(deviceKey);
    }

    /**
     * This machine, which the panel always lists (with no requests, it's a placeholder).
     */
    @computed
    get thisMachine(): DeviceSummary {
        const device = this.devicesByKey.get(THIS_MACHINE_KEY);
        if (device) return device;

        const name = this.customNames.get(THIS_MACHINE_KEY) ?? getThisMachineName(this.thisMachineType);
        return {
            key: THIS_MACHINE_KEY,
            isThisMachine: true,
            type: this.thisMachineType,
            name,
            defaultName: getThisMachineName(this.thisMachineType),
            hasCustomName: this.customNames.has(THIS_MACHINE_KEY),
            shortName: name,
            address: undefined,
            addresses: [],
            eventCount: 0,
            firstSeen: 0,
            lastSeen: 0,
            apps: [],
            hosts: []
        };
    }

    // Phones & other computers: every device except this machine
    @computed
    get otherDevices(): ReadonlyArray<DeviceSummary> {
        return this.devices.filter((device) => !device.isThisMachine);
    }

    // Every captured event, for the "All devices" row
    get totalEventCount() {
        return this.eventsSource.events.length;
    }

    isActive(device: DeviceSummary, currentTime: number = now(ACTIVE_CHECK_INTERVAL_MS)) {
        return device.eventCount > 0 && currentTime - device.lastSeen < ACTIVE_WINDOW_MS;
    }

    // --- Which device sent an event ---

    // The device key for an event: an arrow function, as filters call it unbound
    readonly getEventDeviceKey = (event: ViewableEvent): string | undefined => {
        const clientEvent = getClientEvent(event);
        return this.tracker.getDeviceKey(clientEvent as CollectedEvent) ?? getEventDeviceKey(clientEvent);
    };

    // Each device's type, which only changes now and then (unlike its counts)
    @computed({ equals: comparer.structural })
    private get deviceTypes(): { [key: string]: DeviceType } {
        return _.fromPairs(this.devices.map((device) => [device.key, device.type]));
    }

    // For the text filters (device=iphone), through the device directory
    getEventDevice(event: ViewableEvent): EventDevice | undefined {
        const key = this.getEventDeviceKey(event);
        if (!key) return undefined;
        if (key === THIS_MACHINE_KEY) return { key, type: this.thisMachineType };

        const clientEvent = getClientEvent(event);
        const type = this.deviceTypes[key] ??
            (clientEvent.isHttp() ? detectDeviceType(clientEvent.request) : undefined);
        return { key, type: type ?? 'other' };
    }

    // --- The request list's device markers ---

    // Mixed traffic from several devices gets a device marker on each request row
    @computed
    get showDeviceMarkers() {
        return !this.selection && this.devices.length > 1;
    }

    @computed({ equals: comparer.structural })
    private get deviceMarkers(): { [key: string]: DeviceMarker } {
        return _.fromPairs(this.devices.map((device) => [device.key, {
            name: device.shortName,
            title: device.address ? `${device.name} (${device.address})` : device.name,
            type: device.type
        }]));
    }

    getDeviceMarker(event: ViewableEvent): DeviceMarker | undefined {
        const key = this.getEventDeviceKey(event);
        return key ? this.deviceMarkers[key] : undefined;
    }

    // --- Selection ---

    // Nothing selected means all devices
    @observable.ref
    selection: DeviceSelection | undefined = undefined;

    @action.bound
    select(selection: DeviceSelection | undefined) {
        if (!isSameSelection(selection, this.selection)) this.selection = selection;
    }

    @action.bound
    clearSelection() {
        this.selection = undefined;
    }

    // The selection, minus whatever isn't in the traffic any more (e.g. after Clear)
    @computed
    private get availableSelection(): DeviceSelection | undefined {
        const { selection } = this;
        if (!selection) return undefined;

        const device = this.devicesByKey.get(selection.deviceKey);
        if (!device) {
            // This machine is always listed, so it stays selected without traffic
            return selection.deviceKey === THIS_MACHINE_KEY ? { deviceKey: THIS_MACHINE_KEY } : undefined;
        }

        if (
            (selection.app !== undefined && !device.apps.some((app) => app.name === selection.app)) ||
            (selection.host !== undefined && !device.hosts.some((host) => host.host === selection.host))
        ) {
            return { deviceKey: selection.deviceKey };
        }
        return selection;
    }

    private watchSelection() {
        this.disposers.push(reaction(
            () => this.availableSelection,
            (available) => this.select(available),
            { equals: isSameSelection }
        ));
    }

    // The selection as a filter, for View to AND with the filters typed in its filter box
    @computed
    get selectionFilter(): DeviceSelectionFilter | undefined {
        const { selection } = this;
        if (!selection) return undefined;

        return new DeviceSelectionFilter(
            selection,
            () => this.describeSelection(selection),
            this.getEventDeviceKey
        );
    }

    // "iPhone", or "iPhone › Safari" for an app on it
    describeSelection(selection: DeviceSelection) {
        const device = selection.deviceKey === THIS_MACHINE_KEY
            ? this.thisMachine
            : this.devicesByKey.get(selection.deviceKey);

        return [device?.shortName ?? selection.deviceKey, selection.app, selection.host]
            .filter((part) => part !== undefined)
            .join(' › ');
    }
}
