import * as React from 'react';
import * as polished from 'polished';
import { action } from 'mobx';
import { inject, observer } from 'mobx-react';
import { WarningCircle } from '@phosphor-icons/react';

import { styled } from '../../../styles';
import { RawHeaders } from '../../../types';
import { useHotkeys } from '../../../util/ui';
import { logError } from '../../../errors';

import { SendRequest } from '../../../model/send/send-request-model';
import { SendStore } from '../../../model/send/send-store';
import { UiStore } from '../../../model/ui/ui-store';
import type { WebSocketMessage, WebSocketMessageType } from '../../../model/send/send-extras';
import { switchRequestType } from '../../../model/send/websocket/request-type';
import { webSocketSessionsFor } from '../../../model/send/websocket/websocket-sessions';
import { connectTab, sendComposedMessage } from '../../../model/send/websocket/websocket-actions';

import { SendCardContainer } from '../send-card-section';
import { SendProblemMessage } from '../../collections/send-problem';
import { WebSocketRequestLine } from './websocket-request-line';
import { WebSocketHeadersCard } from './websocket-headers-card';
import { WebSocketComposerCard } from './websocket-composer-card';
import { WebSocketSavedMessagesCard } from './websocket-saved-messages-card';

const ProblemRow = styled.div`
    flex-shrink: 0;
    padding: 8px 16px;

    display: flex;
    align-items: flex-start;
    gap: 8px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.error};
    background-color: ${p => polished.rgba(p.theme.error, 0.08)};
    border-bottom: 1px solid ${p => polished.rgba(p.theme.error, 0.3)};

    > svg {
        flex-shrink: 0;
        margin-top: 2px;
    }
`;

const WebSocketPaneShortcuts = (props: {
    onCmdEnter: () => void,
    onEscape: () => void
}) => {
    useHotkeys('Ctrl+Enter, Cmd+Enter', (event) => {
        event.preventDefault();
        props.onCmdEnter();
    }, [props.onCmdEnter]);

    useHotkeys('Escape', () => {
        props.onEscape();
    }, [props.onEscape]);

    return null;
};

/**
 * The left side of Send for a WebSocket request: URL and Connect, handshake headers and
 * the message composer with saved messages. Shown instead of the HTTP request pane.
 */
