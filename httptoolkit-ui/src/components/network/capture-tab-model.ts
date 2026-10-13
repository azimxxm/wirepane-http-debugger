import type { VpnCaptureState } from '../../model/interception/vpn-network';
import { getReadableSize } from '../../util/buffer';

/*
 * The logic behind the Capture tab: which of its three screens to show, the text of the
 * counters, and the file name and folder of the saved capture. There's no React in here, so it
 * is tested on its own.
 */

// idle: nothing captured yet (or the page was reloaded after one ended)
// running: the sidecar is writing a file now
// saved: a capture ended and its file is on disk
export type CapturePhase = 'idle' | 'running' | 'saved';

export interface CaptureView {
    phase: CapturePhase;
    path?: string;
    folder?: string;
    fileName?: string;
    // A capture that ended without a single packet in it
    isEmpty: boolean;
    packetsText: string;
    sizeText: string;
}

// What the counters say before the first number arrives, so they don't flash a "0"
export const NO_COUNT_TEXT = '–';

export function describeCapture(capture: VpnCaptureState): CaptureView {
    const phase: CapturePhase = capture.running
        ? 'running'
        : capture.path
            ? 'saved'
            : 'idle';

    const location = capture.path ? splitPath(capture.path) : undefined;

    return {
        phase,
        path: capture.path,
        folder: location?.folder,
        fileName: location?.fileName,
        isEmpty: phase === 'saved' && capture.packets === 0,
        packetsText: formatPacketCount(capture.packets),
        sizeText: formatCaptureSize(capture.bytes)
    };
}

function isCount(value: number | undefined): value is number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

// "12,345" (US grouping on purpose: the locale of the machine would change the text between runs)
export function formatPacketCount(packets: number | undefined): string {
    return isCount(packets)
        ? Math.floor(packets).toLocaleString('en-US')
        : NO_COUNT_TEXT;
}

export function formatCaptureSize(bytes: number | undefined): string {
    return isCount(bytes)
        ? getReadableSize(Math.floor(bytes))
        : NO_COUNT_TEXT;
}

// "1 packet", "2 packets", for sentences
export function packetsPhrase(packets: number | undefined): string {
    if (!isCount(packets)) return 'no packet count yet';
    return `${formatPacketCount(packets)} ${Math.floor(packets) === 1 ? 'packet' : 'packets'}`;
}

// The path comes from the server, so it can use / (macOS, Linux) or \ (Windows)
export function splitPath(path: string): { folder: string, fileName: string } {
    const lastSeparator = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
    if (lastSeparator === -1) return { folder: '', fileName: path };

    return {
        // The root keeps its separator ("/capture.pcapng" is in "/", not in "")
        folder: lastSeparator === 0 ? path.slice(0, 1) : path.slice(0, lastSeparator),
        fileName: path.slice(lastSeparator + 1)
    };
}

export type CaptureAction = 'start' | 'stop';

// The server's message (or the network's) as one sentence for the page. A thrown string or an
// object without a message still says what failed.
export function describeCaptureError(error: unknown, action: CaptureAction): string {
    const what = action === 'start' ? "Couldn't start the capture" : "Couldn't stop the capture";

    const message = typeof error === 'string'
            ? error
        : error instanceof Error
            ? error.message
        : typeof (error as { message?: unknown } | null)?.message === 'string'
            ? (error as { message: string }).message
        : '';

    const trimmed = message.trim().replace(/[.\s]+$/, '');
    return trimmed ? `${what}: ${trimmed}.` : `${what}.`;
}
