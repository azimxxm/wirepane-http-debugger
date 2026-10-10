import {
    buildClientSchema,
    getIntrospectionQuery,
    GraphQLSchema,
    IntrospectionQuery
} from 'graphql';

/**
 * Reading a GraphQL schema from the answer to an introspection query.
 */

// The standard introspection query, as GraphiQL sends it. Only the default options are used,
// because older servers reject the newer introspection fields.
export const INTROSPECTION_QUERY = getIntrospectionQuery();
export const INTROSPECTION_OPERATION_NAME = 'IntrospectionQuery';

// Why a schema couldn't be loaded. The message is shown to the user, in the GraphQL editor.
export class GraphqlSchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GraphqlSchemaError';
    }
}

export interface IntrospectionResponse {
    statusCode: number;
    statusMessage?: string;
    // The response body, decoded, as text
    body: string;
}

// Servers can return dozens of errors. The first few say enough.
const MAX_ERRORS_SHOWN = 3;

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function errorMessages(errors: unknown): string[] {
    if (!Array.isArray(errors)) return [];
    return errors
        .map((error) => isRecord(error) && typeof error.message === 'string' ? error.message.trim() : '')
        .filter((message) => message.length > 0)
        .slice(0, MAX_ERRORS_SHOWN);
}

const describeStatus = (response: IntrospectionResponse) =>
    [response.statusCode, response.statusMessage].filter(Boolean).join(' ');

export function parseIntrospectionResponse(response: IntrospectionResponse): GraphQLSchema {
    const json = parseJson(response.body);
    if (json === undefined) {
        throw new GraphqlSchemaError(response.statusCode >= 400
            ? `The server answered ${describeStatus(response)}, without a GraphQL response.`
            : "The response isn't JSON, so this URL doesn't look like a GraphQL endpoint."
        );
    }

    const data = isRecord(json) ? json.data : undefined;
    if (!isRecord(data) || !isRecord(data.__schema)) {
        const messages = isRecord(json) ? errorMessages(json.errors) : [];
        if (messages.length) {
            throw new GraphqlSchemaError(
                `The server returned ${messages.length === 1 ? 'an error' : 'errors'}: ${messages.join(' ')}`
            );
        }

        if (response.statusCode >= 400) {
            throw new GraphqlSchemaError(`The server answered ${describeStatus(response)}.`);
        }

        throw new GraphqlSchemaError("The response has no schema. The server may not allow introspection.");
    }

    let schema: GraphQLSchema;
    try {
        schema = buildClientSchema(data as unknown as IntrospectionQuery);
    } catch (error: any) {
        throw new GraphqlSchemaError(`The schema in the response isn't valid: ${error?.message ?? error}`);
    }

    // Without a query type there's nothing to suggest or document
    if (!schema.getQueryType()) throw new GraphqlSchemaError('The schema in the response has no query type.');
    return schema;
}

// The schema's own types, without GraphQL's introspection types (__Schema, __Type...)
export function countSchemaTypes(schema: GraphQLSchema): number {
    return Object.keys(schema.getTypeMap())
        .filter((name) => !name.startsWith('__'))
        .length;
}
