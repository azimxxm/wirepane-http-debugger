import { expect } from '../../../test-setup';

import {
    DEFAULT_VPN_SETTINGS,
    VpnQuicMode,
    VpnSettings,
    VpnUdpFlow
} from '../../../../src/model/interception/vpn-network';
import {
    MAX_UDP_ROWS,
    QUIC_MODE_OPTIONS,
    QuicModeController,
    QuicSupport,
    describeQuicMark,
    formatUdpBytes,
    formatUdpCount,
    formatUdpDuration,
    getQuicSupport,
    getUdpFlowDurationMs,
    getUdpFlowState,
    hasUdpCounts,
    quicModeUnavailableReason,
    sortUdpFlows,
    summariseUdpFlows,
    totalBytes,
    totalPackets
} from '../../../../src/model/interception/vpn-udp';

const flow = (id: string, overrides: Partial<VpnUdpFlow> = {}): VpnUdpFlow => ({
    flow: id,
    peer: 'p1',
    src: '10.73.0.2:40003',
    dst: '1.2.3.4:5000',
    bytesUp: 0,
    bytesDown: 0,
    packetsUp: 0,
    packetsDown: 0,
    openedAt: 1_000,
    ...overrides
});

const ids = (flows: VpnUdpFlow[]) => flows.map((f) => f.flow);

const CAN_DECRYPT: QuicSupport = { canDecrypt: true, helperRunning: true };
const NO_DECRYPT: QuicSupport = { canDecrypt: false, helperRunning: true };

