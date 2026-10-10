import * as React from 'react';

import { styled } from '../../styles';
import { useHotkeys } from '../../util/ui';

import { ActionButton } from '../common/action-button';

const Divider = styled.span`
    width: 1px;
    height: 20px;
    margin: 0 4px;
    background-color: ${p => p.theme.containerBorder};
`;

const UnsavedNote = styled.span`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
    white-space: nowrap;
`;

export const ModifyPageShortcuts = (props: {
    onNewRule: () => void,
    onSave: () => void
}) => {
    useHotkeys('Ctrl+n, Cmd+n', (event) => {
        event.preventDefault();
        props.onNewRule();
    }, [props.onNewRule]);

    useHotkeys('Ctrl+s, Cmd+s', (event) => {
        event.preventDefault();
        props.onSave();
    }, [props.onSave]);

    return null;
};

/**
 * Modify's page actions. Exactly one accent button at a time: "Save" while there are
 * unsaved changes, otherwise "New rule".
 */
export const ModifyHeaderActions = (props: {
    canReset: boolean,
    canImport: boolean,
    canExport: boolean,
    hasUnsavedChanges: boolean,

    onReset: () => void,
    onImport: () => void,
    onExport: () => void,
    onRevert: () => void,
    onSave: () => void,
    onNewRule: () => void
}) => <>
    <ActionButton
        variant='ghost'
        icon='ArrowCounterClockwise'
        title='Reset all rules to the defaults'
        disabled={!props.canReset}
        onClick={props.onReset}
    >
        Reset to defaults
    </ActionButton>
    <ActionButton
        variant='ghost'
        icon='DownloadSimple'
        title='Import a saved set of rules'
        disabled={!props.canImport}
        onClick={props.onImport}
    >
        Import
    </ActionButton>
    <ActionButton
        variant='ghost'
        icon='UploadSimple'
        title='Export these rules, to reuse or share them'
        disabled={!props.canExport}
        onClick={props.onExport}
    >
        Export
    </ActionButton>

    <Divider aria-hidden={true} />

    <ActionButton
        variant={props.hasUnsavedChanges ? 'secondary' : 'primary'}
        icon='Plus'
        shortcut='Cmd+N'
        title='Add a new rule'
        onClick={props.onNewRule}
    >
        New rule
    </ActionButton>

    { props.hasUnsavedChanges && <>
        <UnsavedNote>Unsaved changes</UnsavedNote>
        <ActionButton
            icon='ArrowUUpLeft'
            title='Revert the changes since the last save'
            onClick={props.onRevert}
        >
            Revert
        </ActionButton>
        <ActionButton
            variant='primary'
            icon='FloppyDisk'
            shortcut='Cmd+S'
            title='Save all rule changes'
            onClick={props.onSave}
        >
            Save
        </ActionButton>
    </> }
</>;
