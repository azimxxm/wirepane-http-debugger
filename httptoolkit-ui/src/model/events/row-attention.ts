/*
 * Wirepane: the marker at the start of a row in View's list. It only shows when a request
 * needs attention, so the list stays calm: the content type has its own Type column now.
 */
import { ViewableEvent } from '../../types';
import { areStepsModifying } from '../rules/rules';

// In priority order: a paused request is waiting for the user, so it wins
export const RowAttentionKinds = ['breakpoint', 'failed', 'modified'] as const;
export type RowAttention = typeof RowAttentionKinds[number];

export const ROW_ATTENTION_LABELS: { readonly [kind in RowAttention]: string } = {
    breakpoint: 'Paused at a breakpoint',
    failed: 'Failed',
    modified: 'Changed by a rule'
};

export const ROW_ATTENTION_DESCRIPTIONS: { readonly [kind in RowAttention]: string } = {
    breakpoint: 'waiting for you to edit and resume it',
    failed: 'the request was aborted, or the server answered with a 5xx error',
    modified: 'a Modify rule mocked, rewrote, redirected or delayed it'
};

export function getRowAttention(event: ViewableEvent): RowAttention | undefined {
    if (!event.isHttp()) return undefined;

    if (event.downstream.isBreakpointed) return 'breakpoint';

    const { response } = event;
    if (response === 'aborted') return 'failed';
    if (response && response.statusCode >= 500) return 'failed';

    if (event.matchedRule && areStepsModifying(event.matchedRule.stepTypes)) return 'modified';

    return undefined;
}

export const describeRowAttention = (kind: RowAttention) =>
    `${ROW_ATTENTION_LABELS[kind]}: ${ROW_ATTENTION_DESCRIPTIONS[kind]}`;
