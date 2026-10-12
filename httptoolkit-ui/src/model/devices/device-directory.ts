import type { ViewableEvent } from '../../types';

import {
    DeviceType,
    THIS_MACHINE_KEY,
    detectDeviceType,
    getClientEvent,
    getEventDeviceKey
} from './device-model';

export interface EventDevice {
    // THIS_MACHINE_KEY, or the device's IP address
    key: string;
    type: DeviceType;
}

/**
 * Says which device sent an event. The devices store is the real one: it knows what
 * each device's earlier requests said about it (an iPhone app's request only says
 * "iOS", but the same phone's Safari says "iPhone"). The text filters (device=) are
 * created from strings, so they look it up here.
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

// Used until the devices store is ready (and in tests): each request's type comes from
// its own user agent.
const standaloneDirectory: DeviceDirectory = {
    getEventDevice(event) {
        const clientEvent = getClientEvent(event);
        const key = getEventDeviceKey(clientEvent);
        if (!key) return undefined;
        if (key === THIS_MACHINE_KEY) return { key, type: THIS_MACHINE_TYPE };

        const type = clientEvent.isHttp() ? detectDeviceType(clientEvent.request) : undefined;
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
