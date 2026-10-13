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
import { getSystemLabel } from './app-identity';
import {
    DeviceType,
    THIS_MACHINE_KEY,
    detectDeviceType,
    getClientEvent,
    getDeviceTypeLabel,
    getEventAppName as getRequestEventAppName,
    getEventDeviceKey,
    getEventVpn,
    getThisMachineName,
    getTypeRank,
    isDeviceType
} from './device-model';
import { DeviceDirectory, EventDevice, THIS_MACHINE_TYPE, setDeviceDirectory } from './device-directory';
import { NameStorage, cleanDeviceName, loadDeviceNames, saveDeviceNames } from './device-names';
import { DeviceSelection, DeviceSelectionFilter, isSameSelection } from './device-selection-filter';
import { VpnPeerNames, describeVpn } from './vpn-peer-names'; // wirepane

export const DEFAULT_DEVICES_PANEL_WIDTH = 216;
export const MIN_DEVICES_PANEL_WIDTH = 180;
export const MAX_DEVICES_PANEL_WIDTH = 440;

// Where the panel's width & the user's show/hide choice are saved
export const DEVICES_STORE_KEY = 'devices-store';

export type PanelChoice = 'open' | 'closed';

// Older versions saved only whether the panel was open, which it was by default. A saved
// "hidden" can only have come from the user, so it stays their choice.
export function migrateSavedPanelState(data: { panelOpen?: unknown, panelChoice?: unknown }) {
    if (data.panelChoice !== undefined || data.panelOpen !== false) return data;
    return { ...data, panelChoice: 'closed' };
}

// A device pinned to the top of the panel, with what its row shows while it has no traffic
export interface PinnedDevice {
    key: string;
    type: DeviceType;
    defaultName: string;
}

// The saved pins. Older versions saved none, and a pin that can't be read is left out.
function readSavedPins(saved: unknown): PinnedDevice[] {
    if (!Array.isArray(saved)) return [];

    const pins: PinnedDevice[] = [];
    saved.forEach((item: unknown) => {
        if (!item || typeof item !== 'object') return;
        const { key, type, defaultName } = item as { [field in keyof PinnedDevice]?: unknown };
        if (typeof key !== 'string' || !key || pins.some((pin) => pin.key === key)) return;

        const pinType = isDeviceType(type) ? type : 'other';
        pins.push({
            key,
            type: pinType,
            defaultName: typeof defaultName === 'string' && defaultName ? defaultName : getDeviceTypeLabel(pinType)
        });
    });
    return pins;
}

function migrateSavedState(data: { [field: string]: unknown }) {
    return { ...migrateSavedPanelState(data), pins: readSavedPins(data.pins) };
}

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
    // wirepane: its traffic comes through the VPN tunnel (some or all of it), from these peers
    viaVpn: boolean;
    vpnPeers: string[];
}

// What a request row's device marker shows. Unlike DeviceSummary it doesn't change with
// every request, so the rows only re-render when a name or type changes.
export interface DeviceMarker {
    name: string;
    title: string;
    type: DeviceType;
    viaVpn: boolean;
}

// The captured traffic: the events store, or a plain list in tests
interface EventsSource {
    readonly events: ReadonlyArray<CollectedEvent>;
    // Deletes many events at once. Without it, a device's traffic can't be cleared.
    deleteEvents?(events: ReadonlyArray<CollectedEvent>): void;
}

interface DevicesStoreOptions {
    nameStorage?: NameStorage;
    thisMachineType?: DeviceType;
    // wirepane: the VPN devices' names. Tests give their own, so none asks a server.
    vpnPeerNames?: VpnPeerNames;
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
 * It also keeps the Devices panel's state: what's selected, names, pins, width & visibility.
 */
export class DevicesStore implements DeviceDirectory {

    private readonly tracker = new DeviceTracker();
    private readonly thisMachineType: DeviceType;
    private readonly vpnPeerNames: VpnPeerNames; // wirepane
    private disposers: Array<Lambda | IReactionDisposer> = [];

