import * as React from 'react';
import * as polished from 'polished';
import * as dateFns from 'date-fns';
import { action, comparer, computed, observable, reaction } from 'mobx';
import { disposeOnUnmount, inject, observer } from 'mobx-react';
import { ArrowClockwise, BookOpenText, WarningCircle } from '@phosphor-icons/react';
import type { DocumentNode } from 'graphql';

import { css, styled } from '../../../styles';
import { Icon } from '../../../icons';
import { logError } from '../../../errors';
import { isMac } from '../../../util/ui';

import { RequestInput, SendRequest } from '../../../model/send/send-request-model';
import { SendStore } from '../../../model/send/send-store';
import { graphqlSchemas, GraphqlSchemaState } from '../../../model/send/graphql/schema-cache';
import {
    GraphqlOperation,
    listOperations,
    operationNameFor,
    parseGraphqlDocument,
    variablesJsonSchema
} from '../../../model/send/graphql/graphql-document';

import { UnstyledButton } from '../../common/inputs';
import { ContainerSizedEditor, EditorProps } from '../../editor/base-editor';
import { GraphqlEditorTools, loadGraphqlEditorTools } from './graphql-monaco';
import { GraphqlQueryEditor } from './graphql-query-editor';
import { GraphqlDocsPanel } from './graphql-docs-panel';

const GraphqlEditorContainer = styled.div`
    flex: 1 1 auto;
    height: 100%;
    min-height: 0;

    display: flex;
    flex-direction: column;

    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};
`;

const Toolbar = styled.div`
    flex-shrink: 0;
    min-height: 40px;
    padding: 6px 8px 6px 12px;

    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;

    border-bottom: 1px solid ${p => p.theme.containerBorder};
    font-size: ${p => p.theme.textInputFontSize};
`;

const ToolbarSpacer = styled.div`
    flex: 1 1 auto;
`;

const SectionLabel = styled.span`
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

// Only shown when the query has several operations
const OperationRow = styled.label`
    flex-shrink: 0;
    min-height: 40px;
    padding: 6px 12px;

    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 8px;

    border-bottom: 1px solid ${p => p.theme.containerBorder};
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};

    select {
        height: 28px;
        min-width: 0;
        max-width: 220px;
        padding: 0 6px;
        border-radius: 6px;
        border: 1px solid ${p => p.theme.containerBorder};

        background-color: ${p => p.theme.inputBackground};
        color: ${p => p.theme.inputColor};
        font-family: ${p => p.theme.fontFamily};
        font-size: ${p => p.theme.textInputFontSize};
        cursor: pointer;

        &:hover {
            border-color: ${p => p.theme.inputBorder};
        }
    }
`;

const NeedsOperationHint = styled.span`
    color: ${p => p.theme.warning};
`;

const SchemaStatus = styled.span`
    min-width: 0;
    display: inline-flex;
    align-items: center;
    gap: 6px;

    color: ${p => p.theme.mainLowlightColor};
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
`;

const ToolbarButton = styled(UnstyledButton)<{ pressed?: boolean }>`
    flex-shrink: 0;
    height: 28px;
    padding: 0 10px;
    border-radius: 6px;

    display: inline-flex;
    align-items: center;
    gap: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
    white-space: nowrap;
    color: ${p => p.theme.mainColor};
    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};

    &:hover:not([disabled]) {
        background-color: ${p => p.theme.rowHover};
        border-color: ${p => p.theme.inputBorder};
    }

    ${p => p.pressed && css`
        color: ${p.theme.popColor};
        border-color: ${p.theme.popColor};
        background-color: ${polished.rgba(p.theme.popColor, 0.1)};

        &:hover:not([disabled]) {
            border-color: ${p.theme.popColor};
        }
    `}
`;

const ErrorRow = styled.div`
    flex-shrink: 0;
    padding: 8px 12px;

    display: flex;
    align-items: flex-start;
    gap: 8px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.error};
    background-color: ${p => polished.rgba(p.theme.error, 0.08)};
    border-bottom: 1px solid ${p => polished.rgba(p.theme.error, 0.3)};
    overflow-wrap: break-word;

    > svg {
        flex-shrink: 0;
        margin-top: 2px;
    }
`;

const EditorArea = styled.div`
    position: relative;
    flex: 1 1 auto;
    min-height: 0;
    display: flex;
