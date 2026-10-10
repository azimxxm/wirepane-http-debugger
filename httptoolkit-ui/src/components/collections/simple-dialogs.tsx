import * as React from 'react';

import { ActionButton } from '../common/action-button';
import {
    CollectionDialog,
    DialogTextInput,
    ErrorText,
    FieldRow,
    useDialogAction
} from './dialog-frame';

// Asks for a name: new collections, folders and requests, and renames
export const NameDialog = (props: {
    title: string,
    label: string,
    initialValue: string,
    submitLabel: string,
    onSubmit: (name: string) => Promise<unknown>,
    onClose: () => void
}) => {
    const [name, setName] = React.useState(props.initialValue);
    const inputRef = React.useRef<HTMLInputElement>(null);

    const { start, isRunning, error } = useDialogAction(async () => {
        await props.onSubmit(name.trim());
        props.onClose();
    });
    const canSubmit = !!name.trim() && !isRunning;

    React.useEffect(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
    }, []);

    return <CollectionDialog
        title={props.title}
        width={440}
        onClose={props.onClose}
        onSubmit={canSubmit ? start : undefined}
        footer={<>
            <ActionButton onClick={props.onClose}>Cancel</ActionButton>
            <ActionButton variant='primary' disabled={!canSubmit} onClick={start}>
                { props.submitLabel }
            </ActionButton>
        </>}
    >
        <FieldRow>
            <span>{ props.label }</span>
            <DialogTextInput
                ref={inputRef}
                value={name}
                onChange={(event) => setName(event.target.value)}
                spellCheck={false}
            />
        </FieldRow>
        { error && <ErrorText role='alert'>{ error }</ErrorText> }
    </CollectionDialog>;
};

export const ConfirmDialog = (props: {
    title: string,
    message: string,
    confirmLabel: string,
    onConfirm: () => Promise<unknown>,
    onClose: () => void
}) => {
    const { start, isRunning, error } = useDialogAction(async () => {
        await props.onConfirm();
        props.onClose();
    });

    // <dialog> focuses its [autofocus] element when it opens, so Cancel (the safe choice)
    // starts focused. React's autoFocus prop doesn't set the attribute, so it's set here.
    const focusOnOpen = React.useCallback((button: HTMLButtonElement | null) => {
        button?.setAttribute('autofocus', '');
    }, []);

    return <CollectionDialog
        title={props.title}
        width={440}
        onClose={props.onClose}
        footer={<>
            <ActionButton ref={focusOnOpen} onClick={props.onClose}>Cancel</ActionButton>
            <ActionButton variant='primary' disabled={isRunning} onClick={start}>
                { props.confirmLabel }
            </ActionButton>
        </>}
    >
        <p>{ props.message }</p>
        { error && <ErrorText role='alert'>{ error }</ErrorText> }
    </CollectionDialog>;
};
