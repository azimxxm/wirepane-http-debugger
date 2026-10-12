import * as React from 'react';
import { observer } from 'mobx-react';
import * as polished from 'polished';

import { styled } from '../../styles';
import { answerDialog, DialogRequest, getCurrentDialog } from '../../model/ui/dialogs';

import { ActionButton } from './action-button';
import { CollectionDialog } from '../collections/dialog-frame';

const DIALOG_WIDTH = 440;

const DialogMessage = styled.p`
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    line-height: 1.5;
`;

// Destructive actions (deleting or resetting something) are red instead of the teal accent. The
// text keeps the accent's text colour, which reads on the red in every theme (at least 6:1).
// Hover mixes in the text colour, so it darkens in light and lightens in dark, like the accent.
const ConfirmButton = styled(ActionButton)`
    &&&[data-destructive] {
        background-color: ${p => p.theme.error};
        color: ${p => p.theme.primaryInputColor};
    }

    &&&[data-destructive]:not([disabled]):hover {
        background-color: ${p => polished.mix(0.15, p.theme.mainColor, p.theme.error)};
    }
`;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// Tab & Shift+Tab go round the dialog's controls. On its own, Tab leaves a modal <dialog> after
// its last control, for the window itself, where keys would reach the page behind it.
function keepTabInside(event: React.KeyboardEvent<HTMLElement>) {
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>(FOCUSABLE))
        .filter((control) => !control.hasAttribute('disabled'));
    if (controls.length === 0) return;

    const index = controls.indexOf(document.activeElement as HTMLElement);
    const wrapTo = event.shiftKey
        ? (index <= 0 ? controls[controls.length - 1] : undefined)
        : (index === -1 || index === controls.length - 1 ? controls[0] : undefined);

    if (wrapTo) {
        event.preventDefault();
        wrapTo.focus();
    }
}

const QueuedDialog = (props: { request: DialogRequest }) => {
    const { request } = props;
    const messageId = React.useId();
    const confirmButtonRef = React.useRef<HTMLButtonElement | null>(null);

    const confirm = React.useCallback(() => answerDialog(request, true), [request]);
    const cancel = React.useCallback(() => answerDialog(request, false), [request]);

    // <dialog> focuses its [autofocus] element when it opens, so the confirm button starts
    // focused, like in the native dialogs. React's autoFocus prop doesn't set the attribute.
    const confirmButton = React.useCallback((button: HTMLButtonElement | null) => {
        confirmButtonRef.current = button;
        button?.setAttribute('autofocus', '');
    }, []);

    const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLElement>) => {
        // Keys pressed in a dialog never reach the page's shortcuts behind it
        event.stopPropagation();

        if (event.key === 'Tab') return keepTabInside(event);
        if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;

        // Enter confirms, unless another button (Cancel, the close button) has the focus
        const focusedButton = (event.target as HTMLElement).closest('button');
        if (focusedButton && focusedButton !== confirmButtonRef.current) return;

        event.preventDefault();
        // A held-down Enter answers this dialog, not the next one in the queue as well
        if (!event.repeat) confirm();
    }, [confirm]);

    const destructive = request.kind === 'confirm' && !!request.options.destructive;
    const confirmLabel = request.kind === 'confirm'
        ? request.options.confirmLabel ?? 'OK'
        : request.options.buttonLabel ?? 'OK';
    const { title, message } = request.options;

    // Key events from the <dialog> bubble through this wrapper, which has no box of its own
    return <div style={{ display: 'contents' }} onKeyDown={onKeyDown}>
        <CollectionDialog
            title={title}
            width={DIALOG_WIDTH}
            role='alertdialog'
            describedBy={message ? messageId : undefined}
            onClose={cancel}
            footer={<>
                { request.kind === 'confirm' && <ActionButton onClick={cancel}>
                    { request.options.cancelLabel ?? 'Cancel' }
                </ActionButton> }
                <ConfirmButton
                    ref={confirmButton}
                    variant='primary'
                    data-destructive={destructive ? '' : undefined}
                    onClick={confirm}
                >
                    { confirmLabel }
                </ConfirmButton>
            </>}
        >
            { message && <DialogMessage id={messageId}>{ message }</DialogMessage> }
        </CollectionDialog>
    </div>;
};

/**
 * Shows the dialogs asked for with messageDialog() & confirmDialog(), one at a time. Mount it
 * once, inside the theme.
 */
export const DialogHost = observer(() => {
    const request = getCurrentDialog();
    if (!request) return null;

    // Keyed, so each dialog opens as its own <dialog>, and focus goes back after each one
    return <QueuedDialog key={request.id} request={request} />;
});
