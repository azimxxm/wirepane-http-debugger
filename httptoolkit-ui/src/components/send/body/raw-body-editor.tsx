import * as React from 'react';
import { observer } from 'mobx-react-lite';
import * as portals from 'react-reverse-portal';

import { RawHeaders } from '../../../types';
import { bufferToString, isProbablyUtf8, stringToBuffer } from '../../../util/buffer';

import { EditableContentType } from '../../../model/events/content-types';
import { EditableBody } from '../../../model/http/editable-body';

import { ContainerSizedEditor } from '../../editor/base-editor';
import { BodyCodingErrorBanner } from '../../editor/body-card-components';
import { SendEditorCardContent } from '../send-card-section';

// Text in the editor, as bytes: UTF-8, unless the body is binary already (as upstream's card)
export function rawBodyFromText(body: EditableBody, text: string): Buffer {
    return stringToBuffer(text, isProbablyUtf8(body.decoded) ? 'utf8' : 'binary');
}

/**
 * The raw body modes (Text, JSON, XML...): upstream's Monaco editor, shared through a portal.
 */
export const RawBodyEditor = observer((props: {
    body: EditableBody,
    headers: RawHeaders,
    contentType: EditableContentType,
    editorNode: portals.HtmlPortalNode<typeof ContainerSizedEditor>,
    onBodyUpdated: (body: Buffer) => void
}) => {
    const { body, onBodyUpdated } = props;
    const textEncoding = isProbablyUtf8(body.decoded) ? 'utf8' : 'binary';
    const onChange = React.useCallback(
        (text: string) => onBodyUpdated(stringToBuffer(text, textEncoding)),
        [onBodyUpdated, textEncoding]
    );

    return <>
        { body.latestEncodingResult.state === 'rejected' && <BodyCodingErrorBanner
            error={body.latestEncodingResult.value as Error}
            headers={props.headers}
            type='encoding'
        /> }

        <SendEditorCardContent showFullBorder={false}>
            <portals.OutPortal<typeof ContainerSizedEditor>
                node={props.editorNode}

                contentId='request'
                language={props.contentType}
                value={bufferToString(body.decoded, textEncoding)}
                onChange={onChange}
            />
        </SendEditorCardContent>
    </>;
});