@inject('sendStore')
@inject('uiStore')
@observer
class WebSocketRequestPaneComponent extends React.Component<{
    sendRequest: SendRequest,
    sendStore?: SendStore,
    uiStore?: UiStore
}> {

    get session() {
        return webSocketSessionsFor(this.props.sendStore!).sessionFor(this.props.sendRequest);
    }

    get request() {
        return this.props.sendRequest.request;
    }

    get draft() {
        return this.request.extras.websocket;
    }

    get cardProps() {
        return this.props.uiStore!.sendCardProps;
    }

    componentDidMount() {
        // The composer uses the body card's space, which bodyless GET requests collapse
        const composerCard = this.cardProps.requestBody;
        if (composerCard.collapsed) composerCard.onCollapseToggled();
    }

    render() {
        const { sendRequest, uiStore } = this.props;
        const { session, request, draft } = this;

        const connectProblem = session.connectProblem?.url === request.url
            ? session.connectProblem.message
            : undefined;
        const sendProblem = session.sendProblem?.content === draft.message
            ? session.sendProblem.message
            : undefined;

        return <SendCardContainer hasExpandedChild={!!uiStore!.expandedSendRequestCard}>
            <WebSocketPaneShortcuts
                onCmdEnter={this.onCmdEnter}
                onEscape={this.cancel}
            />

            <WebSocketRequestLine
                url={request.url}
                updateUrl={this.updateUrl}
                switchToHttp={this.switchToHttp}
                connectionStatus={session.state.status}
                connect={this.connect}
                cancel={this.cancel}
                disconnect={this.disconnect}
            />
            <SendProblemMessage sendRequest={sendRequest} />
            { connectProblem && <ProblemRow role='alert'>
                <WarningCircle size={16} weight='fill' aria-hidden={true} />
                <span>{ connectProblem }</span>
            </ProblemRow> }

            <WebSocketHeadersCard
                {...this.cardProps.requestHeaders}
                headers={request.headers}
                updateHeaders={this.updateHeaders}
            />
            <WebSocketComposerCard
                {...this.cardProps.requestBody}
                ariaLabel='Message section'
                contentId={`websocket-message-${sendRequest.id}`}
                message={draft.message}
                messageType={draft.messageType}
                onMessageChange={this.updateMessage}
                onMessageTypeChange={this.updateMessageType}
                canSend={session.isOpen}
                onSend={this.sendDraft}
                sendProblem={sendProblem}
                onSave={this.saveDraft}
            />
            <WebSocketSavedMessagesCard
                savedMessages={draft.savedMessages}
                canSend={session.isOpen}
                onLoad={this.loadSavedMessage}
                onSend={this.sendSavedMessage}
                onDelete={this.deleteSavedMessage}
            />
        </SendCardContainer>;
    }

    private connect = () => {
        const { sendStore, sendRequest } = this.props;
        connectTab(sendStore!, sendRequest, this.session).catch(logError);
    };

    private cancel = () => this.session.cancel();

    private disconnect = () => {
        this.session.disconnect().catch(logError);
    };

    // ⌘↵ sends the message once connected, and connects otherwise
    private onCmdEnter = () => {
        const { session } = this;
        if (session.isOpen) this.sendDraft();
        else if (!session.isActive) this.connect();
    };

    private send(content: string, type: WebSocketMessageType) {
        const { sendStore, sendRequest } = this.props;
        sendComposedMessage(sendStore!, sendRequest, this.session, content, type).catch(logError);
    }

    private sendDraft = () => {
        this.send(this.draft.message, this.draft.messageType);
    };

    private sendSavedMessage = (saved: WebSocketMessage) => {
        this.send(saved.content, saved.type);
    };

    @action.bound
    private updateUrl(url: string) {
        this.request.url = url;
    }

    private switchToHttp = (method: string) => {
        switchRequestType(this.request, 'http', method);
    };

    @action.bound
    private updateHeaders(headers: RawHeaders) {
        this.request.headers = headers;
    }

    @action.bound
    private updateMessage(message: string) {
        this.draft.message = message;
    }

    @action.bound
    private updateMessageType(type: WebSocketMessageType) {
        this.draft.messageType = type;
    }

    // Saving under an existing name replaces that message
    @action.bound
    private saveDraft(name: string) {
        const { savedMessages } = this.draft;
        const messageName = name || nextMessageName(savedMessages);

        const existing = savedMessages.find((saved) => saved.name === messageName);
        if (existing) {
            existing.content = this.draft.message;
            existing.type = this.draft.messageType;
        } else {
            savedMessages.push({
                id: crypto.randomUUID(),
                name: messageName,
                type: this.draft.messageType,
                content: this.draft.message
            });
        }
    }

    @action.bound
    private loadSavedMessage(saved: WebSocketMessage) {
        this.draft.message = saved.content;
        this.draft.messageType = saved.type;
    }

    @action.bound
    private deleteSavedMessage(saved: WebSocketMessage) {
        const { savedMessages } = this.draft;
        const index = savedMessages.indexOf(saved);
        if (index !== -1) savedMessages.splice(index, 1);
    }

}

function nextMessageName(savedMessages: readonly WebSocketMessage[]) {
    const names = new Set(savedMessages.map((saved) => saved.name));
    let number = savedMessages.length + 1;
    while (names.has(`Message ${number}`)) number += 1;
    return `Message ${number}`;
}

export const WebSocketRequestPane = WebSocketRequestPaneComponent as unknown as React.ComponentType<{
    sendRequest: SendRequest
}>;
