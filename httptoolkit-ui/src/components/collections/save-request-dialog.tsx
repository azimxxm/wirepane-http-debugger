import * as React from 'react';
import { observer } from 'mobx-react-lite';

import { formatShortcut } from '../../util/shortcuts';

import { CollectionsStore } from '../../model/collections/collections-store';
import { defaultRequestName } from '../../model/collections/request-mapping';
import { SendRequest } from '../../model/send/send-request-model';

import { ActionButton } from '../common/action-button';
import {
    CollectionDialog,
    DialogTextInput,
    ErrorText,
    FieldRow,
    HintText,
    useDialogAction
} from './dialog-frame';
import { CollectionPickerFields, usePickedTarget } from './collection-picker';

/**
 * Saves a Send tab that isn't from a collection yet: picks the collection, folder and
 * name. Afterwards, the tab is linked to the new request and saves with ⌘S.
 */
export const SaveRequestDialog = observer((props: {
    collectionsStore: CollectionsStore,
    sendRequest: SendRequest,
    onClose: () => void
}) => {
    const { collectionsStore, sendRequest } = props;
    const { request } = sendRequest;

    const [name, setName] = React.useState(() =>
        request.url ? defaultRequestName(request.method, request.url) : 'New request'
    );
    const { state, picked } = usePickedTarget(collectionsStore, 'My API');
    const nameRef = React.useRef<HTMLInputElement>(null);
    React.useEffect(() => nameRef.current?.select(), []);

    const { start: save, isRunning, error } = useDialogAction(async () => {
        await collectionsStore.saveTabAs(sendRequest, picked.target, name.trim());
        props.onClose();
    });
    const canSave = picked.isValid && !!name.trim() && !isRunning;

    return <CollectionDialog
        title='Save request'
        subtitle='Keep this request, with its headers, body and docs, in a collection you can share.'
        width={500}
        onClose={props.onClose}
        onSubmit={canSave ? save : undefined}
        footer={<>
            <ActionButton onClick={props.onClose}>Cancel</ActionButton>
            <ActionButton variant='primary' disabled={!canSave} onClick={save}>Save</ActionButton>
        </>}
    >
        <FieldRow>
            <span>Request name</span>
            <DialogTextInput
                ref={nameRef}
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                spellCheck={false}
            />
        </FieldRow>
        <CollectionPickerFields collectionsStore={collectionsStore} state={state} showFolders={true} />

        <HintText>
            After this, { formatShortcut('Cmd+S') } saves changes to the same request.
            Auth headers and cookies stay on this Mac: Share replaces them with {'{{variables}}'}.
        </HintText>
        { error && <ErrorText role='alert'>{ error }</ErrorText> }
    </CollectionDialog>;
});
