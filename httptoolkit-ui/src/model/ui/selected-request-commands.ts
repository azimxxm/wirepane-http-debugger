import { action } from 'mobx';

import type { EventsStore } from '../events/events-store';
import type { RulesStore } from '../rules/rules-store';
import type { SendStore } from '../send/send-store';
import type { UiStore } from './ui-store';
import type { SelectedRequestCommands } from './app-actions';

import { copyToClipboard } from '../../util/ui';
import { logError } from '../../errors';
import { buildRuleFromExchange } from '../rules/rule-creation';
import { generateCodeSnippet } from './export';
import { DEFAULT_SNIPPET_FORMAT_KEY, getCodeSnippetOptionFromKey } from './snippet-formats';

export interface SelectedRequestDeps {
    uiStore: Pick<UiStore, 'selectedEventIds'>;
    eventsStore: Pick<EventsStore, 'eventsList'>;
    rulesStore: Pick<RulesStore, 'draftRules'>;
    sendStore: Pick<SendStore, 'addRequestInputFromExchange'>;
    navigate: (path: string) => void;
}

/**
 * The ⌘K palette's "This request" commands, for the one HTTP request selected in View. They do
 * what View's own ⌘M, ⌘R & ⌘P shortcuts do, on the request as it was captured.
 */
export function getSelectedRequestCommands(deps: SelectedRequestDeps): SelectedRequestCommands | undefined {
    const { selectedEventIds } = deps.uiStore;
    if (selectedEventIds.size !== 1) return undefined;

    const [eventId] = Array.from(selectedEventIds);
    const event = deps.eventsStore.eventsList.getById(eventId);
    if (!event?.isHttp()) return undefined;

    return {
        isPlainHttp: !event.isWebSocket(),
        isPinned: event.pinned,

        mockResponse: action(() => {
            const rule = buildRuleFromExchange(event);
            deps.rulesStore.draftRules.items.unshift(rule);
            deps.navigate(`/modify/${rule.id}`);
        }),

        resend: () => {
            deps.sendStore.addRequestInputFromExchange(event)
                .then(() => deps.navigate('/send'))
                .catch(logError);
        },

        copyAsCurl: () => {
            const curlFormat = getCodeSnippetOptionFromKey(DEFAULT_SNIPPET_FORMAT_KEY);
            generateCodeSnippet(event, curlFormat, { waitForBodyDecoding: true })
                .then(copyToClipboard)
                .catch(logError);
        },

        togglePinned: action(() => {
            event.pinned = !event.pinned;
        })
    };
}
