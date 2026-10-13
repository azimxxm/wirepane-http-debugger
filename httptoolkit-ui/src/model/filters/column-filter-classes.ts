import * as _ from 'lodash';

import type { ViewableEvent } from '../../types';
// Types only: search-filters imports this file to build these filters on its Filter class
import type { Filter, FilterClass } from './search-filters';
import type { SyntaxPart, SyntaxPartMatch, SyntaxSuggestion } from './syntax-matching';
import { FixedStringSyntax, StringOptionsSyntax } from './syntax-parts';

import {
    REQUEST_TYPE_LABELS,
    RequestType,
    RequestTypes,
    getRequestType
} from '../events/request-type';

/**
 * Wirepane: the filters behind View's column header menus that the normal filter set
 * can't say yet: status=4xx (a whole class of status codes) and type=image (the Type
 * column's categories). The rest of the menus use the existing method=, status>=,
 * hostname=, app=, pending and aborted filters. Both are in the filter box's suggestions
 * too (search-filters adds them to its list).
 */

type FilterBaseClass = abstract new (filterString: string) => Filter;

type EqualityOperation = '=' | '!=';

export const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;
export type StatusClass = typeof STATUS_CLASSES[number];

const STATUS_CLASS_NAMES: { [statusClass in StatusClass]: string } = {
    '1xx': 'informational (1xx)',
    '2xx': 'successful (2xx)',
    '3xx': 'redirect (3xx)',
    '4xx': 'client error (4xx)',
    '5xx': 'server error (5xx)'
};

// Parses what has been typed so far, e.g. "status!=4" gives the operation but no class.
// Case doesn't matter, as in the rest of the filter syntax.
const STATUS_CLASS_PATTERN = /^status(!=|=)?(?:([1-5])xx)?/i;
const TYPE_PATTERN = /^type(!=|=)?(\w+)?/i;

export function buildColumnFilterClasses(FilterBase: FilterBaseClass): FilterClass[] {

    class StatusClassFilter extends FilterBase {

        static filterSyntax = [
            new FixedStringSyntax('status'),
            new StringOptionsSyntax<EqualityOperation>(['=', '!=']),
            new StringOptionsSyntax<StatusClass>(STATUS_CLASSES)
        ] as const;

        static filterName = 'status-class';

        static filterDescription(value: string) {
            const [, op, hundreds] = STATUS_CLASS_PATTERN.exec(value) ?? [];

            if (!op || !hundreds) {
                return 'responses with a status in a given class, like 4xx';
            }

            const statusClass = `${hundreds}xx` as StatusClass;
            return op === '='
                ? `${STATUS_CLASS_NAMES[statusClass]} responses`
                : `responses that are not ${STATUS_CLASS_NAMES[statusClass]}`;
        }

        private op: EqualityOperation;
        private hundreds: number;

        constructor(filter: string) {
            super(filter);
            const [, op, hundreds] = STATUS_CLASS_PATTERN.exec(filter)!;
            this.op = op as EqualityOperation;
            this.hundreds = Number(hundreds);
        }

        matches(event: ViewableEvent): boolean {
            if (!event.isHttp() || !event.isSuccessfulExchange()) return false;

            const isMatch = Math.floor(event.response.statusCode / 100) === this.hundreds;
            return this.op === '=' ? isMatch : !isMatch;
        }

        toString() {
            return `Status ${this.op} ${this.hundreds}xx`;
        }
    }

    class TypeFilter extends FilterBase {

        static filterSyntax = [
            new FixedStringSyntax('type'),
            new StringOptionsSyntax<EqualityOperation>(['=', '!=']),
            new StringOptionsSyntax<RequestType>(RequestTypes)
        ] as const;

        static filterName = 'type';

        static filterDescription(value: string) {
            const [, op, type] = TYPE_PATTERN.exec(value) ?? [];
            const label = REQUEST_TYPE_LABELS[type?.toLowerCase() as RequestType];

            if (!op || !label) {
                return 'requests of a given type, like image or fetch/XHR';
            }

            return op === '='
                ? `${label} requests, as the Type column shows them`
                : `all requests except ${label}`;
        }

        private op: EqualityOperation;
        private type: RequestType;

        constructor(filter: string) {
            super(filter);
            const [, op, type] = TYPE_PATTERN.exec(filter)!;
            this.op = op as EqualityOperation;
            this.type = type.toLowerCase() as RequestType;
        }

        matches(event: ViewableEvent): boolean {
            const isMatch = getRequestType(event) === this.type;
            return this.op === '=' ? isMatch : !isMatch;
        }

        toString() {
            return `Type ${this.op} ${REQUEST_TYPE_LABELS[this.type]}`;
        }
    }

    return [StatusClassFilter, TypeFilter];
}

