import { action, observable } from 'mobx';
import { GraphQLSchema } from 'graphql';

import { ApiError } from '../../../services/server-api-types';

import { SendRequest } from '../send-request-model';
import type { SendStore } from '../send-store';
import { countSchemaTypes, GraphqlSchemaError } from './introspection';
import { fetchGraphqlSchema } from './schema-fetch';

/**
 * The GraphQL schemas fetched in Send, per endpoint URL (as written in the tab). They're kept
 * in memory only: a schema can be big, and it's quick to fetch again.
 */

export const SCHEMA_FETCH_TIMEOUT_MS = 30_000;

export interface GraphqlSchemaState {
    readonly status: 'loading' | 'loaded' | 'failed';
    // The last schema that loaded. It's kept while fetching again, and when that fails.
    readonly schema?: GraphQLSchema;
    readonly loadedAt?: number;
    readonly typeCount?: number;
    readonly error?: string;
}

export const schemaCacheKey = (url: string) => url.trim();

function errorMessage(error: unknown): string {
    if (error instanceof GraphqlSchemaError) return error.message;
    if (error instanceof ApiError) {
        return `Wirepane's server couldn't send the request: ${error.apiError?.message ?? error.message}`;
    }
    if (error instanceof Error) return error.message;
    return String(error);
}

const lastSchemaOf = (state: GraphqlSchemaState | undefined) => state?.schema
    ? { schema: state.schema, loadedAt: state.loadedAt, typeCount: state.typeCount }
    : {};

export class GraphqlSchemaCache {

    // Not deep: a GraphQLSchema must never become observable
    private readonly states = observable.map<string, GraphqlSchemaState>({}, { deep: false });
    private readonly pendingFetches = new Map<string, AbortController>();

    get(url: string): GraphqlSchemaState | undefined {
        return this.states.get(schemaCacheKey(url));
    }

    @action
    private setState(key: string, state: GraphqlSchemaState | undefined) {
        if (state) this.states.set(key, state);
        else this.states.delete(key);
    }

    async fetch(sendStore: SendStore, sendRequest: SendRequest): Promise<void> {
        const key = schemaCacheKey(sendRequest.request.url);
        const previous = this.states.get(key);

        if (!key) {
            this.setState(key, { status: 'failed', error: 'Enter the GraphQL endpoint URL first.' });
            return;
        }

        this.pendingFetches.get(key)?.abort();
        const abortController = new AbortController();
        this.pendingFetches.set(key, abortController);

        let timedOut = false;
        const timeout = setTimeout(() => {
            timedOut = true;
            abortController.abort();
        }, SCHEMA_FETCH_TIMEOUT_MS);

        this.setState(key, { ...lastSchemaOf(previous), status: 'loading' });

        try {
            const schema = await fetchGraphqlSchema(sendStore, sendRequest, abortController.signal);
            if (this.pendingFetches.get(key) !== abortController) return; // A newer fetch replaced this one

            this.setState(key, {
                status: 'loaded',
                schema,
                loadedAt: Date.now(),
                typeCount: countSchemaTypes(schema)
            });
        } catch (error) {
            if (this.pendingFetches.get(key) !== abortController) return;

            if (abortController.signal.aborted && !timedOut) {
                // Cancelled: back to how it was before
                this.setState(key, previous?.status !== 'loading'
                    ? previous
                    : previous.schema ? { ...lastSchemaOf(previous), status: 'loaded' } : undefined
                );
                return;
            }

            this.setState(key, {
                ...lastSchemaOf(previous),
                status: 'failed',
                error: timedOut
                    ? `The server didn't answer within ${SCHEMA_FETCH_TIMEOUT_MS / 1000} seconds.`
                    : errorMessage(error)
            });
        } finally {
            clearTimeout(timeout);
            if (this.pendingFetches.get(key) === abortController) this.pendingFetches.delete(key);
        }
    }

    cancel(url: string) {
        this.pendingFetches.get(schemaCacheKey(url))?.abort();
    }

}

export const graphqlSchemas = new GraphqlSchemaCache();
