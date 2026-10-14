import { expect } from '../../../test-setup';
import {
    COMMON_HTTP_HEADERS,
    getHeaderSuggestions,
    getValueSuggestions
} from '../../../../src/components/send/request-editor/headers/header-autocomplete';

describe("Header Autocomplete", () => {
    describe("getHeaderSuggestions", () => {
        it("returns the top common headers when input is empty", () => {
            const suggestions = getHeaderSuggestions('');
            expect(suggestions.length).to.be.greaterThan(0);
            expect(suggestions).to.include('Accept');
            expect(suggestions).to.include('Authorization');
            expect(suggestions).to.include('Content-Type');
        });

        it("prioritizes prefix matches over substring matches", () => {
            const suggestions = getHeaderSuggestions('acc');
            // Headers starting with "Acc..." should appear before headers like "Sec-WebSocket-Accept"
            const acceptIndex = suggestions.indexOf('Accept');
            const secAcceptIndex = suggestions.indexOf('Sec-WebSocket-Accept');

            expect(acceptIndex).to.be.greaterThan(-1);
            if (secAcceptIndex !== -1) {
                expect(acceptIndex).to.be.lessThan(secAcceptIndex);
            }
        });

        it("places exact matches at the very top", () => {
            const suggestions = getHeaderSuggestions('accept');
            expect(suggestions[0]).to.equal('Accept');
        });

        it("is case-insensitive", () => {
            const suggestionsLower = getHeaderSuggestions('content-type');
            const suggestionsUpper = getHeaderSuggestions('CONTENT-TYPE');
            expect(suggestionsLower[0]).to.equal('Content-Type');
            expect(suggestionsUpper[0]).to.equal('Content-Type');
        });

        it("returns empty array when no header matches", () => {
            const suggestions = getHeaderSuggestions('non-existent-header-xyz-123');
            expect(suggestions).to.deep.equal([]);
        });
    });

    describe("getValueSuggestions", () => {
        it("returns content-type suggestions for Content-Type", () => {
            const suggestions = getValueSuggestions('Content-Type', '');
            expect(suggestions).to.include('application/json');
            expect(suggestions).to.include('multipart/form-data');
            expect(suggestions).to.include('application/x-www-form-urlencoded');
        });

        it("filters value suggestions by prefix and substring", () => {
            const jsonSuggestions = getValueSuggestions('Content-Type', 'json');
            expect(jsonSuggestions).to.include('application/json');
            expect(jsonSuggestions).to.include('application/graphql+json');
        });

        it("returns accept suggestions for Accept", () => {
            const suggestions = getValueSuggestions('Accept', '');
            expect(suggestions).to.include('application/json');
            expect(suggestions).to.include('*/*');
        });

        it("returns empty array for unknown header", () => {
            const suggestions = getValueSuggestions('X-Custom-Foo', '');
            expect(suggestions).to.deep.equal([]);
        });
    });
});
