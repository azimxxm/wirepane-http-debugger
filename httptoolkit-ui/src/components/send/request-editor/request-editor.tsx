import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite'; // mobx-react 5's observer doesn't support hooks
import * as portals from 'react-reverse-portal';

import { styled } from '../../../styles';
import { RawHeaders } from '../../../types';
import { isEditable, isMac, useHotkeys } from '../../../util/ui';
import { toHotkeys } from '../../../util/shortcuts';

import { RequestInput, SendRequest } from '../../../model/send/send-request-model';
import { RequestEditorTab } from '../../../model/send/send-extras';
import { CollectionsStore } from '../../../model/collections/collections-store';
import {
    hasRequestBody,
    hasAuth,
    hasScripts,
    hasCustomSettings,
    headersCount,
    paramsCount,
    pickEditorTab,
    REQUEST_EDITOR_TABS,
    shownEditorTab
} from '../../../model/send/request-editor-tabs';

import { ContainerSizedEditor } from '../../editor/base-editor';
import { hasDocsText, RequestDocsPanel } from '../../collections/request-docs-card';
import { SendBodyPanel } from '../body/send-body-panel';
import {
    EDITOR_TAB_SHORTCUTS,
    EditorTabInfo,
    editorPanelId,
    editorTabId,
    RequestEditorTabBar
} from './request-editor-tab-bar';
import { ParamsPanel } from './params-panel';
import { HeadersPanel } from './headers-panel';
import { AuthPanel } from './auth-panel';
import { SettingsPanel } from './settings-panel';
import { ScriptsPanel } from './scripts-panel';

const EditorColumn = styled.div`
    flex: 1 1 auto;
    min-height: 0;

    display: flex;
    flex-direction: column;

    background-color: ${p => p.theme.mainBackground};
`;

const TabPanel = styled.div`
    flex: 1 1 auto;
    min-height: 0;

    display: flex;
    flex-direction: column;
`;

const TAB_HOTKEYS = REQUEST_EDITOR_TABS
    .map((tab) => toHotkeys(EDITOR_TAB_SHORTCUTS[tab]))
    .join(', ');

// ⌘⌥1–4 open the tabs that are there, from anywhere on the page
function useEditorTabHotkeys(
    tabIds: readonly RequestEditorTab[],
    selectTab: (tab: RequestEditorTab, options: { focus: boolean }) => void
) {
    useHotkeys(TAB_HOTKEYS, (event) => {
        // Outside macOS, Ctrl+Alt is also AltGr, which types characters like ² into fields
        if (!isMac && isEditable(event.target)) return;

        const digit = /^Digit(\d)$/.exec(event.code)?.[1];
        const tab = digit ? REQUEST_EDITOR_TABS[Number(digit) - 1] : undefined;
        if (!tab || !tabIds.includes(tab)) return;

        event.preventDefault();
        selectTab(tab, { focus: true });
    }, [tabIds.join(), selectTab]);
}

// Calls onFocusIn when anything inside the element gets focus. A native listener, as the
// body editor is a portal: its React events don't pass through the tab panel.
function useFocusIn(ref: React.RefObject<HTMLElement>, onFocusIn: () => void) {
    const latest = React.useRef(onFocusIn);
    latest.current = onFocusIn;

    React.useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const listener = () => latest.current();
        element.addEventListener('focusin', listener);
        return () => element.removeEventListener('focusin', listener);
    }, [ref]);
}

/**
 * The request pane under the URL: Params, Headers, Body and (for collection requests) Docs
 * tabs, each filling the pane. The tab is kept per Send tab (SendExtras.editorTab).
 */
export const RequestEditor = inject('collectionsStore')(observer((props: {
    collectionsStore?: CollectionsStore,
    requestInput: RequestInput,
    // The Send tab, for its collection docs
    sendRequest?: SendRequest,
    editorNode: portals.HtmlPortalNode<typeof ContainerSizedEditor>,
    onHeadersChange: (headers: RawHeaders) => void,
    onBodyUpdated: (body: Buffer) => void
}) => {
    const { requestInput, sendRequest, editorNode } = props;
    const collectionsStore = props.collectionsStore!;
    const idBase = React.useId();

    // Every HTTP tab has docs, as the docs card did: notes can be written before the first save
    const docsShown = !!sendRequest;
    const tabs: EditorTabInfo[] = [
        { id: 'params', label: 'Params', count: paramsCount(requestInput) },
        { id: 'authorization', label: 'Authorization', marker: hasAuth(requestInput) ? 'has auth' : undefined },
        { id: 'headers', label: 'Headers', count: headersCount(requestInput.headers) },
        { id: 'body', label: 'Body', marker: hasRequestBody(requestInput) ? 'has a body' : undefined },
        { id: 'scripts', label: 'Scripts', marker: hasScripts(requestInput) ? 'has scripts' : undefined },
        { id: 'settings', label: 'Settings', marker: hasCustomSettings(requestInput) ? 'has custom settings' : undefined },
        ...(docsShown ? [{
            id: 'docs' as const,
            label: 'Docs',
            marker: hasDocsText(collectionsStore, sendRequest!.id) ? 'has docs' : undefined
        }] : [])
    ];
    const tabIds = tabs.map((tab) => tab.id);
    const shown = shownEditorTab(requestInput, tabIds);

    const selectTab = React.useCallback((tab: RequestEditorTab, options: { focus: boolean }) => {
        pickEditorTab(requestInput, tab);
        if (options.focus) {
            requestAnimationFrame(() => document.getElementById(editorTabId(idBase, tab))?.focus());
        }
    }, [requestInput, idBase]);
    useEditorTabHotkeys(tabIds, selectTab);

    // Working in a tab keeps it open, even when the request changes in ways that would pick
    // another tab (e.g. a method with a body)
    const panelRef = React.useRef<HTMLDivElement>(null);
    useFocusIn(panelRef, () => {
        if (!requestInput.extras.editorTab) pickEditorTab(requestInput, shown);
    });

    return <EditorColumn>
        <RequestEditorTabBar
            idBase={idBase}
            tabs={tabs}
            selected={shown}
            onSelect={selectTab}
        />

        <TabPanel
            ref={panelRef}
            role='tabpanel'
            id={editorPanelId(idBase)}
            aria-labelledby={editorTabId(idBase, shown)}
        >
            { shown === 'params' && <ParamsPanel requestInput={requestInput} /> }

            { shown === 'authorization' && <AuthPanel requestInput={requestInput} /> }

            { shown === 'headers' && <HeadersPanel
                requestInput={requestInput}
                headers={requestInput.headers}
                onChange={props.onHeadersChange}
            /> }

            { shown === 'body' && <SendBodyPanel
                requestInput={requestInput}
                headers={requestInput.headers}
                contentType={requestInput.requestContentType}
                body={requestInput.rawBody}
                onBodyUpdated={props.onBodyUpdated}
                editorNode={editorNode}
            /> }

            { shown === 'scripts' && <ScriptsPanel requestInput={requestInput} /> }

            { shown === 'settings' && <SettingsPanel requestInput={requestInput} /> }

            { shown === 'docs' && sendRequest && <RequestDocsPanel
                key={sendRequest.id}
                collectionsStore={collectionsStore}
                sendRequest={sendRequest}
            /> }
        </TabPanel>
    </EditorColumn>;
}));
