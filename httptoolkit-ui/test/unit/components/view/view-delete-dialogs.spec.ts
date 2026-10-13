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

        it('says that pinned requests stay', async () => {
            const result = confirmClearTraffic(traffic(1, 2), true);

            expect(getCurrentDialog()!.options.title).to.equal('Delete all non-pinned requests?');
            expect(getCurrentDialog()!.options.message).to.equal('This deletes 2 requests. Your 1 pinned request stays.');

            answerDialog(getCurrentDialog()!, false);
            expect(await result).to.equal(false);
        });

        describe('with devices pinned in the Devices panel', () => {

            const messageFor = (events: ReturnType<typeof traffic>, pinnedDevices: Array<{ name: string, count: number }>) => {
                confirmClearTraffic(events, true, pinnedDevices);
                const { title, message } = getCurrentDialog()!.options;
                clearQueue();
                return { title, message };
            };

            it("says how many of the requests a pinned device sent, as they're deleted too", () => {
                expect(messageFor(traffic(0, 6), [{ name: 'iPhone', count: 3 }])).to.deep.equal({
                    title: 'Delete all collected traffic?',
                    message: "This deletes 6 requests, 3 of them from your pinned iPhone. You can't undo this."
                });

                expect(messageFor(traffic(1, 9), [{ name: 'iPhone', count: 4 }])).to.deep.equal({
                    title: 'Delete all non-pinned requests?',
                    message: 'This deletes 9 requests, 4 of them from your pinned iPhone. Your 1 pinned request stays.'
                });
            });

            it('counts several pinned devices together', () => {
                expect(messageFor(traffic(0, 9), [
                    { name: 'iPhone', count: 3 },
                    { name: 'Pixel 8', count: 2 },
                    { name: 'This Mac', count: 0 }
                ]).message).to.equal("This deletes 9 requests, 5 of them from your pinned devices. You can't undo this.");
            });

            it('says when all of them are from pinned devices', () => {
                expect(messageFor(traffic(0, 3), [{ name: 'iPhone', count: 3 }]).message)
                    .to.equal("This deletes 3 requests, all from your pinned iPhone. You can't undo this.");
                expect(messageFor(traffic(0, 1), [{ name: 'iPhone', count: 1 }]).message)
                    .to.equal("This deletes 1 request from your pinned iPhone. You can't undo this.");
            });

            it("doesn't mention pinned devices without traffic", () => {
                expect(messageFor(traffic(0, 3), [{ name: 'iPhone', count: 0 }]).message)
                    .to.equal("This deletes 3 requests. You can't undo this.");
            });

            it("still doesn't ask from the shortcut", async () => {
                expect(await confirmClearTraffic(traffic(0, 3), false, [{ name: 'iPhone', count: 3 }])).to.equal(true);
                expect(dialogQueue.length).to.equal(0);
            });

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
