import * as React from 'react';
import { action, observable } from 'mobx';
import { observer } from 'mobx-react-lite';

import { styled } from '../../../styles';

import { MultipartField, SendExtras } from '../../../model/send/send-extras';
import { newFieldId, newMultipartField } from '../../../model/send/body-modes/body-fields';

import {
    FieldCellInput,
    FieldDeleteButton,
    FieldEnabledCheckbox,
    FieldRow,
    FieldTable,
    focusRowAfterRemoval,
    onFieldTableKeyDown
} from './field-table';
import { FileChip } from './file-chip';
import { ChooseFilesButton } from './file-drop';

const multipartColumns = (showContentTypes: boolean) => [
    '20px', // Enabled
    'minmax(0, 1fr)', // Name
    '74px', // Text or file
    'minmax(0, 2fr)', // Value or files
    ...(showContentTypes ? ['minmax(0, 1fr)'] : []),
    'min-content' // Delete
].join(' ');

const KindSelect = styled.select`
    padding: 0 4px 0 6px;
    border-radius: 4px;
    border: solid 1px ${p => p.theme.inputBorder};
    background-color: ${p => p.theme.inputBackground};
    color: ${p => p.theme.inputColor};

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    cursor: pointer;

    &:hover {
        background-color: ${p => p.theme.inputHoverBackground};
    }
`;

const FilesCell = styled.div`
    min-width: 0;

    display: flex;
    flex-direction: column;
    gap: 5px;
`;

const FileActions = styled.div`
    min-height: 30px;
    display: flex;
    align-items: center;
    gap: 8px;

    > span {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: ${p => p.theme.smallPrintSize};
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const Footer = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px 16px;

    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};

    > label {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        cursor: pointer;

        > input {
            margin: 0;
            accent-color: ${p => p.theme.popColor};
        }
    }
`;

const FieldFiles = observer((props: {
    field: MultipartField,
    onAttach: (files: File[]) => void
}) => {
    const { field } = props;

    return <FilesCell>
        { field.files.map((file, index) =>
            <FileChip
                key={`${file.fileId}-${index}`}
                file={file}
                onRemove={action(() => { field.files.splice(index, 1); })}
            />
        ) }
        <FileActions>
            <ChooseFilesButton
                multiple={true}
                title='Choose files to send in this field. You can also drop them on this row.'
                onFiles={props.onAttach}
            >
                { field.files.length ? 'Add files…' : 'Choose files…' }
            </ChooseFilesButton>
            { !field.files.length && <span>or drop them here</span> }
        </FileActions>
    </FilesCell>;
});

