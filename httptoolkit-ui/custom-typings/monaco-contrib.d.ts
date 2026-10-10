// Monaco modules outside its typed API. The GraphQL editor imports them only so they register
// themselves: GraphQL syntax highlighting, and the suggestion widget for autocomplete.
// Neither is in monaco-editor-webpack-plugin's lists in automation/webpack.common.ts.
declare module 'monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution';
declare module 'monaco-editor/esm/vs/editor/contrib/suggest/suggestController';
