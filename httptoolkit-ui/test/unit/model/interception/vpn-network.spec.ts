import { expect } from '../../../test-setup';

import {
    DEFAULT_VPN_SETTINGS,
    MAX_DNS_QUERIES,
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
