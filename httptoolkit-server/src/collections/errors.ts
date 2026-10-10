import { StatusError } from '@httptoolkit/util';

export const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error);

/**
 * Bad input is by far the most likely reason a conversion fails, so errors without an
 * HTTP status of their own are reported to the client as a 400 with the given context.
 */
export const asClientError = (error: unknown, context: string): Error =>
    error instanceof StatusError
        ? error
        : new StatusError(400, `${context}: ${errorMessage(error)}`);
