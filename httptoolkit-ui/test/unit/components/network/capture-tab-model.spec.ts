import { expect } from '../../../test-setup';

import {
    NO_COUNT_TEXT,
    describeCapture,
    describeCaptureError,
    formatCaptureSize,
    formatPacketCount,
    packetsPhrase,
    splitPath
} from '../../../../src/components/network/capture-tab-model';

describe('Capture tab logic', () => {

    describe('describeCapture', () => {

        it('is idle before any capture', () => {
            const view = describeCapture({ running: false });
            expect(view.phase).to.equal('idle');
            expect(view.path).to.equal(undefined);
            expect(view.isEmpty).to.equal(false);
            expect(view.packetsText).to.equal(NO_COUNT_TEXT);
            expect(view.sizeText).to.equal(NO_COUNT_TEXT);
        });

        it('is running while the capture runs, with the counts so far', () => {
            const view = describeCapture({
                running: true,
                path: '/Users/me/captures/wirepane-1.pcapng',
                packets: 12345,
                bytes: 4_200_000
            });
            expect(view.phase).to.equal('running');
            expect(view.packetsText).to.equal('12,345');
            expect(view.sizeText).to.equal('4.2 MB');
            expect(view.fileName).to.equal('wirepane-1.pcapng');
            expect(view.folder).to.equal('/Users/me/captures');
        });

        it('shows no number before the first count arrives, not a 0', () => {
            const view = describeCapture({ running: true, path: '/tmp/a.pcapng' });
            expect(view.phase).to.equal('running');
            expect(view.packetsText).to.equal(NO_COUNT_TEXT);
            expect(view.sizeText).to.equal(NO_COUNT_TEXT);
        });

        it('is saved once the capture ended and there is a file', () => {
            const view = describeCapture({ running: false, path: '/tmp/a.pcapng', packets: 2, bytes: 1500 });
            expect(view.phase).to.equal('saved');
            expect(view.path).to.equal('/tmp/a.pcapng');
            expect(view.packetsText).to.equal('2');
            expect(view.sizeText).to.equal('1.5 kB');
            expect(view.isEmpty).to.equal(false);
        });

        it('says a saved capture is empty only when it has 0 packets, not when the count is missing', () => {
            expect(describeCapture({ running: false, path: '/tmp/a.pcapng', packets: 0, bytes: 0 }).isEmpty).to.equal(true);
            expect(describeCapture({ running: false, path: '/tmp/a.pcapng' }).isEmpty).to.equal(false);
            // A capture that is still running has no packets yet, which isn't "empty"
            expect(describeCapture({ running: true, path: '/tmp/a.pcapng', packets: 0, bytes: 0 }).isEmpty).to.equal(false);
        });

        it('runs even when the server has not reported a path yet', () => {
            expect(describeCapture({ running: true }).phase).to.equal('running');
        });
    });

    describe('counts', () => {

        it('groups the digits of a packet count', () => {
            expect(formatPacketCount(0)).to.equal('0');
            expect(formatPacketCount(999)).to.equal('999');
            expect(formatPacketCount(1000)).to.equal('1,000');
            expect(formatPacketCount(1234567)).to.equal('1,234,567');
        });

        it('shows a placeholder for a count that is not a usable number', () => {
            expect(formatPacketCount(undefined)).to.equal(NO_COUNT_TEXT);
            expect(formatPacketCount(NaN)).to.equal(NO_COUNT_TEXT);
            expect(formatPacketCount(Infinity)).to.equal(NO_COUNT_TEXT);
            expect(formatPacketCount(-5)).to.equal(NO_COUNT_TEXT);
            expect(formatCaptureSize(undefined)).to.equal(NO_COUNT_TEXT);
            expect(formatCaptureSize(-1)).to.equal(NO_COUNT_TEXT);
        });

        it('rounds a fractional count down', () => {
            expect(formatPacketCount(12.9)).to.equal('12');
            expect(formatCaptureSize(1500.7)).to.equal('1.5 kB');
        });

        it('writes sizes in the units the rest of the app uses', () => {
            expect(formatCaptureSize(0)).to.equal('0 bytes');
            expect(formatCaptureSize(1)).to.equal('1 byte');
            expect(formatCaptureSize(512)).to.equal('512 bytes');
            expect(formatCaptureSize(1500)).to.equal('1.5 kB');
            expect(formatCaptureSize(2_000_000)).to.equal('2 MB');
        });

        it('has singular and plural phrases', () => {
            expect(packetsPhrase(1)).to.equal('1 packet');
            expect(packetsPhrase(2)).to.equal('2 packets');
            expect(packetsPhrase(0)).to.equal('0 packets');
            expect(packetsPhrase(12000)).to.equal('12,000 packets');
            expect(packetsPhrase(undefined)).to.equal('no packet count yet');
        });
    });

    describe('splitPath', () => {

        it('splits a macOS or Linux path', () => {
            expect(splitPath('/Users/me/Library/captures/wirepane-1.pcapng')).to.deep.equal({
                folder: '/Users/me/Library/captures',
                fileName: 'wirepane-1.pcapng'
            });
        });

        it('splits a Windows path', () => {
            expect(splitPath('C:\\Users\\me\\AppData\\captures\\wirepane-1.pcapng')).to.deep.equal({
                folder: 'C:\\Users\\me\\AppData\\captures',
                fileName: 'wirepane-1.pcapng'
            });
        });

        it('keeps the root as the folder of a file in the root', () => {
            expect(splitPath('/capture.pcapng')).to.deep.equal({ folder: '/', fileName: 'capture.pcapng' });
        });

        it('takes a bare name as a file with no folder', () => {
            expect(splitPath('capture.pcapng')).to.deep.equal({ folder: '', fileName: 'capture.pcapng' });
        });
    });

    describe('describeCaptureError', () => {

        it('uses the message of an error as one sentence', () => {
            expect(describeCaptureError(new Error('The VPN is not running'), 'start'))
                .to.equal("Couldn't start the capture: The VPN is not running.");
            expect(describeCaptureError(new Error('no capture is running'), 'stop'))
                .to.equal("Couldn't stop the capture: no capture is running.");
        });

        it('does not double the full stop or keep trailing spaces', () => {
            expect(describeCaptureError(new Error('Disk full.  '), 'start'))
                .to.equal("Couldn't start the capture: Disk full.");
            expect(describeCaptureError(new Error('Disk full...'), 'start'))
                .to.equal("Couldn't start the capture: Disk full.");
        });

        it('reads a thrown string and an object with a message', () => {
            expect(describeCaptureError('Not allowed', 'start')).to.equal("Couldn't start the capture: Not allowed.");
            expect(describeCaptureError({ message: 'Bad answer' }, 'stop')).to.equal("Couldn't stop the capture: Bad answer.");
        });

        it('still says what failed when there is no message', () => {
            expect(describeCaptureError(undefined, 'start')).to.equal("Couldn't start the capture.");
            expect(describeCaptureError(null, 'stop')).to.equal("Couldn't stop the capture.");
            expect(describeCaptureError(new Error(''), 'start')).to.equal("Couldn't start the capture.");
            expect(describeCaptureError({ message: 42 }, 'start')).to.equal("Couldn't start the capture.");
        });
    });
});
