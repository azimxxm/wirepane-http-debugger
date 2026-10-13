import { expect } from '../../../test-setup';

import {
    DEFAULT_VPN_SETTINGS,
    MAX_DNS_QUERIES,
    RELAYED_QUIC_TTL_MS,
    VpnNetworkApi,
    VpnNetworkStore,
    parseCaptureState,
    parseVpnSettings
} from '../../../../src/model/interception/vpn-network';

// Answers like the server's wireguard-vpn interceptor (docs/plans/2026-10-13-rust-network-tools.md)
class FakeServer implements VpnNetworkApi {

    running = true;
    settings: any = { conditions: {}, dnsRules: [], quic: 'block' };
    capture: any = { running: false };
    events: any[] = [];
    seq = 0;

    activations: any[] = [];
    eventCalls: number[] = [];
    metadataCalls = 0;
    failNext: string | undefined;

    push(...events: any[]) {
        for (const event of events) this.events.push({ ...event, seq: ++this.seq });
    }

    async activate(options: any) {
        this.activations.push(options);
        if (this.failNext) {
            const message = this.failNext;
            this.failNext = undefined;
            throw new Error(message);
        }
        switch (options.action) {
            case 'configure':
                this.settings = { ...this.settings, ...options.settings };
                return this.settings;
            case 'capture-start':
                this.capture = { running: true, path: '/c/wirepane-1.pcapng' };
                return this.capture;
            case 'capture-stop':
                this.capture = { running: false, path: '/c/wirepane-1.pcapng', packets: 9, bytes: 900 };
                return this.capture;
        }
        throw new Error(`unexpected action ${options.action}`);
    }

    async getMetadata() {
        this.metadataCalls += 1;
        return {
            available: true,
            running: this.running,
            peers: [],
            settings: this.settings,
            capture: this.capture,
            capabilities: { quicDecrypt: true, ikev2: false }
        };
    }

    async getEvents(since: number) {
        this.eventCalls.push(since);
        return { seq: this.seq, events: this.events.filter((event) => event.seq > since) };
    }
}

const NOW = 1_760_000_000_000;

