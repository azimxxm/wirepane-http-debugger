import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { CheckCircle, Folder } from '@phosphor-icons/react';

import { HttpExchangeView } from '../../types';
import { styled } from '../../styles';

import { CollectionsStore } from '../../model/collections/collections-store';
import { countByHost } from '../../model/collections/traffic-items';

import { ActionButton } from '../common/action-button';
import { CollectionDialog, ErrorText, HintText, SectionTitle, useDialogAction } from './dialog-frame';
import { CollectionPickerFields, usePickedTarget } from './collection-picker';

const HostList = styled.ul`
    border-radius: 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainLowlightBackground};
    max-height: 180px;
    overflow-y: auto;

    li {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;

        & + li {
            border-top: 1px solid ${p => p.theme.containerBorder};
        }
    }

    svg {
        flex-shrink: 0;
        color: ${p => p.theme.mainLowlightColor};
    }

    .host {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-family: ${p => p.theme.monoFontFamily};
    }

    .count {
        flex-shrink: 0;
        color: ${p => p.theme.mainLowlightColor};
        font-variant-numeric: tabular-nums;
    }
`;

const DoneSummary = styled.p`
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 600;

    svg {
        flex-shrink: 0;
        color: ${p => p.theme.popColor};
    }
`;

const WarningList = styled.ul`
    padding: 8px 12px 8px 28px;
    border-radius: 6px;
    list-style: disc;

    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.5;
    background-color: ${p => p.theme.warningBackground};
    border: 1px solid ${p => p.theme.warningColor};

    li + li {
        margin-top: 4px;
    }
`;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;

/**
 * Saves captured requests from View into a collection: one folder per host, and each
 * captured response kept as an example of its request.
 */
export const SaveTrafficDialog = observer((props: {
    collectionsStore: CollectionsStore,
    exchanges: HttpExchangeView[],
    onClose: () => void,
    onOpenInSend: () => void
}) => {
    const { collectionsStore, exchanges } = props;
    const hosts = React.useMemo(() => countByHost(exchanges), [exchanges]);
    const { state, picked } = usePickedTarget(collectionsStore, 'Captured traffic');
    const [done, setDone] = React.useState<{ collectionName: string, warnings: string[] } | undefined>();

    const { start: save, isRunning, error } = useDialogAction(async () => {
        const { collectionId, warnings } = await collectionsStore.saveExchanges(exchanges, picked.target);
        const collectionName = collectionsStore.summaries.find((summary) => summary.id === collectionId)?.name ?? 'the collection';
        setDone({ collectionName, warnings });
    });

    const title = `Save ${plural(exchanges.length, 'request')} to a collection`;

    if (done) {
        return <CollectionDialog
            title={title}
            width={520}
            onClose={props.onClose}
            onSubmit={props.onOpenInSend}
            footer={<>
                <ActionButton onClick={props.onClose}>Done</ActionButton>
                <ActionButton variant='primary' icon='PaperPlaneTilt' onClick={props.onOpenInSend}>
                    Open in Send
                </ActionButton>
            </>}
        >
            <DoneSummary aria-live='polite'>
                <CheckCircle size={18} weight='fill' />
                Saved { plural(exchanges.length, 'request') } to “{ done.collectionName }”, with their responses as examples.
            </DoneSummary>
            { done.warnings.length > 0 && <WarningList>
                { done.warnings.map((warning, index) => <li key={index}>{ warning }</li>) }
            </WarningList> }
        </CollectionDialog>;
    }

    return <CollectionDialog
        title={title}
        subtitle='Each captured response is kept as an example, so the requests stay documented.'
        width={520}
        onClose={props.onClose}
        onSubmit={picked.isValid && !isRunning ? save : undefined}
        footer={<>
            <ActionButton onClick={props.onClose}>Cancel</ActionButton>
            <ActionButton variant='primary' disabled={!picked.isValid || isRunning} onClick={save}>
                { isRunning ? 'Saving…' : 'Save' }
            </ActionButton>
        </>}
    >
        <CollectionPickerFields collectionsStore={collectionsStore} state={state} showFolders={false} />

        <SectionTitle>One folder per host</SectionTitle>
        <HostList>
            { hosts.map(({ host, count }) =>
                <li key={host}>
                    <Folder size={16} />
                    <span className='host'>{ host }</span>
                    <span className='count'>{ plural(count, 'request') }</span>
                </li>
            ) }
        </HostList>
        <HintText>
            Requests keep their headers, including cookies and auth, on this Mac only.
            Share replaces secrets with {'{{variables}}'}. Big response bodies are shortened.
        </HintText>
        { error && <ErrorText role='alert'>{ error }</ErrorText> }
    </CollectionDialog>;
});
