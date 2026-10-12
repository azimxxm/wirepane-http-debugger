import * as _ from 'lodash';
import { IObservableArray, observable, runInAction } from 'mobx';

import { expect } from '../../../test-setup';

import { CollectedEvent } from '../../../../src/types';
import {
    Filter,
    FilterSet,
    SelectableSearchFilterClasses as FilterClasses,
    StringFilter
} from '../../../../src/model/filters/search-filters';
import { applySuggestionToFilters, getFilterSuggestions } from '../../../../src/model/filters/filter-matching';
import { getThisMachineName } from '../../../../src/model/devices/device-model';
import { THIS_MACHINE_TYPE } from '../../../../src/model/devices/device-directory';
import { DevicesStore } from '../../../../src/model/devices/devices-store';

import { MemoryStorage, UA, deviceExchange, failedTls } from './device-test-helpers';

// Given an exact input for a filter, creates the filter (as the filter box would)
function createFilter(input: string): Filter {
    const initialFilters: FilterSet = [new StringFilter(input)];
    const suggestions = getFilterSuggestions(FilterClasses, input).filter((s) => s.matchType === 'full');
    expect(suggestions.length).to.equal(1, `suggestions for ${input}`);

    const updatedFilters = applySuggestionToFilters(initialFilters, suggestions[0]);
    expect(updatedFilters.length).to.equal(2);
    return updatedFilters[1];
}

// What the filter box would contain after picking each suggestion
const suggestionTexts = (input: string, events?: CollectedEvent[]) =>
    getFilterSuggestions(FilterClasses, input, events)
        .filter((s) => s.matchType === 'full')
        .map((s) => input.slice(0, s.index) + s.showAs);

const describeInput = (input: string) => {
    const suggestion = getFilterSuggestions(FilterClasses, input)[0];
    return suggestion.filterClass.filterDescription(input, suggestion.matchType === 'template');
};

