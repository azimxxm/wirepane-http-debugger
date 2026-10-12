import * as _ from 'lodash';
import * as React from 'react';
import { action, computed, observable } from 'mobx';
import { observer, inject } from 'mobx-react';

import { WithInjected } from '../../types';
import { NARROW_LAYOUT_BREAKPOINT, styled } from '../../styles';
import { PhosphorIcon } from '../../icons';
import { trackEvent } from '../../metrics';
import { useHotkeys } from '../../util/ui';
import { formatShortcut } from '../../util/shortcuts';

import { InterceptorStore } from '../../model/interception/interceptor-store';
import { EventsStore } from '../../model/events/events-store';
import { ProxyStore } from '../../model/proxy-store';
import {
    Interceptor,
    MANUAL_INTERCEPT_ID,
    RECOMMENDED_INTERCEPTOR_IDS,
    RECOMMENDED_INTERCEPTOR_TITLES,
    UNIMPLEMENTED_INTERCEPTOR_IDS
} from '../../model/interception/interceptors';
import { THIS_MACHINE } from '../../model/interception/unavailable-reasons';
import { getConnectedClients } from '../../model/traffic-summary';

import { PageHeader, PageLayout } from '../common/page-header';
import { TextInput } from '../common/inputs';
import { IconButton } from '../common/icon-button';
import { CloseButton } from '../common/close-button';
import { Disclosure } from '../common/disclosure';

import { InterceptOption } from './intercept-option';
import { FlowSteps } from './flow-steps';
import { ManualProxyLine } from './manual-proxy-line';
import { ConnectedList } from './connected-list';

interface GuidedInterceptPageProps {
    interceptorStore: InterceptorStore;
    eventsStore: EventsStore;
    proxyStore: ProxyStore;
    navigate: (path: string) => void;
}

const PageScroll = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
`;

const PageContent = styled.div`
    max-width: 1120px;
    box-sizing: border-box;
    margin: 0 auto;
    padding: 24px 24px 48px;

    display: flex;
    flex-direction: column;
    gap: 20px;
`;

const SectionTitle = styled.h2`
    margin-bottom: 10px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

// The intercept option cards: 4 columns (3 on narrow windows), matching the grid
// sizes that the expanded option configs are designed for.
const OptionGrid = styled.div`
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    grid-auto-rows: minmax(128px, auto);
    grid-auto-flow: row dense;
    gap: 16px;

    @media (max-width: ${NARROW_LAYOUT_BREAKPOINT - 1}px) {
        grid-template-columns: repeat(3, minmax(0, 1fr));
    }

    /* Descriptions: secondary text, a step below the title */
    > section > p {
        font-size: ${p => p.theme.textInputFontSize};
        line-height: 1.4;
        color: ${p => p.theme.mainLowlightColor};
    }

    /* Unavailable options stay readable (their reason says why), just quieter */
    > section[disabled] {
        opacity: 1;
        background-color: transparent;

        > h1 {
            color: ${p => p.theme.mainLowlightColor};
        }
    }
`;

const SearchRow = styled.div`
    position: relative;
    max-width: 520px;

    > svg {
        position: absolute;
        left: 10px;
        top: 50%;
        transform: translateY(-50%);
        color: ${p => p.theme.containerWatermark};
        pointer-events: none;
    }
`;

const SearchInput = styled(TextInput)`
    width: 100%;
    height: 32px;
    box-sizing: border-box;
    padding: 0 34px 0 32px;
`;

const ClearSearchButton = styled(IconButton)`
    position: absolute;
    right: 2px;
    top: 50%;
    transform: translateY(-50%);
`;

const NoResults = styled.p`
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const ManualSetupPanel = styled.section`
    position: relative;
    padding: 20px;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
`;

const DisclosureList = styled.div`
    display: flex;
    flex-direction: column;
    gap: 12px;
