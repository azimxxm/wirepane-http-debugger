import { VpnDnsRule } from './vpn-network';

/*
 * The checks behind the DNS rules editor. They follow the sidecar's own (wirepane-tunnel/src/
 * features/dns_rules.rs), so a rule that passes here is never refused there: the same characters
 * and length limits, "*." only as the first part, and IPv4 addresses without leading zeros.
 * The sidecar answers the first rule that matches, so the order of the list matters.
 */

const MAX_NAME_LENGTH = 253;
const MAX_LABEL_LENGTH = 63;

export type DnsRuleAction = VpnDnsRule['action'];

// What the person typed into the form, before it is checked
export interface DnsRuleDraft {
    pattern: string;
    action: DnsRuleAction;
    ipv4: string;
}

export interface DnsRuleCheck {
    // Set when the draft is fine: the rule to save
    rule?: VpnDnsRule;
    patternProblem?: string;
    addressProblem?: string;
}

// The form the sidecar compares: no spaces around, no trailing dot, lower case
export function normalizeDnsPattern(raw: string): string {
    return raw.trim().replace(/\.$/, '').toLowerCase();
}

function checkLabel(label: string): string | undefined {
    if (label === '') {
        return "Remove the extra dot: a name can't start with a dot or have two dots in a row.";
    }
    if (label.length > MAX_LABEL_LENGTH) {
        return `Each part between dots has at most ${MAX_LABEL_LENGTH} characters.`;
    }

    const bad = label.match(/[^a-z0-9_-]/);
    if (!bad) return undefined;
    if (/\s/.test(bad[0])) return "A name can't have spaces in it.";
    return `"${bad[0]}" isn't allowed in a name. Use letters, digits, - and _ only.`;
}

// A message when the pattern can't be used, or undefined when it can
export function checkDnsPattern(raw: string): string | undefined {
    const pattern = normalizeDnsPattern(raw);

    if (!pattern) return 'Enter a name, like api.example.com or *.example.com.';
    if (pattern === '*') {
        return 'A lone * would match every name. Use *.example.com for the subdomains of a name.';
    }
    // Pasting a whole URL is the common slip, so it gets its own hint
    if (/[\/:]/.test(pattern)) {
        return 'Enter just the host name, like example.com: no https://, port or path.';
    }
    if (/[^\u0000-\u007f]/.test(pattern)) {
        return 'Use letters, digits, - and _ only. Write an international name in its xn-- form.';
    }
    if (pattern.length > MAX_NAME_LENGTH) {
        return `A name has at most ${MAX_NAME_LENGTH} characters.`;
    }

    const name = pattern.startsWith('*.') ? pattern.slice(2) : pattern;
    if (name.includes('*')) return 'The * can only be the first part, as in *.example.com.';

    for (const label of name.split('.')) {
        const problem = checkLabel(label);
        if (problem) return problem;
    }
    return undefined;
}

const IPV4_ADDRESS = /^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$/;

// A message when the address can't be used, or undefined when it can
export function checkDnsAddress(raw: string): string | undefined {
    const address = raw.trim();

    if (!address) return 'Enter the IPv4 address to answer with, like 192.168.0.10.';
    if (address.includes(':')) return 'Only IPv4 addresses work for now, like 192.168.0.10.';
    // The sidecar refuses 010 and the like, so the form does too
    if (/(^|\.)0\d/.test(address)) {
        return 'Leave out the leading zeros: write 10.0.0.5, not 10.0.0.05.';
    }
    if (!IPV4_ADDRESS.test(address) || address.split('.').some((part) => Number(part) > 255)) {
        return 'That is not an IPv4 address. Use four numbers from 0 to 255, like 192.168.0.10.';
    }
    return undefined;
}

// Checks the form. Gives the rule to save (the name in its normal form) or what's wrong with it.
export function checkDnsRuleDraft(draft: DnsRuleDraft, existing: readonly VpnDnsRule[]): DnsRuleCheck {
    const pattern = normalizeDnsPattern(draft.pattern);

    let patternProblem = checkDnsPattern(draft.pattern);
    if (!patternProblem && existing.some((rule) => normalizeDnsPattern(rule.pattern) === pattern)) {
        patternProblem = 'That name is already in the list. Remove its rule first to change it.';
    }
    // The address field is ignored (and may still hold text) while the rule only blocks
    const addressProblem = draft.action === 'answer' ? checkDnsAddress(draft.ipv4) : undefined;

    if (patternProblem || addressProblem) return { patternProblem, addressProblem };

    return {
        rule: draft.action === 'block'
            ? { pattern, action: 'block' }
            : { pattern, action: 'answer', ipv4: draft.ipv4.trim() }
    };
}

// Does `earlier` catch every name `later` would catch? Then `later` never fires.
export function patternCovers(earlier: string, later: string): boolean {
    const first = normalizeDnsPattern(earlier);
    const second = normalizeDnsPattern(later);
    if (first === second) return true;
    // An exact name only catches itself
    if (!first.startsWith('*.')) return false;

    const below = first.slice(2);
    const isWildcard = second.startsWith('*.');
    const name = isWildcard ? second.slice(2) : second;
    // *.example.com catches api.example.com and *.api.example.com, but not the bare example.com
    return name.endsWith(`.${below}`) || (isWildcard && name === below);
}

// The rule above this one that already matches everything it would, if there is one
export function findShadowingRule(rules: readonly VpnDnsRule[], index: number): VpnDnsRule | undefined {
    const rule = rules[index];
    if (!rule) return undefined;
    return rules.slice(0, index).find((earlier) => patternCovers(earlier.pattern, rule.pattern));
}

export function describeDnsAction(rule: VpnDnsRule): string {
    return rule.action === 'block' ? 'Block' : `Answer ${rule.ipv4}`;
}
