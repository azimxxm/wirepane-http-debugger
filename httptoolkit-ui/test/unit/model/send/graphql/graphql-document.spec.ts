import { collectVariables, getVariablesJSONSchema } from 'graphql-language-service';

import { expect } from '../../../../test-setup';

import {
    listOperations,
    operationNameFor,
    parseGraphqlDocument,
    variablesJsonSchema
} from '../../../../../src/model/send/graphql/graphql-document';
import {
    fieldsOf,
    rootTypes,
    schemaTypes,
    searchSchema
} from '../../../../../src/model/send/graphql/schema-docs';

import { testSchema } from './test-schema';

const tools = { collectVariables, getVariablesJSONSchema };

const TWO_OPERATIONS = `
    query Countries { countries { name } }
    query Country($code: ID!) { country(code: $code) { name } }
`;

describe("GraphQL documents", () => {

    describe("parsing", () => {

        it("gives nothing for an empty query, or one that doesn't parse", () => {
            expect(parseGraphqlDocument('')).to.equal(undefined);
            expect(parseGraphqlDocument('  \n ')).to.equal(undefined);
            expect(parseGraphqlDocument('{ country(code: ')).to.equal(undefined);
        });

        it("lists the operations, named or not", () => {
            expect(listOperations(parseGraphqlDocument('{ countries { name } }')!)).to.deep.equal([
                { name: undefined, type: 'query' }
            ]);

            expect(listOperations(parseGraphqlDocument(`
                ${TWO_OPERATIONS}
                mutation Rename { rename }
                fragment CountryName on Country { name }
            `)!)).to.deep.equal([
                { name: 'Countries', type: 'query' },
                { name: 'Country', type: 'query' },
                { name: 'Rename', type: 'mutation' }
            ]);
        });

    });

    describe("the operation name to send", () => {

        const operations = listOperations(parseGraphqlDocument(TWO_OPERATIONS)!);
        const single = listOperations(parseGraphqlDocument('query Country { country(code: "UZ") { name } }')!);

        it("keeps a name that's in the query", () => {
            expect(operationNameFor(operations, 'Country')).to.equal('Country');
            expect(operationNameFor(single, 'Country')).to.equal('Country');
        });

        it("drops a name that isn't, when there's one operation", () => {
            expect(operationNameFor(single, 'Countries')).to.equal(undefined);
        });

        it("keeps the choice while one of several operations is renamed", () => {
            expect(operationNameFor(operations, 'Countrie')).to.equal('Countrie');
        });

        it("stays unset when there's no name", () => {
            expect(operationNameFor(operations, undefined)).to.equal(undefined);
        });

    });

    describe("the variables' JSON schema", () => {

        it("describes the variables the query takes", () => {
            const document = parseGraphqlDocument('query ($code: ID!, $region: Region) { country(code: $code) { name } }')!;
            const schema = variablesJsonSchema(tools, testSchema(), document, undefined) as any;

            expect(schema.type).to.equal('object');
            expect(Object.keys(schema.properties)).to.deep.equal(['code', 'region']);
            expect(schema.required).to.deep.equal(['code']);
            expect(schema.properties.region.enum).to.include.members(['EUROPE', 'ASIA']);
        });

        it("only describes the chosen operation's variables", () => {
            const document = parseGraphqlDocument(TWO_OPERATIONS)!;

            expect(variablesJsonSchema(tools, testSchema(), document, 'Countries')).to.equal(undefined);
            expect(Object.keys((variablesJsonSchema(tools, testSchema(), document, 'Country') as any).properties))
                .to.deep.equal(['code']);
        });

        it("is undefined for a query without variables", () => {
            const document = parseGraphqlDocument('{ countries { name } }')!;
            expect(variablesJsonSchema(tools, testSchema(), document, undefined)).to.equal(undefined);
        });

    });

    describe("the schema docs", () => {

        it("lists the schema's own types by name, and its root types", () => {
            const schema = testSchema();

            expect(schemaTypes(schema).map((type) => type.name)).to.deep.equal([
                'Boolean', 'Continent', 'Country', 'CountryFilterInput', 'ID', 'Int',
                'Query', 'Region', 'State', 'String', 'StringQueryOperatorInput'
            ]);
            expect(rootTypes(schema).map(({ label, type }) => `${label}: ${type.name}`)).to.deep.equal([
                'Query: Query'
            ]);
        });

        it("lists the fields of object and input types only", () => {
            const schema = testSchema();

            expect(fieldsOf(schema.getType('State')!).map((field) => field.name)).to.deep.equal(['code', 'name', 'country']);
            expect(fieldsOf(schema.getType('CountryFilterInput')!).map((field) => field.name)).to.deep.equal(['code', 'currency']);
            expect(fieldsOf(schema.getType('Region')!)).to.deep.equal([]);
        });

        it("finds types and fields: exact matches first, then prefixes, types before fields", () => {
            const results = searchSchema(testSchema(), 'Country').map((result) => result.kind === 'type'
                ? result.type.name
                : `${result.type.name}.${result.field.name}`
            );

            expect(results).to.deep.equal([
                'Country',
                'Query.country',
                'State.country',
                'CountryFilterInput',
                'Query.countryCount'
            ]);
        });

        it("finds names that contain the text anywhere", () => {
            expect(searchSchema(testSchema(), 'operator').map((result) => result.type.name)).to.deep.equal([
                'StringQueryOperatorInput'
            ]);
        });

        it("ignores case and spaces, and finds nothing for an empty search", () => {
            expect(searchSchema(testSchema(), '  currency ').map((result) =>
                result.kind === 'field' ? `${result.type.name}.${result.field.name}` : result.type.name
            )).to.deep.equal(['Country.currency', 'CountryFilterInput.currency']);

            expect(searchSchema(testSchema(), '  ')).to.deep.equal([]);
        });

        it("stops at the limit", () => {
            expect(searchSchema(testSchema(), 'e', 3).length).to.equal(3);
        });

    });

});
