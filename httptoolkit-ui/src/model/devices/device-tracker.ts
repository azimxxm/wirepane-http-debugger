import type { CollectedEvent, HttpExchangeView } from '../../types';
import type { IconProps } from '../../icons';
import { getHeaderValue } from '../http/headers';

import {
    DeviceType,
    THIS_MACHINE_KEY,
    detectDeviceType,
    getAndroidModel,
    getAppName,
    getDeviceKey,
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

// Everything seen from one device: this machine, or one client IP
export interface DeviceStats {
    key: string; // THIS_MACHINE_KEY, or the device's IP
    eventCount: number;
    firstSeen: number;
    lastSeen: number;
    // From the user agents. Only for other devices: this machine's comes from its platform.
    type: DeviceType | undefined;
    androidModel: string | undefined;
    // The addresses its traffic came from: one IP, or this machine's loopback addresses
    addresses: Map<string, number>;
    apps: Map<string, AppCount>;
    hosts: Map<string, number>;
}

// What one event added, so removing it takes away exactly that
interface Contribution {
    stats: DeviceStats;
    address: string;
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
 * Counts captured events by the device they came from, with their apps and hosts.
 * It's updated one event at a time as events are added and removed, so it stays
 * cheap with lots of traffic.
 */
export class DeviceTracker {

    private readonly stats = new Map<string, DeviceStats>();
    private contributions = new WeakMap<CollectedEvent, Contribution>();

    get devices(): ReadonlyMap<string, DeviceStats> {
        return this.stats;
    }

    // The device an event was counted under, if it was counted
    getDeviceKey(event: CollectedEvent): string | undefined {
        return this.contributions.get(event)?.stats.key;
    }

    add(event: CollectedEvent) {
        if (this.contributions.has(event)) return;

        const address = getEventAddress(event);
        if (!address) return;
        const key = getDeviceKey(address);

        let stats = this.stats.get(key);
        const time = getEventTime(event);
        if (!stats) {
            stats = {
                key,
                eventCount: 0,
                firstSeen: time,
                lastSeen: time,
                type: undefined,
                androidModel: undefined,
                addresses: new Map(),
                apps: new Map(),
                hosts: new Map()
            };
            this.stats.set(key, stats);
        }

        stats.eventCount += 1;
        stats.firstSeen = Math.min(stats.firstSeen, time);
        stats.lastSeen = Math.max(stats.lastSeen, time);
        increment(stats.addresses, address);

        let app: string | undefined;
        if (event.isHttp()) {
            app = getAppName(event.request);
            const appCount = stats.apps.get(app);
            if (appCount) appCount.count += 1;
            else stats.apps.set(app, { name: app, count: 1, icon: event.request.source.icon });

            if (key !== THIS_MACHINE_KEY) this.updateType(stats, event);
        }

        const host = getEventHost(event);
        if (host) increment(stats.hosts, host);

        this.contributions.set(event, { stats, address, app, host });
    }

    remove(event: CollectedEvent) {
        const contribution = this.contributions.get(event);
        if (!contribution) return;
        this.contributions.delete(event);

        const { stats, address, app, host } = contribution;
        stats.eventCount -= 1;
        decrement(stats.addresses, address);

        if (app) {
            const appCount = stats.apps.get(app);
            if (appCount && appCount.count > 1) appCount.count -= 1;
            else stats.apps.delete(app);
        }
        if (host) decrement(stats.hosts, host);

        if (stats.eventCount <= 0 && this.stats.get(stats.key) === stats) {
            this.stats.delete(stats.key);
        }
    }

    clear() {
        this.stats.clear();
        this.contributions = new WeakMap();
    }

    // The latest request decides, unless it's less sure than what's known already
    private updateType(stats: DeviceStats, event: HttpExchangeView) {
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
