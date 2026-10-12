import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { CaretRight, Info, Warning } from '@phosphor-icons/react';

import { styled, css } from '../../styles';
import { formatShortcut } from '../../util/shortcuts';

import { UiStore } from '../../model/ui/ui-store';
import { SendRequest } from '../../model/send/send-request-model';
import { CollectionsStore } from '../../model/collections/collections-store';
import { BrunoCollection, BrunoExample } from '../../model/collections/collection-types';
import { ItemLocation } from '../../model/collections/collection-tree';
import {
    authModeName,
    authTemplates,
    effectiveAuth,
    inheritedHeaders,
    isAuthSupported
} from '../../model/collections/variables';
import { getStatusColor } from '../../model/events/categorization';

import { CollapsibleCardHeading } from '../common/card';
import { UnstyledButton } from '../common/inputs';
import { SendCardSection } from '../send/send-card-section';
import { MarkdownTextArea, MarkdownView, SegmentedControl } from './markdown-docs';

const Column = styled.div`
    height: 100%;
    display: flex;
    flex-direction: column;
`;

const PaneSlot = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    position: relative;
`;

const DocsCardSection = styled(SendCardSection)`
    /* Docs sit under the request, so they take what they need, up to a share of the pane */
    flex: 0 0 auto;
    max-height: 45%;
    min-height: 50px;
    overflow: hidden;

    > header {
        flex-shrink: 0;
    }
`;

const HeaderActions = styled.div`
    margin-left: auto; /* The card header lays out in reverse: this pushes the actions right */
    display: flex;
    align-items: center;
    gap: 8px;
