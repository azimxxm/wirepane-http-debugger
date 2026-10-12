import * as React from 'react';
import { inject, observer } from 'mobx-react';
import * as dateFns from 'date-fns';
import * as dedent from 'dedent';
import * as Ajv from 'ajv';

import { styled } from '../../styles';
import { CollectedEvent, ViewableEvent } from '../../types';
import { saveFile, uploadFile } from '../../util/ui';
import { formatAjvError } from '../../util/json-schema';
import { logError } from '../../errors';

import { EventsStore } from '../../model/events/events-store';
import { generateHar } from '../../model/http/har';
import {
    FilterSet,
    SelectableSearchFilterClasses
} from '../../model/filters/search-filters';

import { ActionButton } from '../common/action-button';
import { SearchFilter } from './filters/search-filter';

// Same behaviour as the old list footer's HAR buttons (view-event-list-buttons.tsx),
// which these labelled toolbar buttons replace:
async function exportEventsAsHar(events: ReadonlyArray<ViewableEvent>) {
    const harContent = JSON.stringify(await generateHar(events));
    const filename = `Wirepane_${dateFns.format(Date.now(), 'YYYY-MM-DD_HH-mm')}.har`; // wirepane: our name

    saveFile(filename, 'application/har+json;charset=utf-8', harContent);
}

async function importHarFile(eventsStore: EventsStore) {
    const uploadedFile = await uploadFile('text', ['.har', 'application/har', 'application/har+json']);
    if (!uploadedFile) return;

    let data: {} = {};
    try {
        data = JSON.parse(uploadedFile);
        await eventsStore.loadFromHar(data);
    } catch (error: any) {
        logError(error);

        if (error.name === 'HARError' && error.errors) {
            alert(dedent`
                HAR file is not valid.

                ${
                    error.errors
                    .map((e: Ajv.ErrorObject) => formatAjvError(data, e))
                    .join('\n')
                }
            `);
        } else {
            alert(dedent`
                Could not parse HAR file.

                ${error.message || error}
            `);
        }
    }
}

// The filter sits in the page header, so its growing tag list & its suggestions
// drop down over the list instead of up, as they did in the old footer.
const FilterSlot = styled.div`
    flex: 1 1 320px;
    min-width: 200px;
    max-width: 560px;
    align-self: flex-start;
    margin-top: 11px; /* Centred in the header, at the filter's resting height */

    position: relative;
    display: flex;

    .react-autosuggest__suggestions-container {
        top: calc(100% + 6px);
        bottom: auto;
    }
`;

const FilteredCount = styled.span`
    flex-shrink: 0;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
`;

/**
 * The View page's toolbar, shown inside its page header: the traffic filter, and
 * the list actions. Pausing lives in the status bar.
 */
export const ViewToolbar = inject('eventsStore')(observer((props: {
    eventsStore?: EventsStore,

    allEvents: ReadonlyArray<CollectedEvent>,
    filteredEvents: ReadonlyArray<CollectedEvent>,
    // Tracked separately from filteredEvents, which is debounced (see ViewPage)
    filteredCount: [filtered: number, fromTotal: number],

    searchInputRef?: React.Ref<HTMLInputElement>,
    onFiltersConsidered: (filters: FilterSet | undefined) => void,
    onClear: () => void,
    onScrollToEnd: () => void
}) => {
    const [shownCount, totalCount] = props.filteredCount;
    const hasEvents = props.allEvents.length > 0;

    return <>
        <FilterSlot>
            <SearchFilter
                onFiltersConsidered={props.onFiltersConsidered}
                availableFilters={SelectableSearchFilterClasses}
                filterSuggestionContext={props.allEvents}
                placeholder={'Filter by method, host, headers, status...'}
                searchInputRef={props.searchInputRef}
            />
        </FilterSlot>

        { shownCount !== totalCount &&
            <FilteredCount aria-live='polite'>
                { shownCount.toLocaleString() } of { totalCount.toLocaleString() } shown
            </FilteredCount>
        }

        <ActionButton
            icon='Trash'
            shortcut='Cmd+Shift+Backspace'
            shortcutInTooltipOnly={true}
            title='Clear all captured traffic'
            disabled={!hasEvents}
            onClick={props.onClear}
        >
            Clear
        </ActionButton>
        <ActionButton
            icon='ArrowLineDown'
            title='Scroll to the newest request'
            disabled={!hasEvents}
            onClick={props.onScrollToEnd}
        >
            Jump to latest
        </ActionButton>
        <ActionButton
            icon='DownloadSimple'
            title='Import requests & responses from a HAR file'
            onClick={() => importHarFile(props.eventsStore!)}
        >
            Import HAR
        </ActionButton>
        <ActionButton
            icon='UploadSimple'
            title='Export the requests shown here as a HAR file'
            disabled={props.filteredEvents.length === 0}
            onClick={() => exportEventsAsHar(props.filteredEvents)}
        >
            Export HAR
        </ActionButton>
    </>;
}));
