import * as React from 'react';
import {
    File as FileIcon,
    FileAudio,
    FileImage,
    FileText,
    FileVideo,
    X
} from '@phosphor-icons/react';

import { styled } from '../../../styles';
import { getReadableSize } from '../../../util/buffer';

import { FileRef } from '../../../model/send/send-extras';

import { UnstyledButton } from '../../common/inputs';

export function FileTypeIcon(props: { contentType: string, size: number }) {
    const [type, subtype] = props.contentType.toLowerCase().split('/');
    const Icon = type === 'image' ? FileImage
        : type === 'video' ? FileVideo
        : type === 'audio' ? FileAudio
        : type === 'text' || /json|xml|javascript|yaml/.test(subtype ?? '') ? FileText
        : FileIcon;
    return <Icon size={props.size} aria-hidden={true} />;
}

const Chip = styled.div`
    min-width: 0;
    box-sizing: border-box;
    padding: 4px 2px 4px 8px;

    display: flex;
    align-items: center;
    gap: 8px;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 4px;
    background-color: ${p => p.theme.mainLowlightBackground};
    color: ${p => p.theme.mainColor};

    > svg {
        flex-shrink: 0;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

// Name over size & type, so neither is cut short in a narrow column
const ChipText = styled.span`
    flex: 1 1 auto;
    min-width: 0;

    display: flex;
    flex-direction: column;

    > span {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
`;

const ChipName = styled.span`
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 500;
    line-height: 1.3;
`;

const ChipDetails = styled.span`
    font-size: ${p => p.theme.tinyTextSize};
    line-height: 1.3;
    color: ${p => p.theme.mainLowlightColor};
`;

const ChipRemoveButton = styled(UnstyledButton)`
    flex-shrink: 0;
    margin-left: auto;
    width: 26px;
    height: 26px;
    border-radius: 4px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.theme.mainLowlightColor};

    &:hover {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

export const fileDetails = (file: FileRef) =>
    `${getReadableSize(file.size)} · ${file.contentType || 'application/octet-stream'}`;

// An attached file: its name, size and type, with a remove button
export const FileChip = (props: { file: FileRef, onRemove: () => void }) => {
    const { file } = props;

    return <Chip title={`${file.name}\n${fileDetails(file)}`}>
        <FileTypeIcon contentType={file.contentType} size={18} />
        <ChipText>
            <ChipName>{ file.name }</ChipName>
            <ChipDetails>{ fileDetails(file) }</ChipDetails>
        </ChipText>
        <ChipRemoveButton
            title={`Remove ${file.name}`}
            aria-label={`Remove ${file.name}`}
            onClick={props.onRemove}
        >
            <X size={14} weight='bold' />
        </ChipRemoveButton>
    </Chip>;
};
