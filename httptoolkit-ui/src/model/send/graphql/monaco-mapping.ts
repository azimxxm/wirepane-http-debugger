import type * as MonacoTypes from 'monaco-editor';
import type * as GraphqlLanguageService from 'graphql-language-service';

/**
 * Turns graphql-language-service results (Language Server Protocol shapes) into Monaco's
 * suggestions, markers and hovers. It takes only the Monaco enums it needs, so it can be
 * unit tested without loading Monaco.
 */

type CompletionItem = GraphqlLanguageService.CompletionItem;
type Diagnostic = GraphqlLanguageService.Diagnostic;
type HoverContents = ReturnType<typeof GraphqlLanguageService.getHoverInformation>;

export interface MonacoEnums {
    CompletionItemKind: typeof MonacoTypes.languages.CompletionItemKind;
    CompletionItemInsertTextRule: typeof MonacoTypes.languages.CompletionItemInsertTextRule;
    CompletionItemTag: typeof MonacoTypes.languages.CompletionItemTag;
    MarkerSeverity: typeof MonacoTypes.MarkerSeverity;
}

export const monacoEnumsOf = (monaco: typeof MonacoTypes): MonacoEnums => ({
    CompletionItemKind: monaco.languages.CompletionItemKind,
    CompletionItemInsertTextRule: monaco.languages.CompletionItemInsertTextRule,
    CompletionItemTag: monaco.languages.CompletionItemTag,
    MarkerSeverity: monaco.MarkerSeverity
});

// LSP's CompletionItemKind values, in order from 1. Monaco has a kind with each of these names.
const LSP_COMPLETION_KINDS = [
    'Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface',
    'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File',
    'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter'
] as const;

// LSP's InsertTextFormat.Snippet
const LSP_SNIPPET_FORMAT = 2;

// LSP's DiagnosticSeverity values
const LSP_SEVERITY = { error: 1, warning: 2, information: 3 };

// Without a known kind, a suggestion is a Value: Text is for plain words, which the editor hides
export function toMonacoCompletionKind(kind: number | undefined, enums: MonacoEnums) {
    const name = kind ? LSP_COMPLETION_KINDS[kind - 1] : undefined;
    return enums.CompletionItemKind[name ?? 'Value'];
}

function documentationOf(item: CompletionItem): MonacoTypes.IMarkdownString | undefined {
    const deprecation = item.isDeprecated
        ? `**Deprecated**${item.deprecationReason ? `: ${item.deprecationReason}` : ''}`
        : undefined;
    const parts = [item.documentation, deprecation].filter((part): part is string => !!part);
    return parts.length ? { value: parts.join('\n\n') } : undefined;
}

export function toMonacoCompletionItem(
    item: CompletionItem,
    range: MonacoTypes.IRange,
    enums: MonacoEnums
): MonacoTypes.languages.CompletionItem {
    // The GraphQL type, like [Country!]!, shown on the right of the suggestion
    const typeText = item.detail ?? item.labelDetails?.detail?.trim();
    const insertText = item.insertText ?? item.label;

    return {
        label: typeText ? { label: item.label, description: typeText } : item.label,
        kind: toMonacoCompletionKind(item.kind, enums),
        detail: typeText,
        documentation: documentationOf(item),
        insertText,
        insertTextRules: item.insertTextFormat === LSP_SNIPPET_FORMAT
            ? enums.CompletionItemInsertTextRule.InsertAsSnippet
            : undefined,
        // Variables are listed as $name, but after a typed $ only the name is inserted
        filterText: item.filterText ?? (
            item.label.startsWith('$') && !insertText.startsWith('$') ? insertText : undefined
        ),
        sortText: item.sortText,
        tags: item.isDeprecated ? [enums.CompletionItemTag.Deprecated] : undefined,
        // Suggests again after inserting, e.g. the values after an argument name
        command: item.command ? { id: item.command.command, title: item.command.title } : undefined,
        range
    };
}

export const toMonacoCompletionItems = (
    items: CompletionItem[],
    range: MonacoTypes.IRange,
    enums: MonacoEnums
) => items.map((item) => toMonacoCompletionItem(item, range, enums));

function toMarkerSeverity(severity: number | undefined, enums: MonacoEnums): MonacoTypes.MarkerSeverity {
    switch (severity) {
        case LSP_SEVERITY.warning: return enums.MarkerSeverity.Warning;
        case LSP_SEVERITY.information: return enums.MarkerSeverity.Info;
        case undefined:
        case LSP_SEVERITY.error: return enums.MarkerSeverity.Error;
        default: return enums.MarkerSeverity.Hint;
    }
}

// LSP positions count from 0, Monaco's from 1
export function toMonacoMarkers(diagnostics: Diagnostic[], enums: MonacoEnums): MonacoTypes.editor.IMarkerData[] {
    return diagnostics.map((diagnostic) => {
        const { start, end } = diagnostic.range;
        const startColumn = start.character + 1;
        // An error at the very end of the text has an empty range, but still needs a squiggle
        const isEmpty = end.line < start.line || (end.line === start.line && end.character <= start.character);

        return {
            severity: toMarkerSeverity(diagnostic.severity, enums),
            message: typeof diagnostic.message === 'string' ? diagnostic.message : diagnostic.message.value,
            source: diagnostic.source,
            startLineNumber: start.line + 1,
            startColumn,
            endLineNumber: isEmpty ? start.line + 1 : end.line + 1,
            endColumn: isEmpty ? startColumn + 1 : end.character + 1
        };
    });
}

function hoverText(contents: HoverContents): string {
    if (typeof contents === 'string') return contents;
    if (Array.isArray(contents)) return contents.map((part) => hoverText(part)).join('\n\n');
    return contents.value; // Markup content, or a marked string with a language
}

export function toMonacoHover(contents: HoverContents, range?: MonacoTypes.IRange): MonacoTypes.languages.Hover | null {
    const text = hoverText(contents).trim();
    if (!text) return null;
    return { contents: [{ value: text }], range };
}
