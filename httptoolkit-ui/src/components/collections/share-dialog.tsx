import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { CheckCircle, ShieldCheck, Warning } from '@phosphor-icons/react';

import { styled } from '../../styles';
import { saveFile } from '../../util/ui';
import { getReadableSize } from '../../util/buffer';

import { CollectionsStore } from '../../model/collections/collections-store';
import { ExportFormat, ExportResult, RedactionEntry } from '../../model/collections/collection-types';

import { ActionButton } from '../common/action-button';
import { CollectionDialog, ErrorText, HintText, SectionTitle } from './dialog-frame';

const FORMATS: ReadonlyArray<{ format: ExportFormat, title: string, hint: string }> = [
    {
        format: 'postman',
        title: 'Postman Collection v2.1 (.json)',
        hint: 'Opens in Wirepane, Postman, Bruno, Insomnia and Hoppscotch. Environments stay out: receivers set variables like baseUrl themselves.'
    },
    {
        format: 'bruno',
        title: 'Bruno folder (.zip)',
        hint: 'For Git: one readable .bru file per request, the files that requests send, and the environments (without secret values).'
    }
];

const FormatList = styled.div`
    display: flex;
    flex-direction: column;
    gap: 8px;
`;

const FormatOption = styled.label<{ isChosen: boolean }>`
    display: grid;
    grid-template-columns: auto 1fr;
    gap: 2px 10px;
    padding: 10px 12px;
    border-radius: 8px;
    cursor: pointer;

    border: 1px solid ${p => p.isChosen ? p.theme.popColor : p.theme.containerBorder};
    background-color: ${p => p.isChosen ? p.theme.mainBackground : 'transparent'};

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    input {
        grid-row: span 2;
        margin: 2px 0 0;
        accent-color: ${p => p.theme.popColor};
    }

    strong {
        font-weight: 600;
    }

    span {
        color: ${p => p.theme.mainLowlightColor};
    }
`;

// What the chosen format leaves out, e.g. files and WebSocket requests in Postman JSON
const WarningList = styled.ul`
    padding: 8px 10px;
    border-radius: 6px;
    border: 1px solid ${p => p.theme.warningColor};
    background-color: ${p => p.theme.warningBackground};

    display: flex;
    flex-direction: column;
    gap: 6px;

    li {
        display: flex;
        align-items: flex-start;
        gap: 8px;

        font-size: ${p => p.theme.textInputFontSize};
        line-height: 1.45;
        color: ${p => p.theme.mainColor};
    }

    svg {
        flex-shrink: 0;
        margin-top: 2px;
        color: ${p => p.theme.warningColor};
    }
`;

const ReportBox = styled.section`
    padding: 12px 14px;
    border-radius: 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainLowlightBackground};

    display: flex;
    flex-direction: column;
    gap: 8px;
`;

const ReportSummary = styled.p`
    display: flex;
    align-items: center;
    gap: 8px;

    font-weight: 600;

    svg {
        flex-shrink: 0;
        color: ${p => p.theme.popColor};
    }

    code {
        font-family: ${p => p.theme.monoFontFamily};
        font-weight: 500;
    }
`;

const ReportTable = styled.table`
    width: 100%;
    border-collapse: collapse;
    font-size: ${p => p.theme.smallPrintSize};

    th, td {
        padding: 4px 8px 4px 0;
        text-align: left;
        vertical-align: top;
        border-bottom: 1px solid ${p => p.theme.containerBorder};
    }

    th {
        font-weight: 500;
        color: ${p => p.theme.mainLowlightColor};
    }

    td:last-child {
        font-family: ${p => p.theme.monoFontFamily};
        white-space: nowrap;
    }
`;

const ReportScroller = styled.div`
    max-height: 220px;
    overflow-y: auto;
`;

const FileLine = styled.p`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};

    code {
        font-family: ${p => p.theme.monoFontFamily};
        color: ${p => p.theme.mainColor};
    }
`;

const uniqueVariables = (report: RedactionEntry[]) => Array.from(new Set(report.map((entry) => entry.variable)));

