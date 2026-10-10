// Minimal typings for the parts of Bruno's packages (MIT, usebruno/bruno; our copy in
// ../bruno/packages) that the collections service uses. They have no TypeScript declarations.
// Their outputs are typed as unknown on purpose: callers narrow them before use.

declare module '@usebruno/converters' {
    export function postmanToBruno(
        collection: unknown,
        options?: { useWorkers?: boolean, preserveScripts?: boolean }
    ): Promise<{ collection: unknown, issues?: unknown[] }>;

    export function postmanToBrunoEnvironment(environment: unknown): unknown;

    export function brunoToPostman(
        collection: unknown,
        options?: { preserveScripts?: boolean }
    ): unknown;

    export function openApiToBruno(specification: unknown, options?: Record<string, unknown>): unknown;

    export function insomniaToBruno(collection: unknown): unknown;

    export function wsdlToBruno(wsdl: string, options?: { uri?: string }): Promise<unknown>;
}

declare module '@usebruno/lang' {
    export function bruToJsonV2(bru: string): unknown;
    export function jsonToBruV2(json: unknown): string;

    export function bruToEnvJsonV2(bru: string): unknown;
    export function envJsonToBruV2(json: unknown): string;

    export function collectionBruToJson(bru: string): unknown;
    export function jsonToCollectionBru(json: unknown): string;
}

declare module '@usebruno/schema' {
    interface ValidationSchema {
        validate(value: unknown, options?: { abortEarly?: boolean }): Promise<unknown>;
    }

    export const collectionSchema: ValidationSchema;
    export const environmentSchema: ValidationSchema;
    export const itemSchema: ValidationSchema;
}
