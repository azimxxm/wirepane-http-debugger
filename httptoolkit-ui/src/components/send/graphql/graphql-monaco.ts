import * as _ from 'lodash';
import type { GraphQLSchema } from 'graphql';
import type * as GraphqlLanguageService from 'graphql-language-service';

import { logError } from '../../../errors';
import { MonacoTypes, monacoLoadingPromise, reloadMonacoEditor } from '../../editor/monaco';
import {
    monacoEnumsOf,
    toMonacoCompletionItems,
    toMonacoHover,
    toMonacoMarkers
} from '../../../model/send/graphql/monaco-mapping';

/**
 * GraphQL in Monaco: highlighting, autocomplete, hover docs and errors, from
 * graphql-language-service. It loads with the first GraphQL editor, after Monaco itself.
 */

export const GRAPHQL_LANGUAGE_ID = 'graphql';

export interface GraphqlEditorTools {
    monaco: typeof MonacoTypes;
    languageService: typeof GraphqlLanguageService;
}

// Typing these opens the suggestions, as letters do
const COMPLETION_TRIGGER_CHARACTERS = [':', '$', '@', '(', '{', ' '];
const VALIDATION_DELAY_MS = 300;

// Each GraphQL editor's model gets the schema of its tab's endpoint from here, by model URI
const schemaGetters = new Map<string, () => GraphQLSchema | undefined>();
const schemaForModel = (model: MonacoTypes.editor.ITextModel) =>
    schemaGetters.get(model.uri.toString())?.();

let toolsLoading: Promise<GraphqlEditorTools> | undefined;

export function loadGraphqlEditorTools(): Promise<GraphqlEditorTools> {
    if (!toolsLoading) {
        toolsLoading = loadTools();
        // A failed load is tried again by the next editor
        toolsLoading.catch(() => { toolsLoading = undefined; });
    }
    return toolsLoading;
}

async function loadTools(): Promise<GraphqlEditorTools> {
    await monacoLoadingPromise.catch(() => reloadMonacoEditor());

    const [monaco, languageService] = await Promise.all([
        import('monaco-editor/esm/vs/editor/editor.api'),
        import('graphql-language-service'),
        // These two only register themselves:
        import('monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution'),
        import('monaco-editor/esm/vs/editor/contrib/suggest/suggestController')
    ]);

    registerProviders(monaco, languageService);
    return { monaco, languageService };
}

const wordRange = (position: MonacoTypes.IPosition, word: { startColumn: number, endColumn: number }) => ({
    startLineNumber: position.lineNumber,
    endLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endColumn: word.endColumn
});

function registerProviders(monaco: typeof MonacoTypes, languageService: typeof GraphqlLanguageService) {
    const enums = monacoEnumsOf(monaco);
    // Monaco counts lines & columns from 1, the language service from 0
    const servicePosition = (position: MonacoTypes.IPosition) =>
        new languageService.Position(position.lineNumber - 1, position.column - 1);

    monaco.languages.registerCompletionItemProvider(GRAPHQL_LANGUAGE_ID, {
        triggerCharacters: COMPLETION_TRIGGER_CHARACTERS,
        provideCompletionItems(model, position) {
            const schema = schemaForModel(model);
            if (!schema) return { suggestions: [] };

            try {
                const items = languageService.getAutocompleteSuggestions(
                    schema,
                    model.getValue(),
                    servicePosition(position)
                );
                const range = wordRange(position, model.getWordUntilPosition(position));
                return { suggestions: toMonacoCompletionItems(items, range, enums) };
            } catch (error) {
                logError(error);
                return { suggestions: [] };
            }
        }
    });

    monaco.languages.registerHoverProvider(GRAPHQL_LANGUAGE_ID, {
        provideHover(model, position) {
            const schema = schemaForModel(model);
            const word = model.getWordAtPosition(position);
            if (!schema || !word) return null;

            try {
                const contents = languageService.getHoverInformation(
                    schema,
                    model.getValue(),
                    servicePosition(position),
                    undefined,
                    { useMarkdown: true }
                );
                return toMonacoHover(contents, wordRange(position, word));
            } catch (error) {
                logError(error);
                return null;
            }
        }
    });
}

let modelCount = 0;

// The query editor brings its own model, so the providers above can tell which schema it uses
export function createGraphqlModel(tools: GraphqlEditorTools, value: string) {
    const { monaco } = tools;
    modelCount += 1;
    return monaco.editor.createModel(
        value,
        GRAPHQL_LANGUAGE_ID,
        monaco.Uri.parse(`inmemory://wirepane/graphql-query-${modelCount}.graphql`)
    );
}

export interface GraphqlModelAttachment {
    // Checks the query again now, e.g. after the schema changed
    validate(): void;
    dispose(): void;
}

/**
 * Connects a query editor's model to its tab's schema: autocomplete and hovers read it, and
 * errors are shown as you type. Without a schema, only syntax errors are shown.
 */
export function attachGraphqlModel(
    tools: GraphqlEditorTools,
    model: MonacoTypes.editor.ITextModel,
    getSchema: () => GraphQLSchema | undefined
): GraphqlModelAttachment {
    const { monaco, languageService } = tools;
    const enums = monacoEnumsOf(monaco);
    const modelKey = model.uri.toString();
    schemaGetters.set(modelKey, getSchema);

    const validate = () => {
        if (model.isDisposed()) return;

        const query = model.getValue();
        let markers: MonacoTypes.editor.IMarkerData[] = [];
        // An empty editor isn't an error, it's just not written yet
        if (query.trim()) {
            try {
                markers = toMonacoMarkers(languageService.getDiagnostics(query, getSchema()), enums);
            } catch (error) {
                logError(error);
            }
        }
        monaco.editor.setModelMarkers(model, GRAPHQL_LANGUAGE_ID, markers);
    };

    const validateSoon = _.debounce(validate, VALIDATION_DELAY_MS);
    const contentListener = model.onDidChangeContent(validateSoon);
    validate();

    return {
        validate,
        dispose() {
            validateSoon.cancel();
            contentListener.dispose();
            schemaGetters.delete(modelKey);
        }
    };
}
