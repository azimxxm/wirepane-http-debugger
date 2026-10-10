import type { ViewableEvent } from '../../types';

import {
    DeviceType,
    THIS_MACHINE_KEY,
    detectDeviceType,
    getDeviceKey,
    getEventAddress
} from './device-model';

export interface EventDevice {
    // THIS_MACHINE_KEY, or the device's IP address
    key: string;
    type: DeviceType;
}

/**
 * Says which device sent an event. The devices store is the real one: it knows this
 * machine's addresses and what each device's earlier requests said about it. The
 * text filters (device=, client-ip=) are created from strings, so they look it up here.
 */
export interface DeviceDirectory {
    getEventDevice(event: ViewableEvent): EventDevice | undefined;
}

// The type of the machine Wirepane runs on. Read here rather than from util/ui, which
// would pull UI services into the filters.
const platform = typeof navigator !== 'undefined' ? navigator.platform : '';
export const THIS_MACHINE_TYPE: DeviceType = platform.startsWith('Mac')
    ? 'mac'
    : platform.startsWith('Win')
        ? 'windows'
        : 'linux';

const NO_OWN_ADDRESSES: ReadonlySet<string> = new Set();

// Used until the devices store is ready (and in tests): only loopback counts as this
// machine, and each request's type comes from its own user agent.
const standaloneDirectory: DeviceDirectory = {
    getEventDevice(event) {
        const address = getEventAddress(event);
        if (!address) return undefined;

        const key = getDeviceKey(address, NO_OWN_ADDRESSES);
        if (key === THIS_MACHINE_KEY) return { key, type: THIS_MACHINE_TYPE };

        const type = event.isHttp() ? detectDeviceType(event.request) : undefined;
        return { key, type: type ?? 'other' };
    }
};

let activeDirectory: DeviceDirectory | undefined;

export function setDeviceDirectory(directory: DeviceDirectory | undefined) {
    activeDirectory = directory;
}

export function getDeviceDirectory(): DeviceDirectory {
    return activeDirectory ?? standaloneDirectory;
}
