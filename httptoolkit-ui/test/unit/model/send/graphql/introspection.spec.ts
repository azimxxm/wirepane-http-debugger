import { isObjectType } from 'graphql';

import { expect } from '../../../../test-setup';

import {
    countSchemaTypes,
    GraphqlSchemaError,
    INTROSPECTION_OPERATION_NAME,
    INTROSPECTION_QUERY,
    parseIntrospectionResponse
} from '../../../../../src/model/send/graphql/introspection';
import {
    buildIntrospectionRequest,
    readIntrospectionResponse
} from '../../../../../src/model/send/graphql/schema-fetch';
import { buildRequestForSend } from '../../../../../src/model/send/build-request';
import { RequestInput } from '../../../../../src/model/send/send-request-model';
import { ResponseStreamEvent } from '../../../../../src/model/send/send-response-model';

import { testIntrospectionBody } from './test-schema';

const parseError = (statusCode: number, body: string, statusMessage?: string) => {
    try {
        parseIntrospectionResponse({ statusCode, statusMessage, body });
    } catch (error) {
        expect(error).to.be.instanceOf(GraphqlSchemaError);
        return (error as Error).message;
    }
    throw new Error('Expected the response to be rejected');
};

const streamOf = (events: ResponseStreamEvent[]) => new ReadableStream<ResponseStreamEvent>({
    start(controller) {
        events.forEach((event) => controller.enqueue(event));
        controller.close();
    }
});

