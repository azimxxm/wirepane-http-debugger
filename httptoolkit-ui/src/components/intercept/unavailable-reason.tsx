import * as React from 'react';

import { styled } from '../../styles';
import { Icon } from '../../icons';

import { Interceptor } from '../../model/interception/interceptors';
import { getUnavailableReason } from '../../model/interception/unavailable-reasons';

const HelpLink = styled.a`
    margin-left: 6px;
    color: ${p => p.theme.linkColor};

    > svg {
        font-size: 0.9em;
    }
`;

/**
 * One line at the bottom of an unavailable intercept card, saying why it can't be
 * used and what to do about it, in place of a bare "Not available" pill.
 */
export const UnavailableReason = styled((props: {
    interceptor: Interceptor,
    className?: string
}) => {
    const reason = getUnavailableReason(props.interceptor);

    return <div className={props.className} title={reason.detail}>
        { reason.text }
        { reason.helpUrl && <HelpLink
            href={reason.helpUrl}
            target='_blank'
            rel='noreferrer noopener'
            aria-label={`Setup guide for ${props.interceptor.name}`}
            title='Open the setup guide'
            // The card itself is a button: following the link shouldn't also click it
            onClick={(e) => e.stopPropagation()}
        >
            <Icon icon={['fas', 'external-link-alt']} />
        </HelpLink> }
    </div>;
})`
    margin-top: auto; /* Pinned to the bottom of the card, like the status pills */
    padding-top: 10px;

    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.35;
    color: ${p => p.theme.mainLowlightColor};
`;
