import * as React from 'react';
import { observer } from 'mobx-react';

import { SendRequest } from '../../../model/send/send-request-model';

/**
 * The left side of Send for a WebSocket request: URL and Connect, handshake headers and
 * the message composer with saved messages. Shown instead of the HTTP request pane.
 */
export const WebSocketRequestPane = observer((props: {
    sendRequest: SendRequest
}) => {
    return <div>WebSocket request</div>;
});
