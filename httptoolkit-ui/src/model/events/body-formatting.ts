import { Headers } from '../../types';
import { styled } from '../../styles';

import { ViewableContentType } from '../events/content-types';
import { ObservablePromise, observablePromise } from '../../util/observable';
import { bufferToString, bufferToHex } from '../../util/buffer';
import { MAX_HEX_VIEW_BYTES, decodeWithDeclaredCharset } from '../../util/body-text';

import type { WorkerFormatterKey } from '../../services/ui-worker-formatters';
import { formatBufferAsync } from '../../services/ui-worker-api';
import { ReadOnlyParams } from '../../components/common/editable-params';
import { ImageViewer } from '../../components/editor/image-viewer';
import { ExifBanner, ExifTags, parseImageExif } from '../../components/editor/exif-banner';
import { BinaryBodySummary } from '../../components/editor/binary-body-summary';
import { HexTruncation, HexTruncationBanner } from '../../components/editor/hex-truncation-banner';
import { formatJson, getJsonSyntax } from '../../util/json';

export interface EditorFormatter {
    language: string;
    cacheKey: symbol;
    isEditApplicable: boolean; // Can you apply this manually during editing to format an input?
    render(content: Buffer, headers?: Headers): string | ObservablePromise<string>;
}

type FormatComponentProps = {
    content: Buffer;
    rawContentType: string | undefined;
};

type FormatComponent = React.ComponentType<FormatComponentProps>;

type FormatComponentConfig = {
    layout: 'scrollable' | 'centered';
    Component: FormatComponent;
};

// Optional per-formatter metadata banner. Renders above the body editor at the
// card level (sibling of EditorCardContent), for read-only views only.
export interface FormatterMetadata<T> {
    cacheKey: symbol;
    extract: (content: Buffer, headers?: Headers) => Promise<T | undefined>;
    Component: React.ComponentType<{
        metadata: T,
        direction?: 'left' | 'right'
    }>;
}

type Formatter = (EditorFormatter | FormatComponentConfig) & {
    metadata?: FormatterMetadata<any>;
};

export function isEditorFormatter(input: any): input is EditorFormatter {
    return !!input.language;
}

const buildAsyncRenderer = (formatKey: WorkerFormatterKey) =>
    (input: Buffer, headers?: Headers) => observablePromise(
        formatBufferAsync(input, formatKey, headers)
    );

export const Formatters: { [key in ViewableContentType]: Formatter } = {
    raw: {
        language: 'hex',
        cacheKey: Symbol('raw'),
        isEditApplicable: false,
        render: (input: Buffer, headers?: Headers) => {
            if (input.byteLength < 2_000) {
                try {
                    // For short-ish inputs, we return synchronously - conveniently this avoids
                    // showing the loading spinner that churns the layout in short content cases.
                    return bufferToHex(input);
                } catch (e) {
                    return observablePromise(Promise.reject(e));
                }
            } else {
                return observablePromise(
                    formatBufferAsync(input, 'raw', headers)
                );
            }
        },
        // wirepane: big bodies are only shown in part (see MAX_HEX_VIEW_BYTES), so say so above the editor
        metadata: {
            cacheKey: Symbol('hex-truncation'),
            extract: async (content: Buffer) => content.byteLength > MAX_HEX_VIEW_BYTES
                ? { shown: MAX_HEX_VIEW_BYTES, total: content.byteLength }
                : undefined,
            Component: HexTruncationBanner
        } satisfies FormatterMetadata<HexTruncation>
    },
    text: {
        language: 'text',
        cacheKey: Symbol('text'),
        isEditApplicable: false,
        render: (input: Buffer, headers?: Headers) => {
            // wirepane: read it in the charset the response declares (e.g. windows-1251), not only UTF-8
            return decodeWithDeclaredCharset(input, headers) ?? bufferToString(input);
        }
    },
    base64: {
        language: 'text',
        cacheKey: Symbol('base64'),
        isEditApplicable: false,
        render: buildAsyncRenderer('base64')
    },
    markdown: {
        language: 'markdown',
        cacheKey: Symbol('markdown'),
        isEditApplicable: false,
        render: buildAsyncRenderer('markdown')
    },
    yaml: {
        language: 'yaml',
        cacheKey: Symbol('yaml'),
        isEditApplicable: false,
        render: buildAsyncRenderer('yaml')
    },
    html: {
        language: 'html',
        cacheKey: Symbol('html'),
        isEditApplicable: true,
        render: buildAsyncRenderer('html')
    },
    xml: {
        language: 'xml',
        cacheKey: Symbol('xml'),
        isEditApplicable: true,
        render: buildAsyncRenderer('xml')
    },
    json: {
        language: 'json',
        cacheKey: Symbol('json'),
        isEditApplicable: true,
        render: (input: Buffer, headers?: Headers) => {
            if (input.byteLength < 10_000) {
                const inputAsString = decodeWithDeclaredCharset(input, headers) ?? bufferToString(input);
                // wirepane: reformatting text that isn't JSON changes it, so it's shown as sent
                return getJsonSyntax(inputAsString) === 'not-json'
                    ? inputAsString
                    : formatJson(inputAsString, { formatRecords: false });
            } else {
                return observablePromise(
                    formatBufferAsync(input, 'json', headers)
                );
            }
        }
    },
    'json-records': {
        language: 'json-records',
        cacheKey: Symbol('json-records'),
        isEditApplicable: false,
        render: (input: Buffer, headers?: Headers) => {
            if (input.byteLength < 10_000) {
                const inputAsString = decodeWithDeclaredCharset(input, headers) ?? bufferToString(input);
                return formatJson(inputAsString, { formatRecords: true });
            } else {
                return observablePromise(
                    formatBufferAsync(input, 'json-records', headers)
                );
            }
        }
    },
    javascript: {
        language: 'javascript',
        cacheKey: Symbol('javascript'),
        isEditApplicable: true,
        render: buildAsyncRenderer('javascript')
    },
    css: {
        language: 'css',
        cacheKey: Symbol('css'),
        isEditApplicable: true,
        render: buildAsyncRenderer('css')
    },
    protobuf: {
        language: 'protobuf',
        cacheKey: Symbol('protobuf'),
        isEditApplicable: false,
        render: buildAsyncRenderer('protobuf')
    },
    'grpc-proto': {
        language: 'protobuf',
        cacheKey: Symbol('grpc-proto'),
        isEditApplicable: false,
        render: buildAsyncRenderer('grpc-proto')
    },
    'url-encoded': {
        layout: 'scrollable',
        Component: styled(ReadOnlyParams).attrs((p: FormatComponentProps) => ({
            content: bufferToString(p.content)
        }))`
            padding: 5px;
        ` as FormatComponent
    },
    image: {
        layout: 'centered',
        Component: ImageViewer,
        metadata: {
            cacheKey: Symbol('image-exif'),
            extract: parseImageExif,
            Component: ExifBanner
        } satisfies FormatterMetadata<ExifTags>
    },
    // wirepane: the default for big binary bodies, see getCompatibleTypes
    summary: {
        layout: 'scrollable',
        Component: BinaryBodySummary
    }
};
