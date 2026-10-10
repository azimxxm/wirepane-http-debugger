import * as React from 'react';

import { takeSwitchFocus } from '../../../model/send/websocket/request-type';

/**
 * Wirepane: when typing a URL (or picking from the method picker) switches a tab between
 * HTTP and WebSocket, its request line is replaced by the other type's one. This puts the
 * focus back where it was, so typing carries on in the new line.
 */
export function useTypeSwitchFocus(
    typeSelectRef: React.RefObject<HTMLSelectElement>,
    urlInputRef: React.RefObject<HTMLInputElement>
) {
    React.useLayoutEffect(() => {
        const focus = takeSwitchFocus();

        if (focus === 'type') {
            typeSelectRef.current?.focus();
        } else if (focus === 'url') {
            const input = urlInputRef.current;
            if (!input) return;

            input.focus();
            try {
                input.setSelectionRange(input.value.length, input.value.length);
            } catch {
                // Some input types don't allow setting the caret. The focus is what matters.
            }
        }
    }, []);
}
