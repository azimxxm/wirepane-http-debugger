import {
    GraphQLField,
    GraphQLInputField,
    GraphQLNamedType,
    GraphQLObjectType,
    GraphQLSchema,
    isEnumType,
    isInputObjectType,
    isInterfaceType,
    isObjectType,
    isUnionType
} from 'graphql';

/**
 * What the schema docs panel shows: the schema's types and fields, and search over them.
 */

export type SchemaField = GraphQLField<unknown, unknown> | GraphQLInputField;

export type SchemaSearchResult =
    | { kind: 'type', type: GraphQLNamedType }
    | { kind: 'field', type: GraphQLNamedType, field: SchemaField };

const MAX_SEARCH_RESULTS = 50;

const isIntrospectionType = (type: GraphQLNamedType) => type.name.startsWith('__');

// The schema's own types (no __Schema, __Type...), by name
export function schemaTypes(schema: GraphQLSchema): GraphQLNamedType[] {
    return Object.values(schema.getTypeMap())
        .filter((type) => !isIntrospectionType(type))
        .sort((a, b) => a.name.localeCompare(b.name));
}

export function rootTypes(schema: GraphQLSchema): Array<{ label: string, type: GraphQLObjectType }> {
    const roots = [
        { label: 'Query', type: schema.getQueryType() },
        { label: 'Mutation', type: schema.getMutationType() },
        { label: 'Subscription', type: schema.getSubscriptionType() }
    ];

    const result: Array<{ label: string, type: GraphQLObjectType }> = [];
    for (const { label, type } of roots) {
        if (type) result.push({ label, type });
    }
    return result;
}

// The fields of object, interface and input types. Other types have none.
export function fieldsOf(type: GraphQLNamedType): SchemaField[] {
    if (isObjectType(type) || isInterfaceType(type) || isInputObjectType(type)) {
        return Object.values(type.getFields());
    }
    return [];
}

export function typeKindLabel(type: GraphQLNamedType): string {
    if (isObjectType(type)) return 'Object type';
    if (isInterfaceType(type)) return 'Interface';
    if (isUnionType(type)) return 'Union';
    if (isEnumType(type)) return 'Enum';
    if (isInputObjectType(type)) return 'Input type';
    return 'Scalar';
}

// 0 for an exact match, 1 for a prefix, 2 for anywhere in the name, undefined for no match
function matchRank(name: string, needle: string): number | undefined {
    const lowerName = name.toLowerCase();
    if (lowerName === needle) return 0;
    if (lowerName.startsWith(needle)) return 1;
    if (lowerName.includes(needle)) return 2;
    return undefined;
}

// Types and fields whose name contains the text: the closest matches first, types before fields
export function searchSchema(schema: GraphQLSchema, text: string, limit = MAX_SEARCH_RESULTS): SchemaSearchResult[] {
    const needle = text.trim().toLowerCase();
    if (!needle) return [];

    const matches: Array<{ result: SchemaSearchResult, rank: number, order: number, name: string }> = [];
    for (const type of schemaTypes(schema)) {
        const typeRank = matchRank(type.name, needle);
        if (typeRank !== undefined) {
            matches.push({ result: { kind: 'type', type }, rank: typeRank, order: 0, name: type.name });
        }

        for (const field of fieldsOf(type)) {
            const fieldRank = matchRank(field.name, needle);
            if (fieldRank !== undefined) {
                matches.push({
                    result: { kind: 'field', type, field },
                    rank: fieldRank,
                    order: 1,
                    name: `${type.name}.${field.name}`
                });
            }
        }
    }

    return matches
        .sort((a, b) => a.rank - b.rank || a.order - b.order || a.name.localeCompare(b.name))
        .slice(0, limit)
        .map((match) => match.result);
}
