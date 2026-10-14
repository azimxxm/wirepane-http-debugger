import { expect } from '../../../test-setup';
import { resolveAuthEntries } from '../../../../src/model/send/auth/auth-resolver';
import { SendAuthData } from '../../../../src/model/send/send-extras';

describe("Auth resolver", () => {

    it("returns empty headers and query params for 'none' mode", () => {
        const result = resolveAuthEntries({ mode: 'none' }, 'https://example.com/api', 'GET');
        expect(result.headers).to.deep.equal([]);
        expect(result.queryParams).to.deep.equal([]);
    });

    it("resolves Bearer token with custom prefix", () => {
        const auth: SendAuthData = {
            mode: 'bearer',
            bearer: { token: 'my-jwt-token-123', prefix: 'Bearer' }
        };
        const result = resolveAuthEntries(auth, 'https://example.com/api', 'GET');
        expect(result.headers).to.deep.equal([
            ['Authorization', 'Bearer my-jwt-token-123']
        ]);
    });

    it("resolves Basic auth to Base64 encoded header", () => {
        const auth: SendAuthData = {
            mode: 'basic',
            basic: { username: 'admin', password: 'secretpassword' }
        };
        const result = resolveAuthEntries(auth, 'https://example.com/api', 'GET');
        const expectedBase64 = Buffer.from('admin:secretpassword').toString('base64');
        expect(result.headers).to.deep.equal([
            ['Authorization', `Basic ${expectedBase64}`]
        ]);
    });

    it("resolves API Key to Header", () => {
        const auth: SendAuthData = {
            mode: 'apikey',
            apikey: { key: 'X-API-KEY', value: 'secret-key-999', placement: 'header' }
        };
        const result = resolveAuthEntries(auth, 'https://example.com/api', 'GET');
        expect(result.headers).to.deep.equal([
            ['X-API-KEY', 'secret-key-999']
        ]);
        expect(result.queryParams).to.deep.equal([]);
    });

    it("resolves API Key to Query Params", () => {
        const auth: SendAuthData = {
            mode: 'apikey',
            apikey: { key: 'api_key', value: 'secret-key-999', placement: 'queryparams' }
        };
        const result = resolveAuthEntries(auth, 'https://example.com/api', 'GET');
        expect(result.headers).to.deep.equal([]);
        expect(result.queryParams).to.deep.equal([
            ['api_key', 'secret-key-999']
        ]);
    });

    it("resolves OAuth 2.0 token to Authorization header", () => {
        const auth: SendAuthData = {
            mode: 'oauth2',
            oauth2: { grantType: 'authorization_code', token: 'oauth2-access-token', headerPrefix: 'Bearer' }
        };
        const result = resolveAuthEntries(auth, 'https://example.com/api', 'GET');
        expect(result.headers).to.deep.equal([
            ['Authorization', 'Bearer oauth2-access-token']
        ]);
    });

    it("resolves template variables using provided resolver", () => {
        const auth: SendAuthData = {
            mode: 'bearer',
            bearer: { token: '{{tokenVar}}' }
        };
        const result = resolveAuthEntries(auth, 'https://example.com/api', 'GET', (text) =>
            text === '{{tokenVar}}' ? 'resolved-token' : text
        );
        expect(result.headers).to.deep.equal([
            ['Authorization', 'Bearer resolved-token']
        ]);
    });

});