`;

const Breadcrumb = styled(UnstyledButton)`
    min-width: 0;
    padding: 2px 4px;
    margin-left: -4px;
    border-radius: 4px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};

    &:hover:not([disabled]) {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

const CardBody = styled.div`
    min-height: 0;
    overflow-y: auto;
    margin: 0 -20px -20px;
    padding: 0 20px 16px;

    display: flex;
    flex-direction: column;
    gap: 12px;
`;

const NoteList = styled.ul`
    display: flex;
    flex-direction: column;
    gap: 4px;
`;

const Note = styled.li<{ tone: 'info' | 'warning' }>`
    display: flex;
    align-items: flex-start;
    gap: 6px;

    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};

    > svg {
        flex-shrink: 0;
        margin-top: 1px;
        color: ${p => p.tone === 'warning' ? p.theme.warningColor : p.theme.mainLowlightColor};
    }

    code {
        font-family: ${p => p.theme.monoFontFamily};
        color: ${p => p.theme.mainColor};
    }
`;

const Placeholder = styled.p`
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.5;
    color: ${p => p.theme.mainLowlightColor};
`;

const DocsTextArea = styled(MarkdownTextArea)`
    min-height: 140px;
    height: 180px;
    flex-shrink: 0;
`;

const ExamplesHeading = styled.h3`
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const ExampleList = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
`;

const ExampleToggle = styled.button.attrs(() => ({ type: 'button' }))<{ isOpen: boolean }>`
    display: flex;
    align-items: center;
    gap: 6px;
    width: 100%;
    height: 28px;
    padding: 0 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;

    font-family: inherit;
    font-size: ${p => p.theme.textInputFontSize};
    text-align: left;
    color: ${p => p.theme.mainColor};
    background-color: ${p => p.theme.mainBackground};
    cursor: pointer;

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    > svg {
        flex-shrink: 0;
        transition: transform 0.12s;
        ${p => p.isOpen && css`transform: rotate(90deg);`}
    }

    > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
`;

const StatusText = styled.span<{ status: number | undefined }>`
    flex-shrink: 0;
    font-family: ${p => p.theme.monoFontFamily};
    font-weight: 500;
    color: ${p => p.status ? getStatusColor(p.status, p.theme) : p.theme.mainLowlightColor};
`;

const ExampleBody = styled.pre`
    max-height: 220px;
    overflow: auto;
    margin: 0;
    padding: 8px 10px;
    border-radius: 6px;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;

    background-color: ${p => p.theme.mainLowlightBackground};
    border: 1px solid ${p => p.theme.containerBorder};
`;

const MAX_EXAMPLE_PREVIEW = 20_000;

function examplePreview(example: BrunoExample): string {
    const body = example.response?.body;
    if (body?.type === 'binary') return '(binary data)';

    const content = body?.content;
    let text = typeof content === 'string' ? content : content === undefined || content === null ? '' : JSON.stringify(content);
    if (body?.type === 'json') {
        try {
            text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {}
    }

    if (!text) return '(empty body)';
    return text.length > MAX_EXAMPLE_PREVIEW ? `${text.slice(0, MAX_EXAMPLE_PREVIEW)}\n…` : text;
}

const ExampleEntry = (props: { example: BrunoExample }) => {
    const [isOpen, setOpen] = React.useState(false);
    const { example } = props;
    const status = example.response?.status ?? undefined;
    // Names are often "200 OK" already: the status is only added when it's not in the name
    const showStatus = status !== undefined && !example.name.startsWith(String(status));

    return <>
        <ExampleToggle isOpen={isOpen} aria-expanded={isOpen} onClick={() => setOpen(!isOpen)}>
            <CaretRight size={12} weight='bold' />
            { showStatus && <StatusText status={status}>{ status }</StatusText> }
            <span>{ example.name }</span>
        </ExampleToggle>
        { isOpen && <ExampleBody>{ examplePreview(example) }</ExampleBody> }
    </>;
};

// What gets sent with the request that the tab doesn't show: inherited auth & headers
const SentWithNotes = (props: { collection: BrunoCollection, location: ItemLocation }) => {
    const { collection, location } = props;
    const auth = effectiveAuth(collection, location);
    const headers = inheritedHeaders(collection, location);
    const request = location.item.request;
    const hasScripts = !!(request?.script?.req?.trim() || request?.script?.res?.trim() || request?.tests?.trim());

    const notes: React.ReactNode[] = [];

    if (auth && isAuthSupported(auth.auth)) {
        const templates = authTemplates(auth.auth).filter((template) => template.includes('{{'));
        const headerName = auth.auth.mode === 'apikey' ? auth.auth.apikey?.key : 'Authorization';
        const isQuery = auth.auth.mode === 'apikey' && auth.auth.apikey?.placement === 'queryparams';
        notes.push(<Note key='auth' tone='info'>
            <Info size={14} />
            <span>
                Sent with { authModeName(auth.auth.mode) } auth from { auth.source }
                { templates.length > 0 && <> (<code>{ templates.join(', ') }</code>)</> }
                { isQuery
                    ? ', added to the URL.'
                    : <>, unless you add a <code>{ headerName || 'matching' }</code> header yourself.</>
                }
            </span>
        </Note>);
    } else if (auth) {
        notes.push(<Note key='auth' tone='warning'>
            <Warning size={14} />
            <span>
                Uses { authModeName(auth.auth.mode) } auth from { auth.source }, which Send can't apply yet.
                Add the Authorization header yourself.
            </span>
        </Note>);
    }

    if (headers.length) {
        notes.push(<Note key='headers' tone='info'>
            <Info size={14} />
            <span>
                Also sent: { headers.map((header, index) => <React.Fragment key={header.name}>
                    { index > 0 && ', ' }<code>{ header.name }</code>
                </React.Fragment>) } (from { headers[0].source })
            </span>
        </Note>);
    }

    if (hasScripts) {
        notes.push(<Note key='scripts' tone='warning'>
            <Warning size={14} />
            <span>This request has scripts or tests, which Wirepane doesn't run yet.</span>
        </Note>);
    }

    return notes.length ? <NoteList>{ notes }</NoteList> : null;
};

type DocsMode = 'view' | 'edit';

const DocsModeControl = (props: { mode: DocsMode, onChange: (mode: DocsMode) => void }) =>
    <SegmentedControl
        aria-label='Docs mode'
        value={props.mode}
        onChange={props.onChange}
        options={[
            { value: 'view', label: 'Preview' },
            { value: 'edit', label: 'Edit' }
        ]}
    />;

// Where the request is in its collection. Clicking it shows the request in the tree.
const DocsBreadcrumb = observer((props: { collectionsStore: CollectionsStore, sendRequest: SendRequest }) => {
    const { collectionsStore, sendRequest } = props;
    const link = collectionsStore.linkFor(sendRequest.id);
    const linked = collectionsStore.linkedItem(sendRequest.id);

    const breadcrumb = linked
        ? [linked.collection.name, ...linked.location.parents.map((folder) => folder.name)].join(' › ')
        : link?.itemUid ? link.itemName : undefined;
    if (!breadcrumb) return null;

    return <Breadcrumb
        title={linked ? `${breadcrumb}: show it in Collections` : breadcrumb}
        disabled={!linked}
        onClick={() => collectionsStore.revealTab(sendRequest.id)}
    >
        { breadcrumb }
    </Breadcrumb>;
});

// The docs: what the collection sends along, the Markdown (shown or edited) and saved examples
const DocsContent = observer((props: {
    collectionsStore: CollectionsStore,
    sendRequest: SendRequest,
    mode: DocsMode
}) => {
    const { collectionsStore, sendRequest, mode } = props;
    const link = collectionsStore.linkFor(sendRequest.id);
    const linked = collectionsStore.linkedItem(sendRequest.id);
    const docs = link?.docs ?? '';
    const examples = linked?.location.item.examples ?? [];

    return <>
        { linked && <SentWithNotes collection={linked.collection} location={linked.location} /> }

        { mode === 'edit'
            ? <DocsTextArea
                autoFocus
                aria-label='Request docs (Markdown)'
                value={docs}
                placeholder={'What this request does, its parameters, and what the response means. Markdown works: **bold**, `code`, lists, links.'}
                onChange={(event) => collectionsStore.setTabDocs(sendRequest.id, event.target.value)}
            />
            : docs.trim()
                ? <MarkdownView docs={docs} />
                : <Placeholder>
                    { link?.itemUid
                        ? 'No docs for this request yet. Choose Edit to describe it for the people you share it with.'
                        : `Notes about this request, in Markdown. They're kept when you save it to a collection with ${formatShortcut('Cmd+S')}.`
                    }
                </Placeholder>
        }

        { examples.length > 0 && <>
            <ExamplesHeading>Saved examples</ExamplesHeading>
            <ExampleList>
                { examples.map((example, index) =>
                    <ExampleEntry key={example.uid ?? index} example={example} />
                ) }
            </ExampleList>
        </> }
    </>;
});

const RequestDocsCard = observer((props: {
    collectionsStore: CollectionsStore,
    sendRequest: SendRequest
}) => {
    const { collectionsStore, sendRequest } = props;
    const isCollapsed = collectionsStore.docsCardCollapsed;
    const [mode, setMode] = React.useState<DocsMode>('view');

    return <DocsCardSection
        collapsed={isCollapsed}
        headerAlignment='left'
        ariaLabel='Request docs'
        onCollapseToggled={collectionsStore.toggleDocsCard}
    >
        <header>
            { !isCollapsed && <HeaderActions>
                <DocsModeControl mode={mode} onChange={setMode} />
            </HeaderActions> }
            <DocsBreadcrumb collectionsStore={collectionsStore} sendRequest={sendRequest} />
            <CollapsibleCardHeading onCollapseToggled={collectionsStore.toggleDocsCard}>
                Docs
            </CollapsibleCardHeading>
        </header>

        <CardBody>
            <DocsContent collectionsStore={collectionsStore} sendRequest={sendRequest} mode={mode} />
        </CardBody>
    </DocsCardSection>;
});

// The Docs tab of HTTP requests (components/send/request-editor). WebSocket requests keep
// the card under their pane.

const DocsPanelColumn = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
    flex-direction: column;
`;

const DocsPanelToolbar = styled.div`
    flex-shrink: 0;
    min-height: 40px;
    padding: 6px 12px 6px 20px;

    display: flex;
    align-items: center;
    gap: 8px;

    border-bottom: 1px solid ${p => p.theme.containerBorder};

    > [role=radiogroup] {
        margin-left: auto;
    }
`;

const DocsPanelBody = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 16px 20px 20px;

    display: flex;
    flex-direction: column;
    gap: 12px;

    /* The editor takes the space the tab has */
    > ${DocsTextArea} {
        flex: 1 0 240px;
        height: auto;
    }
`;

export const hasDocsText = (collectionsStore: CollectionsStore, sendRequestId: string) =>
    !!collectionsStore.linkFor(sendRequestId)?.docs.trim();

export const RequestDocsPanel = observer((props: {
    collectionsStore: CollectionsStore,
    sendRequest: SendRequest
}) => {
    const { collectionsStore, sendRequest } = props;
    const [mode, setMode] = React.useState<DocsMode>('view');

    return <DocsPanelColumn>
        <DocsPanelToolbar>
            <DocsBreadcrumb collectionsStore={collectionsStore} sendRequest={sendRequest} />
            <DocsModeControl mode={mode} onChange={setMode} />
        </DocsPanelToolbar>
        <DocsPanelBody>
            <DocsContent collectionsStore={collectionsStore} sendRequest={sendRequest} mode={mode} />
        </DocsPanelBody>
    </DocsPanelColumn>;
});

/**
 * The request side of Send with collections added: the request pane on top, and for
 * WebSocket requests, the request's docs (plus what the collection sends along with it)
 * below. HTTP requests show their docs in the request pane's Docs tab.
 */
export const CollectionRequestColumn = inject('collectionsStore', 'uiStore')(observer((props: {
    collectionsStore?: CollectionsStore,
    uiStore?: UiStore,
    sendRequest: SendRequest,
    children: React.ReactNode
}) => {
    // An expanded request card fills the whole pane, so the docs step aside
    const isCardExpanded = !!props.uiStore!.expandedSendRequestCard;
    const showsDocsCard = props.sendRequest.request.extras.requestType === 'websocket';

    return <Column>
        <PaneSlot>{ props.children }</PaneSlot>
        { showsDocsCard && !isCardExpanded && <RequestDocsCard
            key={props.sendRequest.id}
            collectionsStore={props.collectionsStore!}
            sendRequest={props.sendRequest}
        /> }
    </Column>;
}));
