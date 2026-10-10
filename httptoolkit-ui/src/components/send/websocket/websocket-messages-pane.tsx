import * as React from 'react';
import { observer } from 'mobx-react';

import { SendRequest } from '../../../model/send/send-request-model';

/**
 * The right side of Send for a WebSocket request: connection status and the log of sent
 * and received messages. Shown instead of the HTTP response pane.
 */
export const WebSocketMessagesPane = observer((props: {
    sendRequest: SendRequest
}) => {
    return <div>WebSocket messages</div>;
});
