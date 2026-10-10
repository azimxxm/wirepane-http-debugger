import type { ViewableEvent } from '../../types';
import { Filter } from '../filters/search-filters';

import { getEventAppName, getEventHost } from './device-model';

// What's selected in the Devices panel: a device, or one of its apps or domains
export interface DeviceSelection {
    deviceKey: string;
    app?: string;
    host?: string;
}

export const isSameSelection = (a: DeviceSelection | undefined, b: DeviceSelection | undefined) =>
    a?.deviceKey === b?.deviceKey && a?.app === b?.app && a?.host === b?.host;

/**
 * The Devices panel's selection as a filter. View ANDs it with the filters typed in the
 * filter box, so the two combine instead of replacing each other.
 */
export class DeviceSelectionFilter extends Filter {

    static filterDescription() {
        return 'requests from the device selected in the Devices panel';
    }

    constructor(
        readonly selection: DeviceSelection,
        // Read when shown, so the filter doesn't change whenever a device's name does
        private readonly describe: () => string,
        // The device key for an event (as the devices store knows it)
        private readonly getDeviceKey: (event: ViewableEvent) => string | undefined
    ) {
        super(`device-selection:${selection.deviceKey}`);
    }

    matches(event: ViewableEvent): boolean {
        // The device & app are the client's, even for requests a rule rewrote
        const clientEvent = event.isHttp() ? event.downstream : event;
        if (this.getDeviceKey(clientEvent) !== this.selection.deviceKey) return false;

        const { app, host } = this.selection;
        if (app !== undefined && getEventAppName(clientEvent) !== app) return false;
        if (host !== undefined && getEventHost(event) !== host) return false;

        return true;
    }

    toString() {
        return this.describe();
    }
}
