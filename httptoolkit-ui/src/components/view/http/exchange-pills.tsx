import * as React from 'react';
import * as polished from 'polished';

import { styled } from '../../../styles';
import { getMethodThemeColor, getStatusColor } from '../../../model/events/categorization';

import { Pill } from '../../common/pill';

/*
 * Wirepane: the pills that sum up an exchange in View's details pane. Each one has a single
 * style, so the same status or method looks the same in the header and on the cards.
 */

// A response status in its status colour: "200 OK" in the details header, "200" on the
// Response card. Undefined is a response that hasn't arrived yet.
export const StatusPill = styled((props: {
    className?: string,
    status: number | 'aborted' | undefined,
    children: React.ReactNode
}) => <span className={props.className}>{ props.children }</span>)`
    flex-shrink: 0;
    padding: 2px 8px;
    border-radius: 10px;

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    white-space: nowrap;

    ${p => {
        const color = p.status === undefined
            ? p.theme.containerWatermark
            : getStatusColor(p.status, p.theme);

        return `
            color: ${color};
            background-color: ${polished.rgba(color, 0.12)};
            border: 1px solid ${polished.rgba(color, 0.35)};
        `;
    }}
`;

// The method & host on a Request card: neutral, with the method in its method colour, as in
// the list. Upstream coloured the whole pill by content type, which no longer means anything.
export const RequestPill = styled(Pill)`
    color: ${p => p.theme.mainColor};
    background-color: ${p => p.theme.mainLowlightBackground};
`;

export const PillMethod = styled.span<{ httpMethod: string }>`
    color: ${p => getMethodThemeColor(p.httpMethod, p.theme)};
`;
