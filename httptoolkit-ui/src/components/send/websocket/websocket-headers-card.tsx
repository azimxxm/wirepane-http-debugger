import * as React from 'react';
import { observer } from 'mobx-react-lite';

import { styled } from '../../../styles';
import { RawHeaders } from '../../../types';

import { CollapsibleCardHeading, ExpandableCardProps } from '../../common/card';
import { EditableRawHeaders } from '../../common/editable-headers';
import { ExpandShrinkButton } from '../../common/expand-shrink-button';
import { CollapsingButtons } from '../../common/collapsing-buttons';
import { SendCardScrollableWrapper, SendCardSection } from '../send-card-section';

const HeadersHint = styled.p`
    margin: 0 0 10px;

    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.4;
    color: ${p => p.theme.mainLowlightColor};

    code {
        font-family: ${p => p.theme.monoFontFamily};
    }
`;

/**
 * The headers sent with a WebSocket's opening handshake: upstream's editable headers, with
 * a note on what the handshake adds itself.
 */
export const WebSocketHeadersCard = observer(({
    headers,
    updateHeaders,
    ...cardProps
}: ExpandableCardProps & {
    headers: RawHeaders,
    updateHeaders: (headers: RawHeaders) => void
}) => {
    return <SendCardSection
        {...cardProps}
        headerAlignment='left'
    >
        <header>
            <CollapsingButtons>
                <ExpandShrinkButton
                    expanded={cardProps.expanded}
                    onClick={cardProps.onExpandToggled}
                />
            </CollapsingButtons>
            <CollapsibleCardHeading onCollapseToggled={cardProps.onCollapseToggled}>
                Handshake headers
            </CollapsibleCardHeading>
        </header>
        <SendCardScrollableWrapper>
            <HeadersHint>
                The handshake's own headers are added for you. Subprotocols go
                in <code>Sec-WebSocket-Protocol</code>, e.g. <code>graphql-ws, chat</code>.
            </HeadersHint>
            <EditableRawHeaders
                preserveKeyCase={true}
                headers={headers}
                onChange={updateHeaders}
            />
        </SendCardScrollableWrapper>
    </SendCardSection>;
});
