import { Interceptor } from '../../../model/interception/interceptors';
import { confirmDialog } from '../../../model/ui/dialogs'; // wirepane

export async function onActivateExistingBrowser(
    interceptor: Interceptor,
    activateInterceptor: (
        options: { closeConfirmed?: true },
        shouldTrackEvent?: false
    ) => Promise<void>,
    reportStarted: () => void,
    reportSuccess: (options?: { showRequests?: boolean }) => void,
) {
    try {
        // Try to activate, assuming the browser isn't currently open:
        await activateInterceptor({}, false);

        // Only it runs without confirmation does this count as an activation
        reportStarted();
    } catch (error: any) {
        if (!error.metadata || error.metadata.closeConfirmRequired !== true) {
            // This is a real error, not a confirmation requirement.

            reportStarted(); // Track that this started, before it fails
            throw error;
        }

        // If the browser is open, confirm that we can kill & restart it first:
        const confirmed = await confirmDialog({ // wirepane: our own dialog instead of confirm()
            title: 'Restart your browser?',
            message: "It's open right now, and it has to restart before Wirepane can intercept it.",
            confirmLabel: 'Restart browser'
        });

        // If cancelled, we silently do nothing
        if (!confirmed) return;

        reportStarted();
        await activateInterceptor({ closeConfirmed: true });
    }

    reportSuccess();
}