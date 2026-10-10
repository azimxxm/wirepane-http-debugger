import * as _ from 'lodash';
import {
    action,
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
import { getNetworkInterfaces } from '../../services/server-api';

import { AddressStats, AppCount, DeviceTracker } from './device-tracker';
import {
    DeviceType,
    THIS_MACHINE_KEY,
    detectDeviceType,
    getDeviceKey,
    getDeviceTypeLabel,
    getEventAddress,
    getThisMachineName,
    isThisMachineAddress,
    normalizeAddress
} from './device-model';
import { DeviceDirectory, EventDevice, THIS_MACHINE_TYPE, setDeviceDirectory } from './device-directory';
import { NameStorage, cleanDeviceName, loadDeviceNames, saveDeviceNames } from './device-names';
import { DeviceSelection, DeviceSelectionFilter, isSameSelection } from './device-selection-filter';

export const DEFAULT_DEVICES_PANEL_WIDTH = 248;
export const MIN_DEVICES_PANEL_WIDTH = 200;
export const MAX_DEVICES_PANEL_WIDTH = 440;

// A device is shown as active if it sent something in the last minute
export const ACTIVE_WINDOW_MS = 60_000;
const ACTIVE_CHECK_INTERVAL_MS = 5_000;

// A new client address might be this machine's, if its network changed since startup.
// Checking means asking the server, so it's done at most this often:
const ADDRESS_RECHECK_INTERVAL_MS = 30_000;

export interface DeviceHost {
    host: string;
    count: number;
}

export interface DeviceSummary {
    key: string; // THIS_MACHINE_KEY, or the device's IP
    isThisMachine: boolean;
    type: DeviceType;
    name: string; // The user's name for it, or the default one
    defaultName: string;
    hasCustomName: boolean;
    // For the request list: the name, or the type, plus the end of the IP if needed
    shortName: string;
    // The addresses its traffic came from (this machine can have several)
    addresses: string[];
    eventCount: number;
    firstSeen: number;
    lastSeen: number;
    apps: AppCount[]; // Most requests first
    hosts: DeviceHost[]; // Most requests first
}

interface DevicesStoreOptions {
    // This machine's own addresses (default: asked from the server)
    loadOwnAddresses?: () => Promise<string[]>;
    nameStorage?: NameStorage;
    thisMachineType?: DeviceType;
}

async function loadServerAddresses(): Promise<string[]> {
    const interfaces = await getNetworkInterfaces();
    return _.flatMap(Object.values(interfaces), (addresses) =>
        (addresses ?? []).map((info) => info.address)
    );
}

// The end of an address, to tell apart devices with the same name: ".23" or ":5a2f"
function addressSuffix(address: string) {
    const ipv4End = /\.(\d+)$/.exec(address);
    if (ipv4End) return `.${ipv4End[1]}`;
    return `:${_.last(address.split(':'))}`;
}

function mergeApps(statsList: AddressStats[]): AppCount[] {
    const apps = new Map<string, AppCount>();
    statsList.forEach((stats) => stats.apps.forEach((app) => {
        const existing = apps.get(app.name);
        if (existing) existing.count += app.count;
        else apps.set(app.name, { ...app });
    }));
    return _.orderBy([...apps.values()], ['count', 'name'], ['desc', 'asc']);
}

function mergeHosts(statsList: AddressStats[]): DeviceHost[] {
    const hosts = new Map<string, number>();
    statsList.forEach((stats) => stats.hosts.forEach((count, host) => {
        hosts.set(host, (hosts.get(host) ?? 0) + count);
    }));
    return _.orderBy(
        [...hosts.entries()].map(([host, count]) => ({ host, count })),
        ['count', 'host'],
        ['desc', 'asc']
    );
}

/**
 * The devices that sent the captured traffic, told apart by their IP address: this
 * machine (loopback & its own addresses) and each phone or computer on the network.
 * It also keeps the Devices panel's state: what's selected, names, width & visibility.
 */
export class DevicesStore implements DeviceDirectory {

    private readonly tracker = new DeviceTracker();
    private readonly thisMachineType: DeviceType;
    private disposers: Array<Lambda | IReactionDisposer> = [];

    constructor(
        private readonly eventsSource: { readonly events: ReadonlyArray<CollectedEvent> },
        private readonly networkSource: { readonly externalNetworkAddresses: ReadonlyArray<string> },
        private readonly options: DevicesStoreOptions = {}
    ) {
        this.thisMachineType = options.thisMachineType ?? THIS_MACHINE_TYPE;
        this.customNames = loadDeviceNames(options.nameStorage);
    }

    readonly initialized = lazyObservablePromise(async () => {
        await hydrate({ key: 'devices-store', store: this });

        this.startTracking();
        this.watchOwnAddresses();
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
        if (!isObservableArray(events)) throw new Error('Devices need an observable events list');

        runInAction(() => {
            events.forEach((event) => this.tracker.add(event));
            this.revision += 1;
        });

        this.disposers.push(observe(events as IObservableArray<CollectedEvent>, (change) => {
            runInAction(() => {
                const addressCount = this.tracker.addresses.size;

                if (change.type === 'splice') {
                    change.removed.forEach((event) => this.tracker.remove(event));
                    change.added.forEach((event) => this.tracker.add(event));
                } else {
                    this.tracker.remove(change.oldValue);
                    this.tracker.add(change.newValue);
                }
                this.revision += 1;

                if (this.tracker.addresses.size > addressCount) this.checkNewAddresses();
            });
        }));
    }

    // --- This machine's addresses ---

    // Only ever grows: an address that was this machine's earlier still means its traffic
    @observable.ref
    private ownAddresses: ReadonlySet<string> = new Set();

    @action
    private addOwnAddresses(addresses: ReadonlyArray<string>) {
        const normalized = addresses
            .map((address) => normalizeAddress(address))
            .filter((address): address is string => !!address);
        if (normalized.every((address) => this.ownAddresses.has(address))) return;

        this.ownAddresses = new Set([...this.ownAddresses, ...normalized]);
    }

    private watchOwnAddresses() {
        this.disposers.push(reaction(
            () => this.networkSource.externalNetworkAddresses.slice(),
            (addresses) => this.addOwnAddresses(addresses),
            { fireImmediately: true }
        ));
        this.refreshOwnAddresses();
    }

    private async refreshOwnAddresses() {
        try {
            const addresses = await (this.options.loadOwnAddresses ?? loadServerAddresses)();
            this.addOwnAddresses(addresses);
        } catch (e) {
            console.warn("Couldn't read this machine's network addresses", e);
        }
    }

    private readonly recheckOwnAddresses = _.throttle(
        () => this.refreshOwnAddresses(),
        ADDRESS_RECHECK_INTERVAL_MS,
        { trailing: false }
    );

    private checkNewAddresses() {
        const hasUnknownAddress = [...this.tracker.addresses.keys()].some((address) =>
            !isThisMachineAddress(address, this.ownAddresses)
        );
        if (hasUnknownAddress) this.recheckOwnAddresses();
    }

    // --- Names ---

    @observable.ref
    private customNames: ReadonlyMap<string, string>;

    @action.bound
    rename(deviceKey: string, name: string) {
        const cleanName = cleanDeviceName(name);
        const names = new Map(this.customNames);
        if (cleanName) names.set(deviceKey, cleanName);
        else names.delete(deviceKey);

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

    // --- The devices ---

    /**
     * Every device with captured traffic: this machine first, then the others in the
     * order they first sent something (so rows don't jump around).
     */
    @computed
    get devices(): ReadonlyArray<DeviceSummary> {
        this.revision; // Re-derived whenever the tracked traffic changes

        const groups = _.groupBy(
            [...this.tracker.addresses.values()],
            (stats) => getDeviceKey(stats.address, this.ownAddresses)
        );

        const devices = _.sortBy(
            Object.entries(groups).map(([key, statsList]) => this.summarise(key, statsList)),
            [(device) => device.isThisMachine ? 0 : 1, (device) => device.firstSeen]
        );

        // Devices with the same name in the list get the end of their IP added
        const sharedShortNames = _(devices)
            .countBy((device) => device.shortName)
            .pickBy((count) => count > 1)
            .valueOf();

        return devices.map((device) =>
            sharedShortNames[device.shortName] && !device.isThisMachine && !device.hasCustomName
                ? { ...device, shortName: `${device.shortName} · ${addressSuffix(device.key)}` }
                : device
        );
    }

    private summarise(key: string, statsList: AddressStats[]): DeviceSummary {
        const isThisMachine = key === THIS_MACHINE_KEY;
        const customName = this.customNames.get(key);

        let type: DeviceType;
        let typeLabel: string;
        let defaultName: string;
        if (isThisMachine) {
            type = this.thisMachineType;
            typeLabel = defaultName = getThisMachineName(type);
        } else {
            const [stats] = statsList; // Other devices have a single address
            type = stats.type ?? 'other';
            typeLabel = (type === 'android' && stats.androidModel) || getDeviceTypeLabel(type);
            defaultName = `${typeLabel} · ${key}`;
        }

        return {
            key,
            isThisMachine,
            type,
            name: customName ?? defaultName,
            defaultName,
            hasCustomName: !!customName,
            shortName: customName ?? typeLabel,
            addresses: _.sortBy(statsList
                .map((stats) => stats.address)
                .filter((address) => address !== THIS_MACHINE_KEY)
            ),
            eventCount: _.sumBy(statsList, (stats) => stats.eventCount),
            firstSeen: _.min(statsList.map((stats) => stats.firstSeen))!,
            lastSeen: _.max(statsList.map((stats) => stats.lastSeen))!,
            apps: mergeApps(statsList),
            hosts: mergeHosts(statsList)
        };
    }

    @computed
    private get devicesByKey(): ReadonlyMap<string, DeviceSummary> {
        return new Map(this.devices.map((device) => [device.key, device]));
    }

    getDevice(deviceKey: string): DeviceSummary | undefined {
        return this.devicesByKey.get(deviceKey);
    }

    // Every captured event, for the "All devices" row
    get totalEventCount() {
        return this.eventsSource.events.length;
    }

    @computed
    get otherDeviceCount() {
        return this.devices.filter((device) => !device.isThisMachine).length;
    }

    isActive(device: DeviceSummary, currentTime: number = now(ACTIVE_CHECK_INTERVAL_MS)) {
        return currentTime - device.lastSeen < ACTIVE_WINDOW_MS;
    }

    // The device key for an event: an arrow function, as filters call it unbound
    readonly getEventDeviceKey = (event: ViewableEvent): string | undefined => {
        const clientEvent = event.isHttp() ? event.downstream : event;
        const address = this.tracker.getAddress(clientEvent as CollectedEvent) ??
            getEventAddress(clientEvent);
        if (!address) return undefined;
        return getDeviceKey(address, this.ownAddresses);
    };

    getEventDevice(event: ViewableEvent): EventDevice | undefined {
        const key = this.getEventDeviceKey(event);
        if (!key) return undefined;
        if (key === THIS_MACHINE_KEY) return { key, type: this.thisMachineType };

        this.revision; // A device's type can change as more of its requests arrive
        const type = this.tracker.addresses.get(key)?.type ??
            (event.isHttp() ? detectDeviceType(event.request) : undefined);
        return { key, type: type ?? 'other' };
    }

    // The device an event came from, for the markers in the request list
    getDeviceForEvent(event: ViewableEvent): DeviceSummary | undefined {
        const key = this.getEventDeviceKey(event);
        return key ? this.devicesByKey.get(key) : undefined;
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
        if (!device) return undefined;

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

    describeSelection(selection: DeviceSelection) {
        const device = this.devicesByKey.get(selection.deviceKey);
        return [device?.name ?? selection.deviceKey, selection.app, selection.host]
            .filter((part) => part !== undefined)
            .join(' › ');
    }

    // Mixed traffic from several devices gets a device marker on each request row
    @computed
    get showDeviceMarkers() {
        return !this.selection && this.devices.length > 1;
    }
}
