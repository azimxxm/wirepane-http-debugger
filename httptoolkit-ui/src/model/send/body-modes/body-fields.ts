import { action } from 'mobx';

import { FileRef, FormField, MultipartField, SendExtras } from '../send-extras';

/**
 * Rows of the Form and Multipart editors, and attaching files to them.
 */

export const newFieldId = () => crypto.randomUUID();

export const newFormField = (field: Partial<FormField> = {}): FormField => ({
    id: newFieldId(),
    name: '',
    value: '',
    enabled: true,
    ...field
});

export const newMultipartField = (field: Partial<MultipartField> = {}): MultipartField => ({
    id: newFieldId(),
    name: '',
    enabled: true,
    kind: 'text',
    value: '',
    files: [],
    ...field
});

// A name for a new file field: "file", then "file2", "file3"... so each one shows up on its own
export function newFileFieldName(fields: readonly MultipartField[]): string {
    const names = new Set(fields.map((field) => field.name));
    if (!names.has('file')) return 'file';

    let index = 2;
    while (names.has(`file${index}`)) index++;
    return `file${index}`;
}

const isSameFile = (a: FileRef, b: FileRef) => a.fileId === b.fileId && a.name === b.name;

/**
 * Adds files to a multipart body: to the given row (which becomes a file row, keeping any
 * text value for if it's switched back), or to a new file row. Rows need a name to be sent,
 * so a row without one gets a file name. Returns the row's id.
 */
export const addMultipartFiles = action((
    extras: SendExtras,
    files: readonly FileRef[],
    fieldId?: string
): string | undefined => {
    if (!files.length) return undefined;

    const fields = extras.multipartFields;
    const field = fieldId !== undefined
        ? fields.find((candidate) => candidate.id === fieldId)
        : undefined;

    if (!field) {
        const newField = newMultipartField({
            kind: 'file',
            name: newFileFieldName(fields),
            files: [...files]
        });
        fields.push(newField);
        return newField.id;
    }

    field.kind = 'file';
    for (const file of files) {
        if (!field.files.some((existing) => isSameFile(existing, file))) field.files.push(file);
    }
    if (!field.name) field.name = newFileFieldName(fields.filter((other) => other !== field));
    return field.id;
});
