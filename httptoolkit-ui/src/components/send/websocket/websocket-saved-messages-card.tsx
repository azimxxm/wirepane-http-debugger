import * as React from 'react';
import { useRef } from 'react';
import { observer } from 'mobx-react-lite';

import { styled } from '../../../styles';

import type { WebSocketMessage, WebSocketMessageType } from '../../../model/send/send-extras';

import { CollapsibleCardHeading } from '../../common/card';
import { IconButton } from '../../common/icon-button';
import { Pill } from '../../common/pill';
import { UnstyledButton } from '../../common/inputs';
import { SendCardScrollableWrapper, SendCardSection } from '../send-card-section';

const TYPE_LABELS: { [type in WebSocketMessageType]: string } = {
    text: 'Text',
    json: 'JSON',
    xml: 'XML',
    binary: 'Binary'
};

const SavedList = styled.ul`
    margin: 0 -20px;
    border-top: 1px solid ${p => p.theme.containerBorder};
`;

const SavedRow = styled.li`
    display: flex;
    align-items: center;
    gap: 8px;

    padding: 2px 10px 2px 20px;
    border-bottom: 1px solid ${p => p.theme.containerBorder};

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    ${Pill} {
        flex-shrink: 0;
        font-size: ${p => p.theme.tinyTextSize};
    }

    > ${IconButton} {
        flex-shrink: 0;
        padding: 4px 8px;
    }
`;

const LoadButton = styled(UnstyledButton)`
    flex: 1 1 auto;
    min-width: 0;
    padding: 6px 0;

    display: flex;
    align-items: baseline;
    gap: 10px;

    text-align: left;
    font-size: ${p => p.theme.textInputFontSize};

    &:focus:not(:focus-visible) {
        outline: none;
    }
`;

const SavedName = styled.span`
    flex-shrink: 0;
    max-width: 50%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    font-weight: 600;
`;

const SavedPreview = styled.span`
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const EmptyText = styled.p`
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
`;

/**
 * Messages saved with the tab (and with its collection request). Click one to load it into
 * the composer, or send it straight away.
 */
export const WebSocketSavedMessagesCard = observer((props: {
    savedMessages: readonly WebSocketMessage[],
    canSend: boolean,
    onLoad: (message: WebSocketMessage) => void,
    onSend: (message: WebSocketMessage) => void,
    onDelete: (message: WebSocketMessage) => void
}) => {
    const { savedMessages, canSend } = props;
    const [collapsed, setCollapsed] = React.useState(savedMessages.length === 0);
    const toggleCollapsed = React.useCallback(() => setCollapsed((value) => !value), []);

    // A newly saved message shows up in the list straight away
    const savedCount = useRef(savedMessages.length);
    React.useEffect(() => {
        if (savedMessages.length > savedCount.current) setCollapsed(false);
        savedCount.current = savedMessages.length;
    }, [savedMessages.length]);

    return <SendCardSection
        collapsed={collapsed}
        onCollapseToggled={toggleCollapsed}
        ariaLabel='Saved messages section'
        headerAlignment='left'
    >
        <header>
            <Pill>{ savedMessages.length }</Pill>
            <CollapsibleCardHeading onCollapseToggled={toggleCollapsed}>
                Saved messages
            </CollapsibleCardHeading>
        </header>
        <SendCardScrollableWrapper>
            { savedMessages.length === 0
                ? <EmptyText>
                    Name a message under the editor and press Save to keep it here.
                </EmptyText>
                : <SavedList>
                    { savedMessages.map((saved) =>
                        <SavedRow key={saved.id}>
                            <LoadButton
                                onClick={() => props.onLoad(saved)}
                                title='Load this message into the editor'
                            >
                                <SavedName>{ saved.name }</SavedName>
                                <SavedPreview>{ saved.content.replace(/\s+/g, ' ').slice(0, 200) }</SavedPreview>
                            </LoadButton>
                            <Pill>{ TYPE_LABELS[saved.type] ?? saved.type }</Pill>
                            <IconButton
                                icon='PaperPlaneTilt'
                                title={canSend ? `Send "${saved.name}" now` : 'Connect first to send saved messages'}
                                disabled={!canSend}
                                onClick={() => props.onSend(saved)}
                            />
                            <IconButton
                                icon={['far', 'trash-alt']}
                                title={`Delete "${saved.name}"`}
                                onClick={() => props.onDelete(saved)}
                            />
                        </SavedRow>
                    ) }
                </SavedList>
            }
        </SendCardScrollableWrapper>
    </SendCardSection>;
});
