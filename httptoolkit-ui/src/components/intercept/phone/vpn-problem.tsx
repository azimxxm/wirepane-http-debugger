import * as React from 'react';
import { Warning } from '@phosphor-icons/react';

import { styled } from '../../../styles';

const Root = styled.p`
    display: flex;
    gap: 8px;
    align-items: flex-start;
    padding: 8px 12px;

    border: 1px solid ${p => p.theme.warningColor};
    border-radius: 6px;
    background-color: ${p => p.theme.warningBackground};
    color: ${p => p.theme.mainColor};

    > svg {
        flex-shrink: 0;
        margin-top: 2px;
        color: ${p => p.theme.warningColor};
    }
`;

/**
 * Something went wrong with the VPN: an error from the server, or from an action the person
 * just took. Read out as soon as it appears.
 */
export const VpnProblem = (props: { message: string }) => <Root role='alert'>
    <Warning size={16} aria-hidden={true} />
    <span>{ props.message }</span>
</Root>;