const RedactionReport = (props: { report: RedactionEntry[] }) => {
    const { report } = props;

    if (!report.length) {
        return <ReportBox aria-live='polite'>
            <ReportSummary><CheckCircle size={18} weight='fill' /> No secrets found in this collection.</ReportSummary>
            <HintText>
                Auth headers, cookies, API keys and tokens would be replaced with {'{{variables}}'}.
                Values you marked secret in an environment never leave this Mac.
            </HintText>
        </ReportBox>;
    }

    const variables = uniqueVariables(report);
    const shownVariables = variables.slice(0, 4).map((variable) => `{{${variable}}}`).join(', ');
    const more = variables.length > 4 ? ` and ${variables.length - 4} more` : '';

    return <ReportBox aria-live='polite'>
        <ReportSummary>
            <ShieldCheck size={18} weight='fill' />
            <span>
                { report.length } secret{ report.length === 1 ? '' : 's' } removed → <code>{ shownVariables }</code>{ more }
            </span>
        </ReportSummary>
        <ReportScroller>
            <ReportTable>
                <thead>
                    <tr><th>Where</th><th>Name</th><th>Replaced with</th></tr>
                </thead>
                <tbody>
                    { report.map((entry, index) =>
                        <tr key={index}>
                            <td>{ entry.location }</td>
                            <td>{ entry.name }</td>
                            <td>{ `{{${entry.variable}}}` }</td>
                        </tr>
                    ) }
                </tbody>
            </ReportTable>
        </ReportScroller>
        <HintText>
            The file only has these {'{{placeholders}}'}: receivers fill them in from their own
            environment. Your values stay on this Mac, and values you marked secret are never exported.
        </HintText>
    </ReportBox>;
};

const contentBytes = (result: ExportResult) =>
    Buffer.from(result.content, result.encoding === 'base64' ? 'base64' : 'utf8');

/**
 * Shares a collection as one file. The export (and so the redaction report) is built
 * as soon as a format is picked, so the user sees what was removed before saving.
 */
export const ShareDialog = observer((props: {
    collectionsStore: CollectionsStore,
    collectionId: string,
    onClose: () => void
}) => {
    const { collectionsStore, collectionId } = props;
    const summary = collectionsStore.summaries.find((candidate) => candidate.id === collectionId);

    const [format, setFormat] = React.useState<ExportFormat>('postman');
    const [exports, setExports] = React.useState<{ [F in ExportFormat]?: ExportResult }>({});
    const [error, setError] = React.useState<string | undefined>();

    React.useEffect(() => {
        if (exports[format]) return;

        let isCurrent = true;
        setError(undefined);
        collectionsStore.exportCollection(collectionId, format).then((result) => {
            if (isCurrent) setExports((previous) => ({ ...previous, [format]: result }));
        }, (e: unknown) => {
            if (isCurrent) setError(e instanceof Error ? e.message : String(e));
        });
        return () => { isCurrent = false; };
    }, [format, collectionId]);

    const result = exports[format];
    const size = result ? getReadableSize(contentBytes(result)) : undefined;

    const save = () => {
        if (!result) return;
        saveFile(result.fileName, result.mimeType, contentBytes(result));
        props.onClose();
    };

    return <CollectionDialog
        title={`Share ${summary?.name ?? 'collection'}`}
        subtitle='Send one file through Telegram, email or Git. Whoever imports it into Wirepane gets the requests with their docs and examples, ready to use.'
        width={620}
        onClose={props.onClose}
        onSubmit={save}
        footer={<>
            <ActionButton onClick={props.onClose}>Cancel</ActionButton>
            <ActionButton variant='primary' icon='DownloadSimple' disabled={!result} onClick={save}>
                Save file…
            </ActionButton>
        </>}
    >
        <SectionTitle>Format</SectionTitle>
        <FormatList role='radiogroup' aria-label='Format'>
            { FORMATS.map((option) =>
                <FormatOption key={option.format} isChosen={option.format === format}>
                    <input
                        type='radio'
                        name='share-format'
                        checked={option.format === format}
                        onChange={() => setFormat(option.format)}
                    />
                    <strong>{ option.title }</strong>
                    <span>{ option.hint }</span>
                </FormatOption>
            ) }
        </FormatList>

        { result && result.warnings?.length > 0 && <WarningList aria-live='polite'>
            { result.warnings.map((warning) =>
                <li key={warning}><Warning size={16} weight='fill' aria-hidden={true} />{ warning }</li>
            ) }
        </WarningList> }

        <SectionTitle>Secrets</SectionTitle>
        { error && <ErrorText role='alert'>Couldn't build the file: { error }</ErrorText> }
        { !error && !result && <HintText aria-live='polite'>Checking the collection for secrets…</HintText> }
        { result && <RedactionReport report={result.redactionReport} /> }

        { result && <FileLine>
            Saves <code>{ result.fileName }</code>{ size ? `, ${size}` : '' }
        </FileLine> }
    </CollectionDialog>;
});
