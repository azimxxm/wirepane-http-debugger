import type * as React from 'react';

import { expect } from '../../../test-setup';
import { getExchangeData } from '../../unit-test-helpers';

import { CollectedEvent, HttpExchangeView } from '../../../../src/types';
import { AccountStore } from '../../../../src/model/account/account-store';
import { UiStore } from '../../../../src/model/ui/ui-store';
import { ContextMenuItem, ContextMenuOption } from '../../../../src/model/ui/context-menu';
import { ViewEventContextMenuBuilder } from '../../../../src/components/view/view-context-menu-builder';

// Native context menus can't be clicked in the running app, so this checks the items they're built from
describe("View's context menu", () => {
    const accountStore = { user: { isPaidUser: () => true } } as unknown as AccountStore;

    function buildMenu(selected: CollectedEvent[], clicked: CollectedEvent) {
        const shown: Array<{ items: readonly ContextMenuItem<unknown>[], data: unknown }> = [];
        const uiStore = {
            selectedEventIds: new Set(selected.map((event) => event.id)),
            exportSnippetFormat: undefined,
            handleContextMenuEvent: (_event: unknown, items: readonly ContextMenuItem<unknown>[], data: unknown) => {
                shown.push({ items, data });
            }
        } as unknown as UiStore;

        const saved: HttpExchangeView[][] = [];
        const noop = () => {};
        const builder = new ViewEventContextMenuBuilder(accountStore, uiStore, () => selected, {
            onPin: noop,
            onDelete: noop,
            onDeleteSelection: noop,
            onBuildRuleFromExchange: noop,
            onBuildRuleFromSelectedExchanges: noop,
            onPrepareToResendRequest: noop,
            onAddFilter: noop,
            onSaveToCollection: (exchanges) => saved.push(exchanges)
        });

        builder.getContextMenuCallback(clicked)({ preventDefault: noop } as unknown as React.MouseEvent);

        const { items, data } = shown[0];
        const option = (label: string) => items.find((item): item is ContextMenuOption<unknown> =>
            item.type === 'option' && item.label === label
        );
        return { option, data, saved };
    }

    it("saves the clicked request to a collection", () => {
        const exchange = getExchangeData();
        const { option, data, saved } = buildMenu([exchange], exchange);

        const save = option('Save to Collection…')!;
        expect(save.accelerator).to.equal('CmdOrCtrl+Shift+S');

        save.callback(data);
        expect(saved).to.deep.equal([[exchange]]);
    });

    it("saves every selected request when several are selected", () => {
        const first = getExchangeData({ path: '/a' });
        const second = getExchangeData({ path: '/b' });
        const { option, data, saved } = buildMenu([first, second], second);

        option('Save 2 Requests to Collection…')!.callback(data);
        expect(saved).to.deep.equal([[first, second]]);
    });
});
