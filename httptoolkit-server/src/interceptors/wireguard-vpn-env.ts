import * as dgram from 'dgram';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Helpers for the wireguard-vpn interceptor that only look at the machine (files,
// network interfaces, ports). They take their inputs as arguments, so tests can
// feed them fake machines.

// --- The wirepane-tunnel binary ---

const BINARY_NAME = process.platform === 'win32' ? 'wirepane-tunnel.exe' : 'wirepane-tunnel';

// This file is in <repo>/httptoolkit-server/src/interceptors (or lib/interceptors once
// built), so the repo root is three folders up. Release builds don't use this: the
// desktop app points WIREPANE_TUNNEL_BINPATH at the binary it ships.
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

export interface TunnelBinary {
    path?: string;
    // Why there's no binary, for the UI
    error?: string;
}

function isExecutableFile(filePath: string): boolean {
    try {
        if (!fs.statSync(filePath).isFile()) return false;
        fs.accessSync(filePath, fs.constants.X_OK);
        return true;
    } catch (e) {
        return false;
    }
}

export function findTunnelBinary(
    env: NodeJS.ProcessEnv = process.env,
    repoRoot: string = REPO_ROOT
): TunnelBinary {
    const envPath = env.WIREPANE_TUNNEL_BINPATH;
    if (envPath && isExecutableFile(envPath)) return { path: envPath };

    // Dev checkouts: whatever cargo built last, release first
    const devBuilds = ['release', 'debug'].map((profile) =>
        path.join(repoRoot, 'wirepane-tunnel', 'target', profile, BINARY_NAME)
    );
    const devBuild = devBuilds.find(isExecutableFile);
    if (devBuild) return { path: devBuild };

    return {
        error: envPath
            ? `The VPN helper (wirepane-tunnel) is missing: nothing runnable at ${envPath}`
            : 'The VPN helper (wirepane-tunnel) is not built. Run cargo build --release in wirepane-tunnel.'
    };
}

// --- This machine's address on the local network ---

// Docker's bridges and per-container interfaces only face containers on this machine
const CONTAINER_INTERFACE = /^(docker\d|br-|veth)/;
// Wired and Wi-Fi interfaces: en0 (macOS), eth0 / enp3s0 / wlan0 / wlp2s0 (Linux), Wi-Fi / Ethernet (Windows)
const PHYSICAL_INTERFACE = /^(en|eth|wl|wi-?fi|ethernet)/i;

function parseIPv4(address: string): number[] | undefined {
    const parts = address.split('.');
    if (parts.length !== 4) return undefined;
    const octets = parts.map((part) => /^\d{1,3}$/.test(part) ? Number(part) : NaN);
    return octets.every((octet) => octet >= 0 && octet <= 255) ? octets : undefined;
}

// Higher is a better guess for "the address a phone on the same Wi-Fi can reach".
// Mirrors getLanAddresses in the UI's phone-setup.ts, so the VPN and the proxy
// instructions on the iPhone page show the same address.
function rankAddress(address: string, interfaceName: string): number | undefined {
    const octets = parseIPv4(address);
    if (!octets) return undefined;
    const [a, b] = octets;

    const unreachable = a === 0 // unspecified
        || a === 127 // loopback
        || (a === 169 && b === 254) // link-local: no working network
        || a >= 224; // multicast, reserved and broadcast
    if (unreachable) return undefined;

    const isPrivate = a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
    return (isPrivate ? 2 : 0) + (PHYSICAL_INTERFACE.test(interfaceName) ? 1 : 0);
}

const isIPv4 = (family: string | number) => family === 'IPv4' || family === 4;

/**
 * The IPv4 address a phone on the same network would dial to reach this machine,
 * or undefined when the machine isn't on a network.
 */
export function getLanIPv4(
    interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]> = os.networkInterfaces()
): string | undefined {
    let best: { address: string, rank: number } | undefined;

    for (const [interfaceName, addresses] of Object.entries(interfaces)) {
        if (!addresses || CONTAINER_INTERFACE.test(interfaceName)) continue;

        for (const info of addresses) {
            if (info.internal || !isIPv4(info.family)) continue;

            const rank = rankAddress(info.address, interfaceName);
            // Strictly better only, so equally good addresses keep the system's order
            if (rank !== undefined && (!best || rank > best.rank)) {
                best = { address: info.address, rank };
            }
        }
    }

    return best?.address;
}

// --- The UDP port WireGuard listens on ---

export const WIREGUARD_FIRST_PORT = 51873;
export const WIREGUARD_LAST_PORT = 51899;

const PORT_FILE_NAME = 'wirepane-vpn-port.json';

export function isUdpPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = dgram.createSocket('udp4');

        socket.once('error', () => {
            try { socket.close(); } catch (e) { /* it never got bound */ }
            resolve(false);
        });

        socket.bind({ port, address: '0.0.0.0', exclusive: true }, () => {
            socket.close(() => resolve(true));
        });
    });
}

const isVpnPort = (port: unknown): port is number =>
    typeof port === 'number'
    && Number.isInteger(port)
    && port >= WIREGUARD_FIRST_PORT
    && port <= WIREGUARD_LAST_PORT;

export async function readSavedPort(configPath: string): Promise<number | undefined> {
    try {
        const saved = JSON.parse(await fs.promises.readFile(path.join(configPath, PORT_FILE_NAME), 'utf8'));
        return isVpnPort(saved?.port) ? saved.port : undefined;
    } catch (e) {
        return undefined; // Not saved yet, or not readable: pick a port again
    }
}

export async function savePort(configPath: string, port: number): Promise<void> {
    await fs.promises.mkdir(configPath, { recursive: true });
    await fs.promises.writeFile(path.join(configPath, PORT_FILE_NAME), JSON.stringify({ port }));
}

/**
 * The port from last time if it's still free (a scanned QR code has it inside), else the
 * first free one in the range. Throws when the whole range is taken.
 */
export async function choosePort(
    savedPort: number | undefined,
    isFree: (port: number) => Promise<boolean> = isUdpPortFree
): Promise<number> {
    const range = Array.from(
        { length: WIREGUARD_LAST_PORT - WIREGUARD_FIRST_PORT + 1 },
        (_, i) => WIREGUARD_FIRST_PORT + i
    );
    const candidates = isVpnPort(savedPort) ? [savedPort, ...range] : range;

    for (const port of candidates) {
        if (await isFree(port)) return port;
    }

    throw new Error(`No free UDP port between ${WIREGUARD_FIRST_PORT} and ${WIREGUARD_LAST_PORT} for the VPN`);
}
