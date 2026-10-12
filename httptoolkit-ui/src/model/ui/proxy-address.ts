import { action, observable } from 'mobx';

import type { ProxyStore } from '../proxy-store';
import { copyToClipboard } from '../../util/ui';
import { logError } from '../../errors';

const COPIED_FEEDBACK_MS = 1500;

export const getProxyAddress = (proxyStore: Pick<ProxyStore, 'httpProxyPort'>) =>
    `http://localhost:${proxyStore.httpProxyPort}`;

// True for a moment after the address is copied, from the status bar or ⌘K, so the
// status bar can say so
export const proxyAddressCopy = observable({ copied: false });

let resetTimer: ReturnType<typeof setTimeout> | undefined;

const showCopied = action(() => {
    proxyAddressCopy.copied = true;

    if (resetTimer) clearTimeout(resetTimer);
    resetTimer = setTimeout(action(() => {
        proxyAddressCopy.copied = false;
    }), COPIED_FEEDBACK_MS);
});

export async function copyProxyAddress(proxyStore: Pick<ProxyStore, 'httpProxyPort'>): Promise<void> {
    try {
        await copyToClipboard(getProxyAddress(proxyStore));
        showCopied();
    } catch (error) {
        logError(error);
    }
}
