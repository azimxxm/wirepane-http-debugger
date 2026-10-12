import * as _ from 'lodash';
import * as React from 'react';
import { action } from 'mobx';
import { inject, observer } from 'mobx-react';
import * as portals from 'react-reverse-portal';
import * as HarFormat from 'har-format';

import { RawHeaders } from '../../types';

import { AccountStore } from '../../model/account/account-store';
import { RulesStore } from '../../model/rules/rules-store';
import { UiStore } from '../../model/ui/ui-store';
import { RequestInput, SendRequest } from '../../model/send/send-request-model';
import { ContextMenuItem } from '../../model/ui/context-menu';
import { messageDialog } from '../../model/ui/dialogs'; // wirepane
import { generateSendSnippet } from '../../model/send/body-modes/send-snippets'; // wirepane: every body mode
import {
    getCodeSnippetFormatKey,
    getCodeSnippetFormatName,
    getCodeSnippetOptionFromKey,
    snippetExportOptions,
    SnippetOption
} from '../../model/ui/snippet-formats';

import { ContainerSizedEditor } from '../editor/base-editor';
import { useHotkeys, copyToClipboard } from '../../util/ui';

import { SendCardContainer } from './send-card-section';
import { SendRequestLine } from './send-request-line';
import { switchRequestType } from '../../model/send/websocket/request-type';
// wirepane: Params · Headers · Body · Docs tabs instead of the headers & body cards. Each
// tab fills the pane, and the tab a request opens on follows its method & body, as the
// cards' auto-collapse did (request-editor-tabs.ts).
import { RequestEditor } from './request-editor/request-editor';

const RequestPaneKeyboardShortcuts = (props: {
    sendRequest: () => void
}) => {
    useHotkeys('Ctrl+Enter, Cmd+Enter', (event) => {
        props.sendRequest()
    }, [props.sendRequest]);

    return null;
};

@inject('rulesStore')
@inject('uiStore')
@inject('accountStore')
@observer
export class RequestPane extends React.Component<{
    rulesStore?: RulesStore,
    uiStore?: UiStore,
    accountStore?: AccountStore,

    editorNode: portals.HtmlPortalNode<typeof ContainerSizedEditor>,

    requestInput: RequestInput,
    sendRequest: () => void,
    isSending: boolean,
    updateFromHar: (harRequest: HarFormat.Request) => void,
    // Shown right under the URL, e.g. why the last Send didn't go out
    belowRequestLine?: React.ReactNode,
    // wirepane: the Send tab, for its collection docs
    sendTab?: SendRequest
}> {

    render() {
        const {
            requestInput,
            sendRequest,
            isSending,
            editorNode
        } = this.props;

        return <SendCardContainer
            hasExpandedChild={false} // wirepane: the tabs fill the pane, nothing expands
        >
            <RequestPaneKeyboardShortcuts
                sendRequest={sendRequest}
            />

            <SendRequestLine
                method={requestInput.method}
                updateMethod={this.updateMethod}
                url={requestInput.url}
                updateUrl={this.updateUrl}
                isSending={isSending}
                sendRequest={sendRequest}
                updateFromHar={this.props.updateFromHar}
                showCopyAsSnippetMenu={this.showCopyAsSnippetMenu}
                onSelectWebSocket={() => switchRequestType(requestInput, 'websocket')} // wirepane
            />
            { this.props.belowRequestLine }
            <RequestEditor
                requestInput={requestInput}
                sendRequest={this.props.sendTab}
                editorNode={editorNode}
                onHeadersChange={this.updateHeaders}
                onBodyUpdated={this.updateBody}
            />
        </SendCardContainer>;
    }

    @action.bound
    updateMethod(method: string) {
        this.props.requestInput.method = method;
    }

    @action.bound
    updateUrl(url: string) {
        this.props.requestInput.url = url;
    }

    @action.bound
    updateHeaders(headers: RawHeaders) {
        const { requestInput } = this.props;
        requestInput.headers = headers;
    }

    @action.bound
    updateBody(input: Buffer) {
        const { requestInput } = this.props;
        requestInput.rawBody.updateDecodedBody(input);
    }

    private copyRequestAsSnippet = async (snippetOption: SnippetOption) => {
        const { requestInput } = this.props;

        try {
            const snippet = await generateSendSnippet(requestInput, snippetOption);
            await copyToClipboard(snippet);
        } catch (e: any) {
            console.log(e);
            messageDialog({ // wirepane: our own dialog instead of alert()
                title: "Couldn't copy this request as a code snippet",
                message: `${e.message || e}`
            });
        }
    };

    private showCopyAsSnippetMenu = (event: React.MouseEvent) => {
        const uiStore = this.props.uiStore!;
        const isPaidUser = this.props.accountStore!.user.isPaidUser();

        const preferredFormat = uiStore.exportSnippetFormat
            ? getCodeSnippetOptionFromKey(uiStore.exportSnippetFormat)
            : undefined;

        const menuItems: Array<ContextMenuItem<void>> = [
            ...(!isPaidUser ? [
                { type: 'option', label: 'With Pro:', enabled: false, callback: () => {} }
            ] as const : []),
            // If you have a preferred default format, we show that option at the top level:
            ...(preferredFormat && isPaidUser ? [{
                type: 'option' as const,
                label: `Copy as ${getCodeSnippetFormatName(preferredFormat)} Snippet`,
                callback: () => this.copyRequestAsSnippet(preferredFormat)
            }] : []),
            {
                type: 'submenu',
                enabled: isPaidUser,
                label: `Copy as Code Snippet`,
                items: Object.keys(snippetExportOptions).map((snippetGroupName) => ({
                    type: 'submenu' as const,
                    label: snippetGroupName,
                    items: snippetExportOptions[snippetGroupName].map((snippetOption) => ({
                        type: 'option' as const,
                        label: getCodeSnippetFormatName(snippetOption),
                        callback: action(() => {
                            // When you pick an option here, it updates your preferred default option
                            uiStore.exportSnippetFormat = getCodeSnippetFormatKey(snippetOption);
                            this.copyRequestAsSnippet(snippetOption);
                        })
                    }))
                }))
            }
        ];

        uiStore.handleContextMenuEvent(event, menuItems);
    };

}