import { confirmDialog } from '../../model/ui/dialogs';

// View's questions before it deletes traffic, in Wirepane's own dialog instead of confirm()

const countOf = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Asks before Clear deletes traffic, like View always has: every time when only pinned traffic
 * is left (Clear then deletes that too), and otherwise only when confirmRequired is truthy (the
 * toolbar button asks, the keyboard shortcut doesn't). Resolves true when the clear should go
 * ahead, which is straight away when there's nothing to ask.
 */
export async function confirmClearTraffic(
    events: ReadonlyArray<{ pinned: boolean }>,
    confirmRequired: boolean
): Promise<boolean> {
    if (events.length === 0) return true;

    const pinnedCount = events.filter((event) => event.pinned).length;

    if (pinnedCount === events.length) {
        return confirmDialog({
            title: 'Delete pinned traffic?',
            message: `Only pinned traffic is left, so this deletes ${pinnedCount === 1
                ? 'your pinned request'
                : `all ${countOf(pinnedCount, 'pinned request')}`
            }. You can't undo this.`,
            confirmLabel: 'Delete',
            destructive: true
        });
    }

    if (!confirmRequired) return true;

    const unpinnedCount = events.length - pinnedCount;
    return confirmDialog(pinnedCount > 0
        ? {
            title: 'Delete all non-pinned traffic?',
            message: `This deletes ${countOf(unpinnedCount, 'request')}. ` +
                `Your ${countOf(pinnedCount, 'pinned request')} ${pinnedCount === 1 ? 'stays' : 'stay'}.`,
            confirmLabel: 'Delete',
            destructive: true
        }
        : {
            title: 'Delete all collected traffic?',
            message: `This deletes ${countOf(unpinnedCount, 'request')}. You can't undo this.`,
            confirmLabel: 'Delete',
            destructive: true
        }
    );
}

/**
 * Asks before deleting pinned traffic one request (or one selection) at a time. Resolves true
 * when it should be deleted.
 */
export function confirmDeletePinned(count: number): Promise<boolean> {
    return confirmDialog({
        title: count === 1
            ? 'Delete this pinned request?'
            : `Delete ${countOf(count, 'request')}, including pinned ones?`,
        message: "You can't undo this.",
        confirmLabel: 'Delete',
        destructive: true
    });
}
