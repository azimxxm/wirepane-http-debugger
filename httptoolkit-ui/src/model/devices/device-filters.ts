import * as _ from 'lodash';

import type { ViewableEvent } from '../../types';
// Types only: search-filters imports this file to build these filters on its Filter class
import type { Filter, FilterClass } from '../filters/search-filters';
import type { SyntaxPart, SyntaxPartValues } from '../filters/syntax-matching';
import {
    FixedStringSyntax,
    NUMERIC,
    StringOptionsSyntax,
    StringSyntax,
    SyntaxWrapperSyntax,
    charRange
} from '../filters/syntax-parts';

import { THIS_MACHINE_TYPE, getDeviceDirectory } from './device-directory';
import {
    DeviceType,
    THIS_MACHINE_KEY,
    getClientEvent,
    getEventAddress,
    getThisMachineName,
    normalizeAddress
} from './device-model';

/**
 * Text filters for the Devices panel's data, so devices can also be typed in View's
 * filter box: device=iphone, client-ip=192.168.0.23, app=Safari. They also work inside
 * not(...) and or(...), e.g. not(device=this) hides this machine's own traffic.
 */

type FilterBaseClass = abstract new (filterString: string) => Filter;

type EqualityOperation = '=' | '!=';
type StringOperation = EqualityOperation | '*=' | '^=' | '$=';

const stringOperations: { [op in StringOperation]: (value: string, expected: string) => boolean } = {
    '=': (value, expected) => value === expected,
    '!=': (value, expected) => value !== expected,
    '*=': (value, expected) => value.includes(expected),
    '^=': (value, expected) => value.startsWith(expected),
    '$=': (value, expected) => value.endsWith(expected)
};

const operationDescriptions: { [op in StringOperation]: string } = {
    '=': 'equal to',
    '!=': 'not equal to',
    '*=': 'containing',
    '^=': 'starting with',
    '$=': 'ending with'
};

// The same as search-filters' own (private) helpers: parse a fully matching filter...
function parseFilter<SPs extends readonly SyntaxPart<any, any>[]>(
    syntax: SPs,
    value: string
): SyntaxPartValues<SPs> {
    let index = 0;
    const parts: unknown[] = [];
    for (const part of syntax) {
        parts.push(part.parse(value, index));
        index += part.match(value, index)!.consumed;
    }
    return parts as unknown as SyntaxPartValues<SPs>;
}

// ...or as much of a partly typed one as matches so far
function tryParseFilter<SPs extends readonly SyntaxPart<any, any>[]>(
    syntax: SPs,
    value: string
): Partial<SyntaxPartValues<SPs>> {
    let index = 0;
    const parts: unknown[] = [];
    for (const part of syntax) {
        const match = part.match(value, index);
        if (!match || match.type !== 'full') break;
        parts.push(part.parse(value, index));
        index += match.consumed;
    }
    return parts as unknown as Partial<SyntaxPartValues<SPs>>;
}

// --- device= ---

export const DEVICE_KEYWORDS = [
    'iphone',
    'ipad',
    'ios',
    'android',
    'mac',
    'windows',
    'linux',
    'this',
    'other'
] as const;
export type DeviceKeyword = typeof DEVICE_KEYWORDS[number];

const thisMachineName = getThisMachineName(THIS_MACHINE_TYPE);

const KEYWORD_DESCRIPTIONS: { [keyword in DeviceKeyword]: string } = {
    iphone: 'iPhones',
    ipad: 'iPads',
    ios: 'iPhones & iPads',
    android: 'Android devices',
    mac: 'Macs',
    windows: 'Windows PCs',
    linux: 'Linux machines',
    this: _.lowerFirst(thisMachineName),
    other: 'unrecognised devices'
};

const KEYWORD_LABELS: { [keyword in DeviceKeyword]: string } = {
    iphone: 'iPhone',
    ipad: 'iPad',
    ios: 'iOS',
    android: 'Android',
    mac: 'Mac',
    windows: 'Windows',
    linux: 'Linux',
    this: thisMachineName,
    other: 'Other'
};

export function deviceMatchesKeyword(
    keyword: DeviceKeyword,
    device: { key: string, type: DeviceType }
): boolean {
    switch (keyword) {
        case 'this':
            return device.key === THIS_MACHINE_KEY;
        case 'ios':
            return device.type === 'iphone' || device.type === 'ipad' || device.type === 'ios';
        case 'iphone':
        case 'ipad':
            // Apps on iOS don't say which of the two they're on
            return device.type === keyword || device.type === 'ios';
        default:
            return device.type === keyword;
    }
}

// The client IP of an event, if it has one (requests from the Send page don't)
function getClientAddress(event: ViewableEvent): string | undefined {
    const address = getEventAddress(getClientEvent(event));
    return address === THIS_MACHINE_KEY ? undefined : address;
}

// --- Suggestions from the captured traffic ---

const getAddressSuggestions = (events: ViewableEvent[]) =>
    _(events)
        .map((event) => getClientAddress(event))
        .uniq()
        .filter((address): address is string => !!address)
        .valueOf();

// The apps as the Devices panel names them, so an SDK's requests count under their app
const getEventAppName = (event: ViewableEvent) => getDeviceDirectory().getEventAppName(event);

const getAppSuggestions = (events: ViewableEvent[]) =>
    _(events)
        .map((event) => getEventAppName(event))
        .uniq()
        .filter((name): name is string => !!name)
        .valueOf();

