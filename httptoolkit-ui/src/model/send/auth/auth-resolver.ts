import { RawHeaders } from '../../../types';
import { SendAuthData, SendAuthMode } from '../send-extras';

export interface AuthResolutionResult {
    headers: Array<[string, string]>;
    queryParams: Array<[string, string]>;
    unsupportedNote?: string;
}

/**
 * Resolves SendAuthData into raw headers and query params that will be added to the outgoing request.
 */
export function resolveAuthEntries(
    auth: SendAuthData | undefined,
    url: string,
    method: string,
    resolveTemplate: (text: string) => string = (t) => t
): AuthResolutionResult {
    if (!auth || auth.mode === 'none') {
        return { headers: [], queryParams: [] };
    }

    const headers: Array<[string, string]> = [];
    const queryParams: Array<[string, string]> = [];

    switch (auth.mode) {
        case 'bearer': {
            const token = resolveTemplate(auth.bearer?.token ?? '').trim();
            if (token) {
                const prefix = (auth.bearer?.prefix || 'Bearer').trim();
                headers.push(['Authorization', `${prefix} ${token}`]);
            }
            break;
        }

        case 'basic': {
            const username = resolveTemplate(auth.basic?.username ?? '');
            const password = resolveTemplate(auth.basic?.password ?? '');
            if (username || password) {
                const creds = `${username}:${password}`;
                const encoded = Buffer.from(creds).toString('base64');
                headers.push(['Authorization', `Basic ${encoded}`]);
            }
            break;
        }

        case 'apikey': {
            const key = resolveTemplate(auth.apikey?.key ?? '').trim();
            const value = resolveTemplate(auth.apikey?.value ?? '');
            if (key) {
                if (auth.apikey?.placement === 'queryparams') {
                    queryParams.push([key, value]);
                } else {
                    headers.push([key, value]);
                }
            }
            break;
        }

        case 'jwt': {
            const secret = resolveTemplate(auth.jwt?.secret ?? '');
            const prefix = (auth.jwt?.headerPrefix || 'Bearer').trim();
            // If user supplied a ready token in secret or payload
            const rawToken = resolveTemplate(auth.jwt?.secret || auth.jwt?.payload || '').trim();
            if (rawToken) {
                headers.push(['Authorization', `${prefix} ${rawToken}`]);
            }
            break;
        }

        case 'oauth2': {
            const token = resolveTemplate(auth.oauth2?.token ?? '').trim();
            if (token) {
                const prefix = (auth.oauth2?.headerPrefix || 'Bearer').trim();
                headers.push(['Authorization', `${prefix} ${token}`]);
            }
            break;
        }

        case 'oauth1': {
            const consumerKey = resolveTemplate(auth.oauth1?.consumerKey ?? '');
            const token = resolveTemplate(auth.oauth1?.accessToken ?? '');
            const sigMethod = auth.oauth1?.signatureMethod || 'HMAC-SHA1';
            const timestamp = auth.oauth1?.timestamp || Math.floor(Date.now() / 1000).toString();
            const nonce = auth.oauth1?.nonce || crypto.randomUUID().replace(/-/g, '').slice(0, 16);
            const version = auth.oauth1?.version || '1.0';

            const oauthParams = [
                `oauth_consumer_key="${encodeURIComponent(consumerKey)}"`,
                `oauth_token="${encodeURIComponent(token)}"`,
                `oauth_signature_method="${encodeURIComponent(sigMethod)}"`,
                `oauth_timestamp="${encodeURIComponent(timestamp)}"`,
                `oauth_nonce="${encodeURIComponent(nonce)}"`,
                `oauth_version="${encodeURIComponent(version)}"`
            ];

            if (auth.oauth1?.placement === 'queryparams') {
                queryParams.push(['oauth_consumer_key', consumerKey]);
                queryParams.push(['oauth_token', token]);
                queryParams.push(['oauth_version', version]);
            } else {
                headers.push(['Authorization', `OAuth ${oauthParams.join(', ')}`]);
            }
            break;
        }

        case 'digest': {
            const username = resolveTemplate(auth.digest?.username ?? '');
            const realm = resolveTemplate(auth.digest?.realm ?? 'api');
            const nonce = resolveTemplate(auth.digest?.nonce ?? crypto.randomUUID());
            const qop = auth.digest?.qop || 'auth';
            const nc = auth.digest?.nonceCount || '00000001';
            const cnonce = auth.digest?.clientNonce || crypto.randomUUID().slice(0, 8);
            const opaque = auth.digest?.opaque ? `, opaque="${resolveTemplate(auth.digest.opaque)}"` : '';

            headers.push([
                'Authorization',
                `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${url}", qop=${qop}, nc=${nc}, cnonce="${cnonce}"${opaque}`
            ]);
            break;
        }

        case 'hawk': {
            const id = resolveTemplate(auth.hawk?.authId ?? '');
            const ts = auth.hawk?.timestamp || Math.floor(Date.now() / 1000).toString();
            const nonce = auth.hawk?.nonce || crypto.randomUUID().slice(0, 6);
            headers.push([
                'Authorization',
                `Hawk id="${id}", ts="${ts}", nonce="${nonce}", mac="mac"`
            ]);
            break;
        }

        case 'aws': {
            const accessKey = resolveTemplate(auth.aws?.accessKey ?? '');
            const region = resolveTemplate(auth.aws?.region || 'us-east-1');
            const service = resolveTemplate(auth.aws?.service || 'execute-api');
            const date = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
            headers.push([
                'Authorization',
                `AWS4-HMAC-SHA256 Credential=${accessKey}/${date.slice(0, 8)}/${region}/${service}/aws4_request, SignedHeaders=host;x-amz-date, Signature=signature`
            ]);
            break;
        }

        case 'inherit':
            // Resolved at collection level
            break;
    }

    return { headers, queryParams };
}
