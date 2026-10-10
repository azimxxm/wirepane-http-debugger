import * as React from 'react';

import { styled } from '../../../styles';

import { ActionButton } from '../../common/action-button';

/**
 * Picking and dropping files in the Send body card.
 *
 * Send's workspace imports any files dropped on it as collections, so the body card handles
 * its own drops with native listeners and stops them there: React's handlers (the
 * workspace's included) never see a drop the card took.
 */

export interface DroppedFiles {
    files: File[];
    // Folders can't be attached, so they're reported instead
    folderNames: string[];
    // The multipart row the files were dropped on, if any (its data-drop-row attribute)
    rowId?: string;
}

export interface FileDragState {
    isDragging: boolean;
    rowId?: string;
}

const NOT_DRAGGING: FileDragState = { isDragging: false };

const hasFiles = (event: DragEvent) =>
    Array.from(event.dataTransfer?.types ?? []).includes('Files');

const dropRowAt = (target: EventTarget | null) =>
    target instanceof Element
        ? target.closest<HTMLElement>('[data-drop-row]')?.dataset.dropRow
        : undefined;

function readDroppedFiles(dataTransfer: DataTransfer): Omit<DroppedFiles, 'rowId'> {
    const items = Array.from(dataTransfer.items ?? []).filter((item) => item.kind === 'file');
    if (!items.length) return { files: Array.from(dataTransfer.files), folderNames: [] };

    const files: File[] = [];
    const folderNames: string[] = [];
    for (const item of items) {
        const entry = item.webkitGetAsEntry?.();
        if (entry?.isDirectory) {
            folderNames.push(entry.name);
            continue;
        }

        const file = item.getAsFile();
        if (file) files.push(file);
    }
    return { files, folderNames };
}

/**
 * Makes an element a drop target for files from Finder while `enabled`, and reports where
 * the drag is. `getTarget` must be stable (e.g. from useCallback).
 */
export function useFileDrop(
    getTarget: () => HTMLElement | null | undefined,
    enabled: boolean,
    onDrop: (dropped: DroppedFiles) => void
): FileDragState {
    const [dragState, setDragState] = React.useState<FileDragState>(NOT_DRAGGING);
    const onDropRef = React.useRef(onDrop);
    onDropRef.current = onDrop;

    React.useEffect(() => {
        const target = getTarget();
        if (!target || !enabled) return;

        let current = NOT_DRAGGING;
        const update = (next: FileDragState) => {
            // dragover fires constantly, so only re-render when something changed
            if (next.isDragging === current.isDragging && next.rowId === current.rowId) return;
            current = next;
            setDragState(next);
        };

        // dragenter & dragleave fire for every child element, so nesting is counted
        let depth = 0;

        const onDragEnter = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            depth += 1;
            update({ isDragging: true, rowId: dropRowAt(event.target) });
        };

        const onDragOver = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            event.dataTransfer!.dropEffect = 'copy';
            update({ isDragging: true, rowId: dropRowAt(event.target) });
        };

        const onDragLeave = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.stopPropagation();
            depth = Math.max(0, depth - 1);
            if (depth === 0) update(NOT_DRAGGING);
        };

        const onDropFiles = (event: DragEvent) => {
            if (!hasFiles(event)) return;
            event.preventDefault();
            event.stopPropagation();
            depth = 0;
            update(NOT_DRAGGING);

            onDropRef.current({
                ...readDroppedFiles(event.dataTransfer!),
                rowId: dropRowAt(event.target)
            });
        };

        target.addEventListener('dragenter', onDragEnter);
        target.addEventListener('dragover', onDragOver);
        target.addEventListener('dragleave', onDragLeave);
        target.addEventListener('drop', onDropFiles);

        return () => {
            target.removeEventListener('dragenter', onDragEnter);
            target.removeEventListener('dragover', onDragOver);
            target.removeEventListener('dragleave', onDragLeave);
            target.removeEventListener('drop', onDropFiles);
            setDragState(NOT_DRAGGING);
        };
    }, [getTarget, enabled]);

    return dragState;
}

export const folderDropMessage = (folderNames: string[]) =>
    folderNames.length === 1
        ? `"${folderNames[0]}" is a folder. Drop the files inside it instead.`
        : `${folderNames.length} folders were dropped. Drop the files inside them instead.`;

const HiddenFileInput = styled.input.attrs(() => ({ type: 'file', tabIndex: -1 }))`
    display: none;
`;

// A button that opens the system file picker
export const ChooseFilesButton = (props: {
    multiple: boolean,
    children: React.ReactNode,
    title?: string,
    onFiles: (files: File[]) => void
}) => {
    const inputRef = React.useRef<HTMLInputElement>(null);

    return <>
        <ActionButton
            icon='UploadSimple'
            title={props.title}
            onClick={() => inputRef.current?.click()}
        >
            { props.children }
        </ActionButton>
        <HiddenFileInput
            ref={inputRef}
            multiple={props.multiple}
            aria-hidden={true}
            onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = ''; // So picking the same file again still counts
                if (files.length) props.onFiles(files);
            }}
        />
    </>;
};
