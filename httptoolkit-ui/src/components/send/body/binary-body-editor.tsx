import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { FileArrowUp } from '@phosphor-icons/react';

import { styled, css } from '../../../styles';

import { FileRef } from '../../../model/send/send-extras';
import { RequestInput } from '../../../model/send/send-request-model';
import { sendFileStore } from '../../../model/send/send-files';
import { setBinaryFile } from '../../../model/send/body-modes/body-mode-options';
import { isPreviewableImage, MAX_SEND_FILE_SIZE_LABEL } from '../../../model/send/body-modes/attach-files';

import { ActionButton } from '../../common/action-button';
import { ChooseFilesButton } from './file-drop';
import { fileDetails, FileTypeIcon } from './file-chip';

const DropZone = styled.div<{ isDragging: boolean }>`
    flex: 1 1 auto;
    min-height: 140px;
    padding: 20px;

    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 8px;
    text-align: center;

    border: 2px dashed ${p => p.theme.containerBorder};
    border-radius: 8px;
    color: ${p => p.theme.mainLowlightColor};

    ${p => p.isDragging && css`
        border-color: ${p.theme.popColor};
        background-color: ${p.theme.selectionInactiveBackground};
    `}

    > svg {
        color: ${p => p.theme.popColor};
    }

    > strong {
        font-size: ${p => p.theme.textSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }

    > p {
        font-size: ${p => p.theme.smallPrintSize};
        margin-bottom: 4px;
    }
`;

const FileSummary = styled.div`
    display: flex;
    align-items: center;
    gap: 10px;

    > svg {
        flex-shrink: 0;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const FileTitle = styled.div`
    flex: 1 1 auto;
    min-width: 0;

    > strong, > p {
        display: block;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    > strong {
        font-size: ${p => p.theme.textSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }

    > p {
        margin-top: 2px;
        font-size: ${p => p.theme.smallPrintSize};
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const FileButtons = styled.div`
    flex-shrink: 0;
    display: flex;
    gap: 6px;
`;

const PreviewFrame = styled.figure`
    flex: 0 1 auto;
    min-height: 0;
    padding: 10px;

    display: flex;
    justify-content: center;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
    background-color: ${p => p.theme.mainLowlightBackground};

    > img {
        max-width: 100%;
        max-height: 320px;
        object-fit: contain;
    }
`;

const MissingFile = styled.p`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.warning};
`;

// An object URL for an image file's bytes, or whether they're gone from the file store
function useImagePreview(file: FileRef | undefined) {
    const [preview, setPreview] = React.useState<{ url?: string, missing: boolean }>({ missing: false });
    const fileId = file?.fileId;
    const contentType = file?.contentType ?? '';

    React.useEffect(() => {
        setPreview({ missing: false });
        // Only images are read: other files can be big, and are only needed when sending
        if (!fileId || !isPreviewableImage(contentType)) return;

        let url: string | undefined;
        let cancelled = false;
        sendFileStore.get(fileId).then((bytes) => {
            if (cancelled) return;
            if (!bytes) return setPreview({ missing: true });

            url = URL.createObjectURL(new Blob([bytes], { type: contentType }));
            setPreview({ url, missing: false });
        });

        return () => {
            cancelled = true;
            if (url) URL.revokeObjectURL(url);
        };
    }, [fileId, contentType]);

    return preview;
}

/**
 * The Binary body: one file, sent as it is. Images get a preview.
 */
export const BinaryBodyEditor = observer((props: {
    requestInput: RequestInput,
    isDragging: boolean,
    onAttach: (files: File[]) => void
}) => {
    const { requestInput } = props;
    const file = requestInput.extras.binaryFile;
    const preview = useImagePreview(file);

    if (!file) {
        return <DropZone isDragging={props.isDragging}>
            <FileArrowUp size={32} aria-hidden={true} />
            <strong>Drop a file here</strong>
            <p>Its bytes are sent as the request body. Files can be up to { MAX_SEND_FILE_SIZE_LABEL }.</p>
            <ChooseFilesButton multiple={false} onFiles={props.onAttach}>
                Choose file…
            </ChooseFilesButton>
        </DropZone>;
    }

    return <>
        <FileSummary>
            <FileTypeIcon contentType={file.contentType} size={28} />
            <FileTitle>
                <strong title={file.name}>{ file.name }</strong>
                <p>{ fileDetails(file) }</p>
            </FileTitle>
            <FileButtons>
                <ChooseFilesButton
                    multiple={false}
                    title='Choose another file. You can also drop one here.'
                    onFiles={props.onAttach}
                >
                    Replace…
                </ChooseFilesButton>
                <ActionButton
                    icon='Trash'
                    title='Remove this file from the body'
                    onClick={() => setBinaryFile(requestInput, undefined)}
                >
                    Remove
                </ActionButton>
            </FileButtons>
        </FileSummary>
        { preview.url && <PreviewFrame>
            <img src={preview.url} alt={`Preview of ${file.name}`} />
        </PreviewFrame> }
        { preview.missing && <MissingFile role='alert'>
            This file isn't available any more. Choose it again to send it.
        </MissingFile> }
    </>;
});
