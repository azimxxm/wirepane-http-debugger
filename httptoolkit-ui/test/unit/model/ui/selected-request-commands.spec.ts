import { observable } from 'mobx';

import { expect } from '../../../test-setup';
import { getExchangeData, getFailedTls } from '../../unit-test-helpers';

import { CollectedEvent } from '../../../../src/types';
import { getSelectedRequestCommands, SelectedRequestDeps } from '../../../../src/model/ui/selected-request-commands';

describe('Selected request commands', () => {

    function buildDeps(events: CollectedEvent[], selectedIds: string[]) {
        const calls: string[] = [];
        const draftRules = { items: observable.array<any>([]) };

        const deps: SelectedRequestDeps = {
            uiStore: { selectedEventIds: new Set(selectedIds) } as SelectedRequestDeps['uiStore'],
            eventsStore: {
                eventsList: { getById: (id: string) => events.find((event) => event.id === id) }
            } as unknown as SelectedRequestDeps['eventsStore'],
            rulesStore: { draftRules } as unknown as SelectedRequestDeps['rulesStore'],
            sendStore: {
                addRequestInputFromExchange: async () => { calls.push('addRequestInputFromExchange'); }
            } as unknown as SelectedRequestDeps['sendStore'],
            navigate: (path: string) => { calls.push(`navigate:${path}`); }
        };

        return { deps, calls, draftRules };
    }

    it('needs exactly one selected HTTP request', () => {
        const exchange = getExchangeData();
        const otherExchange = getExchangeData();
        const tlsFailure = getFailedTls();
        const events = [exchange, otherExchange, tlsFailure];

        expect(getSelectedRequestCommands(buildDeps(events, []).deps)).to.equal(undefined);
        expect(getSelectedRequestCommands(buildDeps(events, [exchange.id, otherExchange.id]).deps)).to.equal(undefined);
        expect(getSelectedRequestCommands(buildDeps(events, [tlsFailure.id]).deps)).to.equal(undefined);
        expect(getSelectedRequestCommands(buildDeps(events, ['gone']).deps)).to.equal(undefined);
        expect(getSelectedRequestCommands(buildDeps(events, [exchange.id]).deps)!.isPlainHttp).to.equal(true);
    });

    it('mocks the response with a new Modify rule, and opens it', () => {
        const exchange = getExchangeData({ path: '/todos/1', statusCode: 201 });
        const { deps, calls, draftRules } = buildDeps([exchange], [exchange.id]);

        getSelectedRequestCommands(deps)!.mockResponse();

        expect(draftRules.items).to.have.length(1);
        expect(calls).to.deep.equal([`navigate:/modify/${draftRules.items[0].id}`]);
    });

    it('resends the request from Send', async () => {
        const exchange = getExchangeData();
        const { deps, calls } = buildDeps([exchange], [exchange.id]);

        getSelectedRequestCommands(deps)!.resend();
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(calls).to.deep.equal(['addRequestInputFromExchange', 'navigate:/send']);
    });

    it('pins & unpins the request', () => {
        const exchange = Object.assign(getExchangeData(), { pinned: false });
        const { deps } = buildDeps([exchange], [exchange.id]);

        getSelectedRequestCommands(deps)!.togglePinned();
        expect(exchange.pinned).to.equal(true);
        expect(getSelectedRequestCommands(deps)!.isPinned).to.equal(true);

        getSelectedRequestCommands(deps)!.togglePinned();
        expect(exchange.pinned).to.equal(false);
    });

});
