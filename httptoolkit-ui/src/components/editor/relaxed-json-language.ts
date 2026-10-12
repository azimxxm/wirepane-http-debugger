import type * as MonacoTypes from 'monaco-editor';

// JSON written in JavaScript object style, with unquoted keys, single-quoted strings or values
// like NaN, as the Firebase iOS SDK sends it. Monaco's JSON mode reports every such key as an
// error, so these bodies use this mode instead: the same colours as JSON, no validation, and
// one note on top.
export const RELAXED_JSON_LANGUAGE = 'json-relaxed';

const STRING = /"(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?/;
const KEY = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[A-Za-z_$][\w$]*)(\s*)(:)/;

export function registerRelaxedJsonLanguage(monaco: typeof MonacoTypes) {
    monaco.languages.register({ id: RELAXED_JSON_LANGUAGE });

    monaco.languages.setLanguageConfiguration(RELAXED_JSON_LANGUAGE, {
        brackets: [['{', '}'], ['[', ']']]
    });

    // Token names match Monaco's own JSON mode, so the themes colour them the same way
    monaco.languages.setMonarchTokensProvider(RELAXED_JSON_LANGUAGE, {
        tokenizer: {
            root: [
                [/\s+/, ''],
                [/\/\/.*$/, 'comment'],
                [/\/\*/, 'comment', '@blockComment'],
                [KEY, ['string.key.json', '', 'delimiter']],
                [STRING, 'string.value.json'],
                [/-?\d+(\.\d+)?([eE][-+]?\d+)?/, 'number'],
                [/\b(true|false|null|NaN|Infinity|undefined)\b/, 'keyword.json'],
                [/[{}\[\],:]/, 'delimiter']
            ],
            blockComment: [
                [/[^*]+/, 'comment'],
                [/\*\//, 'comment', '@pop'],
                [/\*/, 'comment']
            ]
        }
    });

    monaco.languages.registerCodeLensProvider(RELAXED_JSON_LANGUAGE, {
        provideCodeLenses: () => ({
            lenses: [{
                range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 1 },
                id: 'relaxed-json-note',
                command: {
                    id: '', // Just a note, with nothing to run
                    title: "Not strict JSON (unquoted keys, single quotes or NaN), so it isn't checked for errors"
                }
            }],
            dispose: () => {}
        }),
        resolveCodeLens: (_model, codeLens) => codeLens
    });
}
