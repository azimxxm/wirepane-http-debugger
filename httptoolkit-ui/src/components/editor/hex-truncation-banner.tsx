import * as React from 'react';

import { styled, css } from '../../styles';
import { getReadableSize } from '../../util/buffer';

export interface HexTruncation {
    shown: number;
    total: number;
}

// A one-line note above the hex view of a big body: only its start is rendered (see
// MAX_HEX_VIEW_BYTES), and the card's download button ("Save this body as a file") has all of it.
// The margins and padding follow the other banners, so it sits edge-to-edge in the card.
export const HexTruncationBanner = styled((p: {
    className?: string,
    metadata: HexTruncation,
    direction?: 'left' | 'right'
}) => <div className={p.className} role='note'>
    Only the first { getReadableSize(p.metadata.shown) } of { getReadableSize(p.metadata.total) } is shown.
    {' '}Save the body for the rest.
</div>)`
    ${p => p.direction === 'left'
            ? css`margin: 0 -20px 0 -15px; padding: 6px 20px 6px 15px;`
        : p.direction === 'right'
            ? css`margin: 0 -15px 0 -20px; padding: 6px 15px 6px 20px;`
        : css`margin: 0 -20px; padding: 6px 20px;`
    }

    background-color: ${p => p.theme.mainLowlightBackground};
    border-top: solid 1px ${p => p.theme.containerBorder};
    color: ${p => p.theme.mainColor};
    font-size: ${p => p.theme.textSize};
`;
