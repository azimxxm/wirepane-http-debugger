import {
    getAutocompleteSuggestions,
    getDiagnostics,
    getHoverInformation,
    Position
} from 'graphql-language-service';
import * as monacoEnums from 'monaco-editor/esm/vs/editor/common/standalone/standaloneEnums';

import { expect } from '../../../../test-setup';

import {
    MonacoEnums,
    toMonacoCompletionItems,
    toMonacoCompletionKind,
    toMonacoHover,
    toMonacoMarkers
} from '../../../../../src/model/send/graphql/monaco-mapping';

import { testSchema } from './test-schema';

const enums: MonacoEnums = monacoEnums;
const { CompletionItemKind, CompletionItemInsertTextRule, CompletionItemTag, MarkerSeverity } = monacoEnums;

const RANGE = { startLineNumber: 1, endLineNumber: 1, startColumn: 3, endColumn: 7 };

// Suggestions at the end of the text, as the editor asks for them while typing
function suggestionsAtEnd(query: string) {
    const lines = query.split('\n');
    const cursor = new Position(lines.length - 1, lines[lines.length - 1].length);
    return toMonacoCompletionItems(getAutocompleteSuggestions(testSchema(), query, cursor), RANGE, enums);
}

const labelOf = (item: { label: string | { label: string } }) =>
    typeof item.label === 'string' ? item.label : item.label.label;

describe("GraphQL suggestions, errors and hovers in Monaco", () => {

    describe("completion kinds", () => {

        it("maps LSP kinds to Monaco's, which are numbered differently", () => {
            expect(toMonacoCompletionKind(1, enums)).to.equal(CompletionItemKind.Text);
            expect(toMonacoCompletionKind(3, enums)).to.equal(CompletionItemKind.Function);
            expect(toMonacoCompletionKind(5, enums)).to.equal(CompletionItemKind.Field);
            expect(toMonacoCompletionKind(6, enums)).to.equal(CompletionItemKind.Variable);
            expect(toMonacoCompletionKind(20, enums)).to.equal(CompletionItemKind.EnumMember);
            expect(toMonacoCompletionKind(25, enums)).to.equal(CompletionItemKind.TypeParameter);
        });

        it("uses Value for a missing or unknown kind", () => {
            expect(toMonacoCompletionKind(undefined, enums)).to.equal(CompletionItemKind.Value);
            expect(toMonacoCompletionKind(99, enums)).to.equal(CompletionItemKind.Value);
        });

    });

    describe("completion items", () => {

        it("suggests the root fields that match what's typed", () => {
            const suggestions = suggestionsAtEnd('{ coun');

            expect(suggestions.map(labelOf)).to.have.members(['country', 'countries']);

            const countries = suggestions.find((item) => labelOf(item) === 'countries')!;
            expect(countries).to.deep.include({
                label: { label: 'countries', description: '[Country!]!' },
                kind: CompletionItemKind.Field,
                detail: '[Country!]!',
                insertText: 'countries',
                insertTextRules: undefined,
                range: RANGE
            });
            expect(countries.documentation).to.deep.equal({ value: 'All countries, optionally filtered' });
        });

        it("suggests the fields of a nested type", () => {
            const suggestions = suggestionsAtEnd('{ country(code: "UZ") { na');

            expect(suggestions.map(labelOf)).to.include('name');
            expect(suggestions.find((item) => labelOf(item) === 'name')!.label)
                .to.deep.equal({ label: 'name', description: 'String!' });
        });

        it("inserts arguments as snippets, then suggests again", () => {
            const [code] = suggestionsAtEnd('{ country(');

            expect(code).to.deep.include({
                label: { label: 'code', description: 'ID!' },
                kind: CompletionItemKind.Variable,
                insertText: 'code: ',
                insertTextRules: CompletionItemInsertTextRule.InsertAsSnippet,
                command: { id: 'editor.action.triggerSuggest', title: 'Suggestions' }
            });
        });

        it("suggests enum values for an enum argument", () => {
            const suggestions = suggestionsAtEnd('{ continents(region: ');

            expect(suggestions.map(labelOf)).to.have.members(['EUROPE', 'ASIA']);
            expect(suggestions[0].kind).to.equal(CompletionItemKind.EnumMember);
        });

        it("filters variables by name, after a typed $", () => {
            const suggestions = suggestionsAtEnd('query ($id: ID!) { country(code: $');
            const id = suggestions.find((item) => labelOf(item) === '$id')!;

            expect(id.insertText).to.equal('id');
            expect(id.filterText).to.equal('id');
        });

        it("marks deprecated suggestions, with the reason", () => {
            const [item] = toMonacoCompletionItems([{
                label: 'countryCount',
                kind: 5,
                detail: 'Int',
                isDeprecated: true,
                deprecationReason: 'Count the countries instead'
            }], RANGE, enums);

            expect(item.tags).to.deep.equal([CompletionItemTag.Deprecated]);
            expect(item.documentation).to.deep.equal({ value: '**Deprecated**: Count the countries instead' });
        });

    });

    describe("markers", () => {

        it("shows a syntax error at the end of the text", () => {
            const [marker] = toMonacoMarkers(getDiagnostics('{ country(code: "UZ") { name '), enums);

            expect(marker).to.deep.include({
                severity: MarkerSeverity.Error,
                message: 'Syntax Error: Expected Name, found <EOF>.',
                startLineNumber: 1,
                endLineNumber: 1
            });
            expect(marker.endColumn).to.be.greaterThan(marker.startColumn);
        });

        it("shows fields that aren't in the schema, where they are", () => {
            const query = '{\n  country(code: "UZ") {\n    nam\n  }\n}';
            const [marker] = toMonacoMarkers(getDiagnostics(query, testSchema()), enums);

            expect(marker).to.deep.include({
                severity: MarkerSeverity.Error,
                message: 'Cannot query field "nam" on type "Country". Did you mean "name"?',
                startLineNumber: 3,
                startColumn: 5,
                endLineNumber: 3
            });
        });

        it("shows deprecated fields as warnings", () => {
            const [marker] = toMonacoMarkers(getDiagnostics('{ countryCount }', testSchema()), enums);

            expect(marker.severity).to.equal(MarkerSeverity.Warning);
            expect(marker.message).to.equal('The field Query.countryCount is deprecated. Count the countries instead');
        });

        it("finds no problems in a valid query", () => {
            expect(getDiagnostics('{ country(code: "UZ") { name capital } }', testSchema())).to.deep.equal([]);
        });

        it("maps LSP severities", () => {
            const diagnostic = (severity: 1 | 2 | 3 | 4) => ({
                severity,
                message: 'x',
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
            });

            expect(toMonacoMarkers([1, 2, 3, 4].map((severity) => diagnostic(severity as 1 | 2 | 3 | 4)), enums)
                .map((marker) => marker.severity)
            ).to.deep.equal([MarkerSeverity.Error, MarkerSeverity.Warning, MarkerSeverity.Info, MarkerSeverity.Hint]);
        });

    });

    describe("hovers", () => {

        it("shows the field's type as markdown", () => {
            const query = '{ country(code: "UZ") { name } }';
            const contents = getHoverInformation(testSchema(), query, new Position(0, 4), undefined, { useMarkdown: true });

            expect(toMonacoHover(contents, RANGE)).to.deep.equal({
                contents: [{ value: '```graphql\nQuery.country: Country\n```' }],
                range: RANGE
            });
        });

        it("shows nothing where there's nothing to say", () => {
            expect(toMonacoHover('', RANGE)).to.equal(null);
            expect(toMonacoHover('   ', RANGE)).to.equal(null);
        });

    });

});
