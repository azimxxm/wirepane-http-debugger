import * as React from 'react';
import { observer } from 'mobx-react-lite';

import { RawHeaders } from '../../../types';

import { EditableRawHeaders } from '../../common/editable-headers';
import { PanelNote, PanelScroll } from './panel-layout';

/**
 * The Headers tab: the editable headers table that the request headers card had, filling
 * the pane. Host and Content-Length still follow the URL and body (send-request-model.ts).
 */
export const HeadersPanel = observer((props: {
    headers: RawHeaders,
    onChange: (headers: RawHeaders) => void
}) => <PanelScroll>
    <EditableRawHeaders
        preserveKeyCase={true}
        headers={props.headers}
        onChange={props.onChange}
    />
    <PanelNote>
        <code>Host</code> and <code>Content-Length</code> follow the URL and the body,
        until you change them yourself.
    </PanelNote>
</PanelScroll>);
