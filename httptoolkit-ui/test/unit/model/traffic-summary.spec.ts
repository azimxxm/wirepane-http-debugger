import { observable } from 'mobx';

import { expect } from '../../test-setup';

import { HtkRule } from '../../../src/model/rules/rules';
import { HtkRuleRoot } from '../../../src/model/rules/rules-structure';
import { MANUALLY_SENT_SOURCE, parseSource } from '../../../src/model/http/sources';
import {
    countActiveUserRules,
    getConnectedClients,
    getUserRuleItems
} from '../../../src/model/traffic-summary';

const rule = (id: string, activated = true) => ({ id, activated }) as HtkRule;

const rulesRoot = (...items: HtkRuleRoot['items']) => ({
    id: 'root',
    title: 'HTTP Toolkit Rules',
    isRoot: true,
    items
}) as HtkRuleRoot;

const defaultGroup = {
    id: 'default-group',
    title: 'Default rules',
    items: [rule('default-amiusing'), rule('default-wildcard')]
};

describe('Traffic summary', () => {

    describe('connected clients', () => {
        it('should list the sources of captured traffic', () => {
            const curl = parseSource('curl/8.7.1');
            expect(getConnectedClients([curl])).to.deep.equal([curl]);
        });

        it("shouldn't count requests sent from the Send page as a client", () => {
            const curl = parseSource('curl/8.7.1');
            expect(getConnectedClients([MANUALLY_SENT_SOURCE, curl])).to.deep.equal([curl]);
        });

        it('should recognise the Send page source in observable copies too', () => {
            // The events list keeps its sources in an observable array, which copies them
            const sources = observable.array([MANUALLY_SENT_SOURCE, parseSource('curl/8.7.1')]);
            expect(getConnectedClients(sources).map((source) => source.summary)).to.deep.equal(['Curl/8.7.1']);
        });
    });

    describe('user rules', () => {
        it('should ignore the built-in default rules', () => {
            const rules = rulesRoot(defaultGroup);

            expect(getUserRuleItems(rules)).to.deep.equal([]);
            expect(countActiveUserRules(rules)).to.equal(0);
        });

        it('should count activated rules, including those inside groups', () => {
            const rules = rulesRoot(
                rule('a'),
                rule('b', false),
                { id: 'group', title: 'Group', items: [rule('c'), rule('d')] },
                defaultGroup
            );

            expect(getUserRuleItems(rules).map((item) => item.id)).to.deep.equal(['a', 'b', 'group']);
            expect(countActiveUserRules(rules)).to.equal(3);
        });
    });

});
