import * as React from 'react';
import { observer } from 'mobx-react';

import { RequestInput } from '../../../model/send/send-request-model';

/**
 * The GraphQL body editor: query, variables, schema introspection, autocomplete and docs.
 * Edits requestInput.extras.graphql.
 */
export const GraphqlBodyEditor = observer((props: {
    requestInput: RequestInput
}) => {
    return <div>GraphQL editor</div>;
});