`;

const InterceptPageShortcuts = (props: { onStartSearch: () => void }) => {
    useHotkeys('Ctrl+f, Cmd+f', (event) => {
        event.preventDefault();
        props.onStartSearch();
    }, [props.onStartSearch]);

    return null;
};

const isUsable = (interceptor: Interceptor) => interceptor.isActivable || interceptor.isActive;

const matchesSearch = (interceptor: Interceptor, query: string) =>
    _.includes(interceptor.name.toLocaleLowerCase(), query) ||
    _.includes(interceptor.description.join(' ').toLocaleLowerCase(), query) ||
    _.some(interceptor.tags, (tag) => _.includes(tag.toLocaleLowerCase(), query));

/**
 * The Intercept page as a guided start: how Wirepane works, the 4 sources most people
 * need, the manual route for everything else, then the full catalogue on demand.
 */
@inject('interceptorStore')
@inject('eventsStore')
@inject('proxyStore')
@observer
class GuidedInterceptPage extends React.Component<GuidedInterceptPageProps> {

    @observable private searchQuery = '';
    @observable private moreSourcesOpen = false;
    @observable private unavailableOpen = false;
    @observable private manualSetupOpen = false;

    private searchInputRef = React.createRef<HTMLInputElement>();

    // Everything the server can actually run, in the order they're defined
    @computed
    private get interceptors(): Interceptor[] {
        return _.values(this.props.interceptorStore.interceptors)
            .filter((interceptor) => !UNIMPLEMENTED_INTERCEPTOR_IDS.has(interceptor.id));
    }

    @computed
    private get recommended(): Interceptor[] {
        const { interceptors } = this.props.interceptorStore;
        return RECOMMENDED_INTERCEPTOR_IDS
            .map((id) => interceptors[id])
            .filter((interceptor) => !!interceptor);
    }

    // Everything except the recommended sources
    @computed
    private get otherSources(): Interceptor[] {
        const recommendedIds: readonly string[] = RECOMMENDED_INTERCEPTOR_IDS;
        return this.interceptors.filter((interceptor) => !recommendedIds.includes(interceptor.id));
    }

    // Every source, the recommended ones included, as the search field promises
    @computed
    private get searchResults(): Interceptor[] {
        const query = this.searchQuery.trim().toLocaleLowerCase();
        const matches = this.interceptors.filter((interceptor) => matchesSearch(interceptor, query));

        // With nothing usable to suggest, offer the manual setup instead:
        const manualSetup = this.props.interceptorStore.interceptors[MANUAL_INTERCEPT_ID];
        if (!matches.some(isUsable) && manualSetup && !matches.includes(manualSetup)) {
            matches.push(manualSetup);
        }

        return _.sortBy(matches, (interceptor) => {
            const exactMatch = interceptor.tags.includes(query) ||
                interceptor.name.toLocaleLowerCase().split(' ').includes(query);

            return -1 * (
                (exactMatch ? 100 : 0) +
                (isUsable(interceptor) ? 50 : 0) +
                (interceptor.isSupported ? 25 : 0)
            );
        });
    }

    render(): JSX.Element {
        const { eventsStore, proxyStore } = this.props;
        const clients = getConnectedClients(eventsStore.activeSources);
        const requestCount = eventsStore.events.length;

        const availableSources = this.otherSources.filter(isUsable);
        const unavailableSources = this.otherSources.filter((interceptor) => !isUsable(interceptor));
        const isSearching = this.searchQuery.trim().length > 0;

        return <PageLayout>
            <InterceptPageShortcuts onStartSearch={this.focusSearch} />
            <PageHeader
                title='Intercept'
                purpose='Connect a browser, terminal, phone or container so its HTTP(S) traffic flows through Wirepane.'
            />

            <PageScroll>
                <PageContent>
                    <FlowSteps
                        hasClients={clients.length > 0}
                        requestCount={requestCount}
                        onViewRequests={this.showRequests}
                    />

                    <section aria-labelledby='recommended-sources-heading'>
                        <SectionTitle id='recommended-sources-heading'>Recommended</SectionTitle>
                        { this.renderOptions(this.recommended) }
                    </section>

                    <ManualProxyLine
                        proxyPort={proxyStore.httpProxyPort}
                        setupOpen={this.manualSetupOpen}
                        onToggleSetup={this.toggleManualSetup}
                    />
                    { this.manualSetupOpen && this.renderManualSetup() }

                    <SearchRow>
                        <PhosphorIcon icon='MagnifyingGlass' size={16} aria-hidden={true} />
                        <SearchInput
                            ref={this.searchInputRef}
                            value={this.searchQuery}
                            placeholder={`Search all ${this.interceptors.length} sources: Firefox, Docker, JVM…`}
                            aria-label='Search all intercept options'
                            aria-keyshortcuts='Meta+F Control+F'
                            title={`Search all sources (${formatShortcut('Cmd+F')})`}
                            onChange={this.onSearchInput}
                            onKeyDown={this.onSearchKeyDown}
                        />
                        { isSearching &&
                            <ClearSearchButton
                                icon={['fas', 'times']}
                                title='Clear the search'
                                onClick={this.clearSearch}
                            />
                        }
                    </SearchRow>

                    { isSearching
                        ? <section aria-label='Search results'>
                            <SectionTitle>
                                { this.searchResults.length } result{ this.searchResults.length === 1 ? '' : 's' }
                            </SectionTitle>
                            { this.searchResults.length > 0
                                ? this.renderOptions(this.searchResults)
                                : <NoResults>No sources match that search.</NoResults>
                            }
                        </section>
                        : <DisclosureList>
                            <Disclosure
                                id='more-sources'
                                title={`More sources (${availableSources.length})`}
                                open={this.moreSourcesOpen}
                                onToggle={this.toggleMoreSources}
                            >
                                { this.renderOptions(availableSources) }
                            </Disclosure>
                            { unavailableSources.length > 0 &&
                                <Disclosure
                                    id='unavailable-sources'
                                    title={`Not available on ${THIS_MACHINE} (${unavailableSources.length})`}
                                    open={this.unavailableOpen}
                                    onToggle={this.toggleUnavailable}
                                >
                                    { this.renderOptions(unavailableSources) }
                                </Disclosure>
                            }
                        </DisclosureList>
                    }

                    { clients.length > 0 && <ConnectedList clients={clients} /> }
                </PageContent>
            </PageScroll>
        </PageLayout>;
    }

    private renderOptions(options: Interceptor[]) {
        return <OptionGrid>
            { options.map((option, index) =>
                <InterceptOption
                    key={option.id}
                    index={index}
                    interceptor={option}
                    title={RECOMMENDED_INTERCEPTOR_TITLES[option.id]}
                    showRequests={this.showRequests}
                />
            ) }
        </OptionGrid>;
    }

    private renderManualSetup() {
        const { interceptorStore } = this.props;
        const manualSetup = interceptorStore.interceptors[MANUAL_INTERCEPT_ID];
        const ConfigComponent = manualSetup?.uiConfig?.configComponent;
        if (!ConfigComponent) return null;

        return <ManualSetupPanel aria-label='Manual setup'>
            <CloseButton
                title='Close the manual setup steps'
                onClose={this.toggleManualSetup}
            />
            <ConfigComponent
                interceptor={manualSetup}
                activateInterceptor={(options?: unknown) =>
                    interceptorStore.activateInterceptor(MANUAL_INTERCEPT_ID, options)
                }
                reportStarted={() => trackEvent({
                    category: 'Interceptors',
                    action: 'Activated',
                    value: MANUAL_INTERCEPT_ID
                })}
                reportSuccess={_.noop}
                closeSelf={this.toggleManualSetup}
            />
        </ManualSetupPanel>;
    }

    private focusSearch = () => {
        this.searchInputRef.current?.focus();
    };

    @action.bound
    private showRequests() {
        this.props.navigate('/view');
    }

    @action.bound
    private onSearchInput(event: React.ChangeEvent<HTMLInputElement>) {
        this.searchQuery = event.currentTarget.value;
    }

    @action.bound
    private onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
        if (event.key === 'Escape' && this.searchQuery) {
            this.searchQuery = '';
            event.stopPropagation();
        }
    }

    @action.bound
    private clearSearch() {
        this.searchQuery = '';
        this.focusSearch();
    }

    @action.bound
    private toggleMoreSources() {
        this.moreSourcesOpen = !this.moreSourcesOpen;
    }

    @action.bound
    private toggleUnavailable() {
        this.unavailableOpen = !this.unavailableOpen;
    }

    @action.bound
    private toggleManualSetup() {
        this.manualSetupOpen = !this.manualSetupOpen;
    }
}

// Exclude the stores from the external props, as they're injected
const InjectedGuidedInterceptPage = GuidedInterceptPage as unknown as WithInjected<
    typeof GuidedInterceptPage,
    'interceptorStore' | 'eventsStore' | 'proxyStore' | 'navigate'
>;
export { InjectedGuidedInterceptPage as GuidedInterceptPage };
