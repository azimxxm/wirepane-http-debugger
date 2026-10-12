import * as dateFns from 'date-fns';
import type * as Ajv from 'ajv';

import { ViewableEvent } from '../../types';
import { saveFile, uploadFile } from '../../util/ui';
import { formatAjvError } from '../../util/json-schema';
import { logError } from '../../errors';

import { generateHar } from '../http/har';
import type { EventsStore } from './events-store';

/**
 * Importing & exporting HAR files from anywhere in the app (⌘K and the desktop menu bar).
 * Problems come back as text for the caller to show, instead of in an alert().
 */

const HAR_FILE_TYPES = ['.har', 'application/har', 'application/har+json'];
// The first few schema errors explain the problem. A broken file can have thousands.
const MAX_LISTED_ERRORS = 5;

export const buildHarFilename = (now: number = Date.now()) =>
    `Wirepane_${dateFns.format(now, 'YYYY-MM-DD_HH-mm')}.har`;

export async function exportHarFile(events: ReadonlyArray<ViewableEvent>): Promise<void> {
    const harContent = JSON.stringify(await generateHar(events));
    saveFile(buildHarFilename(), 'application/har+json;charset=utf-8', harContent);
}

export interface HarImportProblem {
    title: string;
    message: string;
}

/**
 * Asks for a HAR file and adds its requests & responses to View. Resolves with a problem to
 * show if the file can't be imported. Like every file picker, it may never resolve if the
 * picker is cancelled.
 */
export async function importHarFile(
    eventsStore: Pick<EventsStore, 'loadFromHar'>
): Promise<HarImportProblem | undefined> {
    const fileContent = await uploadFile('text', HAR_FILE_TYPES);
    if (!fileContent) return undefined;

    let data: {};
    try {
        data = JSON.parse(fileContent);
    } catch (error) {
        return {
            title: "Couldn't read that file",
            message: `It isn't valid JSON, so it can't be a HAR file. ${(error as Error).message}`
        };
    }

    try {
        await eventsStore.loadFromHar(data);
        return undefined;
    } catch (error: any) {
        logError(error);

        if (error?.name === 'HARError' && Array.isArray(error.errors)) {
            const errors: Ajv.ErrorObject[] = error.errors;
            const listed = errors.slice(0, MAX_LISTED_ERRORS).map((e) => formatAjvError(data, e));
            const more = errors.length - listed.length;

            return {
                title: "That isn't a valid HAR file",
                message: [
                    ...listed,
                    ...(more > 0 ? [`…and ${more} more problem${more === 1 ? '' : 's'}.`] : [])
                ].join('\n')
            };
        }

        return {
            title: "Couldn't import that HAR file",
            message: error?.message ?? String(error)
        };
    }
}
