import type { ViewableEvent } from '../../types';
// Types only: search-filters imports this file to build these filters on its Filter class
import type { Filter, FilterClass } from './search-filters';
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
 * hostname=, app=, pending and aborted filters. These can also be typed in the filter box.
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

// Parses what has been typed so far, e.g. "status!=4" gives the operation but no class
const STATUS_CLASS_PATTERN = /^status(!=|=)?(?:([1-5])xx)?/;
const TYPE_PATTERN = /^type(!=|=)?(\w+)?/;

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
            const label = REQUEST_TYPE_LABELS[type as RequestType];

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
            this.type = type as RequestType;
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
