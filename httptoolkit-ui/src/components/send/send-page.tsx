import * as React from 'react';
import { action } from 'mobx';
import { inject, observer } from 'mobx-react';
import * as portals from 'react-reverse-portal';
import * as HarFormat from 'har-format';

import { styled } from '../../styles';
import { useHotkeys } from '../../util/ui';
import { formatShortcut, toHotkeys } from '../../util/shortcuts';
import { WithInjected } from '../../types';

import { ApiError } from '../../services/server-api-types';
import { SendStore } from '../../model/send/send-store';
import { UiStore } from '../../model/ui/ui-store';
import { buildRequestInputFromHarRequest, SendRequest } from '../../model/send/send-request-model';
import { CollectionsStore } from '../../model/collections/collections-store';

import { ContainerSizedEditor } from '../editor/base-editor';

import { SplitPane } from '../split-pane';
import { PageHeader } from '../common/page-header';
import { SendTabs } from './send-tabs';
import { RequestPane } from './request-pane';
import { ResponsePane } from './response-pane';
import { CollectionsHeaderActions, CollectionsWorkspace, collectionTabTitle } from '../collections/send-workspace';
import { CollectionRequestColumn } from '../collections/request-docs-card';
import { SendProblemMessage } from '../collections/send-problem';
import { WebSocketRequestPane } from './websocket/websocket-request-pane';
import { WebSocketMessagesPane } from './websocket/websocket-messages-pane';

const SendPageContainer = styled.div`
    height: 100%;
    position: relative;
    background-color: ${p => p.theme.mainBackground};
    display: flex;
    flex-direction: column;
`;

const TabContentContainer = styled.div`
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    box-shadow: 0 -2px 5px 1px rgba(0,0,0,${p => p.theme.boxShadowAlpha});
`;

const SendPageKeyboardShortcuts = (props: {
    onMoveSelection: (distance: number) => void,
    onCloseTab: () => void,
    onAbortRequest?: () => void
}) => {
    // wirepane: ⌘⇧] & ⌘⇧[ instead of Cmd+Tab, which never reaches the app on macOS
    useHotkeys(`Ctrl+Tab, ${toHotkeys('Cmd+Shift+]')}`, (event) => {
        event.preventDefault();
        props.onMoveSelection(1);
    }, [props.onMoveSelection]);

    useHotkeys(`Ctrl+Shift+Tab, ${toHotkeys('Cmd+Shift+[')}`, (event) => {
        event.preventDefault();
        props.onMoveSelection(-1);
    }, [props.onMoveSelection]);

    useHotkeys('Ctrl+w, Cmd+w', () => {
        props.onCloseTab();
    }, [props.onCloseTab]);

    useHotkeys('Escape', () => {
        if (props.onAbortRequest) props.onAbortRequest();
    }, [props.onAbortRequest]);

    return null;
};

