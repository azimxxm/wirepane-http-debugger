import * as React from 'react';
import * as polished from 'polished';
import { observer } from 'mobx-react-lite';
import { Warning, X } from '@phosphor-icons/react';

import { styled } from '../../../styles';
import { getReadableSize } from '../../../util/buffer';

import { RequestInput } from '../../../model/send/send-request-model';
import {
    BODY_MODE_OPTION_GROUPS,
    BodyModeOption,
    getBodyModeOption,
    getBodyModeOptionName,
    selectBodyMode
} from '../../../model/send/body-modes/body-mode-options';
import { getSendBodySize } from '../../../model/send/body-modes/body-size';
import { attachBinaryFile, attachMultipartFiles } from '../../../model/send/body-modes/attach-files';

import { CollapsibleCardHeading } from '../../common/card';
import { CollapsingButtons } from '../../common/collapsing-buttons';
import { ExpandShrinkButton } from '../../common/expand-shrink-button';
import { FormatButton } from '../../common/format-button';
import { Pill, PillSelect } from '../../common/pill';
import { UnstyledButton } from '../../common/inputs';
import { SendBodyCardSection, SendEditorCardContent } from '../send-card-section';
import { SendRequestBodyProps } from '../send-request-body-card';
import { GraphqlBodyEditor } from '../graphql/graphql-body-editor';

import { RawBodyEditor, rawBodyFromText } from './raw-body-editor';
import { FormBodyEditor } from './form-body-editor';
import { MultipartBodyEditor } from './multipart-body-editor';
import { BinaryBodyEditor } from './binary-body-editor';
import { DroppedFiles, folderDropMessage, useFileDrop } from './file-drop';

const StructuredBodyContent = styled.div`
    margin: 0 -20px -20px -20px;
    padding: 12px 20px 20px;
    border-top: solid 1px ${p => p.theme.containerBorder};

    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;

    display: flex;
    flex-direction: column;
    gap: 12px;
`;

const GraphqlBodyContent = styled(SendEditorCardContent)`
    display: flex;
    flex-direction: column;
`;

const BodyMessages = styled.div`
    display: flex;
    flex-direction: column;
    gap: 4px;
`;

const BodyMessage = styled.p`
    display: flex;
    align-items: flex-start;
    gap: 6px;
    padding: 6px 4px 6px 8px;
    border-radius: 4px;

    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainColor};
    background-color: ${p => p.theme.warningBackground};

    > svg {
        flex-shrink: 0;
        margin-top: 1px;
        color: ${p => p.theme.warningColor};
    }

    > span {
        flex: 1 1 auto;
        min-width: 0;
        overflow-wrap: anywhere;
    }
`;

const DismissButton = styled(UnstyledButton)`
    flex-shrink: 0;
    width: 20px;
    height: 20px;
    margin: -2px 0;
    border-radius: 4px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.theme.mainLowlightColor};

    &:hover {
        color: ${p => p.theme.mainColor};
    }
`;

const PendingNote = styled.p`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

// Shown over the card while files are dragged over it. It lets the drag through.
const DropOverlay = styled.div`
    position: absolute;
    inset: 0;
    z-index: 10;
    pointer-events: none;

    border: 2px dashed ${p => p.theme.popColor};
    background-color: ${p => polished.rgba(p.theme.popColor, 0.04)};

    display: flex;
    align-items: flex-end;
    justify-content: center;
    padding-bottom: 16px;

    > span {
        padding: 4px 10px;
        border-radius: 4px;
        font-size: ${p => p.theme.smallPrintSize};
        font-weight: 600;
        color: ${p => p.theme.primaryInputColor};
        background-color: ${p => p.theme.primaryInputBackground};
    }
