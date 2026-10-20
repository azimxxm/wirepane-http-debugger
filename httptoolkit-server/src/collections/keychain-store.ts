import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export const KEYCHAIN_SERVICE = 'tech.httptoolkit.desktop.collections';
const SECURITY_PATH = '/usr/bin/security';
const TIMEOUT_MS = 2500;

export interface StoredSecret {
    environment: string;
    variable: string;
    value: unknown;
}

export function isKeychainSupported(): boolean {
    return process.platform === 'darwin';
}

/**
 * Stores a collection's secrets in macOS Keychain as a base64-encoded JSON payload.
 * Returns true if stored successfully, or false if Keychain is unavailable or failed.
 */
export async function storeInKeychain(
    collectionId: string,
    secrets: StoredSecret[],
    service: string = KEYCHAIN_SERVICE
): Promise<boolean> {
    if (!isKeychainSupported() || secrets.length === 0) {
        return false;
    }

    try {
        const payload = Buffer.from(JSON.stringify(secrets), 'utf8').toString('base64');
        await execFileAsync(
            SECURITY_PATH,
            ['add-generic-password', '-s', service, '-a', collectionId, '-w', payload, '-U'],
            { timeout: TIMEOUT_MS, windowsHide: true }
        );
        return true;
    } catch {
        return false;
    }
}

/**
 * Reads a collection's secrets from macOS Keychain.
 * Returns the parsed StoredSecret array, or undefined if not found or on error.
 */
export async function readFromKeychain(
    collectionId: string,
    service: string = KEYCHAIN_SERVICE
): Promise<StoredSecret[] | undefined> {
    if (!isKeychainSupported()) {
        return undefined;
    }

    try {
        const { stdout } = await execFileAsync(
            SECURITY_PATH,
            ['find-generic-password', '-s', service, '-a', collectionId, '-w'],
            { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'utf8' }
        );

        const raw = stdout.trim();
        if (!raw) return undefined;

        let jsonString: string;
        if (raw.startsWith('[') || raw.startsWith('{')) {
            jsonString = raw;
        } else {
            try {
                jsonString = Buffer.from(raw, 'base64').toString('utf8');
            } catch {
                jsonString = raw;
            }
        }

        const parsed = JSON.parse(jsonString);
        return Array.isArray(parsed) ? (parsed as StoredSecret[]) : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Deletes a collection's secrets from macOS Keychain.
 * Returns true on success (or if item did not exist), or false on error.
 */
export async function deleteFromKeychain(
    collectionId: string,
    service: string = KEYCHAIN_SERVICE
): Promise<boolean> {
    if (!isKeychainSupported()) {
        return false;
    }

    try {
        await execFileAsync(
            SECURITY_PATH,
            ['delete-generic-password', '-s', service, '-a', collectionId],
            { timeout: TIMEOUT_MS, windowsHide: true }
        );
        return true;
    } catch (error: any) {
        // If the item wasn't found (exit code 44), it's already deleted
        if (error?.code === 44 || /could not be found/i.test(String(error?.stderr || error?.message))) {
            return true;
        }
        return false;
    }
}