describe('Device filters', () => {

    const iphone = deviceExchange({ ip: '192.168.0.23', ua: UA.iphoneSafari });
    const iphoneApp = deviceExchange({ ip: '::ffff:192.168.0.23', ua: UA.iosApp });
    const ipad = deviceExchange({ ip: '192.168.0.24', ua: UA.ipadApp });
    const android = deviceExchange({ ip: '192.168.0.42', ua: UA.androidChrome });
    const androidApp = deviceExchange({ ip: '192.168.0.42', ua: UA.okhttp });
    const local = deviceExchange({ ip: '127.0.0.1', ua: UA.curl });
    const sentFromSend = deviceExchange({ sentFromSendPage: true });
    const tlsFailure = failedTls('192.168.0.42');
    const allEvents: CollectedEvent[] = [iphone, iphoneApp, ipad, android, androidApp, local, sentFromSend, tlsFailure];

    const matching = (input: string, events = allEvents) => {
        const filter = createFilter(input);
        return events.filter((event) => filter.matches(event));
    };

    describe('device=', () => {
        it('matches requests from a type of device', () => {
            expect(matching('device=android')).to.deep.equal([android, androidApp]);
            expect(matching('device=ios')).to.deep.equal([iphone, iphoneApp, ipad]);
            // On its own, an app request using Apple's networking could be either
            expect(matching('device=ipad')).to.deep.equal([iphoneApp, ipad]);
        });

        it('matches this machine, including requests from the Send page', () => {
            expect(matching('device=this')).to.deep.equal([local, sentFromSend]);
        });

        it('can exclude a type of device', () => {
            expect(matching('device!=this')).to.deep.equal([iphone, iphoneApp, ipad, android, androidApp, tlsFailure]);
        });

        it('suggests every keyword', () => {
            expect(suggestionTexts('device=')).to.deep.equal([
                'device=iphone', 'device=ipad', 'device=ios', 'device=android', 'device=mac',
                'device=windows', 'device=linux', 'device=this', 'device=other'
            ]);
            expect(suggestionTexts('device=i')).to.deep.equal(['device=iphone', 'device=ipad', 'device=ios']);
        });

        it('describes what it matches', () => {
            expect(describeInput('device')).to.equal('requests from a given type of device');
            expect(describeInput('device=iphone')).to.equal('requests from iPhones');
            expect(describeInput('device!=this')).to.equal(
                `requests not from ${_.lowerFirst(getThisMachineName(THIS_MACHINE_TYPE))}`
            );
            expect(createFilter('device=iphone').toString()).to.equal('Device = iPhone');
        });

        describe('with the devices store', () => {
            let events: IObservableArray<CollectedEvent>;
            let store: DevicesStore;

            beforeEach(async () => {
                events = observable.array<CollectedEvent>([], { deep: false });
                store = new DevicesStore({ events }, { nameStorage: new MemoryStorage(), thisMachineType: 'mac' });
                await store.initialized;
                runInAction(() => { events.push(...allEvents); });
            });

            afterEach(() => store.dispose());

            it("uses the whole device's type, not just each request's", () => {
                // The app only says "iOS", but the same phone's Safari said iPhone
                expect(matching('device=iphone')).to.deep.equal([iphone, iphoneApp]);
                expect(matching('device=ipad')).to.deep.equal([ipad]);
                // The failed TLS connection has no user agent, but came from the Pixel
                expect(matching('device=android')).to.deep.equal([android, androidApp, tlsFailure]);
                expect(matching('device=mac')).to.deep.equal([local, sentFromSend]);
            });
        });
    });

    describe('client-ip=', () => {
        it('matches requests from an address, however it was written', () => {
            expect(matching('client-ip=192.168.0.23')).to.deep.equal([iphone, iphoneApp]);
            expect(matching('client-ip=::ffff:192.168.0.42')).to.deep.equal([android, androidApp, tlsFailure]);
            expect(matching('client-ip=127.0.0.1')).to.deep.equal([local]);
        });

        it('matches parts of addresses', () => {
            expect(matching('client-ip^=192.168.0.2')).to.deep.equal([iphone, iphoneApp, ipad]);
            expect(matching('client-ip$=.42')).to.deep.equal([android, androidApp, tlsFailure]);
        });

        it("doesn't match requests without an address", () => {
            expect(matching('client-ip!=192.168.0.23')).to.deep.equal([ipad, android, androidApp, local, tlsFailure]);
        });

        it('suggests the addresses in the captured traffic', () => {
            expect(suggestionTexts('client-ip=', allEvents)).to.deep.equal([
                'client-ip=192.168.0.23',
                'client-ip=192.168.0.24',
                'client-ip=192.168.0.42',
                'client-ip=127.0.0.1'
            ]);
            expect(suggestionTexts('client-ip=192.168.0.4', allEvents)).to.deep.equal([
                'client-ip=192.168.0.4',
                'client-ip=192.168.0.42'
            ]);
        });

        it('describes what it matches', () => {
            expect(describeInput('client-ip=192.168.0.23')).to.equal('requests from 192.168.0.23');
            expect(createFilter('client-ip=::ffff:192.168.0.23').toString()).to.equal('Client IP = 192.168.0.23');
        });
    });

    describe('app=', () => {
        it('matches requests from an app, ignoring case', () => {
            expect(matching('app=safari')).to.deep.equal([iphone]);
            expect(matching('app=OkHttp')).to.deep.equal([androidApp]);
            expect(matching('app*=book')).to.deep.equal([iphoneApp]);
        });

        it('takes names with spaces in brackets', () => {
            expect(matching('app=[Wirepane (Send)]')).to.deep.equal([sentFromSend]);
        });

        it('suggests the apps in the captured traffic', () => {
            expect(suggestionTexts('app=', allEvents)).to.include.members([
                'app=Safari',
                'app=Bookshelf',
                'app=curl',
                'app=[Wirepane (Send)]'
            ]);
        });
    });

    describe('inside not() and or()', () => {
        it('hides this machine with not(device=this)', () => {
            expect(matching('not(device=this)')).to.deep.equal(_.without(allEvents, local, sentFromSend));
        });

        it('combines device filters with or()', () => {
            expect(matching('or(device=android, client-ip=127.0.0.1)')).to.deep.equal([android, androidApp, local]);
        });
    });
});
