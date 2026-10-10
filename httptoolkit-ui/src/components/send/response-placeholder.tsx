import * as React from 'react';

import { styled } from '../../styles';
import { formatShortcut } from '../../util/shortcuts';

import { EmptyState } from '../common/empty-state';

const PlaceholderTitle = styled.h2`
    margin-top: 12px;

    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};
`;

const PlaceholderText = styled.p`
    margin-top: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};
`;

/**
 * The response half of Send, before anything has been sent.
 */
export const ResponsePlaceholder = () => <EmptyState icon='PaperPlaneTilt'>
    <PlaceholderTitle>No response yet</PlaceholderTitle>
    <PlaceholderText>
        Press Send or { formatShortcut('Cmd+Enter') }. Sent requests also appear in View.
    </PlaceholderText>
</EmptyState>;
