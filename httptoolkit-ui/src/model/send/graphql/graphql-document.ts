import { DocumentNode, GraphQLSchema, OperationDefinitionNode, parse } from 'graphql';
import type * as GraphqlLanguageService from 'graphql-language-service';

/**
 * What the GraphQL editor reads from the query text: its operations, and the variables they take.
 */

export interface GraphqlOperation {
    name: string | undefined;
    type: OperationDefinitionNode['operation'];
}

// The parsed query, or undefined while it's empty or doesn't parse. The editor shows why.
export function parseGraphqlDocument(query: string): DocumentNode | undefined {
    if (!query.trim()) return undefined;
    try {
        return parse(query);
    } catch {
        return undefined;
    }
}

const isOperation = (definition: DocumentNode['definitions'][number]): definition is OperationDefinitionNode =>
    definition.kind === 'OperationDefinition';

export function listOperations(document: DocumentNode): GraphqlOperation[] {
    return document.definitions
        .filter(isOperation)
        .map((operation) => ({ name: operation.name?.value, type: operation.operation }));
}

/**
 * The operation name to send. Only a document with several operations needs one. In a document
 * with one operation, a name that isn't in it any more is dropped, because the server would
 * reject it. With several operations it's kept, so renaming one doesn't lose the choice.
 */
export function operationNameFor(operations: GraphqlOperation[], current: string | undefined): string | undefined {
    if (current === undefined) return undefined;
    if (operations.some((operation) => operation.name === current)) return current;
    return operations.length > 1 ? current : undefined;
}

type VariableTools = Pick<typeof GraphqlLanguageService, 'collectVariables' | 'getVariablesJSONSchema'>;

// The JSON schema of the variables that the sent operation takes, for the variables editor
export function variablesJsonSchema(
    tools: VariableTools,
    schema: GraphQLSchema,
    document: DocumentNode,
    operationName: string | undefined
): object | undefined {
    // With several operations, only the chosen one's variables are sent
    const sentDocument: DocumentNode = operationName && listOperations(document).length > 1
        ? {
            ...document,
            definitions: document.definitions.filter((definition) =>
                !isOperation(definition) || definition.name?.value === operationName
            )
        }
        : document;

    const variables = tools.collectVariables(schema, sentDocument);
    if (Object.keys(variables).length === 0) return undefined;

    return tools.getVariablesJSONSchema(variables, { useMarkdownDescription: true });
}