describe("The VPN network store", () => {

    let server: FakeServer;
    let store: VpnNetworkStore;

    beforeEach(() => {
        server = new FakeServer();
        store = new VpnNetworkStore(server, () => NOW, 5);
    });

    it("reads the metadata, then only the events after the last number it saw", async () => {
        server.push({ event: 'dns', peer: 'p1', name: 'example.com', qtype: 'A', rcode: 'NOERROR', answers: ['1.2.3.4'], ms: 3 });
        await store.poll();

        expect(store.running).to.equal(true);
        expect(store.capabilities).to.deep.equal({ quicDecrypt: true, ikev2: false });
        expect(store.dnsQueries).to.deep.equal([{
            peer: 'p1', name: 'example.com', qtype: 'A', rcode: 'NOERROR', answers: ['1.2.3.4'], ms: 3, at: NOW
        }]);

        server.push({ event: 'dns', peer: 'p1', name: 'ads.test', qtype: 'A', rcode: 'NXDOMAIN', answers: [], ms: 0, rule: 'blocked' });
        await store.poll();

        expect(server.eventCalls).to.deep.equal([0, 1]);
        expect(store.dnsQueries.map((query) => query.name)).to.deep.equal(['example.com', 'ads.test']);
        expect(store.dnsQueries[1].rule).to.equal('blocked');
        expect(store.error).to.equal(undefined);
    });

    it("asks for no events while the VPN is off", async () => {
        server.running = false;
        server.push({ event: 'dns', peer: 'p1', name: 'a.test', qtype: 'A', rcode: 'NOERROR', answers: [], ms: 1 });
        await store.poll();
        await store.poll();

        expect(store.running).to.equal(false);
        expect(server.eventCalls).to.deep.equal([]);
        expect(server.metadataCalls).to.equal(2);
        expect(store.dnsQueries).to.deep.equal([]);
    });

    it("follows UDP flows from open to close, and marks QUIC", async () => {
        server.push(
            { event: 'udp-open', flow: 7, peer: 'p1', src: '10.73.0.2:5000', dst: '8.8.4.4:3478', name: 'stun.test' },
            { event: 'udp-update', flow: 7, peer: 'p1', packetsUp: 2, packetsDown: 1, bytesUp: 200, bytesDown: 100 },
            { event: 'quic', peer: 'p1', dst: '1.1.1.1:443', action: 'blocked' },
            { event: 'quic', peer: 'p1', dst: '9.9.9.9:443', action: 'relayed' },
            { event: 'udp-open', flow: 8, peer: 'p1', src: '10.73.0.2:5001', dst: '9.9.9.9:443' },
            { event: 'udp-close', flow: 7, peer: 'p1', reason: 'idle', packetsUp: 3, packetsDown: 2, bytesUp: 300, bytesDown: 150 }
        );
        await store.poll();

        expect(store.udpFlows).to.have.length(3);
        const [stun, blocked, relayed] = store.udpFlows;
        expect(stun).to.deep.include({
            flow: '7', name: 'stun.test', packetsUp: 3, packetsDown: 2, bytesUp: 300, bytesDown: 150, closedAt: NOW
        });
        expect(blocked).to.deep.include({ dst: '1.1.1.1:443', quic: 'blocked' });
        expect(relayed).to.deep.include({ flow: '8', dst: '9.9.9.9:443', quic: 'relayed' });
        expect(relayed.closedAt).to.equal(undefined);
    });

    describe("pairing a relayed QUIC flow with its UDP flow", () => {

        const SRC_A = '10.73.0.2:40001';
        const SRC_B = '10.73.0.2:40002';
        const DST = '9.9.9.9:443';

        const quic = { event: 'quic', peer: 'p1', dst: DST, action: 'relayed' };
        const open = (flow: number, src: string, overrides: any = {}) =>
            ({ event: 'udp-open', flow, peer: 'p1', src, dst: DST, ...overrides });
        const marks = () => store.udpFlows.map((flow) => [flow.flow, flow.quic]);

        it("marks both flows when two QUIC flows from one phone go to the same place", async () => {
            server.push(
                { ...quic, src: SRC_A },
                { ...quic, src: SRC_B },
                open(1, SRC_B),
                open(2, SRC_A)
            );
            await store.poll();

            expect(marks()).to.deep.equal([['1', 'relayed'], ['2', 'relayed']]);
        });

        it("does not mark a UDP flow that came from another port", async () => {
            server.push({ ...quic, src: SRC_A }, open(1, SRC_B), open(2, SRC_A));
            await store.poll();

            expect(marks()).to.deep.equal([['1', undefined], ['2', 'relayed']]);
        });

        it("marks a flow once, and the next flow from that port is plain UDP", async () => {
            server.push({ ...quic, src: SRC_A }, open(1, SRC_A), open(2, SRC_A));
            await store.poll();

            expect(marks()).to.deep.equal([['1', 'relayed'], ['2', undefined]]);
        });

        it("still pairs by phone and place when the QUIC event says nothing about the source", async () => {
            server.push(quic, open(1, SRC_A), open(2, SRC_B));
            await store.poll();

            expect(marks()).to.deep.equal([['1', 'relayed'], ['2', undefined]]);
        });

        it("gives a blocked or decrypted QUIC flow the source the helper reports, if it does", async () => {
            server.push(
                { event: 'quic', peer: 'p1', src: SRC_A, dst: DST, action: 'blocked' },
                { event: 'quic', peer: 'p1', src: SRC_B, dst: DST, action: 'decrypted' },
                { event: 'quic', peer: 'p1', dst: '1.1.1.1:443', action: 'blocked' }
            );
            await store.poll();

            expect(store.udpFlows.map((flow) => [flow.src, flow.quic])).to.deep.equal([
                [SRC_A, 'blocked'], [SRC_B, 'decrypted'], ['', 'blocked']
            ]);
        });

        it("keeps the phones apart", async () => {
            server.push({ ...quic, peer: 'p2', src: SRC_A }, open(1, SRC_A));
            await store.poll();

            expect(marks()).to.deep.equal([['1', undefined]]);
        });

        it("forgets a QUIC event whose UDP flow never opened", () => {
            store.addEvents([{ ...quic, src: SRC_A, at: NOW }], 1);
            store.addEvents([{ ...open(1, SRC_A), at: NOW + RELAYED_QUIC_TTL_MS + 1 }], 2);
            store.addEvents([{ ...quic, src: SRC_B, at: NOW + RELAYED_QUIC_TTL_MS + 2 }], 3);
            store.addEvents([{ ...open(2, SRC_B), at: NOW + RELAYED_QUIC_TTL_MS + 3 }], 4);

            expect(marks()).to.deep.equal([['1', undefined], ['2', 'relayed']]);
        });

        it("keeps a QUIC event that waits a little for its UDP flow", () => {
            store.addEvents([{ ...quic, src: SRC_A, at: NOW }], 1);
            store.addEvents([{ ...open(1, SRC_A), at: NOW + RELAYED_QUIC_TTL_MS - 1 }], 2);

            expect(marks()).to.deep.equal([['1', 'relayed']]);
        });

        it("starts again when the server does", () => {
            store.addEvents([{ ...quic, src: SRC_A, at: NOW }], 5);
            // The server restarted: its numbers start again, and the old QUIC event is gone
            store.addEvents([open(1, SRC_A)], 1);

            expect(marks()).to.deep.equal([['1', undefined]]);
        });
    });

    it("keeps TLS hellos and the latest stats", async () => {
        server.push(
            { event: 'tls-hello', peer: 'p1', dst: '93.184.216.34:443', sni: 'example.com', alpn: ['h2', 'http/1.1'], ja4: 't13d1516h2_8daaf6152771_02713d6af862' },
            { event: 'stats', uptimeMs: 10, dnsQueries: 4 },
            { event: 'stats', uptimeMs: 20, dnsQueries: 5 }
        );
        await store.poll();

        expect(store.tlsHellos).to.deep.equal([{
            peer: 'p1', dst: '93.184.216.34:443', sni: 'example.com', alpn: ['h2', 'http/1.1'],
            ja4: 't13d1516h2_8daaf6152771_02713d6af862', at: NOW
        }]);
        expect(store.stats).to.deep.equal({ uptimeMs: 20, dnsQueries: 5 });
    });

    it("uses the server's time for an event when it has one", () => {
        store.addEvents([
            { event: 'dns', peer: 'p1', name: 'old.test', qtype: 'A', rcode: 'NOERROR', answers: [], ms: 1, at: NOW - 60_000 },
            { event: 'stats', uptimeMs: 5, at: NOW - 1 }
        ], 2);
        expect(store.dnsQueries[0].at).to.equal(NOW - 60_000);
        expect(store.stats).to.deep.equal({ uptimeMs: 5 });
    });

    describe("stats", () => {

        // The event as wirepane-tunnel/README.md shows it, with the number and time the server adds
        const README_STATS = {
            event: 'stats',
            uptimeMs: 812345,
            peers: [{
                peer: 'p1', name: 'iPhone', tunnelIp: '10.73.0.2', endpoint: '192.168.0.199:61234',
                lastHandshake: 1791809205206, bytesUp: 48213, bytesDown: 902114
            }],
            tcp: { flowsOpened: 41, flowsActive: 3, bytesUp: 30211, bytesDown: 881200 },
            udp: { flowsOpened: 2, flowsActive: 1, packetsUp: 5, packetsDown: 4, bytesUp: 410, bytesDown: 380 },
            dns: { queries: 57 },
            quic: { blocked: 6, icmpSent: 6 }
        };
        const { event: _event, ...README_STATS_FIELDS } = README_STATS;

        it("are empty until the helper reports some", async () => {
            server.push({ event: 'dns', peer: 'p1', name: 'a.test', qtype: 'A', rcode: 'NOERROR', answers: [], ms: 1 });
            await store.poll();

            expect(store.stats).to.equal(undefined);
            store.clear();
            expect(store.stats).to.equal(undefined);
        });

        it("keep what the helper reports: uptime, devices and the counters", async () => {
            server.push({ ...README_STATS });
            await store.poll();

            expect(store.stats).to.deep.equal(README_STATS_FIELDS);
            expect(store.stats!.uptimeMs).to.equal(812345);
            expect(store.stats!.peers![0]).to.deep.include({ peer: 'p1', name: 'iPhone', bytesUp: 48213, bytesDown: 902114 });
            expect(store.stats!.quic).to.deep.equal({ blocked: 6, icmpSent: 6 });
        });

        it("are replaced by the next report, and keep fields added later", () => {
            store.addEvents([{ ...README_STATS, at: NOW - 2000, seq: 1 }], 1);
            store.addEvents([{
                ...README_STATS,
                uptimeMs: 814345,
                peers: [],
                capture: { packets: 3 },
                futureCounters: { something: 1 },
                at: NOW,
                seq: 2
            }], 2);

            expect(store.stats).to.deep.equal({
                ...README_STATS_FIELDS,
                uptimeMs: 814345,
                peers: [],
                capture: { packets: 3 },
                futureCounters: { something: 1 }
            });
        });

        it("leave out what a phone that has not connected yet has no value for", () => {
            store.addEvents([{
                event: 'stats',
                uptimeMs: 5,
                peers: [{
                    peer: 'p2', name: 'iPad', tunnelIp: '10.73.0.3', endpoint: null, lastHandshake: null,
                    bytesUp: 0, bytesDown: 0
                }]
            }], 1);

            expect(store.stats).to.deep.equal({
                uptimeMs: 5,
                peers: [{ peer: 'p2', name: 'iPad', tunnelIp: '10.73.0.3', bytesUp: 0, bytesDown: 0 }]
            });
        });

        it("cope with a report of an odd shape", () => {
            store.addEvents([{
                event: 'stats',
                uptimeMs: 'soon',
                peers: [{ peer: 'p1', name: 'iPhone', bytesUp: 'lots', bytesDown: 7 }, { name: 'no id' }, 5, null],
                tcp: [],
                udp: { packetsUp: -1, bytesUp: 5, junk: 'x', packetsDown: NaN },
                dns: 12,
                quic: null
            }], 1);

            expect(store.stats).to.deep.equal({
                peers: [{ peer: 'p1', name: 'iPhone', bytesDown: 7 }],
                udp: { bytesUp: 5 }
            });
        });

        it("do not stop the other events being read", () => {
            store.addEvents([
                { event: 'stats', peers: 'nope' },
                { event: 'dns', peer: 'p1', name: 'a.test', qtype: 'A', rcode: 'NOERROR', answers: [], ms: 1 }
            ], 2);

            expect(store.dnsQueries).to.have.length(1);
            expect(store.stats).to.deep.equal({});
        });
    });

    it("keeps only the newest entries", async () => {
        const events = Array.from({ length: MAX_DNS_QUERIES + 10 }, (_, i) => ({
            event: 'dns', peer: 'p1', name: `n${i}.test`, qtype: 'A', rcode: 'NOERROR', answers: [], ms: 0
        }));
        store.addEvents(events, events.length);

        expect(store.dnsQueries).to.have.length(MAX_DNS_QUERIES);
        expect(store.dnsQueries[0].name).to.equal('n10.test');
    });

    it("sends settings patches and keeps what the server saved", async () => {
        await store.configure({ dnsRules: [{ pattern: '*.ads.test', action: 'block' }], quic: 'relay' });

        expect(server.activations).to.deep.equal([{
            action: 'configure',
            settings: { dnsRules: [{ pattern: '*.ads.test', action: 'block' }], quic: 'relay' }
        }]);
        expect(store.settings).to.deep.equal({
            conditions: {}, dnsRules: [{ pattern: '*.ads.test', action: 'block' }], quic: 'relay'
        });

        server.failNext = 'quic must be block, relay or decrypt';
        let failure: Error | undefined;
        await store.configure({ quic: 'fast' as any }).catch((e) => { failure = e; });
        expect(failure?.message).to.include('quic must be');
        expect(store.settings.quic).to.equal('relay');
    });

    it("starts and stops captures", async () => {
        const started = await store.startCapture();
        expect(started).to.deep.equal({ running: true, path: '/c/wirepane-1.pcapng' });
        expect(store.capture.running).to.equal(true);

        const stopped = await store.stopCapture();
        expect(stopped).to.deep.equal({ running: false, path: '/c/wirepane-1.pcapng', packets: 9, bytes: 900 });
        expect(store.capture).to.deep.equal(stopped);
        expect(server.activations.map((options) => options.action)).to.deep.equal(['capture-start', 'capture-stop']);
    });

    it("shows a failed poll as an error until the next good one", async () => {
        server.getEvents = async () => { throw new Error('server went away'); };
        await store.poll();
        expect(store.error).to.equal('server went away');

        server.getEvents = async () => ({ seq: 0, events: [] });
        await store.poll();
        expect(store.error).to.equal(undefined);
    });

    it("polls on a timer only while someone is polling", async () => {
        const stopFirst = store.startPolling();
        const stopSecond = store.startPolling();
        await new Promise((resolve) => setTimeout(resolve, 40));
        const pollsWhileOn = server.metadataCalls + server.eventCalls.length;
        expect(pollsWhileOn).to.be.greaterThan(1);

        stopFirst();
        stopFirst(); // Calling it twice changes nothing
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(server.metadataCalls + server.eventCalls.length).to.be.greaterThan(pollsWhileOn);

        stopSecond();
        await new Promise((resolve) => setTimeout(resolve, 15));
        const pollsAfterStop = server.metadataCalls + server.eventCalls.length;
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(server.metadataCalls + server.eventCalls.length).to.equal(pollsAfterStop);
    });

    it("parses settings and capture states defensively", () => {
        expect(parseVpnSettings(undefined)).to.deep.equal(DEFAULT_VPN_SETTINGS);
        expect(parseVpnSettings({
            conditions: { p1: { latencyMs: 100 }, p2: null },
            dnsRules: [{ pattern: 'a.test', action: 'answer', ipv4: '10.0.0.1' }, { pattern: 'b.test', action: 'odd' }, 7],
            quic: 'nonsense'
        })).to.deep.equal({
            conditions: { p1: { latencyMs: 100, jitterMs: 0, downKbps: 0, upKbps: 0, lossPct: 0 } },
            dnsRules: [{ pattern: 'a.test', action: 'answer', ipv4: '10.0.0.1' }],
            quic: 'block'
        });
        expect(parseCaptureState('x')).to.deep.equal({ running: false });
        expect(parseCaptureState({ running: true, path: '/p', packets: 'many' })).to.deep.equal({ running: true, path: '/p' });
    });
});
