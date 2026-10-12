/**
 * The command palette's type-to-filter: fuzzy matching & ranking, grouped by section.
 * Every word typed has to match the command's label, keywords, section or description,
 * either as a whole ("proxy") or letter by letter from the start of a word ("prxy").
 */

export interface SearchableCommand {
    readonly label: string;
    readonly section: string;
    readonly description?: string;
    readonly keywords?: readonly string[];
}

export interface CommandMatch<T> {
    readonly command: T;
    readonly score: number;
    // Positions of the label's matched characters, to highlight them:
    readonly labelMatches: readonly number[];
}

export interface CommandGroup<T> {
    readonly section: string;
    readonly matches: readonly CommandMatch<T>[];
}

interface FieldMatch {
    score: number;
    indices: number[];
}

// A label match counts most, then keywords, then the section & description:
const LABEL_WEIGHT = 1;
const KEYWORD_WEIGHT = 0.8;
const SECTION_WEIGHT = 0.6;
const DESCRIPTION_WEIGHT = 0.5;

const WHOLE_WORD_SCORE = 100;
const WORD_START_BONUS = 40;
const TEXT_START_BONUS = 20;
const LETTER_SCORE = 1;
const LETTER_AT_WORD_START_BONUS = 8;
const LETTER_IN_A_RUN_BONUS = 5;

const isLetterOrDigit = (char: string) =>
    char.toLowerCase() !== char.toUpperCase() || /[0-9]/.test(char);

// Word starts: the beginning, after a space or punctuation, and camel humps (the P in iPhone)
function isWordStart(text: string, index: number): boolean {
    if (index === 0) return true;
    const previous = text[index - 1];
    const current = text[index];
    if (!isLetterOrDigit(previous)) return true;
    return previous === previous.toLowerCase() && current !== current.toLowerCase();
}

const range = (start: number, end: number) =>
    Array.from({ length: end - start }, (_v, i) => start + i);

// The token as a whole, preferring the start of a word:
function matchWhole(token: string, text: string, lowerText: string): FieldMatch | undefined {
    let best: FieldMatch | undefined;

    for (let index = lowerText.indexOf(token); index !== -1; index = lowerText.indexOf(token, index + 1)) {
        const score = WHOLE_WORD_SCORE
            + (isWordStart(text, index) ? WORD_START_BONUS : 0)
            + (index === 0 ? TEXT_START_BONUS : 0)
            - index * 0.1;

        if (!best || score > best.score) best = { score, indices: range(index, index + token.length) };
    }

    return best;
}

// Whether a word starts anywhere after `from`, up to & including `to`:
function startsNewWord(text: string, from: number, to: number): boolean {
    for (let i = from + 1; i <= to; i++) {
        if (isWordStart(text, i)) return true;
    }
    return false;
}

// The token's letters in order, starting at the start of a word: "gts" for "Go to Send", or
// "prxy" for "proxy". Each next letter carries on the same word or starts a new one, so the
// letters of "har" don't match an H, an a & an r from three unrelated words.
function matchLetters(token: string, text: string, lowerText: string): FieldMatch | undefined {
    let best: FieldMatch | undefined;

    for (let start = lowerText.indexOf(token[0]); start !== -1; start = lowerText.indexOf(token[0], start + 1)) {
        if (!isWordStart(text, start)) continue;

        const indices = [start];
        let score = LETTER_SCORE + LETTER_AT_WORD_START_BONUS;

        for (let i = start + 1; i < lowerText.length && indices.length < token.length; i++) {
            if (lowerText[i] !== token[indices.length]) continue;

            const previous = indices[indices.length - 1];
            const atWordStart = isWordStart(text, i);
            if (!atWordStart && startsNewWord(text, previous, i)) continue;

            score += LETTER_SCORE
                + (atWordStart ? LETTER_AT_WORD_START_BONUS : 0)
                + (previous === i - 1 ? LETTER_IN_A_RUN_BONUS : 0);
            indices.push(i);
        }

        if (indices.length < token.length) continue;

        // Letters spread far apart are a weaker match:
        const gaps = indices[indices.length - 1] - start + 1 - indices.length;
        const total = score - gaps * 0.5;
        if (total > 0 && (!best || total > best.score)) best = { score: total, indices };
    }

    return best;
}

function matchField(token: string, text: string | undefined): FieldMatch | undefined {
    if (!text) return undefined;
    const lowerText = text.toLowerCase();
    return matchWhole(token, text, lowerText) ?? matchLetters(token, text, lowerText);
}

const tokenize = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);

/**
 * Matches one command against a query. Returns undefined if any word doesn't match.
 */
export function matchCommand<T extends SearchableCommand>(command: T, query: string): CommandMatch<T> | undefined {
    const tokens = tokenize(query);
    if (tokens.length === 0) return { command, score: 0, labelMatches: [] };

    let score = 0;
    const labelMatches = new Set<number>();

    for (const token of tokens) {
        const labelMatch = matchField(token, command.label);
        const otherScores = [
            ...(command.keywords ?? []).map((keyword) => (matchField(token, keyword)?.score ?? 0) * KEYWORD_WEIGHT),
            (matchField(token, command.section)?.score ?? 0) * SECTION_WEIGHT,
            (matchField(token, command.description)?.score ?? 0) * DESCRIPTION_WEIGHT
        ];
        const bestOther = Math.max(...otherScores);
        const labelScore = (labelMatch?.score ?? 0) * LABEL_WEIGHT;

        if (labelScore === 0 && bestOther === 0) return undefined;

        if (labelMatch && labelScore >= bestOther) {
            labelMatch.indices.forEach((index) => labelMatches.add(index));
        }
        score += Math.max(labelScore, bestOther);
    }

    return {
        command,
        score,
        labelMatches: Array.from(labelMatches).sort((a, b) => a - b)
    };
}

/**
 * Filters & ranks commands for a query, in sections. With no query, every command shows in
 * its usual order. Otherwise the best match comes first: sections are ordered by their best
 * match, and commands within them by score.
 */
export function searchCommands<T extends SearchableCommand>(
    commands: readonly T[],
    query: string,
    sectionOrder: readonly string[]
): CommandGroup<T>[] {
    const hasQuery = tokenize(query).length > 0;
    const sectionIndex = (section: string) => {
        const index = sectionOrder.indexOf(section);
        return index === -1 ? sectionOrder.length : index;
    };

    const bySection = new Map<string, Array<CommandMatch<T> & { order: number }>>();
    commands.forEach((command, order) => {
        const match = matchCommand(command, query);
        if (!match) return;

        const matches = bySection.get(command.section) ?? [];
        matches.push({ ...match, order });
        bySection.set(command.section, matches);
    });

    const groups = Array.from(bySection.entries()).map(([section, matches]) => ({
        section,
        matches: hasQuery
            ? matches.slice().sort((a, b) => (b.score - a.score) || (a.order - b.order))
            : matches,
        best: Math.max(...matches.map((match) => match.score))
    }));

    groups.sort((a, b) => hasQuery
        ? (b.best - a.best) || (sectionIndex(a.section) - sectionIndex(b.section))
        : sectionIndex(a.section) - sectionIndex(b.section)
    );

    return groups.map(({ section, matches }) => ({
        section,
        matches: matches.map(({ command, score, labelMatches }) => ({ command, score, labelMatches }))
    }));
}
