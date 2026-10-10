import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';

import { appHistory } from '../../routing';

import { CollectionsStore } from '../../model/collections/collections-store';
import { SendStore } from '../../model/send/send-store';

import { ConfirmDialog, NameDialog } from './simple-dialogs';
import { DocsDialog } from './docs-dialog';
import { EnvironmentsDialog } from './environments-dialog';
import { SaveRequestDialog } from './save-request-dialog';
import { SaveTrafficDialog } from './save-traffic-dialog';
import { ShareDialog } from './share-dialog';

/**
 * Shows the collections dialog that's open, if any. It's mounted once for the whole app,
 * as some dialogs open from View (saving captured traffic) and others from Send.
 */
export const CollectionsDialogs = inject('collectionsStore', 'sendStore')(observer((props: {
    collectionsStore?: CollectionsStore,
    sendStore?: SendStore
}) => {
    const collectionsStore = props.collectionsStore!;
    const { dialog, closeDialog } = collectionsStore;
    if (!dialog) return null;

    switch (dialog.kind) {
        case 'name':
            return <NameDialog
                title={dialog.title}
                label={dialog.label}
                initialValue={dialog.initialValue}
                submitLabel={dialog.submitLabel}
                onSubmit={dialog.onSubmit}
                onClose={closeDialog}
            />;
        case 'confirm':
            return <ConfirmDialog
                title={dialog.title}
                message={dialog.message}
                confirmLabel={dialog.confirmLabel}
                onConfirm={dialog.onConfirm}
                onClose={closeDialog}
            />;
        case 'save-request': {
            const sendRequest = props.sendStore!.sendRequests.find((request) => request.id === dialog.sendRequestId);
            if (!sendRequest) return null;
            return <SaveRequestDialog collectionsStore={collectionsStore} sendRequest={sendRequest} onClose={closeDialog} />;
        }
        case 'save-traffic':
            return <SaveTrafficDialog
                collectionsStore={collectionsStore}
                exchanges={dialog.exchanges}
                onClose={closeDialog}
                onOpenInSend={() => {
                    closeDialog();
                    appHistory.navigate('/send');
                }}
            />;
        case 'share':
            return <ShareDialog collectionsStore={collectionsStore} collectionId={dialog.collectionId} onClose={closeDialog} />;
        case 'environments': {
            const collection = collectionsStore.collections.get(dialog.collectionId);
            if (!collection) return null;
            return <EnvironmentsDialog
                key={collection.uid}
                collectionsStore={collectionsStore}
                collection={collection}
                highlightVariables={dialog.highlightVariables}
                onClose={closeDialog}
            />;
        }
        case 'docs':
            return <DocsDialog
                collectionsStore={collectionsStore}
                collectionId={dialog.collectionId}
                folderUid={dialog.folderUid}
                onClose={closeDialog}
            />;
    }
}));
