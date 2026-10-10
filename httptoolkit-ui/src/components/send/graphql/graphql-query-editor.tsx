import * as React from 'react';
import type { GraphQLSchema } from 'graphql';

import { MonacoTypes } from '../../editor/monaco';
import { ContainerSizedEditor } from '../../editor/base-editor';
import {
    attachGraphqlModel,
    createGraphqlModel,
    GRAPHQL_LANGUAGE_ID,
    GraphqlEditorTools,
    GraphqlModelAttachment
} from './graphql-monaco';

// Suggestions open as you type. They come from the schema only: words from the text are hidden.
const QUERY_EDITOR_OPTIONS: MonacoTypes.editor.IStandaloneEditorConstructionOptions = {
    quickSuggestions: { other: true, comments: false, strings: false },
    suggestOnTriggerCharacters: true,
    suggest: { showWords: false }
};

interface GraphqlQueryEditorProps {
    tools: GraphqlEditorTools;
    contentId: string;
    value: string;
    onChange: (value: string) => void;
    schema: GraphQLSchema | undefined;
}

/**
 * The query editor: Monaco with GraphQL highlighting, plus autocomplete, hover docs and
 * errors from the tab's schema, when it has been fetched.
 */
export class GraphqlQueryEditor extends React.Component<GraphqlQueryEditorProps> {

    private model: MonacoTypes.editor.ITextModel | undefined;
    private attachment: GraphqlModelAttachment | undefined;

    // react-monaco-editor calls this just before creating the editor. The editor gets our own
    // model, which the autocomplete and hover providers can find the schema for.
    private editorWillMount = (): MonacoTypes.editor.IStandaloneEditorConstructionOptions => {
        if (!this.model || this.model.isDisposed()) {
            this.attachment?.dispose();
            this.model = createGraphqlModel(this.props.tools, this.props.value);
            this.attachment = attachGraphqlModel(this.props.tools, this.model, () => this.props.schema);
        }
        return { model: this.model };
    };

    componentDidUpdate(prevProps: GraphqlQueryEditorProps) {
        if (prevProps.schema !== this.props.schema) this.attachment?.validate();
    }

    componentWillUnmount() {
        this.attachment?.dispose();
        this.model?.dispose();
    }

    render() {
        return <ContainerSizedEditor
            contentId={this.props.contentId}
            language={GRAPHQL_LANGUAGE_ID}
            value={this.props.value}
            onChange={this.props.onChange}
            editorWillMount={this.editorWillMount}
            options={QUERY_EDITOR_OPTIONS}
        />;
    }
}
