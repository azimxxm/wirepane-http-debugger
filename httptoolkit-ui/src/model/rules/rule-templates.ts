import { observable } from 'mobx';
import { matchers, completionCheckers } from 'mockttp';

import { RulesStore } from './rules-store';
import * as HttpRule from './definitions/http-rule-definitions';

export interface RuleTemplate {
    id: string;
    title: string;
    description: string;
    buildRule: (rulesStore: RulesStore) => HttpRule.HttpRule;
}

// Templates match a placeholder host or URL, so a rule saved without editing
// changes nothing that matters. The user fills in their own target.
const EXAMPLE_HOST = 'example.com';

function buildHttpRule(
    ruleMatchers: HttpRule.HttpRule['matchers'],
    step: HttpRule.HttpRule['steps'][number]
): HttpRule.HttpRule {
    return observable({
        id: crypto.randomUUID(),
        type: 'http',
        activated: true,
        matchers: ruleMatchers,
        completionChecker: new completionCheckers.Always(),
        steps: [step]
    });
}

const anyRequestToExampleHost = () => [
    new HttpRule.WildcardMatcher(),
    new matchers.HostMatcher(EXAMPLE_HOST)
];

export const RULE_TEMPLATES: ReadonlyArray<RuleTemplate> = [
    {
        id: 'mock-response',
        title: 'Mock a response',
        description: 'Answer matching requests with a response you write, without calling the server.',
        buildRule: () => buildHttpRule(
            [
                new HttpRule.MethodMatchers.GET(),
                new matchers.FlexiblePathMatcher(`https://${EXAMPLE_HOST}/api/hello`)
            ],
            new HttpRule.StaticResponseStep(
                200,
                'OK',
                JSON.stringify({ message: 'Hello from Wirepane' }, null, 2),
                { 'content-type': 'application/json' }
            )
        )
    },
    {
        id: 'rewrite-request-headers',
        title: 'Rewrite request headers',
        description: 'Add, change or remove headers before requests reach the server.',
        buildRule: (rulesStore) => buildHttpRule(
            anyRequestToExampleHost(),
            new HttpRule.TransformingStep(
                rulesStore,
                { updateHeaders: { 'x-wirepane-example': 'rewritten' } },
                {}
            )
        )
    },
    {
        id: 'breakpoint',
        title: 'Pause at a breakpoint',
        description: 'Stop matching requests, so you can edit them by hand before they continue.',
        buildRule: (rulesStore) => buildHttpRule(
            anyRequestToExampleHost(),
            new HttpRule.RequestBreakpointStep(rulesStore)
        )
    },
    {
        id: 'map-local-file',
        title: 'Map to a local file',
        description: 'Serve a file from your disk instead of the real response.',
        buildRule: () => buildHttpRule(
            [
                new HttpRule.MethodMatchers.GET(),
                new matchers.FlexiblePathMatcher(`https://${EXAMPLE_HOST}/app.js`)
            ],
            new HttpRule.FromFileResponseStep(200, undefined, '', {})
        )
    },
    {
        id: 'redirect-host',
        title: 'Redirect to another host',
        description: 'Send matching requests to another server, like your local dev build.',
        buildRule: (rulesStore) => buildHttpRule(
            anyRequestToExampleHost(),
            new HttpRule.ForwardToHostStep('http', 'localhost:3000', true, rulesStore)
        )
    },
    {
        id: 'fail-request',
        title: 'Fail or block a request',
        description: 'Close the connection, to test how your app handles network failures.',
        buildRule: () => buildHttpRule(
            anyRequestToExampleHost(),
            new HttpRule.CloseConnectionStep()
        )
    }
];
