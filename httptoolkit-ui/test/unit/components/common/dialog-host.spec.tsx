import * as React from 'react';
import * as ReactDOM from 'react-dom';
import { act } from 'react-dom/test-utils';

import { expect } from '../../../test-setup';

import { ThemeProvider, lightTheme, darkTheme, Theme } from '../../../../src/styles';
import { DialogHost } from '../../../../src/components/common/dialog-host';
import {
    answerDialog,
    confirmDialog,
    dialogQueue,
    messageDialog
} from '../../../../src/model/ui/dialogs';

// Dismisses anything left over, from other specs too: the queue is shared by the whole app
const clearQueue = () => act(() => {
    dialogQueue.slice().forEach((request) => answerDialog(request, false));
});

describe('Dialog host', () => {

    let container: HTMLDivElement;

    beforeEach(() => {
        clearQueue();
        container = document.createElement('div');
        document.body.appendChild(container);
    });

    afterEach(() => {
        clearQueue();
        act(() => { ReactDOM.unmountComponentAtNode(container); });
        container.remove();
    });

    const renderHost = (theme: Theme = lightTheme) => act(() => {
        ReactDOM.render(<ThemeProvider theme={theme}>
            <DialogHost />
        </ThemeProvider>, container);
    });

    // Opens a dialog from outside React, like the app's stores & services do
    function open<T>(show: () => Promise<T>): Promise<T> {
        let result!: Promise<T>;
        act(() => { result = show(); });
        return result;
    }

    const dialog = () => container.querySelector('dialog') as HTMLDialogElement | null;
    const buttons = () => Array.from(dialog()!.querySelectorAll('footer button')) as HTMLButtonElement[];
    const buttonLabels = () => buttons().map((button) => button.textContent);
    const confirmButton = () => buttons()[buttons().length - 1];

    const pressKey = (target: Element, key: string, init: KeyboardEventInit = {}) => {
        const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
        act(() => { target.dispatchEvent(event); });
        return event;
    };

    // Lets the dialog's promise callbacks run
    const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

    it('shows nothing until a dialog is asked for', () => {
        renderHost();
        expect(dialog()).to.equal(null);
    });

    it('shows a confirm dialog as a modal, with its text and buttons', () => {
        renderHost();
        open(() => confirmDialog({
            title: 'Delete all collected traffic?',
            message: 'This deletes 3 requests.\nYou can\'t undo this.',
            confirmLabel: 'Delete'
        }));

        expect(dialog()!.open).to.equal(true);
        expect(dialog()!.matches(':modal')).to.equal(true);
        expect(dialog()!.getAttribute('role')).to.equal('alertdialog');

        expect(dialog()!.querySelector('h1')!.textContent).to.equal('Delete all collected traffic?');
        const message = dialog()!.querySelector('p')!;
        expect(message.textContent).to.equal('This deletes 3 requests.\nYou can\'t undo this.');
        // Read out as the dialog's description, with its line breaks kept on screen:
        expect(dialog()!.getAttribute('aria-describedby')).to.equal(message.id);
        expect(getComputedStyle(message).whiteSpace).to.equal('pre-wrap');

        expect(buttonLabels()).to.deep.equal(['Cancel', 'Delete']);
    });

    it('starts with the confirm button focused, so Enter confirms', async () => {
        renderHost();
        const result = open(() => confirmDialog({ title: 'Restart your browser?', confirmLabel: 'Restart browser' }));

        expect(document.activeElement).to.equal(confirmButton());

        const enter = pressKey(confirmButton(), 'Enter');
        // Handled here, rather than also clicking the button natively:
        expect(enter.defaultPrevented).to.equal(true);

        expect(await result).to.equal(true);
        expect(dialog()).to.equal(null);
    });

    it('confirms with Enter when nothing in particular is focused', async () => {
        renderHost();
        const result = open(() => confirmDialog({ title: 'Reset all rules?', message: 'Some text' }));

        pressKey(dialog()!.querySelector('p')!, 'Enter');

        expect(await result).to.equal(true);
    });

    it("leaves Enter to Cancel and the close button when they're focused", async () => {
        renderHost();
        const result = open(() => confirmDialog({ title: 'Reset all rules?' }));
        let answer: boolean | undefined;
        result.then((confirmed) => { answer = confirmed; });

        const cancelButton = buttons()[0];
        const closeButton = dialog()!.querySelector('button[aria-label="Close"]')!;

        const enterOnCancel = pressKey(cancelButton, 'Enter');
        const enterOnClose = pressKey(closeButton, 'Enter');
        await settle();

        // Not confirmed, and the browser's own Enter (which clicks the focused button) isn't blocked:
        expect(answer).to.equal(undefined);
        expect(enterOnCancel.defaultPrevented).to.equal(false);
        expect(enterOnClose.defaultPrevented).to.equal(false);

        act(() => { cancelButton.click(); });
        expect(await result).to.equal(false);
    });

    it('ignores a held-down Enter, so it never answers the next dialog too', async () => {
        renderHost();
        const result = open(() => confirmDialog({ title: 'Delete pinned traffic?', destructive: true }));
        let answer: boolean | undefined;
        result.then((confirmed) => { answer = confirmed; });

        const repeatedEnter = pressKey(confirmButton(), 'Enter', { repeat: true });
        await settle();

        expect(answer).to.equal(undefined);
        expect(repeatedEnter.defaultPrevented).to.equal(true); // Doesn't click the button either
        expect(dialog()!.open).to.equal(true);
    });

    it('cancels with Escape', async () => {
        renderHost();
        const result = open(() => confirmDialog({ title: 'Delete it?' }));

        // The cancel event is what the browser fires for Escape:
        act(() => { dialog()!.dispatchEvent(new Event('cancel', { cancelable: true })); });

        expect(await result).to.equal(false);
        expect(dialog()).to.equal(null);
    });

    it('cancels with the Cancel and close buttons', async () => {
        renderHost();

        const viaCancel = open(() => confirmDialog({ title: 'First?' }));
        act(() => { buttons()[0].click(); });
        expect(await viaCancel).to.equal(false);

        const viaClose = open(() => confirmDialog({ title: 'Second?' }));
        act(() => { (dialog()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement).click(); });
        expect(await viaClose).to.equal(false);
    });

    it('confirms when the confirm button is clicked', async () => {
        renderHost();
        const result = open(() => confirmDialog({ title: 'Delete it?', confirmLabel: 'Delete' }));

        act(() => { confirmButton().click(); });
        expect(await result).to.equal(true);
    });

    it('uses the labels it is given', () => {
        renderHost();
        open(() => confirmDialog({ title: 'Keep going?', confirmLabel: 'Keep going', cancelLabel: 'Stop' }));

        expect(buttonLabels()).to.deep.equal(['Stop', 'Keep going']);
    });

    it('shows a message dialog with one OK button, which Enter and Escape both dismiss', async () => {
        renderHost();

        const viaEnter = open(() => messageDialog({ title: "Couldn't read that cURL command", message: 'Bad quotes' }));
        expect(buttonLabels()).to.deep.equal(['OK']);
        expect(document.activeElement).to.equal(confirmButton());
        pressKey(confirmButton(), 'Enter');
        await viaEnter;
        expect(dialog()).to.equal(null);

        const viaEscape = open(() => messageDialog({ title: 'Something else', buttonLabel: 'Got it' }));
        expect(buttonLabels()).to.deep.equal(['Got it']);
        act(() => { dialog()!.dispatchEvent(new Event('cancel', { cancelable: true })); });
        await viaEscape;
        expect(dialog()).to.equal(null);
    });

    it('shows queued dialogs one after another', async () => {
        renderHost();
        const first = open(() => confirmDialog({ title: 'First?' }));
        const second = open(() => messageDialog({ title: 'Second' }));

        expect(container.querySelectorAll('dialog').length).to.equal(1);
        expect(dialog()!.querySelector('h1')!.textContent).to.equal('First?');

        act(() => { confirmButton().click(); });
        expect(await first).to.equal(true);

        expect(dialog()!.querySelector('h1')!.textContent).to.equal('Second');
        expect(document.activeElement).to.equal(confirmButton());

        act(() => { confirmButton().click(); });
        await second;
        expect(dialog()).to.equal(null);
    });

    it('shows dialogs that were asked for before it was mounted', () => {
        open(() => messageDialog({ title: 'Asked for during startup' }));
        renderHost();

        expect(dialog()!.querySelector('h1')!.textContent).to.equal('Asked for during startup');
    });

    it('gives focus back to where it was once a dialog is answered', async () => {
        const outsideButton = document.createElement('button');
        document.body.appendChild(outsideButton);
        try {
            renderHost();
            outsideButton.focus();

            const result = open(() => confirmDialog({ title: 'Delete it?' }));
            expect(document.activeElement).to.equal(confirmButton());

            pressKey(confirmButton(), 'Enter');
            await result;

            expect(document.activeElement).to.equal(outsideButton);
        } finally {
            outsideButton.remove();
        }
    });

    it('keeps Tab & Shift+Tab going round the dialog, instead of leaving it', () => {
        renderHost();
        open(() => confirmDialog({ title: 'Delete it?' }));

        const [cancelButton, okButton] = buttons();
        const closeButton = dialog()!.querySelector('button[aria-label="Close"]') as HTMLButtonElement;

        // The close button is the dialog's last control (shown top right):
        closeButton.focus();
        expect(pressKey(closeButton, 'Tab').defaultPrevented).to.equal(true);
        expect(document.activeElement).to.equal(cancelButton);

        expect(pressKey(cancelButton, 'Tab', { shiftKey: true }).defaultPrevented).to.equal(true);
        expect(document.activeElement).to.equal(closeButton);

        // In between, the browser moves the focus as usual:
        okButton.focus();
        expect(pressKey(okButton, 'Tab').defaultPrevented).to.equal(false);
        expect(pressKey(okButton, 'Tab', { shiftKey: true }).defaultPrevented).to.equal(false);

        // From outside the controls, like the dialog's background after a click on its text:
        okButton.blur();
        pressKey(dialog()!, 'Tab', { shiftKey: true });
        expect(document.activeElement).to.equal(closeButton);
    });

    it("keeps key presses from reaching the page's shortcuts behind it", () => {
        renderHost();
        open(() => confirmDialog({ title: 'Delete it?' }));

        const pageKeys: string[] = [];
        const onPageKey = (event: KeyboardEvent) => pageKeys.push(event.key);
        document.addEventListener('keydown', onPageKey);
        try {
            pressKey(buttons()[0], 'j');
            pressKey(buttons()[0], 'Escape');
            pressKey(confirmButton(), 'Delete', { metaKey: true, shiftKey: true });
        } finally {
            document.removeEventListener('keydown', onPageKey);
        }

        expect(pageKeys).to.deep.equal([]);
    });

    it('shows destructive confirm buttons in red, in light and dark', () => {
        for (const [theme, red] of [
            [lightTheme, 'rgb(185, 28, 28)'],
            [darkTheme, 'rgb(251, 133, 133)']
        ] as const) {
            renderHost(theme);
            open(() => confirmDialog({ title: 'Delete it?', confirmLabel: 'Delete', destructive: true }));

            expect(confirmButton().hasAttribute('data-destructive')).to.equal(true);
            expect(getComputedStyle(confirmButton()).backgroundColor).to.equal(red);

            clearQueue();
        }
    });

    it('shows other confirm buttons in the accent colour', () => {
        renderHost();
        open(() => confirmDialog({ title: 'Restart your browser?', confirmLabel: 'Restart browser' }));

        expect(confirmButton().hasAttribute('data-destructive')).to.equal(false);
        expect(getComputedStyle(confirmButton()).backgroundColor).to.equal('rgb(15, 118, 110)');
    });

});