// One field, or (with no field) the empty last row that adds one when used
const MultipartFieldRow = observer((props: {
    field: MultipartField | undefined,
    showContentType: boolean,
    isDropTarget: boolean,
    onAdd: (field: Partial<MultipartField>) => void,
    onRemove: () => void,
    onAttach: (files: File[]) => void
}) => {
    const { field } = props;
    const name = field?.name ?? '';
    const kind = field?.kind ?? 'text';
    const hasContent = !!field && (kind === 'text' ? !!field.value : field.files.length > 0);

    const update = action((change: Partial<MultipartField>) => {
        if (field) Object.assign(field, change);
        else props.onAdd(change);
    });

    const firstFile = field && field.files.length > 0 ? field.files[0] : undefined;
    const defaultContentType = kind === 'file'
        ? (firstFile?.contentType || 'From the file')
        : 'None';

    return <FieldRow
        gridColumns={multipartColumns(props.showContentType)}
        isDisabled={!!field && !field.enabled}
        isDropTarget={props.isDropTarget}
        data-field-row={field?.id ?? ''}
        data-drop-row={field?.id}
    >
        <FieldEnabledCheckbox
            key='enabled'
            enabled={field?.enabled ?? true}
            fieldName={name}
            placeholder={!field}
            onChange={(enabled) => update({ enabled })}
        />
        <FieldCellInput
            key='name'
            value={name}
            placeholder='Name'
            aria-label='Field name'
            invalid={hasContent && !name}
            title={hasContent && !name ? 'Fields need a name to be sent' : undefined}
            onChange={(event) => update({ name: event.target.value })}
        />
        <KindSelect
            key='kind'
            value={kind}
            aria-label={name ? `Type of ${name}` : 'Field type'}
            title='Send text, or the contents of files'
            onChange={(event) => update({ kind: event.target.value as MultipartField['kind'] })}
        >
            <option value='text'>Text</option>
            <option value='file'>File</option>
        </KindSelect>
        { field && kind === 'file'
            ? <FieldFiles key='files' field={field} onAttach={props.onAttach} />
            : <FieldCellInput
                key='value'
                value={field?.value ?? ''}
                placeholder='Value'
                aria-label={name ? `Value of ${name}` : 'Field value'}
                onChange={(event) => update({ value: event.target.value })}
            />
        }
        { props.showContentType && <FieldCellInput
            key='content-type'
            value={field?.contentType ?? ''}
            placeholder={defaultContentType}
            aria-label={name ? `Content type of ${name}` : 'Field content type'}
            title='The Content-Type of this part. Leave it empty to use the default.'
            onChange={(event) => update({ contentType: event.target.value || undefined })}
        /> }
        <FieldDeleteButton
            key='delete'
            fieldName={name}
            placeholder={!field}
            onClick={props.onRemove}
        />
    </FieldRow>;
});

/**
 * The Multipart (multipart/form-data) body: a table of text fields and file fields. Files can
 * be chosen, or dropped from Finder on a row (dropping elsewhere on the Body tab adds a file
 * field, see SendBodyPanel).
 */
export const MultipartBodyEditor = observer((props: {
    extras: SendExtras,
    // The row files are being dragged over, if any
    dropRowId?: string,
    onAttach: (files: File[], fieldId?: string) => void
}) => {
    const { extras } = props;
    const tableRef = React.useRef<HTMLDivElement>(null);
    const [emptyRow] = React.useState(() => observable({ id: newFieldId() }));

    const hasContentTypes = extras.multipartFields.some((field) => !!field.contentType);
    const [contentTypesShown, showContentTypes] = React.useState(hasContentTypes);
    const showContentType = contentTypesShown || hasContentTypes;

    const addField = action((change: Partial<MultipartField>) => {
        extras.multipartFields.push(newMultipartField({ ...change, id: emptyRow.id }));
        emptyRow.id = newFieldId();
    });

    const removeField = action((index: number) => {
        extras.multipartFields.splice(index, 1);
        focusRowAfterRemoval(tableRef.current, index);
    });

    // One array, so the empty row and the field it becomes share a key scope
    const rows = [
        ...extras.multipartFields.map((field, index) =>
            <MultipartFieldRow
                key={field.id}
                field={field}
                showContentType={showContentType}
                isDropTarget={props.dropRowId === field.id}
                onAdd={addField}
                onRemove={() => removeField(index)}
                onAttach={(files) => props.onAttach(files, field.id)}
            />
        ),
        <MultipartFieldRow
            key={emptyRow.id}
            field={undefined}
            showContentType={showContentType}
            isDropTarget={false}
            onAdd={addField}
            onRemove={() => {}}
            onAttach={(files) => props.onAttach(files)}
        />
    ];

    return <>
        <FieldTable ref={tableRef} onKeyDown={onFieldTableKeyDown}>
            { rows }
        </FieldTable>
        <Footer>
            <span>Drop files on a row to add them to it, or anywhere here for a new file field.</span>
            <label title={hasContentTypes ? 'Clear the content types to hide this column' : undefined}>
                <input
                    type='checkbox'
                    checked={showContentType}
                    disabled={hasContentTypes}
                    onChange={(event) => showContentTypes(event.target.checked)}
                />
                Content type column
            </label>
        </Footer>
    </>;
});