`;

const EditorsColumn = styled.div`
    flex: 1 1 auto;
    min-width: 0;
    display: flex;
    flex-direction: column;
`;

const QueryArea = styled.div`
    position: relative;
    flex: 3 1 0;
    min-height: 80px;
`;

// Shown over the empty query editor. Clicks go through to the editor.
const EmptyQueryHint = styled.div`
    position: absolute;
    top: 40%;
    left: 0;
    right: 0;
    padding: 0 24px;
    z-index: 1;
    pointer-events: none;

    text-align: center;
    line-height: 1.5;
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.containerWatermark};

    strong {
        display: block;
        font-size: ${p => p.theme.textSize};
        font-weight: 600;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const VariablesHeader = styled.div`
    flex-shrink: 0;
    height: 28px;
    padding: 0 12px;

    display: flex;
    align-items: center;
    gap: 6px;

    border-top: 1px solid ${p => p.theme.containerBorder};
    border-bottom: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainLowlightBackground};
`;

const HeaderHint = styled.span`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.containerWatermark};
`;

const VariablesArea = styled.div`
    position: relative;
    flex: 1 1 0;
    min-height: 60px;
`;

const EditorMessage = styled.div`
    padding: 12px;
    color: ${p => p.theme.mainLowlightColor};
    font-size: ${p => p.theme.textInputFontSize};
`;

const DocsEmptyState = styled.div`
    margin-top: 12px;
    color: ${p => p.theme.mainLowlightColor};

    p {
        margin-bottom: 10px;
    }
`;

// Suggestions in the variables come from their JSON schema, built from the query
const VARIABLES_EDITOR_OPTIONS: EditorProps['options'] = {
    quickSuggestions: true,
    suggestOnTriggerCharacters: true,
    suggest: { showWords: false }
};

// Below this width there's no room to put the docs beside the editors, so they float over
// them, and the toolbar buttons drop their labels
const NARROW_EDITOR_WIDTH = 480;

// Monaco's own shortcut for opening suggestions: the Control key on every platform
const SUGGEST_SHORTCUT = isMac ? '⌃Space' : 'Ctrl+Space';

// The docs panel stays open or closed across tabs, until the app restarts
const docsPanel = observable({ open: false });

const contentIds = new WeakMap<RequestInput, string>();
function contentIdFor(requestInput: RequestInput, sendRequest: SendRequest | undefined) {
    if (sendRequest) return sendRequest.id;
    if (!contentIds.has(requestInput)) contentIds.set(requestInput, crypto.randomUUID());
    return contentIds.get(requestInput)!;
}

const formatTime = (timestamp: number) => dateFns.format(timestamp, 'HH:mm');

function describeSchema(state: GraphqlSchemaState | undefined, compact: boolean): string {
    if (!state?.schema) return compact ? 'No schema' : 'No schema yet';
    const types = state.typeCount === 1 ? '1 type' : `${state.typeCount} types`;
    return compact ? types : `${types}, fetched ${formatTime(state.loadedAt!)}`;
}

/**
 * The GraphQL body editor: the query and its variables, the operation to send, and the
 * endpoint's schema (fetched with an introspection query) for autocomplete, errors and docs.
 * It edits requestInput.extras.graphql.
 */
@inject('sendStore')
@observer
export class GraphqlBodyEditor extends React.Component<{
    requestInput: RequestInput,
    // The tab, when the caller has it. Otherwise it's looked up in the Send store.
    sendRequest?: SendRequest,
    sendStore?: SendStore
}> {

    @observable.ref private tools: GraphqlEditorTools | undefined = undefined;
    @observable private toolsError: string | undefined = undefined;

    // The operations of the last query that parsed, so the picker doesn't blink while typing
    @observable.ref private operations: GraphqlOperation[] = [];

    // The editor's own width, which decides how the docs and the toolbar fit
    private container = React.createRef<HTMLDivElement>();
    @observable private width: number | undefined = undefined;
    private resizeObserver = new ResizeObserver(action((entries: ResizeObserverEntry[]) => {
        const lastEntry = entries[entries.length - 1];
        if (lastEntry) this.width = lastEntry.contentRect.width;
    }));

    componentDidMount() {
        if (this.container.current) this.resizeObserver.observe(this.container.current);

        loadGraphqlEditorTools().then(
            action((tools: GraphqlEditorTools) => { this.tools = tools; }),
            action((error: Error) => {
                logError(error);
                this.toolsError = error?.message ?? String(error);
            })
        );

        disposeOnUnmount(this, reaction(
            () => this.document,
            action((document: DocumentNode | undefined) => {
                if (!document) {
                    // A cleared query has no operations. One that doesn't parse keeps the last ones.
                    if (!this.graphql.query.trim()) this.operations = [];
                    return;
                }

                this.operations = listOperations(document);
                const operationName = operationNameFor(this.operations, this.graphql.operationName);
                if (operationName !== this.graphql.operationName) this.graphql.operationName = operationName;
            }),
            { fireImmediately: true }
        ));
    }

    componentWillUnmount() {
        this.resizeObserver.disconnect();
    }

    private get isNarrow() {
        return this.width !== undefined && this.width < NARROW_EDITOR_WIDTH;
    }

    private get graphql() {
        return this.props.requestInput.extras.graphql;
    }

    @computed
    private get sendRequest(): SendRequest | undefined {
        if (this.props.sendRequest) return this.props.sendRequest;
        return this.props.sendStore!.sendRequests.find((sendRequest) =>
            sendRequest.request === this.props.requestInput
        );
    }

    @computed
    private get document() {
        return parseGraphqlDocument(this.graphql.query);
    }

    private get schemaState() {
        return graphqlSchemas.get(this.props.requestInput.url);
    }

    @computed
    private get namedOperations() {
        return this.operations.filter((operation) => operation.name !== undefined);
    }

    // Structural, so the variables editor only gets a new schema when it really changes
    @computed({ equals: comparer.structural })
    private get variablesSchema(): object | undefined {
        const schema = this.schemaState?.schema;
        if (!this.tools || !schema || !this.document) return undefined;

        try {
            return variablesJsonSchema(this.tools.languageService, schema, this.document, this.graphql.operationName);
        } catch (error) {
            logError(error);
            return undefined;
        }
    }

    @action.bound
    private updateQuery(query: string) {
        this.graphql.query = query;
    }

    @action.bound
    private updateVariables(variables: string) {
        this.graphql.variables = variables;
    }

    @action.bound
    private updateOperationName(event: React.ChangeEvent<HTMLSelectElement>) {
        this.graphql.operationName = event.target.value || undefined;
    }

    @action.bound
    private toggleDocs() {
        docsPanel.open = !docsPanel.open;
    }

    @action.bound
    private closeDocs() {
        docsPanel.open = false;
    }

    private fetchSchema = () => {
        const sendRequest = this.sendRequest ?? {
            id: contentIdFor(this.props.requestInput, undefined),
            request: this.props.requestInput,
            sentExchange: undefined
        };
        graphqlSchemas.fetch(this.props.sendStore!, sendRequest);
    };

    private cancelFetch = () => {
        graphqlSchemas.cancel(this.props.requestInput.url);
    };

    private renderOperationPicker() {
        const operations = this.namedOperations;
        if (operations.length < 2) return null;

        const { operationName } = this.graphql;
        const isChosen = operations.some((operation) => operation.name === operationName);

        return <OperationRow>
            <SectionLabel>Operation</SectionLabel>
            <select
                value={isChosen ? operationName : ''}
                onChange={this.updateOperationName}
                title='The operation to send, when the query has several'
            >
                { !isChosen && <option value='' disabled>Choose an operation</option> }
                { operations.map((operation) =>
                    <option key={operation.name} value={operation.name}>
                        { operation.name } ({ operation.type })
                    </option>
                ) }
            </select>
            { !isChosen && <NeedsOperationHint>The query has several operations: choose the one to send.</NeedsOperationHint> }
        </OperationRow>;
    }

    private renderSchemaControls(state: GraphqlSchemaState | undefined) {
        const isLoading = state?.status === 'loading';
        const url = this.props.requestInput.url.trim();
        const compact = this.isNarrow;

        return <>
            <SchemaStatus
                aria-live='polite'
                title={state?.schema ? `The schema of ${url}, fetched at ${dateFns.format(state.loadedAt!, 'HH:mm:ss')}` : undefined}
            >
                { isLoading
                    ? <><Icon spin fixedWidth={true} icon={['fas', 'spinner']} /> { compact ? 'Fetching…' : 'Fetching schema…' }</>
                    : describeSchema(state, compact)
                }
            </SchemaStatus>
            { isLoading
                ? <ToolbarButton onClick={this.cancelFetch} title='Stop fetching the schema'>
                    Cancel
                </ToolbarButton>
                : <ToolbarButton
                    onClick={this.fetchSchema}
                    aria-label='Fetch schema'
                    title={`Send an introspection query${url ? ` to ${url}` : ''}, with this tab's headers, for autocomplete and docs`}
                >
                    <ArrowClockwise size={14} aria-hidden={true} />
                    { !compact && 'Fetch schema' }
                </ToolbarButton>
            }
        </>;
    }

    private renderDocsEmptyState(state: GraphqlSchemaState | undefined) {
        if (state?.status === 'loading') return <DocsEmptyState><p>Fetching the schema…</p></DocsEmptyState>;

        return <DocsEmptyState>
            <p>Fetch the endpoint's schema to browse its types and fields here.</p>
            <ToolbarButton onClick={this.fetchSchema}>
                <ArrowClockwise size={14} aria-hidden={true} />
                Fetch schema
            </ToolbarButton>
        </DocsEmptyState>;
    }

    render() {
        const { tools, toolsError } = this;
        const { graphql } = this;
        const state = this.schemaState;
        const contentId = contentIdFor(this.props.requestInput, this.sendRequest);

        return <GraphqlEditorContainer ref={this.container}>
            <Toolbar>
                <SectionLabel>Query</SectionLabel>
                <ToolbarSpacer />
                { this.renderSchemaControls(state) }
                <ToolbarButton
                    pressed={docsPanel.open}
                    aria-pressed={docsPanel.open}
                    aria-label='Schema docs'
                    onClick={this.toggleDocs}
                    title={docsPanel.open ? 'Hide the schema docs' : 'Show the schema docs'}
                >
                    <BookOpenText size={14} aria-hidden={true} />
                    { !this.isNarrow && 'Schema docs' }
                </ToolbarButton>
            </Toolbar>

            { this.renderOperationPicker() }

            { state?.status === 'failed' && <ErrorRow role='alert'>
                <WarningCircle size={16} weight='fill' aria-hidden={true} />
                <span>
                    Couldn't fetch the schema. { state.error }
                    { state.schema && ` Autocomplete still uses the schema fetched at ${formatTime(state.loadedAt!)}.` }
                </span>
            </ErrorRow> }

            <EditorArea>
                <EditorsColumn>
                    <QueryArea role='group' aria-label='GraphQL query'>
                        { tools && !graphql.query && <EmptyQueryHint aria-hidden={true}>
                            <strong>Write a GraphQL query here</strong>
                            { state?.schema
                                ? `Suggestions come as you type, or with ${SUGGEST_SHORTCUT}.`
                                : 'Fetch the schema to get suggestions, errors and docs as you type.'
                            }
                        </EmptyQueryHint> }
                        { tools
                            // One editor per tab, so undo never brings back another tab's text
                            ? <GraphqlQueryEditor
                                key={contentId}
                                tools={tools}
                                contentId={contentId}
                                value={graphql.query}
                                onChange={this.updateQuery}
                                schema={state?.schema}
                            />
                        : toolsError
                            ? <EditorMessage role='alert'>The GraphQL editor couldn't load: { toolsError }</EditorMessage>
                            : <EditorMessage>Loading the GraphQL editor…</EditorMessage>
                        }
                    </QueryArea>
                    <VariablesHeader>
                        <SectionLabel>Variables</SectionLabel> <HeaderHint>JSON</HeaderHint>
                    </VariablesHeader>
                    <VariablesArea role='group' aria-label='GraphQL variables'>
                        { tools && <ContainerSizedEditor
                            key={contentId}
                            contentId={`${contentId}-variables`}
                            language='json'
                            value={graphql.variables}
                            onChange={this.updateVariables}
                            schema={this.variablesSchema as EditorProps['schema']}
                            options={VARIABLES_EDITOR_OPTIONS}
                        /> }
                    </VariablesArea>
                </EditorsColumn>

                { docsPanel.open && <GraphqlDocsPanel
                    schema={state?.schema}
                    emptyState={this.renderDocsEmptyState(state)}
                    overlay={this.isNarrow}
                    onClose={this.closeDocs}
                /> }
            </EditorArea>
        </GraphqlEditorContainer>;
    }
}
