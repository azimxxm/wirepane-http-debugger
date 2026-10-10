// Monaco's enums on their own (no imports, no DOM), so tests can map to real Monaco values
// without loading the editor.
declare module 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums' {
    import type * as MonacoTypes from 'monaco-editor';

    export const CompletionItemKind: typeof MonacoTypes.languages.CompletionItemKind;
    export const CompletionItemInsertTextRule: typeof MonacoTypes.languages.CompletionItemInsertTextRule;
    export const CompletionItemTag: typeof MonacoTypes.languages.CompletionItemTag;
    export const MarkerSeverity: typeof MonacoTypes.MarkerSeverity;
}
