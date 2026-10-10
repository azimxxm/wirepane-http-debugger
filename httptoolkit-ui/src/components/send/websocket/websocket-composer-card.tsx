import * as React from 'react';
import * as polished from 'polished';
import { observer } from 'mobx-react-lite';

import { styled } from '../../../styles';
import { getReadableSize } from '../../../util/buffer';
import { formatShortcut } from '../../../util/shortcuts';
import { isMac } from '../../../util/ui';

import type { WebSocketMessageType } from '../../../model/send/send-extras';

import { CollapsibleCardHeading, ExpandableCardProps } from '../../common/card';
import { CollapsingButtons } from '../../common/collapsing-buttons';
import { ExpandShrinkButton } from '../../common/expand-shrink-button';
import { FormatButton } from '../../common/format-button';
import { Pill, PillSelector } from '../../common/pill';
import { Button, SecondaryButton, TextInput } from '../../common/inputs';
import { ContainerSizedEditor } from '../../editor/base-editor';
import { SendBodyCardSection, SendEditorCardContent } from '../send-card-section';

const MESSAGE_TYPES: readonly WebSocketMessageType[] = ['text', 'json', 'xml', 'binary'];

const MESSAGE_TYPE_NAMES: { [type in WebSocketMessageType]: string } = {
    text: 'Text',
    json: 'JSON',
    xml: 'XML',
    binary: 'Binary (base64)'
};

const SEND_SHORTCUT = formatShortcut('Cmd+Enter');

const ComposerEditorContent = styled(SendEditorCardContent)`
    margin-bottom: 0;
`;

const ComposerFooter = styled.div`
    margin: 0 -20px -20px;
    padding: 8px 12px;

    display: flex;
    align-items: center;
    gap: 8px;

    border-top: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};
`;

const SaveNameInput = styled(TextInput)`
    flex: 0 1 220px;
    min-width: 80px;
`;

const SmallSecondaryButton = styled(SecondaryButton)`
    flex-shrink: 0;
    padding: 4px 12px;
    border-width: 1px;
    border-radius: 6px;
    font-size: ${p => p.theme.textInputFontSize};
`;

const SendMessageButton = styled(Button)`
    flex-shrink: 0;
    margin-left: auto;
    padding: 5px 14px;
    border-radius: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;
`;

const ProblemText = styled.p`
    margin: 0 -20px;
    padding: 6px 16px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.4;
    color: ${p => p.theme.error};
    background-color: ${p => polished.rgba(p.theme.error, 0.08)};
    border-top: 1px solid ${p => polished.rgba(p.theme.error, 0.3)};
`;

const editorLanguage = (type: WebSocketMessageType) =>
    type === 'json' ? 'json'
    : type === 'xml' ? 'xml'
    : 'text';

/**
 * Writes the message to send: Text, JSON, XML or binary (as base64), with Send and a way
 * to save it under a name for later.
 */
export const WebSocketComposerCard = observer((props: ExpandableCardProps & {
    contentId: string,
    message: string,
    messageType: WebSocketMessageType,
    onMessageChange: (message: string) => void,
    onMessageTypeChange: (type: WebSocketMessageType) => void,

    canSend: boolean,
    onSend: () => void,
    // Why the last send didn't go out, if it didn't
    sendProblem?: string,

    onSave: (name: string) => void
}) => {
    const {
        contentId,
        message,
        messageType,
        onMessageChange,
        onMessageTypeChange,
        canSend,
        onSend,
        sendProblem,
        onSave,
        ...cardProps
    } = props;

    const [saveName, setSaveName] = React.useState('');

    const save = React.useCallback(() => {
        onSave(saveName.trim());
        setSaveName('');
    }, [onSave, saveName]);

    const onSaveNameKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Enter') {
            event.preventDefault();
            save();
        }
    }, [save]);

    const messageBytes = Buffer.from(message);

    return <SendBodyCardSection
        {...cardProps}
        headerAlignment='left'
    >
        <header>
            <CollapsingButtons>
                <ExpandShrinkButton
                    expanded={cardProps.expanded}
                    onClick={cardProps.onExpandToggled}
                />
                <FormatButton
                    format={messageType === 'json' || messageType === 'xml' ? messageType : 'raw'}
                    content={messageBytes}
                    onFormatted={onMessageChange}
                />
            </CollapsingButtons>

            <Pill title={messageType === 'binary'
                ? 'The size of this base64 text (the message itself is about 3/4 of this)'
                : 'The size of this message'
            }>{ getReadableSize(messageBytes.byteLength) }</Pill>

            <PillSelector<WebSocketMessageType>
                onChange={onMessageTypeChange}
                value={messageType}
                options={MESSAGE_TYPES}
                nameFormatter={(type) => MESSAGE_TYPE_NAMES[type]}
            />

            <CollapsibleCardHeading onCollapseToggled={cardProps.onCollapseToggled}>
                Message
            </CollapsibleCardHeading>
        </header>

        <ComposerEditorContent showFullBorder={false}>
            <ContainerSizedEditor
                contentId={contentId}
                language={editorLanguage(messageType)}
                value={message}
                onChange={onMessageChange}
            />
        </ComposerEditorContent>

        { sendProblem && <ProblemText role='alert'>{ sendProblem }</ProblemText> }

        <ComposerFooter>
            <SaveNameInput
                value={saveName}
                onChange={(event) => setSaveName(event.target.value)}
                onKeyDown={onSaveNameKeyDown}
                placeholder='Name to save this message as'
                aria-label='Saved message name'
            />
            <SmallSecondaryButton
                onClick={save}
                disabled={!message}
                title='Save this message, to load or send it later. A saved message with the same name is replaced.'
            >
                Save
            </SmallSecondaryButton>

            <SendMessageButton
                onClick={onSend}
                disabled={!canSend}
                title={canSend
                    ? `Send this message (${SEND_SHORTCUT})`
                    : 'Connect first, then send messages here'
                }
                aria-keyshortcuts={canSend ? (isMac ? 'Meta+Enter' : 'Control+Enter') : undefined}
            >
                Send { SEND_SHORTCUT }
            </SendMessageButton>
        </ComposerFooter>
    </SendBodyCardSection>;
});
