import * as React from 'react';
import * as polished from 'polished';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { WarningCircle } from '@phosphor-icons/react';

import { styled } from '../../styles';

import { SendRequest } from '../../model/send/send-request-model';
import { CollectionsStore } from '../../model/collections/collections-store';

const ProblemRow = styled.div`
    flex-shrink: 0;
    padding: 8px 16px;

    display: flex;
    align-items: flex-start;
    gap: 8px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.error};
    background-color: ${p => polished.rgba(p.theme.error, 0.08)};
    border-bottom: 1px solid ${p => polished.rgba(p.theme.error, 0.3)};

    > svg {
        flex-shrink: 0;
        margin-top: 2px;
    }
`;

/**
 * Why the last Send of this tab didn't go out (no URL, or a {{variable}} that isn't set),
 * shown under the URL. It never blocks the window: it just waits for the next Send.
 */
export const SendProblemMessage = inject('collectionsStore')(observer((props: {
    collectionsStore?: CollectionsStore,
    sendRequest: SendRequest
}) => {
    const message = props.collectionsStore!.sendProblemFor(props.sendRequest);
    if (!message) return null;

    return <ProblemRow role='alert' data-send-problem={true}>
        <WarningCircle size={16} weight='fill' aria-hidden={true} />
        <span>{ message }</span>
    </ProblemRow>;
}));