    constructor(
        private readonly eventsSource: EventsSource,
        private readonly options: DevicesStoreOptions = {}
    ) {
        this.thisMachineType = options.thisMachineType ?? THIS_MACHINE_TYPE;
        this.vpnPeerNames = options.vpnPeerNames ?? new VpnPeerNames();
        this.customNames = loadDeviceNames(options.nameStorage);
    }

    readonly initialized = lazyObservablePromise(async () => {
        try {
            await hydrate({
                key: DEVICES_STORE_KEY,
                store: this,
                dataTransform: migrateSavedState
            });
        } catch (e) {
            // Only the panel's width, visibility & pins are saved, so the defaults are fine
            console.warn("Couldn't restore the Devices panel layout", e);
        }

        this.startTracking();
        this.watchForOtherDevices();
        this.watchVpnPeers();
        this.watchSelection();
        this.watchPins();
        setDeviceDirectory(this);

        console.log('Devices store initialized');
    });

    dispose() {
        this.disposers.forEach((dispose) => dispose());
        this.disposers = [];
        setDeviceDirectory(undefined);
    }

    // --- Panel state ---

    // The user's own choice, once they've shown or hidden the panel. Until then it stays out of
    // the way while all the traffic is from this machine, and opens once another device sends some,
    // or straight away when a phone or another computer is pinned.
    @persist @observable
    panelChoice: PanelChoice | undefined = undefined;

    // Stays set after Clear, so the panel doesn't close again between a phone's requests
    @observable
    private hasSeenOtherDevices = false;

    @computed
    get panelOpen(): boolean {
        return this.panelChoice !== undefined
            ? this.panelChoice === 'open'
            : this.hasSeenOtherDevices || this.pins.some((pin) => pin.key !== THIS_MACHINE_KEY);
    }

    @persist @observable
    panelWidth = DEFAULT_DEVICES_PANEL_WIDTH;

    @action.bound
    togglePanel() {
        this.panelChoice = this.panelOpen ? 'closed' : 'open';
    }

    @action.bound
    showPanel() {
        this.panelChoice = 'open';
    }