// What can follow "status=": a status code, or a class of them. A class only means
// something with = and !=, not with >= and the like.
const CLASS_ALLOWED_AFTER = /status(?:!=|=)$/i;

class StatusValueSyntax implements SyntaxPart<number | StatusClass, any> {

    private classes = new StringOptionsSyntax<StatusClass>(STATUS_CLASSES);

    constructor(private codes: SyntaxPart<number, any>) {}

    private getParts(value: string, index: number): Array<SyntaxPart<number | StatusClass, any>> {
        return CLASS_ALLOWED_AFTER.test(value.slice(0, index))
            ? [this.codes, this.classes]
            : [this.codes];
    }

    match(value: string, index: number): SyntaxPartMatch | undefined {
        const matches = this.getParts(value, index)
            .map((part) => part.match(value, index))
            .filter((match): match is SyntaxPartMatch => !!match);

        // As OptionsSyntax does: a full match is best, then the longest
        const full = matches.filter((match) => match.type === 'full');
        return (full.length ? full : matches).reduce<SyntaxPartMatch | undefined>(
            (best, match) => !best || match.consumed > best.consumed ? match : best,
            undefined
        );
    }

    getSuggestions(value: string, index: number, context?: any): SyntaxSuggestion[] {
        return _.flatMap(this.getParts(value, index), (part) => {
            const match = part.match(value, index);
            // Only the parts that fit all of the text: "4x" is no start of a number
            return match && index + match.consumed === value.length
                ? part.getSuggestions(value, index, context)
                : [];
        });
    }

    parse(value: string, index: number): number | StatusClass {
        const part = this.getParts(value, index)
            .find((candidate) => candidate.match(value, index)?.type === 'full');
        if (!part) throw new Error(`Not a status or status class at ${index} of "${value}"`);
        return part.parse(value, index);
    }
}

const isStatusClassInput = (input: string) => /^status(?:!=|=)[1-5]x/i.test(input);

/**
 * One status filter for the filter box that takes both status=404 (and status>=400 and the
 * rest) and status=4xx. They share the name "status", so the suggestions list it once,
 * and the operators and the numbers are suggested exactly as before. Typing "status=" adds
 * the classes (1xx to 5xx) next to the number.
 */
export function addStatusClasses(
    StatusCodeFilter: FilterClass,
    StatusClassFilter: FilterClass
): FilterClass {
    const [name, operators, codes] = StatusCodeFilter.filterSyntax;

    // Each input makes the filter that fits it, which is what custom filters do too
    const factory = (function (input: string) {
        return isStatusClassInput(input)
            ? new StatusClassFilter(input)
            : new StatusCodeFilter(input);
    }) as unknown as new (input: string) => Filter;

    return Object.assign(factory, {
        filterSyntax: [name, operators, new StatusValueSyntax(codes)] as const,
        filterName: StatusCodeFilter.filterName,
        filterDescription: (input: string, isTemplate: boolean) =>
            (isStatusClassInput(input) ? StatusClassFilter : StatusCodeFilter)
                .filterDescription(input, isTemplate)
    });
}
