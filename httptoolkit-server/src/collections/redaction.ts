import * as _ from 'lodash';

import {
    BrunoAuth,
    BrunoBody,
    BrunoCollection,
    BrunoEnvironment,
    BrunoExample,
    BrunoFolderRoot,
    BrunoItem,
    BrunoKeyValue,
    BrunoRequest,
    BrunoScript,
    BrunoVars,
    isFolder,
    isRecord
} from './bruno-types';

/**
 * Removes secrets from a collection before it leaves the machine. Secret values are
 * replaced with {{variable}} placeholders, so the receiver only has to set those
 * variables in an environment. Variables that hold secrets themselves are emptied.
 *
 * Secrets are found by where they live (auth headers, cookies, *-key/*-token headers,
 * secret-looking parameter and field names, auth settings, secret environment variables)
 * and by what they look like (JWTs, AWS/GitHub/Slack/Stripe/Google keys, private keys),
 * which is checked in every other string, including docs and saved examples.
 */

export interface RedactionEntry {
    // Where the secret was, e.g. "Users / Get user › header"
    location: string;
    // The header, parameter, field, setting or variable that held it
    name: string;
    // The {{variable}} that replaced it, or the name of the variable that was emptied
    variable: string;
}

export interface RedactionResult {
    collection: BrunoCollection;
    report: RedactionEntry[];
}

interface SecretPattern {
    label: string;
    variable: string;
    pattern: RegExp;
}

const SECRET_VALUE_PATTERNS: SecretPattern[] = [
    {
        label: 'private key',
        variable: 'privateKey',
        pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/g
    },
    {
        // A key whose END line was cut off: the header plus everything key-like after it
        label: 'private key',
        variable: 'privateKey',
        pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[A-Za-z0-9+/=\s\\]*/g
    },
    { label: 'JWT', variable: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g },
    { label: 'AWS access key', variable: 'awsAccessKeyId', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
    {
        label: 'GitHub token',
        variable: 'githubToken',
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{22,255})\b/g
    },
    { label: 'Slack token', variable: 'slackToken', pattern: /\bxox[abposre]-[A-Za-z0-9-]{10,}/g },
    { label: 'Stripe key', variable: 'stripeKey', pattern: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g },
    { label: 'Google API key', variable: 'googleApiKey', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g }
];

const containsSecretPattern = (value: string) =>
    SECRET_VALUE_PATTERNS.some(({ pattern }) => new RegExp(pattern.source).test(value));

// Names whose last word is one of these hold secrets: api_key, accessToken, client_secret...
const SECRET_NAME_WORDS: ReadonlySet<string> = new Set([
    'token', 'key', 'apikey', 'secret', 'password', 'passwd', 'pwd', 'passphrase',
    'signature', 'sig', 'credential', 'credentials', 'jwt', 'session', 'sessionid'
]);

// ...unless another word says otherwise: public_key, page_token, idempotency_key...
const NOT_SECRET_WORDS: ReadonlySet<string> = new Set([
    'public', 'publishable', 'page', 'next', 'prev', 'previous', 'continuation', 'cursor',
    'sync', 'idempotency', 'cache', 'sort', 'partition', 'primary', 'foreign', 'object', 'routing'
]);

const SECRET_EXACT_NAMES: ReadonlySet<string> = new Set([
    'code', 'auth', 'auth_code', 'authorization', 'authorization_code', 'session_id'
]);

export function isSecretName(name: string): boolean {
    if (SECRET_EXACT_NAMES.has(name.trim().toLowerCase())) return true;

    const words = _.words(name).map((word) => word.toLowerCase());
    const lastWord = words[words.length - 1];
    if (!lastWord || !SECRET_NAME_WORDS.has(lastWord)) return false;
    return !words.some((word) => NOT_SECRET_WORDS.has(word));
}

const variableNameFor = (name: string) => _.camelCase(name) || 'secret';

const SECRET_HEADER_VARIABLES: ReadonlyMap<string, string> = new Map([
    ['cookie', 'cookie'],
    ['set-cookie', 'setCookie'],
    ['x-api-key', 'apiKey'],
    ['api-key', 'apiKey'],
    ['apikey', 'apiKey'],
    ['x-token', 'token']
]);

