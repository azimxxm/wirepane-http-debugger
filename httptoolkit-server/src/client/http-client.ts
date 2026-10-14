import * as _ from 'lodash';
import * as stream from 'stream';
import { LookupFunction } from 'net';
import * as tls from 'tls';
import * as http from 'http';
import * as https from 'https';

// We import lots of Mockttp internal passthrough logic, to ensure our
// upstream behaviour matches normal passthrough:
import {
    getDnsLookupFunction,
    getUpstreamTlsOptions as getUpstreamMockttpTlsOptions
} from 'mockttp/dist/rules/passthrough-handling';
import { getEffectivePort } from 'mockttp/dist/util/url';

import { getUpstreamProxyAgent, RuleParameters } from './upstream-proxy';

import {
    RawHeaders,
    RequestDefinition,
    RequestOptions
} from './client-types';
import * as fs from '../util/fs';

export class HttpClient {

    constructor(
        readonly ruleParameters: RuleParameters // wirepane: read by the WebSocket client too
    ) {}

    readonly getDns = _.memoize((dnsServers: string[] | undefined) => {
        if (!dnsServers?.length) return undefined;
        return getDnsLookupFunction({ servers: dnsServers }) as LookupFunction;
    }, (dnsServers: string[] | undefined) =>
        // Quick & easy memoize key:
        JSON.stringify(dnsServers)
    );

    async sendRequest(
        requestDefn: RequestDefinition,
        options: RequestOptions
    ): Promise<stream.Readable> {
        const resultsStream = new stream.Readable({
            objectMode: true,
            read() {} // Can't pull data - we manually fill this with .push() instead.
        });

        resultsStream.push({
            type: 'request-start',
            startTime: Date.now(),
            timestamp: performance.now()
        });

        this.executeRequest(requestDefn, options, 0, resultsStream);

        return resultsStream;
    }

    private async executeRequest(
        requestDefn: RequestDefinition,
        options: RequestOptions,
        redirectCount: number,
        resultsStream: stream.Readable
    ): Promise<void> {
        try {
            const url = new URL(requestDefn.url);

            // Each option here should closely match the behaviour of the passthrough rules. We delegate
            // calculation of option values as much as possible to the UI, even where somewhat possible
            // here, since the UI controls the passthrough options directly already.

            const effectivePort = getEffectivePort(url);
            const additionalCAs = options.additionalTrustedCAs || options.trustAdditionalCAs;

            const agent = await getUpstreamProxyAgent({
                hostname: url.hostname!,
                port: effectivePort,
                proxyConfig: options.proxyConfig,
                ruleParameters: this.ruleParameters
            });

            const request = (url.protocol === 'https:' ? https : http).request(requestDefn.url, {
                method: requestDefn.method,
                signal: options.abortSignal,

                setDefaultHeaders: false,
                headers: flattenPairedRawHeaders(requestDefn.headers),

                // Low-level connection configuration:
                agent,
                lookup: this.getDns(options.lookupOptions?.servers),

                // TLS options (should be effectively identical to Mockttp's passthrough config)
                ...getUpstreamMockttpTlsOptions({
                    hostname: url.hostname!,
                    port: effectivePort,

                    ignoreHostHttpsErrors: options.ignoreHostHttpsErrors ?? [],
                    clientCertificateHostMap: options.clientCertificate
                        ? { '*': options.clientCertificate }
                        : {},
                    trustedCAs: additionalCAs
                        ? tls.rootCertificates.concat(additionalCAs.map(({ cert }) => cert))
                        : undefined
                })
            } as any); // Would be nice to avoid this but raw header options aren't in the types yet

            if (options.keyLogFile) {
                request.on('socket', (socket) => {
                    socket.on('keylog', (line) => fs.appendOrCreateFile(options.keyLogFile!, line));
                });
            }

            options.abortSignal?.addEventListener('abort', () => {
                // In older Node versions, this seems to be required to _actually_ abort the request:
                request.abort();
            });

            if (requestDefn.rawBody?.byteLength) {
                request.end(requestDefn.rawBody);
            } else {
                request.end();
            }

            const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
                request.on('error', reject);
                request.on('response', resolve);
            });

            const isRedirect = options.followRedirects &&
                [301, 302, 303, 307, 308].includes(response.statusCode!) &&
                response.headers.location;

            const maxRedirects = options.maxRedirects ?? 5;

            if (isRedirect && redirectCount < maxRedirects) {
                response.resume(); // Discard body

                const nextUrl = new URL(response.headers.location!, requestDefn.url).toString();
                let nextMethod = requestDefn.method;
                let nextBody = requestDefn.rawBody;

                if (response.statusCode === 303 || ((response.statusCode === 301 || response.statusCode === 302) && !options.followOriginalMethod)) {
                    nextMethod = 'GET';
                    nextBody = undefined;
                }

                let nextHeaders = [...requestDefn.headers];
                if (!options.followAuthHeader) {
                    const currentOrigin = new URL(requestDefn.url).origin;
                    const nextOrigin = new URL(nextUrl).origin;
                    if (currentOrigin !== nextOrigin) {
                        nextHeaders = nextHeaders.filter(([name]) => name.toLowerCase() !== 'authorization');
                    }
                }

                if (nextMethod === 'GET' && !nextBody) {
                    nextHeaders = nextHeaders.filter(([name]) =>
                        !['content-length', 'content-type', 'transfer-encoding'].includes(name.toLowerCase())
                    );
                }

                return this.executeRequest({
                    url: nextUrl,
                    method: nextMethod,
                    headers: nextHeaders,
                    rawBody: nextBody
                }, options, redirectCount + 1, resultsStream);
            }

            resultsStream.push({
                type: 'response-head',
                statusCode: response.statusCode!,
                statusMessage: response.statusMessage,
                headers: pairFlatRawHeaders(response.rawHeaders),
                timestamp: performance.now()
            });

            response.on('data', (data) => resultsStream.push({
                type: 'response-body-part',
                rawBody: data,
                timestamp: performance.now()
            }));

            response.on('end', () => {
                if (response.rawTrailers?.length) {
                    resultsStream.push({
                        type: 'response-trailers',
                        trailers: pairFlatRawHeaders(response.rawTrailers),
                        timestamp: performance.now()
                    });
                }
                resultsStream.push({ type: 'response-end', timestamp: performance.now() });
                resultsStream.push(null);
            });

            response.on('error', (error) => resultsStream.destroy(error));
        } catch (error: any) {
            resultsStream.destroy(error);
        }
    }

}

/**
 * Turn node's _very_ raw headers ([k, v, k, v, ...]) into our slightly more convenient
 * pairwise tuples [[k, v], [k, v], ...] RawHeaders structure.
 */
export function pairFlatRawHeaders(flatRawHeaders: string[]): RawHeaders {
    const result: RawHeaders = [];
    for (let i = 0; i < flatRawHeaders.length; i += 2 /* Move two at a time */) {
        result[i/2] = [flatRawHeaders[i], flatRawHeaders[i+1]];
    }
    return result;
}

/**
 * Turn our raw headers [[k, v], [k, v], ...] tuples into Node's very flat
 * [k, v, k, v, ...] structure.
 */
export function flattenPairedRawHeaders(rawHeaders: RawHeaders): string[] {
    return rawHeaders.flat();
}