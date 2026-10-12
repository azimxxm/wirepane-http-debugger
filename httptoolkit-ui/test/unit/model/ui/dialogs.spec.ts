import { expect } from '../../../test-setup';

import {
    answerDialog,
    confirmDialog,
    dialogQueue,
    getCurrentDialog,
    messageDialog
} from '../../../../src/model/ui/dialogs';

// Dismisses anything left over, from other specs too: the queue is shared by the whole app
const clearQueue = () => dialogQueue.slice().forEach((request) => answerDialog(request, false));

const titles = () => dialogQueue.map((request) => request.options.title);

describe('Dialog service', () => {

    beforeEach(clearQueue);
    afterEach(clearQueue);

    it('has nothing to show when nothing was asked', () => {
        expect(getCurrentDialog()).to.equal(undefined);
    });

    it('queues a confirm dialog, and resolves true once it is confirmed', async () => {
        const result = confirmDialog({ title: 'Delete it?', confirmLabel: 'Delete', destructive: true });

        const current = getCurrentDialog()!;
        expect(current.kind).to.equal('confirm');
        expect(current.options).to.deep.equal({ title: 'Delete it?', confirmLabel: 'Delete', destructive: true });

        answerDialog(current, true);

        expect(await result).to.equal(true);
        expect(getCurrentDialog()).to.equal(undefined);
    });

    it('resolves a cancelled confirm dialog with false', async () => {
        const result = confirmDialog({ title: 'Delete it?' });
        answerDialog(getCurrentDialog()!, false);

        expect(await result).to.equal(false);
    });

    it('resolves a message dialog once it is dismissed', async () => {
        let dismissed = false;
        const result = messageDialog({ title: "Couldn't do that", message: 'Details' })
            .then(() => { dismissed = true; });

        await Promise.resolve();
        expect(dismissed).to.equal(false);
        expect(getCurrentDialog()!.kind).to.equal('message');

        answerDialog(getCurrentDialog()!, false);
        await result;

        expect(dismissed).to.equal(true);
        expect(getCurrentDialog()).to.equal(undefined);
    });

    it('shows dialogs one at a time, oldest first', async () => {
        const first = confirmDialog({ title: 'First?' });
        const second = messageDialog({ title: 'Second' });
        const third = confirmDialog({ title: 'Third?' });

        expect(titles()).to.deep.equal(['First?', 'Second', 'Third?']);
        expect(getCurrentDialog()!.options.title).to.equal('First?');

        answerDialog(getCurrentDialog()!, true);
        expect(getCurrentDialog()!.options.title).to.equal('Second');

        answerDialog(getCurrentDialog()!, true);
        answerDialog(getCurrentDialog()!, false);

        expect(await first).to.equal(true);
        expect(await second).to.equal(undefined);
        expect(await third).to.equal(false);
    });

    it('ignores a second answer to the same dialog', async () => {
        const first = confirmDialog({ title: 'First?' });
        const second = confirmDialog({ title: 'Second?' });

        const request = getCurrentDialog()!;
        answerDialog(request, true);
        answerDialog(request, false);

        expect(await first).to.equal(true);
        // The second dialog wasn't touched by the repeated answer:
        expect(titles()).to.deep.equal(['Second?']);

        answerDialog(getCurrentDialog()!, false);
        expect(await second).to.equal(false);
    });

    it('shows a message that is already waiting only once, and resolves every request for it', async () => {
        const options = { title: "Couldn't load your rules", message: 'Broken JSON' };
        const first = messageDialog(options);
        const repeat = messageDialog({ ...options });
        const different = messageDialog({ ...options, message: 'Other details' });

        expect(titles()).to.deep.equal([options.title, options.title]);
        expect(dialogQueue.map((request) => request.options.message))
            .to.deep.equal(['Broken JSON', 'Other details']);

        answerDialog(getCurrentDialog()!, false);
        await first;
        await repeat;

        expect(dialogQueue.map((request) => request.options.message)).to.deep.equal(['Other details']);
        answerDialog(getCurrentDialog()!, false);
        await different;
    });

    it('never merges confirm dialogs, as each one is its own question', () => {
        confirmDialog({ title: 'Delete it?' });
        confirmDialog({ title: 'Delete it?' });

        expect(titles()).to.deep.equal(['Delete it?', 'Delete it?']);
    });

});
