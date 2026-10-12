import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';

import { styled } from '../../styles';
import { CollectedEvent } from '../../types';
import { logError } from '../../errors';

import { EventsStore } from '../../model/events/events-store';
import { exportHarFile, HarImportProblem, importHarFile } from '../../model/events/har-files';
import { CLEAR_TRAFFIC_SHORTCUT, IMPORT_HAR_SHORTCUT } from '../../model/ui/app-actions';
import {
    FilterSet,
    SelectableSearchFilterClasses
} from '../../model/filters/search-filters';

import { ActionButton } from '../common/action-button';
import { HarImportProblemDialog } from '../common/har-import-problem-dialog';
import { SearchFilter } from './filters/search-filter';

// The filter sits in the window toolbar, so its growing tag list & its suggestions
// drop down over the list instead of up, as they did in the old footer.
const FilterSlot = styled.div`
    flex: 1 1 320px;
    width: 320px; /* Its natural width too, so the page title gives way before it does */
    min-width: 200px;
    max-width: 560px;
    align-self: flex-start;
    margin-top: 8px; /* Centred in the toolbar at the filter's resting height (35px of 51px) */

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
 * The View page's part of the window toolbar: the traffic filter, and the list
 * actions. Pausing lives in the status bar.
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

    // The same import & export as ⌘K and the menu bar, with problems shown in a dialog
    const [importProblem, setImportProblem] = React.useState<HarImportProblem | undefined>();
    const importHar = () => { importHarFile(props.eventsStore!).then(setImportProblem).catch(logError); };
    const exportHar = () => { exportHarFile(props.filteredEvents).catch(logError); };

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
            shortcut={CLEAR_TRAFFIC_SHORTCUT}
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
            shortcut={IMPORT_HAR_SHORTCUT}
            title='Import requests & responses from a HAR file'
            onClick={importHar}
        >
            Import HAR
        </ActionButton>
        <ActionButton
            icon='UploadSimple'
            title='Export the requests shown here as a HAR file'
            disabled={props.filteredEvents.length === 0}
            onClick={exportHar}
        >
            Export HAR
        </ActionButton>

        { importProblem &&
            <HarImportProblemDialog problem={importProblem} onClose={() => setImportProblem(undefined)} />
        }
    </>;
}));
