import type { DeviceSummary } from './devices-store';

/**
 * The devices and apps in plain words, for the status bar: "iPhone · 9 apps" or "2 devices",
 * with the whole list as its tooltip. Raw user agents (SDKs, system services) never show here.
 */

export interface DevicesOverview {
    label: string;
    title: string;
}

const MAX_LISTED_APPS = 8;

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

// The Send page's own requests aren't a client that connected to the proxy
const isOnlyFromSendPage = (device: DeviceSummary) =>
    device.apps.length > 0 && device.apps.every((app) => app.kind === 'send');

export const getConnectedDevices = (devices: ReadonlyArray<DeviceSummary>) =>
    devices.filter((device) => !isOnlyFromSendPage(device));

function listNames(names: string[], limit = MAX_LISTED_APPS) {
    const shown = names.slice(0, limit).join(', ');
    return names.length > limit ? `${shown} and ${names.length - limit} more` : shown;
}

function describeDevice(device: DeviceSummary): string {
    const realApps = device.apps.filter((app) => app.kind === 'app').map((app) => app.name);
    const otherClients = device.apps.filter((app) => app.kind !== 'app' && app.kind !== 'send').map((app) => app.name);

    return [
        [
            device.name,
            device.address ? `(${device.address})` : undefined,
            device.viaVpn ? '· VPN' : undefined,
            `· ${plural(device.eventCount, 'request')}`
        ].filter(Boolean).join(' '),
        realApps.length ? `    Apps: ${listNames(realApps)}` : undefined,
        otherClients.length ? `    Also: ${listNames(otherClients)}` : undefined
    ].filter(Boolean).join('\n');
}

export function describeDevices(allDevices: ReadonlyArray<DeviceSummary>): DevicesOverview | undefined {
    const devices = getConnectedDevices(allDevices);
    if (devices.length === 0) return undefined;

    const title = `Devices with traffic:\n${devices.map(describeDevice).join('\n')}`;

    if (devices.length > 1) return { label: plural(devices.length, 'device'), title };

    const [device] = devices;
    const apps = device.apps.filter((app) => app.kind === 'app');
    return {
        label: apps.length === 0
            ? device.name
            : `${device.name} · ${apps.length === 1 ? apps[0].name : plural(apps.length, 'app')}`,
        title
    };
}
