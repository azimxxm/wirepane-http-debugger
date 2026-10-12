import * as React from 'react';

import { styled } from '../../styles';
import { getReadableSize } from '../../util/buffer';

// Shown by default for big binary bodies, like video segments or file downloads: as text
// they're unreadable, and turning megabytes into hex blocks the UI for seconds. The format
// picker still offers Hex and Text for anybody who wants them anyway.
export const BinaryBodySummary = styled((p: {
    className?: string,
    content: Buffer,
    rawContentType: string | undefined
}) => {
    const mimeType = p.rawContentType?.split(';')[0].trim();

    return <div className={p.className} role='note'>
        <p>
            This is { getReadableSize(p.content.byteLength) } of binary data{
                mimeType ? <> (<code>{ mimeType }</code>)</> : null
            }, so it isn't shown as text.
        </p>
        <p>
            Save it with the download button, or choose Hex to see the bytes.
        </p>
    </div>;
})`
    padding: 15px 20px;
    font-size: ${p => p.theme.textSize};
    line-height: 1.4;

    p + p {
        margin-top: 5px;
        opacity: ${p => p.theme.lowlightTextOpacity};
    }

    code {
        font-family: ${p => p.theme.monoFontFamily};
    }
`;
