import { action, observable } from 'mobx';

/**
 * Wirepane's own message & confirm dialogs, used instead of the browser's alert() and
 * confirm(). Those look out of place and freeze the whole app while they're open. Anything can
 * ask for one, from anywhere: DialogHost (mounted once, in index.tsx) shows them one at a
 * time, oldest first. Until it's mounted, they wait in the queue.
 */

export interface MessageDialogOptions {
    title: string;
    // Plain text. Line breaks are kept.
    message?: string;
    // Defaults to 'OK'
    buttonLabel?: string;
}

export interface ConfirmDialogOptions {
    title: string;
    // Plain text. Line breaks are kept.
    message?: string;
    // Defaults to 'OK', but name the action where you can, like 'Delete' or 'Restart browser'
    confirmLabel?: string;
    // Defaults to 'Cancel'
    cancelLabel?: string;
    // Shows the confirm button in red, for actions that delete or reset something
    destructive?: boolean;
}

interface MessageDialogRequest {
    kind: 'message';
    id: number;
    options: MessageDialogOptions;
    resolve: () => void;
}

interface ConfirmDialogRequest {
    kind: 'confirm';
    id: number;
    options: ConfirmDialogOptions;
    resolve: (confirmed: boolean) => void;
}

export type DialogRequest = MessageDialogRequest | ConfirmDialogRequest;

// Not deep, so each request stays the plain object that was queued
export const dialogQueue = observable.array<DialogRequest>([], { deep: false });

let nextDialogId = 1;

const enqueue = action((request: DialogRequest) => {
    dialogQueue.push(request);
});

const isSameMessage = (a: MessageDialogOptions, b: MessageDialogOptions) =>
    a.title === b.title && a.message === b.message && a.buttonLabel === b.buttonLabel;

/**
 * Shows a message with one button. Resolves once it's dismissed: with its button, Enter,
 * Escape, the close button or a click outside it.
 */
export function messageDialog(options: MessageDialogOptions): Promise<void> {
    return new Promise((resolve) => {
        // A message that's already waiting (like an error that keeps happening) is shown once,
        // and dismissing it resolves every request for it
        const waiting = dialogQueue.find((request): request is MessageDialogRequest =>
            request.kind === 'message' && isSameMessage(request.options, options)
        );

        if (waiting) {
            const resolveWaiting = waiting.resolve;
            waiting.resolve = () => { resolveWaiting(); resolve(); };
        } else {
            enqueue({ kind: 'message', id: nextDialogId++, options, resolve });
        }
    });
}

/**
 * Asks a yes/no question. Resolves true for the confirm button or Enter, and false for
 * Cancel, Escape, the close button or a click outside it.
 */
export function confirmDialog(options: ConfirmDialogOptions): Promise<boolean> {
    return new Promise((resolve) => enqueue({ kind: 'confirm', id: nextDialogId++, options, resolve }));
}

// The dialog to show now, if any
export function getCurrentDialog(): DialogRequest | undefined {
    // Checking the length first, as MobX warns about reads past the end of an array
    return dialogQueue.length > 0 ? dialogQueue[0] : undefined;
}

/**
 * Answers a dialog: takes it out of the queue and resolves its promise. A message dialog
 * ignores `confirmed`. Answering the same dialog again does nothing.
 */
export const answerDialog = action((request: DialogRequest, confirmed: boolean) => {
    const index = dialogQueue.indexOf(request);
    if (index === -1) return;
    dialogQueue.splice(index, 1);

    if (request.kind === 'confirm') request.resolve(confirmed);
    else request.resolve();
});