@inject('sendStore')
@inject('uiStore')
@inject('collectionsStore')
@observer
class SendPage extends React.Component<{
    sendStore: SendStore,
    uiStore: UiStore,
    collectionsStore: CollectionsStore,
    navigate: (path: string) => void
}> {

    private requestEditorNode = portals.createHtmlPortalNode<typeof ContainerSizedEditor>({
        attributes: { 'style': 'height: 100%' }
    });
    private responseEditorNode = portals.createHtmlPortalNode<typeof ContainerSizedEditor>({
        attributes: { 'style': 'height: 100%' }
    });

    private sendRequest = () => {
        const {
            sendRequest,
            selectedRequest
        } = this.props.sendStore;

        sendRequest(selectedRequest).catch(e => {
            console.log(e);
            const errorMessage = (e instanceof ApiError && e.apiError?.message)
                ? e.apiError?.message
                : e.message ?? e;
            alert(errorMessage);
        });
    };

    private deleteSelectedRequest = () => {
        const { deleteRequest, selectedRequest } = this.props.sendStore;
        deleteRequest(selectedRequest);
    }

    private showRequestOnViewPage = () => {
        const { sentExchange } = this.props.sendStore.selectedRequest;
        if (!sentExchange) return;

        const { navigate } = this.props;

        navigate(`/view/${sentExchange.id}`);
    }

    render() {
        const {
            sendRequests,
            selectRequest,
            moveSelection,
            deleteRequest,
            selectedRequest,
            addRequestInput
        } = this.props.sendStore;

        const {
            handleContextMenuEvent
        } = this.props.uiStore;
        // wirepane: WebSocket requests get their own panes
        const isWebSocket = selectedRequest.request.extras.requestType === 'websocket';

        return <SendPageContainer>
            <PageHeader
                title='Send'
                purpose={`Build a request or paste a cURL command. Resend captured requests from View with ${formatShortcut('Cmd+R')}.`}
            ><CollectionsHeaderActions /></PageHeader>
            <CollectionsWorkspace><SendTabs
                sendRequests={sendRequests}
                selectedTab={selectedRequest}
                onSelectTab={selectRequest}
                onMoveSelection={moveSelection}
                onCloseTab={deleteRequest}
                onAddTab={addRequestInput}
                onContextMenu={handleContextMenuEvent}
                getTabTitle={this.getTabTitle}
            />

            <SendPageKeyboardShortcuts
                onCloseTab={this.deleteSelectedRequest}
                onMoveSelection={moveSelection}
                onAbortRequest={selectedRequest?.pendingSend?.abort}
            />

            <TabContentContainer
                id='send-tabpanel'
                role='tabpanel'
            >
                <SplitPane
                    split='vertical'
                    primary='second'
                    defaultSize='50%'
                    minSize={300}
                    maxSize={-300}
                >
                    <CollectionRequestColumn sendRequest={selectedRequest}>{ isWebSocket
                        ? <WebSocketRequestPane sendRequest={selectedRequest} />
                        : <RequestPane
                        requestInput={selectedRequest.request}
                        sendRequest={this.sendRequest}
                        isSending={
                            selectedRequest.pendingSend?.promise.state === 'pending'
                        }
                        editorNode={this.requestEditorNode}
                        updateFromHar={this.updateFromHar}
                        belowRequestLine={<SendProblemMessage sendRequest={selectedRequest} />}
                        sendTab={selectedRequest} // wirepane: for the Docs tab
                    /> }</CollectionRequestColumn>
                    { isWebSocket
                    ? <WebSocketMessagesPane sendRequest={selectedRequest} />
                    : <ResponsePane
                        requestInput={selectedRequest.request}
                        exchange={selectedRequest.sentExchange}
                        abortRequest={selectedRequest.pendingSend?.abort}
                        showRequestOnViewPage={selectedRequest.sentExchange
                            ? this.showRequestOnViewPage
                            : undefined
                        }
                        editorNode={this.responseEditorNode}
                    /> }
                </SplitPane>
            </TabContentContainer></CollectionsWorkspace>

            <portals.InPortal node={this.requestEditorNode}>
                <ContainerSizedEditor contentId={null} />
            </portals.InPortal>
            <portals.InPortal node={this.responseEditorNode}>
                <ContainerSizedEditor contentId={null} />
            </portals.InPortal>
        </SendPageContainer>;
    }

    private getTabTitle = (sendRequest: SendRequest) =>
        collectionTabTitle(this.props.collectionsStore, sendRequest);

    @action.bound
    updateFromHar(harRequest: HarFormat.Request) {
        const { selectedRequest } = this.props.sendStore;
        selectedRequest.request = buildRequestInputFromHarRequest(harRequest);
    }

}

// Annoying cast required to handle the store prop nicely in our types
const InjectedSendPage = SendPage as unknown as WithInjected<
    typeof SendPage,
    'sendStore' | 'uiStore' | 'collectionsStore' | 'navigate'
>;
export { InjectedSendPage as SendPage };