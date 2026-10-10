import * as React from 'react';
import { observer } from 'mobx-react';

import { RequestInput } from '../../../model/send/send-request-model';

import { SendRequestBodyCard, SendRequestBodyProps } from '../send-request-body-card';

/**
 * The request body card in Send, with the body mode picker: the raw modes (Text, JSON, XML...)
 * use upstream's editor, and Form, Multipart, Binary and GraphQL have their own editors.
 */
export const SendBodyCard = observer((props: SendRequestBodyProps & {
    requestInput: RequestInput
}) => {
    const { requestInput, ...cardProps } = props;
    return <SendRequestBodyCard {...cardProps} />;
});
