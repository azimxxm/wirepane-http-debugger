import { test, expect } from '@playwright/test';
import { createRequire } from 'module';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

import { getCapturesFolder, resolveCapturePath } from '../src/captures-path.ts';

// Unit tests for "Show in Finder": which files of a page's request the desktop may reveal. No
// Electron needed, as it's plain path logic.

const MAC_FOLDER = '/Users/me/Library/Preferences/httptoolkit/captures';
const WIN_FOLDER = 'C:\\Users\\me\\AppData\\Local\\httptoolkit\\Config\\captures';

test.describe('The captures folder', () => {

    test('is the captures folder inside the server config folder, on each platform', () => {
        expect(getCapturesFolder('darwin', {}, '/Users/me')).toBe(MAC_FOLDER);
        expect(getCapturesFolder('linux', {}, '/home/me')).toBe('/home/me/.config/httptoolkit/captures');
        expect(getCapturesFolder('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/me')).toBe('/xdg/httptoolkit/captures');
        expect(getCapturesFolder('win32', { LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local' }, 'C:\\Users\\me')).toBe(WIN_FOLDER);
        expect(getCapturesFolder('win32', {}, 'C:\\Users\\me')).toBe(WIN_FOLDER);
    });

    test("is where this computer's server really saves captures", () => {
        // The server's own env-paths (the one it uses for its config folder)
        const serverEnvPaths = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'httptoolkit-server', 'node_modules', 'env-paths');
        test.skip(!fs.existsSync(serverEnvPaths), 'the server is not installed next to the desktop');

        const envPaths = createRequire(import.meta.url)(serverEnvPaths) as
            (name: string, options: { suffix: string }) => { config: string };
        expect(getCapturesFolder()).toBe(path.join(envPaths('httptoolkit', { suffix: '' }).config, 'captures'));
    });
});

test.describe('The files that can be shown', () => {

    const resolveOnMac = (requested: unknown) => resolveCapturePath(requested, MAC_FOLDER, 'darwin');
    const resolveOnWindows = (requested: unknown) => resolveCapturePath(requested, WIN_FOLDER, 'win32');

    test('are the files inside the captures folder', () => {
        const capture = `${MAC_FOLDER}/wirepane-2026-10-13_12-24-27.pcapng`;
        expect(resolveOnMac(capture)).toBe(capture);
        expect(resolveOnMac(`${MAC_FOLDER}/old/a.pcapng`)).toBe(`${MAC_FOLDER}/old/a.pcapng`);
        expect(resolveOnMac(`${MAC_FOLDER}/..hidden.pcapng`)).toBe(`${MAC_FOLDER}/..hidden.pcapng`);
    });

    test('are tidied up, but only a path that stays inside the folder is accepted', () => {
        expect(resolveOnMac(`${MAC_FOLDER}/../captures/a.pcapng`)).toBe(`${MAC_FOLDER}/a.pcapng`);
        expect(resolveOnMac(`${MAC_FOLDER}/../wirepane-ca.key`)).toBeUndefined();
        expect(resolveOnMac(`${MAC_FOLDER}/../../../../../etc/passwd`)).toBeUndefined();
    });

    test('are not the folder itself, its siblings or anything else on the disk', () => {
        expect(resolveOnMac(MAC_FOLDER)).toBeUndefined();
        expect(resolveOnMac(`${MAC_FOLDER}/`)).toBeUndefined();
        expect(resolveOnMac(`${MAC_FOLDER}-old/a.pcapng`)).toBeUndefined(); // starts the same, but is another folder
        expect(resolveOnMac('/Users/me/Library/Preferences/httptoolkit/wirepane-ca.key')).toBeUndefined();
        expect(resolveOnMac('/etc/passwd')).toBeUndefined();
        expect(resolveOnMac('/')).toBeUndefined();
    });

    test('are full paths of the right type', () => {
        expect(resolveOnMac('captures/a.pcapng')).toBeUndefined();
        expect(resolveOnMac('a.pcapng')).toBeUndefined();
        expect(resolveOnMac('')).toBeUndefined();
        expect(resolveOnMac(undefined)).toBeUndefined();
        expect(resolveOnMac(null)).toBeUndefined();
        expect(resolveOnMac(42)).toBeUndefined();
        expect(resolveOnMac({ toString: () => `${MAC_FOLDER}/a.pcapng` })).toBeUndefined();
        expect(resolveOnMac(`${MAC_FOLDER}/a.pcapng\0../../../etc/passwd`)).toBeUndefined();
    });

    test('work the same way for Windows paths', () => {
        const capture = `${WIN_FOLDER}\\wirepane-2026-10-13_12-24-27.pcapng`;
        expect(resolveOnWindows(capture)).toBe(capture);
        expect(resolveOnWindows(capture.toLowerCase())).toBe(capture.toLowerCase()); // Windows paths ignore case

        expect(resolveOnWindows(WIN_FOLDER)).toBeUndefined();
        expect(resolveOnWindows(`${WIN_FOLDER}\\..\\wirepane-ca.key`)).toBeUndefined();
        expect(resolveOnWindows(`${WIN_FOLDER}-old\\a.pcapng`)).toBeUndefined();
        expect(resolveOnWindows('D:\\Users\\me\\AppData\\Local\\httptoolkit\\Config\\captures\\a.pcapng')).toBeUndefined();
        expect(resolveOnWindows('\\\\server\\share\\captures\\a.pcapng')).toBeUndefined();
        expect(resolveOnWindows('captures\\a.pcapng')).toBeUndefined();
    });
});
