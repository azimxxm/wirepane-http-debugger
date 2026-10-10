import * as React from 'react';
import { action, observable } from 'mobx';
import { observer } from 'mobx-react-lite';

import { FormField, SendExtras } from '../../../model/send/send-extras';
import { newFieldId, newFormField } from '../../../model/send/body-modes/body-fields';

import {
    FieldCellInput,
    FieldDeleteButton,
    FieldEnabledCheckbox,
    FieldRow,
    FieldTable,
    focusRowAfterRemoval,
    onFieldTableKeyDown
} from './field-table';

const FORM_COLUMNS = '20px minmax(0, 1fr) minmax(0, 2fr) min-content';

// One field, or (with no field) the empty last row that adds one when typed into
const FormFieldRow = observer((props: {
    field: FormField | undefined,
    onAdd: (field: Partial<FormField>) => void,
    onRemove: () => void
}) => {
    const { field } = props;
    const name = field?.name ?? '';

    const update = action((change: Partial<FormField>) => {
        if (field) Object.assign(field, change);
        else props.onAdd(change);
    });

    return <FieldRow
        gridColumns={FORM_COLUMNS}
        isDisabled={!!field && !field.enabled}
        data-field-row={field?.id ?? ''}
    >
        <FieldEnabledCheckbox
            enabled={field?.enabled ?? true}
            fieldName={name}
            placeholder={!field}
            onChange={(enabled) => update({ enabled })}
        />
        <FieldCellInput
            value={name}
            placeholder='Name'
            aria-label='Field name'
            invalid={!!field && !name && !!field.value}
            title={!!field && !name && field.value ? 'Fields need a name to be sent' : undefined}
            onChange={(event) => update({ name: event.target.value })}
        />
        <FieldCellInput
            value={field?.value ?? ''}
            placeholder='Value'
            aria-label={name ? `Value of ${name}` : 'Field value'}
            onChange={(event) => update({ value: event.target.value })}
        />
        <FieldDeleteButton
            fieldName={name}
            placeholder={!field}
            onClick={props.onRemove}
        />
    </FieldRow>;
});

/**
 * The Form (application/x-www-form-urlencoded) body: a name/value table. Typing in the empty
 * last row adds a field.
 */
export const FormBodyEditor = observer((props: { extras: SendExtras }) => {
    const { extras } = props;
    const tableRef = React.useRef<HTMLDivElement>(null);

    // The empty row's key is the id its field will get, so React keeps the same inputs (and
    // the focus) when typing turns it into a field
    const [emptyRow] = React.useState(() => observable({ id: newFieldId() }));

    const addField = action((change: Partial<FormField>) => {
        extras.formFields.push(newFormField({ ...change, id: emptyRow.id }));
        emptyRow.id = newFieldId();
    });

    const removeField = action((index: number) => {
        extras.formFields.splice(index, 1);
        focusRowAfterRemoval(tableRef.current, index);
    });

    // One array, so the empty row and the field it becomes share a key scope
    const rows = [
        ...extras.formFields.map((field, index) =>
            <FormFieldRow
                key={field.id}
                field={field}
                onAdd={addField}
                onRemove={() => removeField(index)}
            />
        ),
        <FormFieldRow
            key={emptyRow.id}
            field={undefined}
            onAdd={addField}
            onRemove={() => {}}
        />
    ];

    return <FieldTable ref={tableRef} onKeyDown={onFieldTableKeyDown}>
        { rows }
    </FieldTable>;
});
