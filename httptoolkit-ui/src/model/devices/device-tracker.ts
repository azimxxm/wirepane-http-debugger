import type { CollectedEvent, HttpExchangeView } from '../../types';
import type { IconProps } from '../../icons';
import { getHeaderValue } from '../http/headers';
import { isLoopbackAddress } from '../interception/phone-setup';

import {
    DeviceType,
    THIS_MACHINE_KEY,
    detectDeviceType,
    getAndroidModel,
    getAppName,
    getEventAddress,
    getEventHost,
    getEventTime,
    getTypeRank
} from './device-model';

export interface AppCount {
    name: string;
    count: number;
    // The Source column's icon for the app's first request
    icon: IconProps;
}

/**
 * Everything seen from one client address. This machine usually has several of these
 * (127.0.0.1, ::1, its LAN address), which the store merges into one device.
 */
export interface AddressStats {
    address: string; // A normalised IP, or THIS_MACHINE_KEY for requests from Send
    eventCount: number;
    firstSeen: number;
    lastSeen: number;
    type: DeviceType | undefined;
    androidModel: string | undefined;
    apps: Map<string, AppCount>;
    hosts: Map<string, number>;
}

// What one event added, so removing it takes away exactly that
interface Contribution {
    stats: AddressStats;
    app: string | undefined;
    host: string | undefined;
}

function increment(counts: Map<string, number>, key: string) {
    counts.set(key, (counts.get(key) ?? 0) + 1);
}

function decrement(counts: Map<string, number>, key: string) {
    const count = (counts.get(key) ?? 0) - 1;
    if (count > 0) counts.set(key, count);
    else counts.delete(key);
}

/**
 * Counts captured events by the address they came from, with their apps and hosts.
 * It's updated one event at a time as events are added and removed, so it stays
 * cheap with lots of traffic.
 */
export class DeviceTracker {

    private readonly stats = new Map<string, AddressStats>();
    private contributions = new WeakMap<CollectedEvent, Contribution>();

    get addresses(): ReadonlyMap<string, AddressStats> {
        return this.stats;
    }

    // The address an event was counted under, if it was counted
    getAddress(event: CollectedEvent): string | undefined {
        return this.contributions.get(event)?.stats.address;
    }

    add(event: CollectedEvent) {
        if (this.contributions.has(event)) return;

        const address = getEventAddress(event);
        if (!address) return;

        let stats = this.stats.get(address);
        const time = getEventTime(event);
        if (!stats) {
            stats = {
                address,
                eventCount: 0,
                firstSeen: time,
                lastSeen: time,
                type: undefined,
                androidModel: undefined,
                apps: new Map(),
                hosts: new Map()
            };
            this.stats.set(address, stats);
        }

        stats.eventCount += 1;
        stats.firstSeen = Math.min(stats.firstSeen, time);
        stats.lastSeen = Math.max(stats.lastSeen, time);

        let app: string | undefined;
        if (event.isHttp()) {
            app = getAppName(event.request);
            const appCount = stats.apps.get(app);
            if (appCount) appCount.count += 1;
            else stats.apps.set(app, { name: app, count: 1, icon: event.request.source.icon });

            // This machine's type comes from its platform instead
            if (address !== THIS_MACHINE_KEY && !isLoopbackAddress(address)) {
                this.updateType(stats, event);
            }
        }

        const host = getEventHost(event);
        if (host) increment(stats.hosts, host);

        this.contributions.set(event, { stats, app, host });
    }

    remove(event: CollectedEvent) {
        const contribution = this.contributions.get(event);
        if (!contribution) return;
        this.contributions.delete(event);

        const { stats, app, host } = contribution;
        stats.eventCount -= 1;

        if (app) {
            const appCount = stats.apps.get(app);
            if (appCount && appCount.count > 1) appCount.count -= 1;
            else stats.apps.delete(app);
        }
        if (host) decrement(stats.hosts, host);

        if (stats.eventCount <= 0 && this.stats.get(stats.address) === stats) {
            this.stats.delete(stats.address);
        }
    }

    clear() {
        this.stats.clear();
        this.contributions = new WeakMap();
    }

    // The latest request decides, unless it's less sure than what's known already
    private updateType(stats: AddressStats, event: HttpExchangeView) {
        const type = detectDeviceType(event.request);
        if (!type) return;

        if (!stats.type || getTypeRank(type) >= getTypeRank(stats.type)) {
            if (type !== stats.type) stats.androidModel = undefined;
            stats.type = type;
        }

        if (stats.type === 'android' && type === 'android') {
            const model = getAndroidModel(getHeaderValue(event.request.headers, 'user-agent'));
            if (model) stats.androidModel = model;
        }
    }
}
