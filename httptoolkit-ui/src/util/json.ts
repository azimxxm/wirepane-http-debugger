import {
    createScanner as createJsonScanner,
    SyntaxKind as JsonSyntaxKind
} from 'jsonc-parser';

const JSON_START_REGEX = /^\s*[\[\{tfn"\d-]/; // Optional whitespace, then start array/object/true/false/null/string/number

const JSON_TEXT_SEQ_START_REGEX = /^\u001E\s*[\[\{]/; // Record separate, optional whitespace, then array/object

const SIGNALR_HUB_START_REGEX = /^\s*\{/; // Optional whitespace, then start object
const SIGNALR_HUB_END_REGEX = /\}\s*\u001E$/; // End object, optional whitespace, then record separator

const JSON_LINES_END_REGEX = /[\]\}](\r?\n)+$/; // Array/object end, then optional newline(s)
const JSON_LINES_INNER_REGEX = /[\]\}](\r?\n)+[\{\[]/; // Object/array end, then newline(s), then start object/array
const JSON_LINES_SCAN_LIMIT = 16 * 1024;

export const isProbablyJson = (text: Buffer | undefined) => {
    if (!text || text.length < 2) return false;

    const startChunk = text.subarray(0, 6).toString('utf8');
    return JSON_START_REGEX.test(startChunk);
}

export const isProbablyJsonRecords = (text: Buffer | undefined) => {
    if (!text || text.length < 3) return false;

    // This has some false negatives: e.g. standalone JSON primitive values, or unusual
    // extra whitespace in certain places, but I think it should provide pretty good coverage
    // the rest of the time.

    const startChunk = text.subarray(0, 6).toString('utf8');
    const endChunk = text.subarray(-6).toString('utf8');

    if (JSON_TEXT_SEQ_START_REGEX.test(startChunk)) {
        // JSON text sequence: https://www.rfc-editor.org/rfc/rfc7464.html
        return true;
    }

    if (SIGNALR_HUB_START_REGEX.test(startChunk) && SIGNALR_HUB_END_REGEX.test(endChunk)) {
        // SignalR hub protocol:
        // https://github.com/dotnet/aspnetcore/blob/v9.0.8/src/SignalR/docs/specs/HubProtocol.md
        return true;
    }

    if (
        JSON_START_REGEX.test(startChunk) &&
        // Technically for JSON Lines the end newline is optional, but strongly recommended & common AFAICT
        JSON_LINES_END_REGEX.test(endChunk) &&
        // If the end looks like JSON lines/NDJSON, so scan a bigger chunk to check:
        JSON_LINES_INNER_REGEX.test(text.subarray(0, JSON_LINES_SCAN_LIMIT).toString('utf8'))
    ) {
        // JSON Lines or NDJSON: https://jsonlines.org/
        return true;
    }

    return false;
}

export const RECORD_SEPARATOR_CHARS = [
    '\u001E', // ASCII Record Separator (used by SignalR and others)
    '\n',
    '\r'
];

// A *very* forgiving & flexible JSON formatter. This will correctly format even things that
// will fail validation later, such as trailing commas, unquoted keys, comments, etc.
export function formatJson(text: string, options: { formatRecords: boolean } = { formatRecords: false }): string {
    const scanner = createJsonScanner(text);

    let result = "";
    let indent = 0;
    let token: JsonSyntaxKind;

    const indentString = '  ';
    let needsIndent = false;
    let previousToken: JsonSyntaxKind | null = null;

    let betweenRecords = false;

    while ((token = scanner.scan()) !== JsonSyntaxKind.EOF) {
        const tokenOffset = scanner.getTokenOffset();
        const tokenLength = scanner.getTokenLength();
        let tokenText = text.slice(tokenOffset, tokenOffset + tokenLength);

        // wirepane: the JSON scanner has no single-quoted strings, so it would split 'a:b, c'
        // at the colon and comma, and we'd add spaces and line breaks inside the value.
        if (token === JsonSyntaxKind.Unknown && tokenText[0] === "'") {
            const stringEnd = findSingleQuotedStringEnd(text, tokenOffset);
            tokenText = text.slice(tokenOffset, stringEnd);
            scanner.setPosition(stringEnd);
            token = JsonSyntaxKind.StringLiteral;
        }

        if (options.formatRecords && indent === 0) {
            betweenRecords = true;
        }

        // Skip over explicit 'record separator' characters, which can cause parsing problems
        // when parsing JSON records:
        if (betweenRecords && tokenText[0] === '\u001E') {
            scanner.setPosition(tokenOffset + 1);
            continue;
        }

        // Ignore irrelevant whitespace (internally or between records) - we'll handle that ourselves
        if (token === JsonSyntaxKind.Trivia || token === JsonSyntaxKind.LineBreakTrivia) {
            continue;
        }

        if (betweenRecords) {
            // We've finished one record and we have another coming that won't get a newline
            // automatically: add an extra newline to properly separate records if required.
            betweenRecords = false;
            if (result && result[result.length - 1] !== '\n' && !isValueToken(token)) {
                result += '\n';
            }
        }

        if (needsIndent) {
            result += indentString.repeat(indent);
            needsIndent = false;
        }

        switch (token) {
            case JsonSyntaxKind.OpenBraceToken:
            case JsonSyntaxKind.OpenBracketToken:
                result += tokenText;
                indent++;

                const afterOpener = scanAhead(scanner);
                const isClosing = afterOpener === JsonSyntaxKind.CloseBraceToken ||
                                 afterOpener === JsonSyntaxKind.CloseBracketToken;
                if (
                    !isClosing &&
                    afterOpener !== JsonSyntaxKind.EOF &&
                    afterOpener !== JsonSyntaxKind.LineCommentTrivia
                ) {
                    result += '\n';
                    needsIndent = true;
                }
                break;

            case JsonSyntaxKind.CloseBraceToken:
            case JsonSyntaxKind.CloseBracketToken:
                const wasEmpty = previousToken === JsonSyntaxKind.OpenBraceToken ||
                                previousToken === JsonSyntaxKind.OpenBracketToken;

                let indentUnderflow = indent === 0;
                indent = Math.max(0, indent - 1);

                if (!wasEmpty) {
                    if (!result.endsWith('\n')) {
                        result += '\n';
                    }
                    result += indentString.repeat(indent);
                }

                result += tokenText;
                if (indentUnderflow) result += '\n';

                break;

            case JsonSyntaxKind.CommaToken:
                result += tokenText;

                const afterComma = scanAhead(scanner);
                if (
                    afterComma !== JsonSyntaxKind.LineCommentTrivia &&
                    afterComma !== JsonSyntaxKind.BlockCommentTrivia &&
                    afterComma !== JsonSyntaxKind.CloseBraceToken &&
                    afterComma !== JsonSyntaxKind.CloseBracketToken &&
                    afterComma !== JsonSyntaxKind.EOF &&
                    afterComma !== JsonSyntaxKind.CommaToken
                ) {
                    result += '\n';
                    needsIndent = true;
                }
                break;

            case JsonSyntaxKind.ColonToken:
                result += tokenText;
                result += ' ';
                break;

            case JsonSyntaxKind.LineCommentTrivia:
                const needsNewlineBefore = (
                    previousToken === JsonSyntaxKind.OpenBraceToken ||
                    previousToken === JsonSyntaxKind.OpenBracketToken
                ) && !result.endsWith('\n');

                if (needsNewlineBefore) {
                    result += '\n';
                    needsIndent = true;
                }

                if (needsIndent) {
                    result += indentString.repeat(indent);
                    needsIndent = false;
                    result += tokenText;
                } else {
                    const trimmedResult = result.trimEnd();
                    if (result.length > trimmedResult.length) {
                        result = trimmedResult + tokenText;
                    } else {
                        result += ' ' + tokenText;
                    }
                }

                const afterComment = scanAhead(scanner);
                if (
                    afterComment !== JsonSyntaxKind.CloseBraceToken &&
                    afterComment !== JsonSyntaxKind.CloseBracketToken &&
                    afterComment !== JsonSyntaxKind.EOF
                ) {
                    result += '\n';
                    needsIndent = true;
                }
                break;

            case JsonSyntaxKind.BlockCommentTrivia:
                const prevChar = result[result.length - 1];
                if (prevChar === '\n' || (prevChar === ' ' && result[result.length - 2] === '\n')) {
                    result += tokenText;
                } else {
                    result += ' ' + tokenText;
                }

                const afterBlock = scanAhead(scanner);
                if (
                    afterBlock !== JsonSyntaxKind.CommaToken &&
                    afterBlock !== JsonSyntaxKind.CloseBraceToken &&
                    afterBlock !== JsonSyntaxKind.CloseBracketToken &&
                    afterBlock !== JsonSyntaxKind.EOF
                ) {
                    result += '\n';
                    needsIndent = true;
                }
                break;

            default:
                const followsValue = isValueToken(previousToken);
                if (followsValue && isValueToken(token) && !result.endsWith('\n')) {
                    // Missing comma detected between sequential values,
                    // so add a newline for readability
                    result += '\n';
                    result += indentString.repeat(indent);
                }

                result += tokenText;
                break;
        }

        previousToken = token;
    }

    return result;
}

function isValueToken(token: JsonSyntaxKind | null): boolean {
    return token === JsonSyntaxKind.StringLiteral ||
           token === JsonSyntaxKind.NumericLiteral ||
           token === JsonSyntaxKind.TrueKeyword ||
           token === JsonSyntaxKind.FalseKeyword ||
           token === JsonSyntaxKind.NullKeyword ||
           token === JsonSyntaxKind.CloseBraceToken ||
           token === JsonSyntaxKind.CloseBracketToken;
}

// wirepane: returns the offset just after the closing quote of the single-quoted string
// starting at `start`. Unclosed strings stop at the end of the line, like in JavaScript.
function findSingleQuotedStringEnd(text: string, start: number): number {
    for (let i = start + 1; i < text.length; i++) {
        const char = text[i];
        if (char === '\\') i++; // Skip the escaped character, which may be a quote
        else if (char === "'") return i + 1;
        else if (char === '\n' || char === '\r') return i;
    }
    return text.length;
}

const IDENTIFIER_REGEX = /^[A-Za-z_$][\w$]*$/;

// Not JSON, but what Python's json.dumps and JavaScript objects write for these numbers
const JS_VALUE_REGEX = /^(NaN|Infinity|undefined)$/;

// How much of a body we read to guess its JSON syntax, when we only need a guess:
const JSON_SYNTAX_SNIFF_LIMIT = 16 * 1024;

export type JsonSyntax =
    | 'json' // Only JSON tokens, though maybe broken: cut off, comments, missing commas...
    | 'relaxed-json' // JavaScript object style: unquoted keys or single-quoted strings
    | 'not-json';

// wirepane: formatJson only moves whitespace around tokens. That's safe for JSON, even broken
// or cut-off JSON, but other text gets changed: '404 page not found' became '404pagenotfound'
// and '12:00:00' became '12: 0\n0: 0\n0'. This checks that the text really is made of JSON
// values (allowing unquoted keys and single quotes), so anything else can be shown as sent.
// The end of the text may be missing, so a body cut down to a prefix gives the same answer.
export function getJsonSyntax(text: string): JsonSyntax {
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1); // A byte order mark isn't content
    const scanner = createJsonScanner(text);

    let relaxed = false;
    let depth = 0;
    let topLevelValueDone = false;
    let expectColon = false;
    let separated = true; // Whitespace or a comment since the previous token?
    let previous: 'start' | 'open' | 'close' | 'comma' | 'colon' | 'key' | 'string' | 'value' = 'start';

    let token: JsonSyntaxKind;
    while ((token = scanner.scan()) !== JsonSyntaxKind.EOF) {
        if (
            token === JsonSyntaxKind.Trivia ||
            token === JsonSyntaxKind.LineBreakTrivia ||
            token === JsonSyntaxKind.LineCommentTrivia ||
            token === JsonSyntaxKind.BlockCommentTrivia
        ) {
            separated = true;
            continue;
        }

        // Only one value per body, and an unquoted key must be followed by its colon:
        if (topLevelValueDone) return 'not-json';
        if (expectColon && token !== JsonSyntaxKind.ColonToken) return 'not-json';

        const tokenOffset = scanner.getTokenOffset();
        const tokenText = text.slice(tokenOffset, tokenOffset + scanner.getTokenLength());

        if (token === JsonSyntaxKind.Unknown && tokenText[0] === "'") {
            scanner.setPosition(findSingleQuotedStringEnd(text, tokenOffset));
            token = JsonSyntaxKind.StringLiteral;
            relaxed = true;
        }

        const isTouchingValue = !separated &&
            (previous === 'string' || previous === 'value' || previous === 'key');

        switch (token) {
            case JsonSyntaxKind.OpenBraceToken:
            case JsonSyntaxKind.OpenBracketToken:
                if (isTouchingValue) return 'not-json';
                depth++;
                previous = 'open';
                break;
            case JsonSyntaxKind.CloseBraceToken:
            case JsonSyntaxKind.CloseBracketToken:
                if (depth === 0) return 'not-json';
                depth--;
                if (depth === 0) topLevelValueDone = true;
                previous = 'close';
                break;
            case JsonSyntaxKind.CommaToken:
                if (depth === 0) return 'not-json';
                previous = 'comma';
                break;
            case JsonSyntaxKind.ColonToken:
                // Keys are strings or (relaxed) identifiers, so 12:30 isn't a key and value
                if (depth === 0 || (previous !== 'string' && previous !== 'key')) return 'not-json';
                expectColon = false;
                previous = 'colon';
                break;
            case JsonSyntaxKind.StringLiteral:
            case JsonSyntaxKind.NumericLiteral:
            case JsonSyntaxKind.TrueKeyword:
            case JsonSyntaxKind.FalseKeyword:
            case JsonSyntaxKind.NullKeyword:
                // Touching values are one word split in two, like the 0s of 00 or 2026-07
                if (isTouchingValue) return 'not-json';
                if (depth === 0) topLevelValueDone = true;
                previous = token === JsonSyntaxKind.StringLiteral ? 'string' : 'value';
                break;
            default: // Unknown: unquoted keys (right after { or a comma) or NaN-like values
                if (!IDENTIFIER_REGEX.test(tokenText)) return 'not-json';
                relaxed = true;
                if (previous === 'colon' && JS_VALUE_REGEX.test(tokenText)) {
                    previous = 'value';
                } else if (previous === 'open' || previous === 'comma') {
                    expectColon = true;
                    previous = 'key';
                } else {
                    return 'not-json';
                }
        }

        separated = false;
    }

    return relaxed ? 'relaxed-json' : 'json';
}

// wirepane: a quick guess from the start of a body, for picking views and editor modes
export function sniffJsonSyntax(content: Buffer): JsonSyntax {
    let text = content.subarray(0, JSON_SYNTAX_SNIFF_LIMIT).toString('utf8');
    if (content.byteLength > JSON_SYNTAX_SNIFF_LIMIT) {
        // Drop the last token, as the cut may have split it (e.g. 'tru' from 'true')
        const lastBreak = text.search(/[\s,:{\[][^\s,:{\[]*$/);
        if (lastBreak !== -1) text = text.slice(0, lastBreak);
    }
    return getJsonSyntax(text);
}

function scanAhead(scanner: any): JsonSyntaxKind {
    const savedPosition = scanner.getPosition();

    let nextToken = scanner.scan();
    while (nextToken === JsonSyntaxKind.Trivia ||
           nextToken === JsonSyntaxKind.LineBreakTrivia) {
        nextToken = scanner.scan();
    }

    scanner.setPosition(savedPosition);
    return nextToken;
}
