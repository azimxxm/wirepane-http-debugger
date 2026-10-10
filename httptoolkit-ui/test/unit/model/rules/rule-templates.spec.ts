import { expect } from '../../../test-setup';

import { RULE_TEMPLATES } from '../../../../src/model/rules/rule-templates';
import { getRulePartKey } from '../../../../src/model/rules/rules';
import {
    HttpInitialMatcherClasses,
    HttpStepLookup
} from '../../../../src/model/rules/definitions/http-rule-definitions';

// Just the parts of the rules store that rule steps read when they're built:
const rulesStore = {
    activePassthroughOptions: {},
    triggerRequestBreakpoint: () => {},
    triggerResponseBreakpoint: () => {}
} as any;

describe('Rule templates', () => {

    it('should offer the six common jobs, in order', () => {
        expect(RULE_TEMPLATES.map((template) => template.title)).to.deep.equal([
            'Mock a response',
            'Rewrite request headers',
            'Pause at a breakpoint',
            'Map to a local file',
            'Redirect to another host',
            'Fail or block a request'
        ]);
    });

    RULE_TEMPLATES.forEach((template) => {
        it(`should build an editable HTTP rule for "${template.title}"`, () => {
            const rule = template.buildRule(rulesStore);

            expect(rule.type).to.equal('http');
            expect(rule.activated).to.equal(true);

            // The rule editor needs an initial matcher (any/method) first:
            expect(HttpInitialMatcherClasses.some((matcherClass) =>
                rule.matchers[0] instanceof matcherClass
            )).to.equal(true);

            // ...and a step type it knows how to configure:
            expect(rule.steps).to.have.length(1);
            expect(Object.keys(HttpStepLookup)).to.include(getRulePartKey(rule.steps[0]));
        });
    });

    it('should give every new rule its own id', () => {
        const [template] = RULE_TEMPLATES;
        expect(template.buildRule(rulesStore).id).not.to.equal(template.buildRule(rulesStore).id);
    });

});