// X-*-Key, X-*-Token and X-*-Secret, e.g. X-Auth-Token -> {{authToken}}
const PREFIXED_SECRET_HEADER = /^x-.+-(key|token|secret)$/;

const AUTH_SCHEME_VARIABLES: ReadonlyMap<string, string> = new Map([
    ['bearer', 'authToken'],
    ['token', 'authToken'],
    ['basic', 'basicAuth'],
    ['digest', 'digestAuth']
]);

// Auth settings that hold secrets, by Bruno auth mode, with the variable replacing each
const AUTH_SECRET_FIELDS: ReadonlyArray<[mode: keyof Omit<BrunoAuth, 'mode'>, field: string, variable: string]> = [
    ['basic', 'password', 'basicAuthPassword'],
    ['bearer', 'token', 'authToken'],
    ['digest', 'password', 'digestAuthPassword'],
    ['ntlm', 'password', 'ntlmPassword'],
    ['wsse', 'password', 'wssePassword'],
    ['awsv4', 'accessKeyId', 'awsAccessKeyId'],
    ['awsv4', 'secretAccessKey', 'awsSecretAccessKey'],
    ['awsv4', 'sessionToken', 'awsSessionToken'],
    ['oauth1', 'consumerSecret', 'oauth1ConsumerSecret'],
    ['oauth1', 'accessToken', 'oauth1AccessToken'],
    ['oauth1', 'accessTokenSecret', 'oauth1AccessTokenSecret'],
    ['oauth1', 'privateKey', 'oauth1PrivateKey'],
    ['oauth2', 'clientSecret', 'oauth2ClientSecret'],
    ['oauth2', 'password', 'oauth2Password'],
    ['akamaiEdgegrid', 'accessToken', 'edgegridAccessToken'],
    ['akamaiEdgegrid', 'clientToken', 'edgegridClientToken'],
    ['akamaiEdgegrid', 'clientSecret', 'edgegridClientSecret']
];

const TEMPLATE_VARIABLE = /\{\{[^{}]*\}\}/g;

// Empty values and values made only of {{variables}} hold nothing to remove
const holdsSecret = (value: string) => value.replace(TEMPLATE_VARIABLE, '').trim() !== '';

class RedactionContext {
    readonly report: RedactionEntry[] = [];
    private readonly reported = new Set<string>();
    private readonly variablesBySecret = new Map<string, string>();
    private readonly takenVariables = new Set<string>();

    // The same secret always gets the same variable; a different secret wanting a taken
    // name gets a numbered one (authToken, authToken2...). Deterministic for a given input.
    variableFor(baseName: string, secret: string): string {
        const known = this.variablesBySecret.get(secret);
        if (known) return known;

        let variable = baseName;
        for (let counter = 2; this.takenVariables.has(variable); counter++) variable = `${baseName}${counter}`;

        this.variablesBySecret.set(secret, variable);
        this.takenVariables.add(variable);
        return variable;
    }

    record(location: string, name: string, variable: string) {
        const key = JSON.stringify([location, name, variable]);
        if (this.reported.has(key)) return;

        this.reported.add(key);
        this.report.push({ location, name, variable });
    }

    // Replaces a whole value with a placeholder, if it holds a secret
    replace(value: string, baseVariable: string, location: string, name: string): string {
        if (!holdsSecret(value)) return value;

        const variable = this.variableFor(baseVariable, value);
        this.record(location, name, variable);
        return `{{${variable}}}`;
    }

    // Replaces every secret-looking substring (JWTs, keys...) with a placeholder
    scan(text: string, location: string): string {
        return SECRET_VALUE_PATTERNS.reduce((result, { label, variable, pattern }) =>
            result.replace(pattern, (secret) => {
                const name = this.variableFor(variable, secret);
                this.record(location, label, name);
                return `{{${name}}}`;
            }),
        text);
    }
}

export function redactCollection(input: BrunoCollection): RedactionResult {
    const collection = _.cloneDeep(input);
    const context = new RedactionContext();

    if (collection.brunoConfig) {
        collection.brunoConfig = redactJsonValue(collection.brunoConfig, 'Collection › settings', context) as Record<string, unknown>;
    }
    redactFolderRoot(collection.root, 'Collection', context);
    redactItems(collection.items, [], context);
    collection.environments.forEach((environment) => redactEnvironment(environment, context));

    return { collection, report: context.report };
}

