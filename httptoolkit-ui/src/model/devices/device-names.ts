/**
 * The names the user gave devices, kept in localStorage as { [ip]: name }. This machine
 * is stored under its device key, since it has several addresses.
 */

export const DEVICE_NAMES_KEY = 'wirepane:device-names';
export const MAX_DEVICE_NAME_LENGTH = 80;

export interface NameStorage {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
}

// localStorage itself throws when storage is disabled, so it's only read when needed
const getLocalStorage = (): NameStorage | undefined => {
    try {
        return window.localStorage;
    } catch (e) {
        return undefined;
    }
};

export function cleanDeviceName(name: string): string {
    return name.trim().replace(/\s+/g, ' ').slice(0, MAX_DEVICE_NAME_LENGTH);
}

export function loadDeviceNames(storage = getLocalStorage()): Map<string, string> {
    const names = new Map<string, string>();
    if (!storage) return names;

    try {
        const data: unknown = JSON.parse(storage.getItem(DEVICE_NAMES_KEY) || '{}');
        if (!data || typeof data !== 'object' || Array.isArray(data)) return names;

        Object.entries(data as Record<string, unknown>).forEach(([key, name]) => {
            if (typeof name !== 'string') return;
            const cleanName = cleanDeviceName(name);
            if (cleanName) names.set(key, cleanName);
        });
    } catch (e) {
        console.warn("Couldn't read the saved device names", e);
    }
    return names;
}

export function saveDeviceNames(names: ReadonlyMap<string, string>, storage = getLocalStorage()) {
    if (!storage) return;

    const data: Record<string, string> = {};
    names.forEach((name, key) => { data[key] = name; });

    try {
        storage.setItem(DEVICE_NAMES_KEY, JSON.stringify(data));
    } catch (e) {
        // E.g. storage is full or disabled: names still work until the app restarts
        console.warn("Couldn't save the device names", e);
    }
}
