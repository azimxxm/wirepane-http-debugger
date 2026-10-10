import * as React from 'react';

import { styled, css } from '../../../styles';
import { Icon } from '../../../icons';

import { Button, TextInput } from '../../common/inputs';

/**
 * The key/value tables of the Form and Multipart editors. They look like the request
 * headers table above them (editable-pairs.tsx), plus an enable checkbox per row.
 *
 * Keyboard: Tab goes through every control, Enter moves to the next text cell (Shift+Enter
 * to the previous one), so a table can be filled in without the mouse.
 */

// Rows hold controls of this height, so they line up when a row grows (e.g. many files)
const CONTROL_HEIGHT = '30px';

export const FieldTable = styled.div`
    display: flex;
    flex-direction: column;
    gap: 5px;
`;

export const FieldRow = styled.div<{
    gridColumns: string,
    isDisabled?: boolean,
    isDropTarget?: boolean
}>`
    display: grid;
    grid-template-columns: ${p => p.gridColumns};
    gap: 5px;
    align-items: start;

    border-radius: 4px;

    > input, > select {
        height: ${CONTROL_HEIGHT};
        box-sizing: border-box;
    }

    ${p => p.isDisabled && css`
        > :not(.field-enabled):not(.field-delete) {
            opacity: 0.55;
        }
    `}

    ${p => p.isDropTarget && css`
        outline: 2px dashed ${p.theme.popColor};
        outline-offset: 2px;
        background-color: ${p.theme.selectionInactiveBackground};
    `}
`;

const CheckboxCell = styled.label`
    height: ${CONTROL_HEIGHT};
    display: flex;
    align-items: center;
    justify-content: center;

    > input {
        margin: 0;
        accent-color: ${p => p.theme.popColor};
        cursor: pointer;
    }
`;

export const FieldEnabledCheckbox = (props: {
    enabled: boolean,
    fieldName: string,
    // The empty last row has no field yet: the checkbox only holds its place
    placeholder?: boolean,
    onChange: (enabled: boolean) => void
}) => <CheckboxCell
    className='field-enabled'
    style={props.placeholder ? { visibility: 'hidden' } : undefined}
    title={props.enabled
        ? 'Sent with the request. Untick to leave it out.'
        : 'Left out of the request. Tick to send it.'
    }
>
    <input
        type='checkbox'
        checked={props.enabled}
        disabled={props.placeholder}
        tabIndex={props.placeholder ? -1 : undefined}
        aria-label={`Send ${props.fieldName || 'this field'}`}
        onChange={(event) => props.onChange(event.target.checked)}
    />
</CheckboxCell>;

// Matches the delete buttons of the headers table
const DeleteButton = styled(Button)`
    font-size: ${p => p.theme.textSize};
    padding: 3px 10px 5px;
    height: ${CONTROL_HEIGHT};
`;

export const FieldDeleteButton = (props: {
    fieldName: string,
    placeholder?: boolean,
    onClick: () => void
}) => <DeleteButton
    className='field-delete'
    style={props.placeholder ? { visibility: 'hidden' } : undefined}
    disabled={props.placeholder}
    tabIndex={props.placeholder ? -1 : undefined}
    title={`Remove ${props.fieldName ? `"${props.fieldName}"` : 'this field'}`}
    aria-label={`Remove ${props.fieldName || 'this field'}`}
    onClick={props.onClick}
>
    <Icon icon={['far', 'trash-alt']} />
</DeleteButton>;

const CellInput = styled(TextInput)`
    width: 100%;
`;

// A text cell. These take part in Enter navigation.
export const FieldCellInput = React.forwardRef((
    props: React.InputHTMLAttributes<HTMLInputElement> & { invalid?: boolean },
    ref: React.Ref<HTMLInputElement>
) => <CellInput ref={ref} data-field-cell='' spellCheck={false} {...props} />);

const cellInputs = (table: HTMLElement) => Array.from(
    table.querySelectorAll<HTMLInputElement>('input[data-field-cell]:not(:disabled)')
);

export function onFieldTableKeyDown(event: React.KeyboardEvent<HTMLElement>) {
    if (event.key !== 'Enter' || event.metaKey || event.ctrlKey || event.altKey) return;

    const target = event.target as HTMLElement;
    if (!target.matches('input[data-field-cell]')) return;

    const cells = cellInputs(event.currentTarget);
    const next = cells[cells.indexOf(target as HTMLInputElement) + (event.shiftKey ? -1 : 1)];
    if (!next) return;

    event.preventDefault();
    next.focus();
}

// After a row is removed, keyboard focus moves to the row that took its place
export function focusRowAfterRemoval(table: HTMLElement | null, rowIndex: number) {
    requestAnimationFrame(() => {
        if (!table) return;
        const rows = table.querySelectorAll<HTMLElement>('[data-field-row]');
        const row = rows[Math.min(rowIndex, rows.length - 1)];
        row?.querySelector<HTMLInputElement>('input[data-field-cell]')?.focus();
    });
}