function redactItems(items: BrunoItem[] | undefined, parents: string[], context: RedactionContext) {
    for (const item of items ?? []) {
        const itemPath = [...parents, item.name];
        const location = itemPath.join(' / ');

        if (isFolder(item)) {
            redactFolderRoot(item.root, location, context);
            redactItems(item.items, itemPath, context);
            continue;
        }

        if (item.request) redactRequest(item.request, location, context);
        for (const example of item.examples ?? []) redactExample(example, location, context);
    }
}

function redactFolderRoot(root: BrunoFolderRoot | null | undefined, location: string, context: RedactionContext) {
    if (!root) return;

    const request = root.request;
    if (request) {
        redactAuth(request.auth, `${location} › auth`, context);
        redactHeaders(request.headers, `${location} › header`, context);
        redactVars(request.vars, `${location} › variables`, context);
        redactScripts(request.script, request, location, context);
    }
    if (typeof root.docs === 'string') root.docs = context.scan(root.docs, `${location} › docs`);
}

// Auth settings go first, so they get the plain variable names ({{authToken}}) when two
// different secrets would want the same one
function redactRequest(request: BrunoRequest, location: string, context: RedactionContext) {
    redactAuth(request.auth, `${location} › auth`, context);
    redactHeaders(request.headers, `${location} › header`, context);
    if (typeof request.url === 'string') request.url = redactUrl(request.url, location, context);
    redactParams(request.params, location, context);
    redactBody(request.body, `${location} › body`, context);
    redactVars(request.vars, `${location} › variables`, context);
    redactScripts(request.script, request, location, context);
    if (typeof request.docs === 'string') request.docs = context.scan(request.docs, `${location} › docs`);
}

function redactExample(example: BrunoExample, itemLocation: string, context: RedactionContext) {
    const location = `${itemLocation} › example "${example.name}"`;

    const request = example.request;
    if (request) {
        if (typeof request.url === 'string') request.url = redactUrl(request.url, location, context);
        redactParams(request.params, location, context);
        redactHeaders(request.headers, `${location} › header`, context);
        redactBody(request.body, `${location} › body`, context);
    }

    const response = example.response;
    if (response) {
        redactHeaders(response.headers, `${location} › response header`, context);
        if (response.body) {
            response.body.content = redactContent(response.body.content, `${location} › response body`, context);
        }
    }
}

function redactParams(params: BrunoKeyValue[] | undefined, location: string, context: RedactionContext) {
    for (const param of params ?? []) {
        const section = param.type === 'path' ? 'path parameter' : 'query';
        redactKeyValue(param, `${location} › ${section}`, context);
    }
}

function redactKeyValue(entry: BrunoKeyValue, location: string, context: RedactionContext) {
    if (typeof entry.value !== 'string' || typeof entry.name !== 'string') return;

    entry.value = isSecretName(entry.name)
        ? context.replace(entry.value, variableNameFor(entry.name), location, entry.name)
        : context.scan(entry.value, location);
}

const safeDecode = (value: string) => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

// Handles the query string and user:password@ by hand, because URLs with {{variables}}
// in them often aren't valid for the URL parser
function redactUrl(url: string, location: string, context: RedactionContext): string {
    const withoutUserPassword = url.replace(
        /^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#@]+)@/i,
        (match, prefix: string, password: string) => {
            const decoded = safeDecode(password);
            const replaced = context.replace(decoded, 'urlPassword', `${location} › URL`, 'password');
            return replaced === decoded ? match : `${prefix}${replaced}@`;
        }
    );

    const hashIndex = withoutUserPassword.indexOf('#');
    const beforeHash = hashIndex === -1 ? withoutUserPassword : withoutUserPassword.slice(0, hashIndex);
    const hash = hashIndex === -1 ? '' : withoutUserPassword.slice(hashIndex);
    const queryIndex = beforeHash.indexOf('?');

    const redacted = queryIndex === -1
        ? beforeHash
        : beforeHash.slice(0, queryIndex + 1) + redactQueryString(beforeHash.slice(queryIndex + 1), location, context);

    return context.scan(redacted + hash, `${location} › URL`);
}