/**
 * Builds the filter classes on search-filters' Filter base class, which can't be
 * imported here directly without an import cycle.
 */
export function buildDeviceFilterClasses(FilterBase: FilterBaseClass): FilterClass[] {

    class DeviceFilter extends FilterBase {

        static filterSyntax = [
            new FixedStringSyntax('device'),
            new StringOptionsSyntax<EqualityOperation>(['=', '!=']),
            new StringOptionsSyntax<DeviceKeyword>(DEVICE_KEYWORDS)
        ] as const;

        static filterName = 'device';

        static filterDescription(value: string) {
            const [, op, keyword] = tryParseFilter(DeviceFilter.filterSyntax, value);

            if (!op) {
                return 'requests from a given type of device';
            } else if (!keyword) {
                return `requests ${op === '=' ? 'from' : 'not from'} a given type of device`;
            } else {
                return `requests ${op === '=' ? 'from' : 'not from'} ${KEYWORD_DESCRIPTIONS[keyword]}`;
            }
        }

        private op: EqualityOperation;
        private keyword: DeviceKeyword;

        constructor(filter: string) {
            super(filter);
            [, this.op, this.keyword] = parseFilter(DeviceFilter.filterSyntax, filter);
        }

        matches(event: ViewableEvent): boolean {
            const device = getDeviceDirectory().getEventDevice(event);
            if (!device) return false;

            const isMatch = deviceMatchesKeyword(this.keyword, device);
            return this.op === '=' ? isMatch : !isMatch;
        }

        toString() {
            return `Device ${this.op} ${KEYWORD_LABELS[this.keyword]}`;
        }
    }

    class ClientIpFilter extends FilterBase {

        static filterSyntax = [
            new FixedStringSyntax('client-ip'),
            new StringOptionsSyntax<StringOperation>(['=', '!=', '^=', '*=', '$=']),
            new StringSyntax('IP address', {
                // IPv4 & IPv6
                allowedChars: [NUMERIC, charRange('a', 'f'), charRange('A', 'F'), charRange('.'), charRange(':')],
                suggestionGenerator: (_value, _index, events: ViewableEvent[]) => getAddressSuggestions(events)
            })
        ] as const;

        static filterName = 'client-ip';

        static filterDescription(value: string) {
            const [, op, address] = tryParseFilter(ClientIpFilter.filterSyntax, value);

            if (!op || (!address && op === '=')) {
                return 'requests sent from a given IP address';
            } else if (op === '=') {
                return `requests from ${address}`;
            } else if (op === '!=') {
                return `requests not from ${address || 'a given IP address'}`;
            } else {
                return `requests from any IP address ${operationDescriptions[op]} ${address || 'a given value'}`;
            }
        }

        private op: StringOperation;
        private expectedAddress: string;
        private predicate: (address: string, expected: string) => boolean;

        constructor(filter: string) {
            super(filter);
            const [, op, address] = parseFilter(ClientIpFilter.filterSyntax, filter);
            this.op = op;
            this.predicate = stringOperations[op];
            // Whole addresses are compared normalised, so ::ffff:10.0.0.2 matches 10.0.0.2
            this.expectedAddress = op === '=' || op === '!='
                ? normalizeAddress(address)!.toLowerCase()
                : address.toLowerCase();
        }

        matches(event: ViewableEvent): boolean {
            const address = getClientAddress(event);
            if (!address) return false;
            return this.predicate(address.toLowerCase(), this.expectedAddress);
        }

        toString() {
            return `Client IP ${this.op} ${this.expectedAddress}`;
        }
    }

    class AppFilter extends FilterBase {

        static filterSyntax = [
            new FixedStringSyntax('app'),
            new StringOptionsSyntax<StringOperation>(['=', '!=', '*=', '^=', '$=']),
            new SyntaxWrapperSyntax(
                ['[', ']'],
                new StringSyntax('app name', {
                    allowedChars: [[0, Infinity]], // Any name: the wrapper stops it at spaces or ]
                    suggestionGenerator: (_value, _index, events: ViewableEvent[]) => getAppSuggestions(events)
                }),
                // [] are only needed (& suggested) for names with spaces
                { optional: true }
            )
        ] as const;

        static filterName = 'app';

        static filterDescription(value: string) {
            const [, op, appName] = tryParseFilter(AppFilter.filterSyntax, value);

            if (!op || (!appName && op === '=')) {
                return 'requests sent by a given app';
            } else if (op === '=') {
                return `requests sent by ${appName}`;
            } else if (op === '!=') {
                return `requests not sent by ${appName || 'a given app'}`;
            } else {
                return `requests sent by any app ${operationDescriptions[op]} ${appName || 'a given value'}`;
            }
        }

        private op: StringOperation;
        private appName: string;
        private predicate: (name: string, expected: string) => boolean;

        constructor(filter: string) {
            super(filter);
            const [, op, appName] = parseFilter(AppFilter.filterSyntax, filter);
            this.op = op;
            this.appName = appName;
            this.predicate = stringOperations[op];
        }

        matches(event: ViewableEvent): boolean {
            const appName = getEventAppName(event);
            if (!appName) return false;
            return this.predicate(appName.toLowerCase(), this.appName.toLowerCase());
        }

        toString() {
            return `App ${this.op} ${this.appName}`;
        }
    }

    return [DeviceFilter, ClientIpFilter, AppFilter];
}
