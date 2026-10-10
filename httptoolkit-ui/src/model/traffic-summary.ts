import { TrafficSource, MANUALLY_SENT_SOURCE } from './http/sources';
import {
    HtkRuleItem,
    HtkRuleRoot,
    isRuleGroup,
    flattenRules
} from './rules/rules-structure';

// The id of the built-in rules group (see buildDefaultGroupWrapper in rule-creation)
export const DEFAULT_RULE_GROUP_ID = 'default-group';

// Compared by value: the events list stores observable copies of each source.
const isManuallySent = (source: TrafficSource) =>
    source.summary === MANUALLY_SENT_SOURCE.summary &&
    source.description === MANUALLY_SENT_SOURCE.description;

// The clients that sent traffic through the proxy. Requests made from the Send
// page show up as a source too, but they aren't a connected client.
export function getConnectedClients(
    activeSources: ReadonlyArray<TrafficSource>
): TrafficSource[] {
    return activeSources.filter((source) => !isManuallySent(source));
}

// The rules & groups the user added, i.e. everything outside the built-in default group.
export function getUserRuleItems(rules: HtkRuleRoot): HtkRuleItem[] {
    return rules.items.filter((item) => item.id !== DEFAULT_RULE_GROUP_ID);
}

// How many of the user's own rules are switched on.
export function countActiveUserRules(rules: HtkRuleRoot): number {
    return getUserRuleItems(rules).reduce((count, item) => {
        const itemRules = isRuleGroup(item) ? flattenRules(item) : [item];
        return count + itemRules.filter((rule) => rule.activated).length;
    }, 0);
}