    private watchForOtherDevices() {
        this.disposers.push(reaction(
            () => this.otherDevices.length > 0,
            (hasOtherDevices) => {
                if (hasOtherDevices) runInAction(() => { this.hasSeenOtherDevices = true; });
            },
            { fireImmediately: true }
        ));
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
                    // Deleting many events at once replaces the whole list: the events that stay
                    // are in both lists, and keep what they were counted under
                    const added = new Set(change.added);
                    change.removed.forEach((event) => { if (!added.has(event)) this.tracker.remove(event); });
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
        // Renaming to the default name (or to nothing) forgets the custom one
        if (!cleanName || cleanName === this.getListedDevice(deviceKey)?.defaultName) {
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
            // wirepane: the requests of an SDK count under the app they came from
            apps: stats.apps.grouped(getSystemLabel(type)),
            hosts: byCount(
                [...stats.hosts.entries()].map(([host, count]) => ({ host, count })),
                (host) => host.host
            ),
            viaVpn: stats.vpnEvents > 0,
            vpnPeers: _.sortBy([...stats.vpnPeers.keys()])
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
        return this.devicesByKey.get(THIS_MACHINE_KEY) ??
            this.placeholder(THIS_MACHINE_KEY, this.thisMachineType, getThisMachineName(this.thisMachineType));
    }

    // The row of a device the panel lists without traffic: this machine, or a pinned device
    private placeholder(key: string, type: DeviceType, defaultName: string): DeviceSummary {
        const isThisMachine = key === THIS_MACHINE_KEY;
        const name = this.customNames.get(key) ?? defaultName;
        return {
            key,
            isThisMachine,
            type,
            name,
            defaultName,
            hasCustomName: this.customNames.has(key),
            shortName: name,
            address: isThisMachine ? undefined : key,
            addresses: [],
            eventCount: 0,
            firstSeen: 0,
            lastSeen: 0,
            apps: [],
            hosts: [],
            viaVpn: false,
            vpnPeers: []
        };
    }

    // A device the panel lists: one with traffic, this machine, or a pinned device
    getListedDevice(deviceKey: string): DeviceSummary | undefined {
        if (deviceKey === THIS_MACHINE_KEY) return this.thisMachine;
        return this.devicesByKey.get(deviceKey) ?? this.pinnedDevices.find((device) => device.key === deviceKey);
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

    // The names the Devices panel lists each device's apps under, by the key their requests were counted under
    @computed
    private get appNamesByDevice(): ReadonlyMap<string, ReadonlyMap<string, string>> {
        return new Map(this.devices.map((device) => [
            device.key,
            new Map(_.flatMap(device.apps, (app) => app.keys.map((key): [string, string] => [key, app.name])))
        ]));
    }

    /**
     * The app an event is listed under in the Devices panel (and so what app= matches). An
     * SDK's request is listed under the app it was tied to, which the request alone doesn't say.
     */
    readonly getEventAppName = (event: ViewableEvent): string | undefined => {
        const clientEvent = getClientEvent(event);
        const collected = clientEvent as CollectedEvent;
        const deviceKey = this.tracker.getDeviceKey(collected);
        const appKey = this.tracker.getAppKey(collected);

        const name = deviceKey && appKey
            ? this.appNamesByDevice.get(deviceKey)?.get(appKey)
            : undefined;
        return name ?? getRequestEventAppName(clientEvent);
    };

    // --- Pinned devices ---

    // The devices pinned to the top of the panel, in the order they were pinned
    @persist('list') @observable.ref
    private pins: ReadonlyArray<PinnedDevice> = [];

    isPinned(deviceKey: string) {
        return this.pins.some((pin) => pin.key === deviceKey);
    }

    @action.bound
    pin(deviceKey: string) {
        const device = this.getListedDevice(deviceKey);
        if (!device || this.isPinned(deviceKey)) return;
        this.pins = [...this.pins, { key: device.key, type: device.type, defaultName: device.defaultName }];
    }

    @action.bound
    unpin(deviceKey: string) {
        if (this.isPinned(deviceKey)) this.pins = this.pins.filter((pin) => pin.key !== deviceKey);
    }

    /**
     * The pinned devices, which the panel lists first, in the order they were pinned. One without
     * traffic (after Clear, or before it reconnects) stays listed as a placeholder, with the name
     * & icon it had.
     */
    @computed
    get pinnedDevices(): ReadonlyArray<DeviceSummary> {
        return this.pins.map((pin) => pin.key === THIS_MACHINE_KEY
            ? this.thisMachine
            : this.devicesByKey.get(pin.key) ?? this.placeholder(pin.key, pin.type, pin.defaultName)
        );
    }

    // Saves what a pinned device's placeholder needs again whenever the device says more about
    // itself, like a phone that's known as "Android" until its browser names the model. A device's
    // counts start again after Clear, so until it identifies itself it's only "Device" (a tunnel,
    // a TLS failure) or "Android" (okhttp), and that doesn't replace what the pin knows.
    private watchPins() {
        this.disposers.push(reaction(
            () => this.pins.map((pin) => {
                const device = this.devicesByKey.get(pin.key);
                if (!device) return pin;

                const isMoreSpecific = getTypeRank(device.type) > getTypeRank(pin.type) ||
                    (device.type === pin.type && device.defaultName !== getDeviceTypeLabel(device.type));
                return isMoreSpecific ? { key: pin.key, type: device.type, defaultName: device.defaultName } : pin;
            }),
            (pins) => { if (!comparer.structural(pins, this.pins)) this.pins = pins; },
            { equals: comparer.structural, fireImmediately: true }
        ));
    }

    // How many of the requests Clear deletes (all but the pinned ones) each pinned device sent. Its
    // question says so, as pinning a device keeps it listed, but not its traffic.
    pinnedDeviceTraffic(): Array<{ name: string, count: number }> {
        const counts = _.countBy(
            this.eventsSource.events.filter((event) => !event.pinned),
            (event) => this.tracker.getDeviceKey(event)
        );
        return this.pinnedDevices.map((device) => ({ name: device.name, count: counts[device.key] ?? 0 }));
    }

    // --- Clearing one device's traffic ---

    // Whatever the panel counts for the device, except pinned requests, which Clear keeps too
    private isClearable(event: CollectedEvent, deviceKey: string) {
        return !event.pinned && this.tracker.getDeviceKey(event) === deviceKey;
    }

    // False when the device has no traffic, or only pinned requests
    canClearTraffic(deviceKey: string) {
        if (!this.eventsSource.deleteEvents || !this.devicesByKey.has(deviceKey)) return false;
        return this.eventsSource.events.some((event) => this.isClearable(event, deviceKey));
    }

    /**
     * Deletes one device's traffic in one go, leaving every other device's alone. Its pinned
     * requests stay, as they do with Clear. Returns the deleted events.
     */
    @action.bound
    clearTraffic(deviceKey: string): ReadonlyArray<CollectedEvent> {
        const source = this.eventsSource;
        if (!source.deleteEvents) return [];

        const deleted = source.events.filter((event) => this.isClearable(event, deviceKey));
        if (deleted.length > 0) source.deleteEvents(deleted);
        return deleted;
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
            type: device.type,
            viaVpn: device.viaVpn
        }]));
    }

    getDeviceMarker(event: ViewableEvent): DeviceMarker | undefined {
        const key = this.getEventDeviceKey(event);
        return key ? this.deviceMarkers[key] : undefined;
    }

    // --- VPN devices ---

    // wirepane: the ids of the VPN peers in the captured traffic. Just the ids, as the names
    // come from the server and so don't need the tracker's counts.
    @computed({ equals: comparer.structural })
    private get vpnPeerIds(): string[] {
        this.revision; // Re-derived whenever the tracked traffic changes
        return _.sortBy(_.uniq(_.flatMap(
            [...this.tracker.devices.values()],
            (stats) => [...stats.vpnPeers.keys()]
        )));
    }

    // Asks the server for the peers' names when the first VPN traffic arrives, and again only
    // when a peer shows up that it hasn't named (a second phone), never on a timer.
    private watchVpnPeers() {
        this.disposers.push(reaction(
            () => this.vpnPeerIds,
            (peerIds) => { this.vpnPeerNames.ensureNamed(peerIds); },
            { equals: comparer.structural, fireImmediately: true }
        ));
    }

    // What the Devices panel says about a device that connected through the VPN: "through the
    // VPN (iPhone)", with the names the server gave its peers
    describeDeviceVpn(device: Pick<DeviceSummary, 'vpnPeers'>): string {
        return describeVpn(this.vpnPeerNames.namesOf(device.vpnPeers));
    }

    /**
     * What a request row says about the VPN, if that request itself came through the tunnel.
     * A phone that used the proxy directly as well has rows of both kinds, so this is
     * per request, unlike the device's `viaVpn`.
     */
    describeEventVpn(event: ViewableEvent): string | undefined {
        const vpn = getEventVpn(getClientEvent(event));
        if (!vpn) return undefined;
        return describeVpn(vpn.peer ? [this.vpnPeerNames.nameOf(vpn.peer)] : []);
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
            // This machine & pinned devices are always listed, so they stay selected without traffic
            return selection.deviceKey === THIS_MACHINE_KEY || this.isPinned(selection.deviceKey)
                ? { deviceKey: selection.deviceKey }
                : undefined;
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
            this.getEventDeviceKey,
            this.getEventAppName
        );
    }

    // "iPhone", or "iPhone › Safari" for an app on it
    describeSelection(selection: DeviceSelection) {
        const device = this.getListedDevice(selection.deviceKey);

        return [device?.shortName ?? selection.deviceKey, selection.app, selection.host]
            .filter((part) => part !== undefined)
            .join(' › ');
    }
}
