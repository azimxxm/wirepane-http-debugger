import { expect } from '../../../test-setup';

import { answerDialog, dialogQueue, getCurrentDialog } from '../../../../src/model/ui/dialogs';
import { confirmClearTraffic, confirmDeletePinned } from '../../../../src/components/view/view-delete-dialogs';

const clearQueue = () => dialogQueue.slice().forEach((request) => answerDialog(request, false));

const traffic = (pinned: number, unpinned: number) => [
    ...Array.from({ length: pinned }, () => ({ pinned: true })),
    ...Array.from({ length: unpinned }, () => ({ pinned: false }))
];

describe("View's delete dialogs", () => {

    beforeEach(clearQueue);
    afterEach(clearQueue);

    describe('before clearing traffic', () => {

        it("doesn't ask when there's nothing to clear", async () => {
            expect(await confirmClearTraffic([], true)).to.equal(true);
            expect(dialogQueue.length).to.equal(0);
        });

        it('asks before the button clears unpinned traffic', async () => {
            const result = confirmClearTraffic(traffic(0, 3), true);

            const dialog = getCurrentDialog()!;
            expect(dialog.kind).to.equal('confirm');
            expect(dialog.options).to.deep.equal({
                title: 'Delete all collected traffic?',
                message: "This deletes 3 requests. You can't undo this.",
                confirmLabel: 'Delete',
                destructive: true
            });

            answerDialog(dialog, true);
            expect(await result).to.equal(true);
        });

        it('says that pinned traffic stays', async () => {
            const result = confirmClearTraffic(traffic(1, 2), true);

            expect(getCurrentDialog()!.options.title).to.equal('Delete all non-pinned traffic?');
            expect(getCurrentDialog()!.options.message).to.equal('This deletes 2 requests. Your 1 pinned request stays.');

            answerDialog(getCurrentDialog()!, false);
            expect(await result).to.equal(false);
        });

        it("doesn't ask when the shortcut clears unpinned traffic", async () => {
            expect(await confirmClearTraffic(traffic(2, 1), false)).to.equal(true);
            expect(dialogQueue.length).to.equal(0);
        });

        it('always asks when only pinned traffic is left, even from the shortcut', async () => {
            for (const confirmRequired of [true, false]) {
                const result = confirmClearTraffic(traffic(2, 0), confirmRequired);

                expect(getCurrentDialog()!.options).to.deep.equal({
                    title: 'Delete pinned traffic?',
                    message: "Only pinned traffic is left, so this deletes all 2 pinned requests. You can't undo this.",
                    confirmLabel: 'Delete',
                    destructive: true
                });

                answerDialog(getCurrentDialog()!, confirmRequired);
                expect(await result).to.equal(confirmRequired);
            }
        });

        it('names a single pinned request', () => {
            confirmClearTraffic(traffic(1, 0), true);
            expect(getCurrentDialog()!.options.message).to.equal(
                "Only pinned traffic is left, so this deletes your pinned request. You can't undo this."
            );
        });

    });

    describe('before deleting pinned requests', () => {

        it('asks about one pinned request', async () => {
            const result = confirmDeletePinned(1);

            expect(getCurrentDialog()!.options).to.deep.equal({
                title: 'Delete this pinned request?',
                message: "You can't undo this.",
                confirmLabel: 'Delete',
                destructive: true
            });

            answerDialog(getCurrentDialog()!, true);
            expect(await result).to.equal(true);
        });

        it('asks about a selection that includes pinned requests', () => {
            confirmDeletePinned(4);
            expect(getCurrentDialog()!.options.title).to.equal('Delete 4 requests, including pinned ones?');
        });

    });

});