function redactQueryString(query: string, location: string, context: RedactionContext): string {
    return query.split('&').map((part) => {
        const equalsIndex = part.indexOf('=');
        if (equalsIndex === -1) return part;

        const name = safeDecode(part.slice(0, equalsIndex));
        const value = safeDecode(part.slice(equalsIndex + 1));
        if (!isSecretName(name)) return part;

        const replaced = context.replace(value, variableNameFor(name), `${location} › query`, name);
        return replaced === value ? part : `${part.slice(0, equalsIndex)}=${replaced}`;
    }).join('&');
}

function redactHeaders(headers: BrunoKeyValue[] | null | undefined, location: string, context: RedactionContext) {
    for (const header of headers ?? []) {
        if (typeof header.value !== 'string' || typeof header.name !== 'string') continue;
        header.value = redactHeaderValue(header.name, header.value, location, context);
    }
}

function redactHeaderValue(name: string, value: string, location: string, context: RedactionContext): string {
    const lowerName = name.toLowerCase();
    if (lowerName === 'authorization' || lowerName === 'proxy-authorization') {
        return redactAuthorizationValue(name, value, location, context);
    }

    const variable = SECRET_HEADER_VARIABLES.get(lowerName) ??
        (PREFIXED_SECRET_HEADER.test(lowerName) ? variableNameFor(lowerName.slice(2)) : undefined);

    return variable
        ? context.replace(value, variable, location, name)
        : context.scan(value, location);
}

// "Bearer abc" becomes "Bearer {{authToken}}": the scheme stays, so the request works
// as soon as the variable is set
function redactAuthorizationValue(name: string, value: string, location: string, context: RedactionContext): string {
    const isProxy = name.toLowerCase() === 'proxy-authorization';
    const fallbackVariable = isProxy ? 'proxyAuthorization' : 'authorization';
    const match = /^(\S+)(\s+)([\s\S]+)$/.exec(value.trim());
    if (!match) return context.replace(value, fallbackVariable, location, name);

    const [, scheme, space, credentials] = match;
    const variable = isProxy
        ? fallbackVariable
        : AUTH_SCHEME_VARIABLES.get(scheme.toLowerCase()) ?? fallbackVariable;

    return `${scheme}${space}${context.replace(credentials, variable, location, name)}`;
}

function redactAuth(auth: BrunoAuth | undefined, location: string, context: RedactionContext) {
    if (!auth) return;

    // Every mode's settings are checked, not only the active one: inactive modes keep values too
    for (const [mode, field, variable] of AUTH_SECRET_FIELDS) {
        const settings = auth[mode];
        if (!isRecord(settings) || typeof settings[field] !== 'string') continue;
        settings[field] = context.replace(settings[field] as string, variable, location, `${mode} ${field}`);
    }

    // API key auth: the variable is named after the key, e.g. X-API-Key -> {{apiKey}}
    const apiKey = auth.apikey;
    if (isRecord(apiKey) && typeof apiKey.value === 'string') {
        const keyName = typeof apiKey.key === 'string' ? apiKey.key : '';
        const variable = _.camelCase(keyName.replace(/^x-/i, '')) || 'apiKey';
        apiKey.value = context.replace(apiKey.value, variable, location, keyName || 'API key');
    }

    const oauth2 = auth.oauth2;
    if (isRecord(oauth2) && isRecord(oauth2.additionalParameters)) {
        for (const params of Object.values(oauth2.additionalParameters)) {
            if (!Array.isArray(params)) continue;
            params.filter(isRecord).forEach((param) => redactKeyValue(param as BrunoKeyValue, location, context));
        }
    }
}

