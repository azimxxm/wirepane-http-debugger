import { action } from 'mobx';

import {
    EditableContentType,
    EditableContentTypes,
    getDefaultMimeType,
    getEditableContentType
} from '../../events/content-types';
import { getHeaderValue, removeHeader, setHeaderValue } from '../../http/headers';

import { RequestInput } from '../send-request-model';
import { FileRef, SendBodyMode } from '../send-extras';
import { multipartBoundaryOf, newMultipartBoundary } from '../build-request';

/**
 * The options of Send's body mode picker: upstream's raw types (Text, JSON, XML...), which
 * are edited as text, and the structured modes, which keep their own data in the tab's
 * extras and are only turned into a body when sending (build-request.ts).
 */

export type StructuredBodyMode = Exclude<SendBodyMode, 'raw'>;
export type BodyModeOption = EditableContentType | StructuredBodyMode;

export const STRUCTURED_BODY_MODES: readonly StructuredBodyMode[] = ['form', 'multipart', 'binary', 'graphql'];

export const BODY_MODE_OPTION_GROUPS: ReadonlyArray<{ label: string, options: readonly BodyModeOption[] }> = [
    { label: 'Text', options: EditableContentTypes },
    { label: 'Structured', options: STRUCTURED_BODY_MODES }
];

const OPTION_NAMES: { [option in BodyModeOption]: string } = {
    text: 'Text',
    json: 'JSON',
    xml: 'XML',
    html: 'HTML',
    css: 'CSS',
    javascript: 'JavaScript',
    form: 'Form',
    multipart: 'Multipart',
    binary: 'Binary',
    graphql: 'GraphQL'
};

export const getBodyModeOptionName = (option: BodyModeOption) => OPTION_NAMES[option];

export const isStructuredBodyMode = (option: string): option is StructuredBodyMode =>
    (STRUCTURED_BODY_MODES as readonly string[]).includes(option);

// What the picker shows for this request
export function getBodyModeOption(input: RequestInput): BodyModeOption {
    return input.extras.bodyMode === 'raw'
        ? input.requestContentType
        : input.extras.bodyMode;
}

const DEFAULT_BINARY_TYPE = 'application/octet-stream';

const binaryContentType = (file: FileRef | undefined) => file?.contentType || DEFAULT_BINARY_TYPE;

const baseMimeType = (contentType: string) => contentType.split(';')[0].trim().toLowerCase();

// Whether the tab's Content-Type already fits a structured mode, so it can stay as it is
function contentTypeFitsMode(contentType: string | undefined, mode: StructuredBodyMode): boolean {
    if (!contentType) return false;

    switch (mode) {
        case 'form':
            return baseMimeType(contentType) === 'application/x-www-form-urlencoded';
        case 'multipart':
            // A new boundary is only needed if there's none yet
            return !!multipartBoundaryOf(contentType);
        case 'graphql':
            return baseMimeType(contentType) === 'application/json';
        case 'binary':
            return false; // Always the file's own type
    }
}

function contentTypeForMode(input: RequestInput, mode: StructuredBodyMode): string {
    switch (mode) {
        case 'form':
            return 'application/x-www-form-urlencoded';
        case 'multipart':
            return `multipart/form-data; boundary=${newMultipartBoundary()}`;
        case 'binary':
            return binaryContentType(input.extras.binaryFile);
        case 'graphql':
            return 'application/json';
    }
}

// Back in a raw mode, the raw body is sent again, so it needs its Content-Length again
function restoreRawContentLength(input: RequestInput) {
    const { headers, rawBody } = input;
    if (getHeaderValue(headers, 'transfer-encoding')) return;

    if (rawBody.decoded.byteLength === 0) {
        removeHeader(headers, 'content-length');
    } else {
        // The encoded length, as upstream's sync uses, if the body has been encoded already
        const length = rawBody.latestEncodedLength ?? rawBody.decoded.byteLength;
        setHeaderValue(headers, 'content-length', length.toString());
    }
}

/**
 * Picks a body mode for the request, and updates its headers to match:
 * - a raw type from a raw type works as upstream (the header follows the format, if in sync);
 * - a structured mode sets its Content-Type and drops Content-Length, which is calculated
 *   when sending. GraphQL also turns GET into POST;
 * - a raw type from a structured mode sets that type's Content-Type, and Content-Length for
 *   the raw body (which was kept, untouched, while the other mode was used).
 */
export const selectBodyMode = action((input: RequestInput, option: BodyModeOption) => {
    const { extras, headers } = input;

    if (!isStructuredBodyMode(option)) {
        if (extras.bodyMode === 'raw') {
            input.requestContentType = option;
            return;
        }

        extras.bodyMode = 'raw';
        if (getEditableContentType(getHeaderValue(headers, 'content-type')) !== option) {
            setHeaderValue(headers, 'content-type', getDefaultMimeType(option));
        }
        input.requestContentType = option;
        restoreRawContentLength(input);
        return;
    }

    if (extras.bodyMode === option) return;
    extras.bodyMode = option;

    if (!contentTypeFitsMode(getHeaderValue(headers, 'content-type'), option)) {
        setHeaderValue(headers, 'content-type', contentTypeForMode(input, option));
    }
    removeHeader(headers, 'content-length');

    if (option === 'graphql' && input.method.toUpperCase() === 'GET') {
        input.method = 'POST';
    }
});

/**
 * Sets (or clears) the file of a binary body. The Content-Type follows the file, unless it
 * was changed by hand.
 */
export const setBinaryFile = action((input: RequestInput, file: FileRef | undefined) => {
    const { extras, headers } = input;
    const previousType = binaryContentType(extras.binaryFile);
    extras.binaryFile = file;

    if (extras.bodyMode !== 'binary') return;
    if (getHeaderValue(headers, 'content-type') === previousType) {
        setHeaderValue(headers, 'content-type', binaryContentType(file));
    }
});