describe("GraphQL introspection", () => {

    describe("parsing the response", () => {

        it("builds the schema from an introspection result", () => {
            const schema = parseIntrospectionResponse({ statusCode: 200, body: testIntrospectionBody() });

            const queryType = schema.getQueryType()!;
            expect(Object.keys(queryType.getFields())).to.deep.equal([
                'countries', 'country', 'continents', 'countryCount'
            ]);
            expect(queryType.getFields().country.args[0].type.toString()).to.equal('ID!');

            const country = schema.getType('Country');
            expect(isObjectType(country)).to.equal(true);
            expect(country!.description).to.equal('A country, with its ISO code');
            expect(queryType.getFields().countryCount.deprecationReason).to.equal('Count the countries instead');
        });

        it("counts the schema's own types, without the introspection types", () => {
            const schema = parseIntrospectionResponse({ statusCode: 200, body: testIntrospectionBody() });

            // Country, Continent, State, two inputs, Region, Query, and the ID, String, Int & Boolean scalars
            expect(countSchemaTypes(schema)).to.equal(11);
        });

        it("explains a response that isn't JSON", () => {
            expect(parseError(200, '<html>Hello</html>')).to.equal(
                "The response isn't JSON, so this URL doesn't look like a GraphQL endpoint."
            );
        });

        it("includes the status of an HTTP error without a GraphQL body", () => {
            expect(parseError(404, 'Not found', 'Not Found')).to.equal(
                'The server answered 404 Not Found, without a GraphQL response.'
            );
            expect(parseError(401, '{"message":"Unauthorized"}', 'Unauthorized')).to.equal(
                'The server answered 401 Unauthorized.'
            );
        });

        it("shows the GraphQL errors the server returned", () => {
            expect(parseError(200, JSON.stringify({
                errors: [{ message: 'GraphQL introspection is not allowed.' }]
            }))).to.equal('The server returned an error: GraphQL introspection is not allowed.');

            expect(parseError(400, JSON.stringify({
                errors: [{ message: 'One.' }, { message: 'Two.' }, { message: 'Three.' }, { message: 'Four.' }]
            }))).to.equal('The server returned errors: One. Two. Three.');
        });

        it("explains a JSON response without a schema", () => {
            expect(parseError(200, JSON.stringify({ data: { hello: 'world' } }))).to.equal(
                'The response has no schema. The server may not allow introspection.'
            );
            expect(parseError(200, '[]')).to.equal(
                'The response has no schema. The server may not allow introspection.'
            );
        });

        it("rejects an introspection result that isn't complete", () => {
            const message = parseError(200, JSON.stringify({ data: { __schema: {
                queryType: { name: 'Query' },
                types: [{
                    kind: 'OBJECT',
                    name: 'Query',
                    interfaces: [],
                    fields: [{ name: 'user', args: [], type: { kind: 'OBJECT', name: 'User' } }]
                }]
            } } }));

            expect(message).to.match(/^The schema in the response isn't valid: .*unknown type: User/);
        });

        it("rejects a schema without a query type", () => {
            expect(parseError(200, JSON.stringify({ data: { __schema: { types: [] } } }))).to.equal(
                'The schema in the response has no query type.'
            );
        });

    });

    describe("reading Send's response events", () => {

        it("joins the body parts of the response", async () => {
            const response = await readIntrospectionResponse(streamOf([
                { type: 'request-start', startTime: 1, timestamp: 1 },
                { type: 'response-head', statusCode: 200, statusMessage: 'OK', headers: [['content-type', 'application/json']], timestamp: 2 },
                { type: 'response-body-part', rawBody: Buffer.from('{"data":'), timestamp: 3 },
                { type: 'response-body-part', rawBody: Buffer.from('{}}'), timestamp: 4 },
                { type: 'response-end', timestamp: 5 }
            ]));

            expect(response).to.deep.equal({ statusCode: 200, statusMessage: 'OK', body: '{"data":{}}' });
        });

        it("turns a connection error into a message", async () => {
            await expect(readIntrospectionResponse(streamOf([
                { type: 'request-start', startTime: 1, timestamp: 1 },
                { type: 'error', error: { code: 'ENOTFOUND', message: 'getaddrinfo ENOTFOUND nowhere.test' }, timestamp: 2 }
            ]))).to.be.rejectedWith(GraphqlSchemaError, 'The request failed: getaddrinfo ENOTFOUND nowhere.test (ENOTFOUND)');
        });

        it("fails when the stream ends before the response", async () => {
            await expect(readIntrospectionResponse(streamOf([
                { type: 'request-start', startTime: 1, timestamp: 1 }
            ]))).to.be.rejectedWith(GraphqlSchemaError, 'The connection closed before the server answered.');
        });

    });

    describe("building the request", () => {

        const tabRequest = () => new RequestInput({
            method: 'GET',
            url: 'https://api.example.com/graphql',
            headers: [
                ['host', 'api.example.com'],
                ['authorization', 'Bearer {{token}}'],
                ['content-type', 'text/plain'],
                ['content-length', '12'],
                ['content-encoding', 'gzip']
            ],
            requestContentType: 'text',
            rawBody: Buffer.from('hello world!'),
            extras: { bodyMode: 'graphql', graphql: { query: '{ me { id } }', variables: '{"a": 1}' } }
        });

        it("keeps the tab's URL and headers, with a JSON body", () => {
            const request = buildIntrospectionRequest(tabRequest());

            expect(request.method).to.equal('POST');
            expect(request.url).to.equal('https://api.example.com/graphql');
            expect(request.headers).to.deep.equal([
                ['host', 'api.example.com'],
                ['authorization', 'Bearer {{token}}'],
                ['content-type', 'application/json'],
                ['accept', 'application/graphql-response+json, application/json']
            ]);
            expect(request.extras.bodyMode).to.equal('graphql');
            expect(request.extras.graphql).to.deep.equal({
                query: INTROSPECTION_QUERY,
                variables: '',
                operationName: INTROSPECTION_OPERATION_NAME
            });
        });

        it("keeps an Accept header the tab already has", () => {
            const tab = new RequestInput({
                method: 'POST',
                url: 'https://api.example.com/graphql',
                headers: [['Accept', 'application/json']],
                requestContentType: 'json',
                rawBody: Buffer.alloc(0)
            });

            const request = buildIntrospectionRequest(tab);
            expect(request.headers.filter(([name]) => name.toLowerCase() === 'accept')).to.deep.equal([
                ['Accept', 'application/json']
            ]);
        });

        it("leaves the tab's own request as it was", () => {
            const tab = tabRequest();
            buildIntrospectionRequest(tab);

            expect(tab.method).to.equal('GET');
            expect(tab.headers.length).to.equal(5);
            expect(tab.extras.graphql.query).to.equal('{ me { id } }');
        });

        it("is sent as the standard introspection query", async () => {
            const sent = await buildRequestForSend(buildIntrospectionRequest(tabRequest()));

            expect(JSON.parse(sent.rawBody.decoded.toString())).to.deep.equal({
                query: INTROSPECTION_QUERY,
                operationName: 'IntrospectionQuery'
            });
            expect(sent.headers).to.deep.include(['content-length', sent.rawBody.decoded.byteLength.toString()]);
        });

    });

});
