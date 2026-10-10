import * as _ from 'lodash';

import { SendRequest } from '../send-request-model';
import { sendFileStore } from '../send-files';

// The ids of every file the given Send tabs refer to
export function usedSendFileIds(sendRequests: readonly SendRequest[]): Set<string> {
    return new Set(_.flatMap(sendRequests, (sendRequest) =>
        sendRequest.request.extras.fileRefs.map((file) => file.fileId)
    ));
}

/**
 * Drops stored files that no Send tab refers to any more (tabs that were closed, or files
 * that were removed or replaced). Runs once the Send tabs are loaded.
 */
export async function dropUnusedSendFiles(sendRequests: readonly SendRequest[]): Promise<void> {
    try {
        await sendFileStore.retainOnly(usedSendFileIds(sendRequests));
    } catch (error) {
        console.warn('Send file cleanup failed', error);
    }
}