describe('UDP view model', () => {

    describe('flow numbers', () => {

        it('adds up both ways', () => {
            const f = flow('a', { bytesUp: 100, bytesDown: 250, packetsUp: 2, packetsDown: 3 });
            expect(totalBytes(f)).to.equal(350);
            expect(totalPackets(f)).to.equal(5);
        });

        it('knows whether a flow has any counts', () => {
            expect(hasUdpCounts(flow('a'))).to.equal(false);
            expect(hasUdpCounts(flow('a', { packetsUp: 1 }))).to.equal(true);
            expect(hasUdpCounts(flow('a', { bytesDown: 10 }))).to.equal(true);
        });

        it('says a flow is open until it has a close time', () => {
            expect(getUdpFlowState(flow('a'))).to.equal('open');
            expect(getUdpFlowState(flow('a', { closedAt: 5_000 }))).to.equal('closed');
        });

        it('does not track a blocked QUIC flow, closed or not', () => {
            expect(getUdpFlowState(flow('a', { quic: 'blocked' }))).to.equal('untracked');
            expect(getUdpFlowState(flow('a', { quic: 'blocked', closedAt: 1_000 }))).to.equal('untracked');
        });

        it('does not track decrypted QUIC until it has counters or an end', () => {
            expect(getUdpFlowState(flow('a', { quic: 'decrypted' }))).to.equal('untracked');
            expect(getUdpFlowState(flow('a', { quic: 'decrypted', packetsUp: 2 }))).to.equal('open');
            expect(getUdpFlowState(flow('a', { quic: 'decrypted', closedAt: 2_000 }))).to.equal('closed');
        });

        it('tracks QUIC that was let through like other UDP', () => {
            expect(getUdpFlowState(flow('a', { quic: 'relayed' }))).to.equal('open');
            expect(getUdpFlowState(flow('a', { quic: 'relayed', closedAt: 2_000 }))).to.equal('closed');
        });

        it('measures a closed flow from open to close, an open one up to now', () => {
            expect(getUdpFlowDurationMs(flow('a', { openedAt: 1_000, closedAt: 4_500 }), 99_000)).to.equal(3_500);
            expect(getUdpFlowDurationMs(flow('a', { openedAt: 1_000 }), 6_000)).to.equal(5_000);
        });

        it('never shows a negative duration when the clocks disagree', () => {
            expect(getUdpFlowDurationMs(flow('a', { openedAt: 9_000 }), 6_000)).to.equal(0);
            expect(getUdpFlowDurationMs(flow('a', { openedAt: 9_000, closedAt: 8_000 }), 6_000)).to.equal(0);
        });
    });

    describe('formatting', () => {

        it('formats durations from milliseconds to hours', () => {
            expect(formatUdpDuration(0)).to.equal('0 ms');
            expect(formatUdpDuration(850)).to.equal('850 ms');
            expect(formatUdpDuration(999.6)).to.equal('1 s'); // Rounds first: never "1000 ms"
            expect(formatUdpDuration(1_000)).to.equal('1 s');
            expect(formatUdpDuration(12_999)).to.equal('12 s');
            expect(formatUdpDuration(60_000)).to.equal('1 min');
            expect(formatUdpDuration(200_000)).to.equal('3 min 20 s');
            expect(formatUdpDuration(3_600_000)).to.equal('1 h');
            expect(formatUdpDuration(3_900_000)).to.equal('1 h 5 min');
        });

        it('copes with a duration that is not a number', () => {
            expect(formatUdpDuration(NaN)).to.equal('0 ms');
            expect(formatUdpDuration(-5)).to.equal('0 ms');
            expect(formatUdpDuration(Infinity)).to.equal('0 ms');
        });

        it('formats counts and sizes', () => {
            expect(formatUdpCount(1234567)).to.equal('1,234,567');
            expect(formatUdpBytes(0)).to.equal('0 bytes');
            expect(formatUdpBytes(1)).to.equal('1 byte');
            expect(formatUdpBytes(1_400)).to.equal('1.4 kB');
        });
    });

    describe('sorting', () => {

        const flows = [
            flow('old-big', { openedAt: 1_000, bytesUp: 500, bytesDown: 4_500 }),
            flow('new-small', { openedAt: 9_000, bytesUp: 10, bytesDown: 10 }),
            flow('mid-medium', { openedAt: 5_000, bytesUp: 1_000, bytesDown: 1_000 })
        ];

        it('puts the newest flow first', () => {
            expect(ids(sortUdpFlows(flows, 'newest'))).to.deep.equal(['new-small', 'mid-medium', 'old-big']);
        });

        it('puts the flow with the most data, both ways, first', () => {
            expect(ids(sortUdpFlows(flows, 'bytes'))).to.deep.equal(['old-big', 'mid-medium', 'new-small']);
        });

        it('keeps the order steady for ties, later arrivals first', () => {
            const tied = [
                flow('first', { openedAt: 1_000, bytesUp: 5 }),
                flow('second', { openedAt: 1_000, bytesUp: 5 }),
                flow('third', { openedAt: 1_000, bytesUp: 5 })
            ];
            expect(ids(sortUdpFlows(tied, 'newest'))).to.deep.equal(['third', 'second', 'first']);
            expect(ids(sortUdpFlows(tied, 'bytes'))).to.deep.equal(['third', 'second', 'first']);
        });

        it('breaks a size tie with the newest flow', () => {
            const sameSize = [
                flow('older', { openedAt: 1_000, bytesUp: 5 }),
                flow('newer', { openedAt: 2_000, bytesUp: 5 })
            ];
            expect(ids(sortUdpFlows(sameSize, 'bytes'))).to.deep.equal(['newer', 'older']);
        });

        it('returns a new list and leaves the store\'s order alone', () => {
            const before = ids(flows);
            const sorted = sortUdpFlows(flows, 'bytes');

            expect(sorted).to.not.equal(flows);
            expect(ids(flows)).to.deep.equal(before);
        });

        it('sorts an empty list', () => {
            expect(sortUdpFlows([], 'bytes')).to.deep.equal([]);
        });

        it('is meant to be cut at a sensible number of rows', () => {
            expect(MAX_UDP_ROWS).to.be.greaterThan(50);
        });
    });

    describe('summary', () => {

        it('counts flows, open flows, bytes and blocked QUIC', () => {
            const summary = summariseUdpFlows([
                flow('a', { bytesUp: 100, bytesDown: 200 }),
                flow('b', { bytesUp: 1, closedAt: 2_000 }),
                flow('c', { quic: 'blocked' }),
                flow('d', { quic: 'relayed', bytesDown: 700 })
            ]);

            expect(summary).to.deep.equal({ flows: 4, open: 2, bytes: 1001, quicBlocked: 1 });
        });

        it('is all zeros without flows', () => {
            expect(summariseUdpFlows([])).to.deep.equal({ flows: 0, open: 0, bytes: 0, quicBlocked: 0 });
        });
    });

    describe('QUIC marks', () => {

        it('names the three kinds', () => {
            expect(describeQuicMark(flow('a', { quic: 'blocked' }))?.label).to.equal('Blocked');
            expect(describeQuicMark(flow('a', { quic: 'relayed' }))?.label).to.equal('Let through');
            expect(describeQuicMark(flow('a', { quic: 'decrypted' }))?.label).to.equal('Decrypted');
        });

        it('explains each kind', () => {
            expect(describeQuicMark(flow('a', { quic: 'blocked' }))?.description).to.contain('falls back to HTTPS');
            expect(describeQuicMark(flow('a', { quic: 'relayed' }))?.description).to.contain('not shown in View');
            expect(describeQuicMark(flow('a', { quic: 'decrypted' }))?.description).to.contain('show up in View');
        });

        it('has no mark on UDP that is not QUIC', () => {
            expect(describeQuicMark(flow('a'))).to.equal(undefined);
        });
    });

    describe('what the helper can do', () => {

        const store = (quicDecrypt: boolean, running: boolean) => ({
            capabilities: { quicDecrypt, ikev2: false },
            running
        });

        it('takes it from the store', () => {
            expect(getQuicSupport(store(true, true))).to.deep.equal({ canDecrypt: true, helperRunning: true });
            expect(getQuicSupport(store(false, true))).to.deep.equal({ canDecrypt: false, helperRunning: true });
            expect(getQuicSupport(store(false, false))).to.deep.equal({ canDecrypt: false, helperRunning: false });
        });

        it('lets only Decrypt wait for the helper', () => {
            expect(quicModeUnavailableReason('block', NO_DECRYPT)).to.equal(undefined);
            expect(quicModeUnavailableReason('relay', NO_DECRYPT)).to.equal(undefined);
            expect(quicModeUnavailableReason('decrypt', CAN_DECRYPT)).to.equal(undefined);
        });

        it('gives a short reason when Decrypt is not available', () => {
            expect(quicModeUnavailableReason('decrypt', NO_DECRYPT))
                .to.equal("This build's VPN helper can't decrypt HTTP/3 yet.");
        });

        it('asks to start the VPN when there is no helper to ask', () => {
            expect(quicModeUnavailableReason('decrypt', { canDecrypt: false, helperRunning: false }))
                .to.equal('Start the VPN to check: its helper says whether this build can decrypt HTTP/3.');
        });

        it('offers the three modes in the order of the plan', () => {
            expect(QUIC_MODE_OPTIONS.map((o) => o.mode)).to.deep.equal(['block', 'relay', 'decrypt']);
            expect(QUIC_MODE_OPTIONS.map((o) => o.label)).to.deep.equal(['Block', 'Let through', 'Decrypt (beta)']);
            expect(QUIC_MODE_OPTIONS[0].note).to.equal('(recommended: apps fall back to HTTPS Wirepane can read)');
        });
    });

    describe('QUIC mode controller', () => {

        // Saves like the real store: takes the patch, then shows it in the settings
        class FakeStore {
            settings: VpnSettings = DEFAULT_VPN_SETTINGS;
            saved: Array<Partial<VpnSettings>> = [];
            fail: Error | undefined;
            gate: Promise<void> | undefined;

            async configure(patch: Partial<VpnSettings>) {
                this.saved.push(patch);
                await this.gate;
                if (this.fail) throw this.fail;
                this.settings = { ...this.settings, ...patch };
            }
        }

        const decryptReady = CAN_DECRYPT;

        it('starts on the store\'s mode', () => {
            const store = new FakeStore();
            store.settings = { ...DEFAULT_VPN_SETTINGS, quic: 'relay' };

            expect(new QuicModeController(store).selected).to.equal('relay');
        });

        it('saves the choice through store.configure({ quic })', async () => {
            const store = new FakeStore();
            const controller = new QuicModeController(store);

            expect(await controller.choose('relay', NO_DECRYPT)).to.equal(true);

            expect(store.saved).to.deep.equal([{ quic: 'relay' }]);
            expect(controller.selected).to.equal('relay');
            expect(controller.saving).to.equal(false);
            expect(controller.error).to.equal(undefined);
        });

        it('shows the choice while it is being saved', async () => {
            const store = new FakeStore();
            let finish!: () => void;
            store.gate = new Promise<void>((resolve) => { finish = resolve; });
            const controller = new QuicModeController(store);

            const saving = controller.choose('relay', NO_DECRYPT);
            expect(controller.saving).to.equal(true);
            expect(controller.pending).to.equal('relay');
            expect(controller.selected).to.equal('relay');

            finish();
            await saving;
            expect(controller.saving).to.equal(false);
        });

        it('takes the choice back and says why when saving fails', async () => {
            const store = new FakeStore();
            store.fail = new Error('The VPN is not running');
            const controller = new QuicModeController(store);

            expect(await controller.choose('relay', NO_DECRYPT)).to.equal(false);

            expect(controller.selected).to.equal('block');
            expect(controller.saving).to.equal(false);
            expect(controller.error).to.equal('The VPN is not running');
        });

        it('has a plain message for an error without one', async () => {
            const store = new FakeStore();
            store.fail = new Error('');
            const controller = new QuicModeController(store);

            await controller.choose('relay', NO_DECRYPT);
            expect(controller.error).to.equal('Something went wrong. Try again.');
        });

        it('clears the old error at the next choice', async () => {
            const store = new FakeStore();
            store.fail = new Error('nope');
            const controller = new QuicModeController(store);
            await controller.choose('relay', NO_DECRYPT);
            expect(controller.error).to.equal('nope');

            store.fail = undefined;
            await controller.choose('relay', NO_DECRYPT);
            expect(controller.error).to.equal(undefined);
            expect(controller.selected).to.equal('relay');
        });

        it('does not save the mode that is already chosen', async () => {
            const store = new FakeStore();
            const controller = new QuicModeController(store);

            expect(await controller.choose('block', NO_DECRYPT)).to.equal(false);
            expect(store.saved).to.deep.equal([]);
        });

        it('does not save while another save is running', async () => {
            const store = new FakeStore();
            let finish!: () => void;
            store.gate = new Promise<void>((resolve) => { finish = resolve; });
            const controller = new QuicModeController(store);

            const first = controller.choose('relay', decryptReady);
            expect(await controller.choose('decrypt', decryptReady)).to.equal(false);
            finish();
            await first;

            expect(store.saved).to.deep.equal([{ quic: 'relay' }]);
        });

        it('does not save Decrypt unless the helper can do it', async () => {
            const store = new FakeStore();
            const controller = new QuicModeController(store);

            expect(await controller.choose('decrypt', NO_DECRYPT)).to.equal(false);
            expect(await controller.choose('decrypt', { canDecrypt: false, helperRunning: false })).to.equal(false);
            expect(store.saved).to.deep.equal([]);

            expect(await controller.choose('decrypt', decryptReady)).to.equal(true);
            expect(store.saved).to.deep.equal([{ quic: 'decrypt' as VpnQuicMode }]);
        });
    });
});