function redactBody(body: BrunoBody | undefined, location: string, context: RedactionContext) {
    if (!body) return;

    if (typeof body.json === 'string') body.json = redactJsonText(body.json, location, context);
    if (typeof body.text === 'string') body.text = context.scan(body.text, location);
    if (typeof body.xml === 'string') body.xml = context.scan(body.xml, location);
    if (typeof body.sparql === 'string') body.sparql = context.scan(body.sparql, location);

    for (const field of [...body.formUrlEncoded ?? [], ...body.multipartForm ?? []]) {
        redactKeyValue(field, location, context);
    }

    const graphql = body.graphql;
    if (graphql) {
        if (typeof graphql.query === 'string') graphql.query = context.scan(graphql.query, location);
        if (typeof graphql.variables === 'string') graphql.variables = redactJsonText(graphql.variables, location, context);
    }

    // WebSocket requests' saved messages
    for (const message of body.ws ?? []) {
        if (typeof message.content !== 'string') continue;
        const messageLocation = message.name ? `${location} › message "${message.name}"` : `${location} › message`;
        message.content = message.type === 'json'
            ? redactJsonText(message.content, messageLocation, context)
            : context.scan(message.content, messageLocation);
    }
}

// Finds "key": "value" pairs anywhere in JSON-like text, including bodies that {{variables}}
// make invalid JSON, so secrets are swapped in place without reformatting the body
const JSON_STRING_PAIR = /"((?:[^"\\]|\\.)*)"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;

function redactJsonText(text: string, location: string, context: RedactionContext): string {
    const withoutNamedSecrets = text.replace(JSON_STRING_PAIR, (match, key: string, separator: string, value: string) => {
        if (!isSecretName(key) || !holdsSecret(value)) return match;
        return `"${key}"${separator}"${context.replace(value, variableNameFor(key), location, key)}"`;
    });
    return context.scan(withoutNamedSecrets, location);
}

function redactJsonValue(value: unknown, location: string, context: RedactionContext, key?: string): unknown {
    if (typeof value === 'string') {
        return key !== undefined && isSecretName(key)
            ? context.replace(value, variableNameFor(key), location, key)
            : context.scan(value, location);
    }

    if (Array.isArray(value)) return value.map((entry) => redactJsonValue(entry, location, context, key));
    if (isRecord(value)) return _.mapValues(value, (entry, entryKey) => redactJsonValue(entry, location, context, entryKey));
    return value;
}

function redactContent(content: unknown, location: string, context: RedactionContext): unknown {
    return typeof content === 'string'
        ? redactJsonText(content, location, context)
        : redactJsonValue(content, location, context);
}

// Pre-request variables can't point at themselves, so a secret one is emptied and turned
// off instead: the receiver sets a variable of the same name in their environment.
// Post-response variables hold expressions (res.body.token), so only their text is scanned.
function redactVars(vars: BrunoVars | null | undefined, location: string, context: RedactionContext) {
    for (const variable of vars?.req ?? []) {
        if (typeof variable.value !== 'string' || typeof variable.name !== 'string') continue;
        if (!holdsSecret(variable.value)) continue;
        if (!isSecretName(variable.name) && !containsSecretPattern(variable.value)) continue;

        variable.value = '';
        variable.enabled = false;
        context.record(location, variable.name, variable.name);
    }

    for (const variable of vars?.res ?? []) {
        if (typeof variable.value === 'string') variable.value = context.scan(variable.value, location);
    }
}

function redactScripts(
    script: BrunoScript | null | undefined,
    owner: { tests?: string | null },
    location: string,
    context: RedactionContext
) {
    if (script && typeof script.req === 'string') script.req = context.scan(script.req, `${location} › script`);
    if (script && typeof script.res === 'string') script.res = context.scan(script.res, `${location} › script`);
    if (typeof owner.tests === 'string') owner.tests = context.scan(owner.tests, `${location} › tests`);
}

// Variables marked secret always leave empty. Unmarked ones that look secret (by name
// or value) are emptied and marked secret too, so Bruno asks the receiver for them.
function redactEnvironment(environment: BrunoEnvironment, context: RedactionContext) {
    const location = `Environment "${environment.name}"`;

    for (const variable of environment.variables) {
        const { name, value } = variable;
        if (typeof name !== 'string' || value === undefined || value === null || value === '') continue;

        const looksSecret = typeof value === 'string' && holdsSecret(value) &&
            (isSecretName(name) || containsSecretPattern(value));
        if (variable.secret !== true && !looksSecret) continue;

        variable.value = '';
        variable.secret = true;
        context.record(location, name, name);
    }
}
