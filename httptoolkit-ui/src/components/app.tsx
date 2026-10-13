import * as _ from 'lodash';
import * as React from 'react';
import { autorun, computed, IReactionDisposer } from 'mobx';
import { observer, inject } from 'mobx-react';
import {
    Router,
    RouteComponentProps,
    Redirect,
    LocationProvider
} from '@reach/router';

import { styled } from '../styles';
import { WithInjected } from '../types';
import { appHistory } from '../routing';
import { formatShortcut } from '../util/shortcuts';

import { UiStore } from '../model/ui/ui-store';
import { ProxyStore } from '../model/proxy-store';
import {
    canUseMcp,
    canVisitModify,
    canVisitSend,
    GO_INTERCEPT_SHORTCUT,
    GO_MODIFY_SHORTCUT,
    GO_SEND_SHORTCUT,
    GO_VIEW_SHORTCUT,
    REPORT_ISSUE_URL,
    SETTINGS_SHORTCUT
} from '../model/ui/app-actions';

import { Rail, RailItem } from './rail';
import { AppToolbar } from './app-toolbar'; // wirepane
import { AppActionsHost } from './app-actions-host';
import { StatusBar } from './status-bar';
import { GuidedInterceptPage } from './intercept/guided-intercept-page';
import { ConnectIPhonePage } from './intercept/phone/connect-iphone-page';
import { ConnectAndroidPage } from './intercept/phone/connect-android-page';
import { IPHONE_SETUP_PATH, ANDROID_SETUP_PATH } from './intercept/phone/phone-setup-routes';
import { ViewPage } from './view/view-page';
import { ModifyPage } from './modify/modify-page';
import { SendPage } from './send/send-page';
import { SettingsPage } from './settings/settings-page';
import { NetworkPage, NETWORK_PATH } from './network/network-page'; // wirepane

import { HtmlContextMenu } from './html-context-menu';
import { DisconnectedWarning } from './disconnected-warning';
import { McpModal } from './mcp/mcp-modal';
import { CollectionsDialogs } from './collections/collections-dialogs';
import { ZipExportDialog } from './view/zip-export-dialog';

// wirepane: the toolbar along the top, then the rail and the page below it
const AppContainer = styled.div`
    display: flex;
    flex-direction: column;
    height: 100%;
`;

const AppBody = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
`;

// The current page, with the status bar below it
const MainColumn = styled.div`
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;

    display: flex;
    flex-direction: column;
`;

const PageSlot = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    position: relative;

    > div { /* The router's own wrapper element */
        height: 100%;
    }
`;

interface ExtendProps extends React.ComponentProps<any> {
    pageComponent: React.ComponentType<any>;
}

const Route = ({ children, ...props }: ExtendProps & RouteComponentProps): React.ReactElement => {
	const { pageComponent, ...otherProps } = props;
	return (
		<props.pageComponent {...otherProps}>
			{children}
		</props.pageComponent>
	)
};

// wirepane: the page shortcuts (⌘1–⌘4, and ⌘, or ⌘9 for Settings) are app actions now, bound
// with the rest by AppActionsHost (model/ui/app-actions.ts)

