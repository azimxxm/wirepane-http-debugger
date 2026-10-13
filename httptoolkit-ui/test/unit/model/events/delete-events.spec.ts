import { IObservableArray, observe, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import {
    CollectedEvent,
    HttpExchange,
    InputRTCDataChannelOpened,
    InputRTCMediaStats,
    InputRTCMediaTrackOpened,
    InputRTCPeerConnected
} from '../../../../src/types';
import type { ProxyStore } from '../../../../src/model/proxy-store';
import type { ApiStore } from '../../../../src/model/api/api-store';
import type { RulesStore } from '../../../../src/model/rules/rules-store';
import { EventsStore } from '../../../../src/model/events/events-store';
import { RTCConnection } from '../../../../src/model/webrtc/rtc-connection';
import { RTCDataChannel } from '../../../../src/model/webrtc/rtc-data-channel';
import { RTCMediaTrack } from '../../../../src/model/webrtc/rtc-media-track';

import { getExchangeData, getFailedTls } from '../../unit-test-helpers';
import { UA, deviceExchange } from '../devices/device-test-helpers';

describe('Deleting many events at once', () => {

    let eventsStore: EventsStore;
    let cleanedUp: string[];

    beforeEach(() => {
        eventsStore = new EventsStore({} as ProxyStore, {} as ApiStore, {} as RulesStore);
        cleanedUp = [];
    });

    // The test exchanges can't run an exchange's own cleanup, so this notes the call instead
    const withCleanup = <T extends CollectedEvent>(event: T): T =>
        Object.assign(event, { cleanup: () => { cleanedUp.push(event.id); } });

    const capture = (...events: CollectedEvent[]) => runInAction(() => { eventsStore.eventsList.push(...events); });
    const ids = (events: ReadonlyArray<CollectedEvent>) => events.map((event) => event.id);

    it('takes them off every list, with one change to each, and cleans them up', () => {
        const exchanges = [0, 1, 2, 3, 4].map(() => withCleanup(getExchangeData()));
        const failure = getFailedTls();
        capture(exchanges[0], failure, ...exchanges.slice(1));

        const changes: string[] = [];
        const stopObserving = [
            observe(eventsStore.events as IObservableArray<CollectedEvent>, (change) => {
                changes.push(`events ${change.type}`);
            }),
            observe(eventsStore.exchanges as IObservableArray<HttpExchange>, (change) => {
                changes.push(`exchanges ${change.type}`);
            })
        ];
        eventsStore.deleteEvents([exchanges[1], failure, exchanges[3]]);
        stopObserving.forEach((stop) => stop());

        expect(changes).to.deep.equal(['events splice', 'exchanges splice']);
        expect(ids(eventsStore.events)).to.deep.equal(ids([exchanges[0], exchanges[2], exchanges[4]]));
        expect(ids(eventsStore.exchanges)).to.deep.equal(ids([exchanges[0], exchanges[2], exchanges[4]]));
        expect(eventsStore.tlsFailures).to.have.length(0);

        expect(eventsStore.eventsList.getById(exchanges[1].id)).to.equal(undefined);
        expect(eventsStore.eventsList.getById(failure.id)).to.equal(undefined);
        expect(eventsStore.eventsList.getById(exchanges[2].id)).to.equal(exchanges[2]);

        expect(cleanedUp).to.deep.equal(ids([exchanges[1], exchanges[3]]));
    });

    it('keeps the sources that a remaining exchange still has', () => {
        const curl = withCleanup(deviceExchange({ ua: UA.curl }));
        const safari = withCleanup(deviceExchange({ ua: UA.macSafari }));
        const otherSafari = withCleanup(deviceExchange({ ua: UA.macSafari }));
        capture(curl, safari, otherSafari);

        const sources = () => eventsStore.activeSources.map((source) => source.summary);
        expect(sources()).to.deep.equal([curl.request.source.summary, safari.request.source.summary]);

        eventsStore.deleteEvents([curl, safari]);
        expect(sources()).to.deep.equal([otherSafari.request.source.summary]);
    });

    it("changes nothing for events that aren't in the list", () => {
        const kept = withCleanup(getExchangeData());
        capture(kept);

        let changes = 0;
        const stopObserving = observe(eventsStore.events as IObservableArray<CollectedEvent>, () => { changes += 1; });
        eventsStore.deleteEvents([]);
        stopObserving();

        expect(changes).to.equal(0);
        expect(ids(eventsStore.events)).to.deep.equal([kept.id]);
    });

    describe('WebRTC', () => {
        let connection: RTCConnection;
        let channel: RTCDataChannel;
        let track: RTCMediaTrack;

        beforeEach(() => {
            connection = new RTCConnection({ sessionId: 'session-1' } as unknown as InputRTCPeerConnected);
            channel = new RTCDataChannel({ channelId: 1 } as unknown as InputRTCDataChannelOpened, connection);
            track = new RTCMediaTrack({ trackMid: '0' } as unknown as InputRTCMediaTrackOpened, connection);

            runInAction(() => {
                eventsStore.eventsList.push(connection, channel, track);
                connection.addStream(channel);
                connection.addStream(track);
            });
        });

        it('takes a deleted stream off its connection, as deleting one does', () => {
            eventsStore.deleteEvents([channel]);

            expect(ids(connection.streams)).to.deep.equal([track.id]);
            expect(ids(eventsStore.events)).to.deep.equal([connection.id, track.id]);
            expect(eventsStore.rtcDataChannels).to.have.length(0);
            expect(ids(eventsStore.rtcMediaTracks)).to.deep.equal([track.id]);
        });

        it("deletes a connection's streams with it, and cleans them up", () => {
            track.addStats({
                eventTimestamp: 1000,
                totalBytesSent: 10,
                totalBytesReceived: 20
            } as unknown as InputRTCMediaStats);
            expect(track.stats).to.have.length(1);

            eventsStore.deleteEvents([connection]);

            expect(eventsStore.events).to.have.length(0);
            expect(eventsStore.rtcConnections).to.have.length(0);
            expect(eventsStore.rtcDataChannels).to.have.length(0);
            expect(eventsStore.rtcMediaTracks).to.have.length(0);
            expect(connection.streams).to.have.length(0);
            expect(track.stats).to.have.length(0);
        });
    });
});
