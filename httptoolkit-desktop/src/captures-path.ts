import * as os from 'os';
import * as path from 'path';

/*
 * wirepane: "Show in Finder" for a saved packet capture. The UI gives the desktop the file's
 * path and the desktop only reveals files inside the captures folder, so a page can't use it to
 * look at other places on the disk.
 */

// The server is started without --config, so its folder is env-paths('httptoolkit', { suffix: '' }).config
// and the captures go in its captures/ folder (wireguard-vpn-tools.ts). This repeats env-paths 1.x,
// which the server uses, for each platform.
export function getCapturesFolder(
    platform: NodeJS.Platform = process.platform,
    env: NodeJS.ProcessEnv = process.env,
    home: string = os.homedir()
): string {
    const name = 'httptoolkit';

    if (platform === 'darwin') {
        return path.posix.join(home, 'Library', 'Preferences', name, 'captures');
    }
    if (platform === 'win32') {
        const appData = env.LOCALAPPDATA || path.win32.join(home, 'AppData', 'Local');
        return path.win32.join(appData, name, 'Config', 'captures');
    }
    return path.posix.join(env.XDG_CONFIG_HOME || path.posix.join(home, '.config'), name, 'captures');
}

// The full path of a file inside the captures folder, or undefined for anything else: not a
// string, a relative path, the folder itself, a sibling folder or a path that climbs out with `..`.
export function resolveCapturePath(
    requested: unknown,
    capturesFolder: string,
    platform: NodeJS.Platform = process.platform
): string | undefined {
    if (typeof requested !== 'string' || requested === '' || requested.includes('\0')) return undefined;

    const pathModule = platform === 'win32' ? path.win32 : path.posix;
    if (!pathModule.isAbsolute(requested)) return undefined;

    const resolved = pathModule.resolve(requested);
    const relative = pathModule.relative(capturesFolder, resolved);

    const isInside = relative !== ''
        && relative !== '..'
        && !relative.startsWith(`..${pathModule.sep}`)
        && !pathModule.isAbsolute(relative); // another drive on Windows

    return isInside ? resolved : undefined;
}
