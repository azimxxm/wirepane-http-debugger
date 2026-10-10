import * as React from 'react';

import { styled } from '../../styles';

import { TrafficSource } from '../../model/http/sources';

import { ActionButton } from '../common/action-button';
import { ClientIcon } from '../common/client-icon';

const ConnectedSection = styled.section`
    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;
    overflow: hidden;
`;

const ConnectedHeader = styled.header`
    height: 44px;
    padding: 0 12px 0 16px;
    box-sizing: border-box;

    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;

    border-bottom: 1px solid ${p => p.theme.containerBorder};

    > h2 {
        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }
`;

const ClientRow = styled.li`
    height: 32px;
    padding: 0 16px;

    display: flex;
    align-items: center;
    gap: 10px;

    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainColor};

    &:not(:last-child) {
        border-bottom: 1px solid ${p => p.theme.containerBorder};
    }

    > span {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }
`;

/**
 * The clients that have sent traffic through Wirepane so far. Only shown once
 * there's at least one.
 */
export const ConnectedList = (props: {
    clients: TrafficSource[],
    onViewRequests: () => void
}) => <ConnectedSection aria-labelledby='connected-clients-heading'>
    <ConnectedHeader>
        <h2 id='connected-clients-heading'>Connected ({ props.clients.length })</h2>
        <ActionButton
            icon='Rows'
            shortcut='Cmd+2'
            title='Show the captured requests'
            onClick={props.onViewRequests}
        >
            View requests
        </ActionButton>
    </ConnectedHeader>
    <ul>
        { props.clients.map((client) =>
            <ClientRow key={client.summary} title={client.description ?? client.ua}>
                <ClientIcon source={client} />
                <span>{ client.summary }</span>
            </ClientRow>
        ) }
    </ul>
</ConnectedSection>;