@inject('uiStore')
@inject('proxyStore')
@observer
class App extends React.Component<{
    uiStore: UiStore,
    proxyStore: ProxyStore
}> {

    @computed
    get canUseMcp() {
        return canUseMcp(this.props.proxyStore);
    }

    private closeZipExportOnOtherModal?: IReactionDisposer;

    componentDidMount() {
        this.closeZipExportOnOtherModal = autorun(() => {
            if (this.props.uiStore.mcpModalOpen) {
                this.props.uiStore.closeZipExport();
            }
        });
    }

    componentWillUnmount() {
        this.closeZipExportOnOtherModal?.();
    }

    @computed
    get canVisitSend() {
        // Hide Send option if the server is too old for proper support.
        // We show by default to avoid flicker in the most common case
        return canVisitSend();
    }

    @computed
    get menuItems() {
        return [
            {
                name: 'Intercept',
                title: `Connect clients to Wirepane (${formatShortcut(GO_INTERCEPT_SHORTCUT)})`,
                icon: 'Plugs',
                position: 'top',
                type: 'router',
                url: '/intercept'
            },
            {
                name: 'View',
                title: `View intercepted HTTP traffic (${formatShortcut(GO_VIEW_SHORTCUT)})`,
                icon: 'Rows',
                position: 'top',
                type: 'router',
                url: '/view'
            },

            ...(
                // Hide Modify option if the server is too old for proper support.
                // We show by default to avoid flicker in the most common case
                canVisitModify()
                ? [{
                    name: 'Modify',
                    title: `Add rules to transform & mock HTTP traffic (${formatShortcut(GO_MODIFY_SHORTCUT)})`,
                    icon: 'Pencil',
                    position: 'top',
                    type: 'router',
                    url: '/modify'
                }]
                : []
            ),

            ...(this.canVisitSend
                ? [{
                    name: 'Send',
                    title: `Send HTTP requests directly (${formatShortcut(GO_SEND_SHORTCUT)})`,
                    icon: 'PaperPlaneTilt',
                    position: 'top',
                    type: 'router',
                    url: '/send'
                }]
                : []
            ),

            {
                name: 'Settings',
                title: `Reconfigure Wirepane (${formatShortcut(SETTINGS_SHORTCUT)})`,
                icon: 'GearSix',
                position: 'bottom',
                type: 'router',
                url: '/settings'
            },

            ...(this.canUseMcp
                ? [{
                    name: 'AI',
                    title: 'Connect AI assistants (MCP)',
                    icon: 'Sparkle',
                    position: 'bottom',
                    type: 'callback',
                    onClick: this.props.uiStore.openMcpModal
                }]
                : []
            ),

            {
                // A quiet icon in the rail's own colour, never an accent. The same page as
                // Help → Report an Issue in the desktop menu bar, and "Report an issue" in ⌘K.
                name: 'Send feedback',
                title: 'Send feedback: report an issue or suggest a feature',
                icon: 'ChatText',
                position: 'bottom',
                iconOnly: true,
                type: 'web',
                url: REPORT_ISSUE_URL
            }
        ] as RailItem[];
    }

    render() {
        const {
            contextMenuState,
            clearHtmlContextMenu
        } = this.props.uiStore;

        return <LocationProvider history={appHistory}>
            <AppActionsHost />
            <AppContainer>
                <AppToolbar />
                <AppBody><Rail items={this.menuItems} />

                <MainColumn>
                    <PageSlot>
                        <Router>
                            <Redirect noThrow from="/" to={'/intercept'} />
                            <Route path={'/intercept'} pageComponent={GuidedInterceptPage} />
                            <Route path={IPHONE_SETUP_PATH} pageComponent={ConnectIPhonePage} />
                            <Route path={ANDROID_SETUP_PATH} pageComponent={ConnectAndroidPage} />
                            <Route path={'/view'} pageComponent={ViewPage} />
                            <Route path={'/view/:eventId'} pageComponent={ViewPage} />
                            <Route path={'/modify'} pageComponent={ModifyPage} />
                            <Route path={'/modify/:initialRuleId'} pageComponent={ModifyPage} />
                            <Route path={'/send'} pageComponent={SendPage} />
                            <Route path={'/settings'} pageComponent={SettingsPage} />
                            {/* wirepane: the VPN's network tools */}
                            <Route path={NETWORK_PATH} pageComponent={NetworkPage} />
                        </Router>
                    </PageSlot>
                    <StatusBar />
                </MainColumn></AppBody>

                <DisconnectedWarning />
            </AppContainer>

            { this.props.uiStore.mcpModalOpen && this.canUseMcp &&
                <McpModal onClose={this.props.uiStore.closeMcpModal} />
            }

            <CollectionsDialogs />

            { this.props.uiStore.zipExportRequest &&
                <ZipExportDialog
                    events={this.props.uiStore.zipExportRequest.events}
                    onClose={this.props.uiStore.closeZipExport}
                />
            }

            {
                contextMenuState &&
                    <HtmlContextMenu
                        menuState={contextMenuState}
                        onHidden={clearHtmlContextMenu}
                    />
            }
        </LocationProvider>;
    }
}

// Annoying cast required to handle the store prop nicely in our types
const AppWithStoreInjected = (
    App as unknown as WithInjected<typeof App, 'accountStore' | 'uiStore' | 'proxyStore'>
);

export { AppWithStoreInjected as App };