`;

const BodyModePicker = (props: {
    value: BodyModeOption,
    onChange: (option: BodyModeOption) => void
}) => <PillSelect
    aria-label='Body type'
    title='Body type: text in a format, a form, a multipart form with files, one file, or a GraphQL query'
    value={props.value}
    onChange={(event: React.ChangeEvent<HTMLSelectElement>) =>
        props.onChange(event.target.value as BodyModeOption)
    }
>
    { BODY_MODE_OPTION_GROUPS.map((group) =>
        <optgroup key={group.label} label={group.label}>
            { group.options.map((option) =>
                <option key={option} value={option}>
                    { getBodyModeOptionName(option) }
                </option>
            ) }
        </optgroup>
    ) }
</PillSelect>;

/**
 * The request body card in Send, with the body mode picker: the raw modes (Text, JSON, XML...)
 * use upstream's editor, and Form, Multipart, Binary and GraphQL have their own editors.
 * Multipart and Binary bodies take files dropped anywhere on the card.
 */
export const SendBodyCard = observer((props: SendRequestBodyProps & {
    requestInput: RequestInput
}) => {
    const {
        requestInput,
        editorNode,
        headers,
        contentType,
        body,
        onBodyUpdated,
        onContentTypeUpdated,
        ...cardProps
    } = props;
    const mode = requestInput.extras.bodyMode;

    // Problems with the last files attached, shown until the next attempt
    const [messages, setMessages] = React.useState<string[]>([]);
    const [pendingFiles, setPendingFiles] = React.useState(0);
    React.useEffect(() => setMessages([]), [requestInput, mode]);

    // Files are read asynchronously: by then, another tab may be shown
    const shownInput = React.useRef(requestInput);
    shownInput.current = requestInput;

    const attachFiles = async (files: File[], fieldId?: string, otherProblems: string[] = []) => {
        const fileCount = mode === 'binary' ? 1 : files.length; // A binary body takes only one
        const showMessages = (problems: string[]) => {
            if (shownInput.current === requestInput) setMessages([...otherProblems, ...problems]);
        };

        setPendingFiles((count) => count + fileCount);
        try {
            showMessages(mode === 'binary'
                ? await attachBinaryFile(requestInput, files)
                : await attachMultipartFiles(requestInput, files, fieldId)
            );
        } catch (error: any) {
            showMessages([`The files couldn't be attached: ${error?.message ?? error}`]);
        } finally {
            setPendingFiles((count) => count - fileCount);
        }
    };

    const headerRef = React.useRef<HTMLElement>(null);
    const getCard = React.useCallback(() => headerRef.current?.parentElement, []);

    const takesFiles = mode === 'multipart' || mode === 'binary';
    const dragState = useFileDrop(getCard, takesFiles, (dropped: DroppedFiles) => {
        // Dropped on the collapsed card: open it, to show where the files went
        if (cardProps.collapsed) cardProps.onCollapseToggled?.();

        const folderProblems = dropped.folderNames.length ? [folderDropMessage(dropped.folderNames)] : [];
        if (dropped.files.length) attachFiles(dropped.files, dropped.rowId, folderProblems);
        else setMessages(folderProblems);
    });

    const dropRowName = dragState.rowId &&
        requestInput.extras.multipartFields.find((field) => field.id === dragState.rowId)?.name;
    const dropLabel = mode === 'binary'
        ? 'Drop to send this file as the body'
        : dropRowName
            ? `Drop to add to "${dropRowName}"`
            : 'Drop to add a file field';

    const messageList = (messages.length > 0 || pendingFiles > 0) && <BodyMessages aria-live='polite'>
        { pendingFiles > 0 && <PendingNote>
            Adding { pendingFiles === 1 ? 'a file' : `${pendingFiles} files` }…
        </PendingNote> }
        { messages.map((message, index) =>
            <BodyMessage key={index} role='alert'>
                <Warning size={14} weight='fill' aria-hidden={true} />
                <span>{ message }</span>
                <DismissButton
                    title='Dismiss'
                    aria-label='Dismiss'
                    onClick={() => setMessages(messages.filter((_message, i) => i !== index))}
                >
                    <X size={12} weight='bold' />
                </DismissButton>
            </BodyMessage>
        ) }
    </BodyMessages>;

    return <SendBodyCardSection
        {...cardProps}
        headerAlignment='left'
    >
        <header ref={headerRef}>
            <CollapsingButtons>
                <ExpandShrinkButton
                    expanded={cardProps.expanded}
                    onClick={cardProps.onExpandToggled}
                />
                <FormatButton
                    format={mode === 'raw' ? contentType : 'text'}
                    content={body.decoded}
                    onFormatted={(text) => onBodyUpdated(rawBodyFromText(body, text))}
                />
            </CollapsingButtons>

            <Pill>{ getReadableSize(getSendBodySize(requestInput)) }</Pill>

            <BodyModePicker
                value={getBodyModeOption(requestInput)}
                onChange={(option) => selectBodyMode(requestInput, option)}
            />

            <CollapsibleCardHeading onCollapseToggled={cardProps.onCollapseToggled}>
                Request body
            </CollapsibleCardHeading>
        </header>

        { mode === 'raw' && <RawBodyEditor
            body={body}
            headers={headers}
            contentType={contentType}
            editorNode={editorNode}
            onBodyUpdated={onBodyUpdated}
        /> }

        { mode === 'form' && <StructuredBodyContent>
            <FormBodyEditor extras={requestInput.extras} />
        </StructuredBodyContent> }

        { mode === 'multipart' && <StructuredBodyContent>
            { messageList }
            <MultipartBodyEditor
                extras={requestInput.extras}
                dropRowId={dragState.rowId}
                onAttach={attachFiles}
            />
        </StructuredBodyContent> }

        { mode === 'binary' && <StructuredBodyContent>
            { messageList }
            <BinaryBodyEditor
                requestInput={requestInput}
                isDragging={dragState.isDragging}
                onAttach={attachFiles}
            />
        </StructuredBodyContent> }

        { mode === 'graphql' && <GraphqlBodyContent showFullBorder={false}>
            <GraphqlBodyEditor requestInput={requestInput} />
        </GraphqlBodyContent> }

        { dragState.isDragging && <DropOverlay aria-hidden={true}>
            <span>{ dropLabel }</span>
        </DropOverlay> }
    </SendBodyCardSection>;
});
