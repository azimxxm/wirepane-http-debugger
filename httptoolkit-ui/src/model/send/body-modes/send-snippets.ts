import * as _ from 'lodash';
import * as HTTPSnippet from '@httptoolkit/httpsnippet';
import type * as HarFormat from 'har-format';

import { generateHarRequest } from '../../http/har';
import { buildHtkRequest } from '../../http/http-exchange';
import { generateCodeSnippetFromRequestInput } from '../../ui/export';
import { simplifyHarRequestForSnippetExport } from '../../ui/snippet-export-sanitization';
import { SnippetOption } from '../../ui/snippet-formats';

import { buildSentExchangeRequest, RequestInput } from '../send-request-model';
import { buildRequestForSend } from '../build-request';

/**
 * "Copy as code snippet" for every Send body mode. Upstream's snippet reads the raw body, so
 * form, binary and GraphQL bodies are built first, as when sending. Multipart bodies become
 * HAR form params instead: a snippet can't hold the files, so it refers to them by name,
 * like `curl -F "image=@photo.png"`.
 */

function multipartParams(input: RequestInput): HarFormat.Param[] {
    const fields = input.extras.multipartFields.filter((field) => field.enabled && field.name !== '');

    return _.flatMap(fields, (field): HarFormat.Param[] => field.kind === 'text'
        ? [{
            name: field.name,
            value: field.value,
            ...(field.contentType ? { contentType: field.contentType } : {})
        }]
        : field.files.map((file) => ({
            name: field.name,
            fileName: file.name,
            contentType: field.contentType || file.contentType || 'application/octet-stream'
        }))
    );
}

function multipartSnippet(input: RequestInput, snippetFormat: SnippetOption): string {
    const sentRequest = buildSentExchangeRequest(input, { encodedLength: 0, decoded: Buffer.alloc(0) });
    const harRequest = generateHarRequest(buildHtkRequest(sentRequest), false, { bodySizeLimit: Infinity });
    harRequest.postData = {
        mimeType: 'multipart/form-data',
        params: multipartParams(input)
    };

    return new HTTPSnippet(simplifyHarRequestForSnippetExport(harRequest))
        .convert(snippetFormat.target, snippetFormat.client)
        .trim();
}

export async function generateSendSnippet(input: RequestInput, snippetFormat: SnippetOption): Promise<string> {
    if (input.extras.bodyMode === 'multipart') return multipartSnippet(input, snippetFormat);

    // Raw requests come back as they are
    return generateCodeSnippetFromRequestInput(await buildRequestForSend(input), snippetFormat);
}
