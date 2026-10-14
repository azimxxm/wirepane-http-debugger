import * as React from 'react';
import { observer } from 'mobx-react-lite';

import { styled } from '../../../styles';

import { QueryParam } from '../../../model/send/send-extras';
import { RequestInput } from '../../../model/send/send-request-model';
import { getQueryParams, setQueryParams } from '../../../model/send/params/query-params';
import { decodePathValue, getPathParams, PathParam, setPathParamValue } from '../../../model/send/params/path-params';

import {
    FieldCellInput,
    FieldDeleteButton,
    FieldEnabledCheckbox,
    FieldRow,
    FieldTable,
    focusRowAfterRemoval,
    onFieldTableKeyDown
} from '../body/field-table';
import { PanelNote, PanelScroll, PanelSection, PanelSectionHeading } from './panel-layout';

// Grid: [Checkbox 20px] [Name 1fr] [Value 2fr] [Description 1.5fr] [Delete min-content]
const PARAM_COLUMNS = '20px minmax(0, 1fr) minmax(0, 2fr) minmax(0, 1.5fr) min-content';

const ToolbarRow = styled.div`
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
`;

const ToolbarTitle = styled.div`
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const ToolbarButton = styled.button.attrs(() => ({ type: 'button' }))`
    background: none;
    border: none;
    color: ${p => p.theme.popColor};
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 500;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }
`;

const BulkTextarea = styled.textarea`
    width: 100%;
    min-height: 140px;
    border-radius: 4px;
    padding: 10px;
    box-sizing: border-box;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    resize: vertical;

    &:focus {
        outline: none;
        border-color: ${p => p.theme.popColor};
    }
`;

const PathParamName = styled.div`
    height: 30px;
    padding: 0 11px;
    overflow: hidden;

    display: flex;
    align-items: center;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.mainLowlightColor};
    white-space: nowrap;
    text-overflow: ellipsis;
`;

// One query param, or (with no param) the empty last row, which adds one when typed into
const QueryParamRow = (props: {
    param: QueryParam | undefined,
    onChange: (change: Partial<QueryParam>) => void,
    onRemove: () => void
}) => {
    const { param } = props;
    const name = param?.name ?? '';

    return <FieldRow
        gridColumns={PARAM_COLUMNS}
        isDisabled={!!param && !param.enabled}
        data-field-row=''
    >
        <FieldEnabledCheckbox
            enabled={param?.enabled ?? true}
            fieldName={name}
            placeholder={!param}
            onChange={(enabled) => props.onChange({ enabled })}
        />
        <FieldCellInput
            value={name}
            placeholder='Name'
            aria-label='Query param name'
            onChange={(event) => props.onChange({ name: event.target.value })}
        />
        <FieldCellInput
            value={param?.value ?? ''}
            placeholder='Value'
            aria-label={name ? `Value of ${name}` : 'Query param value'}
            onChange={(event) => props.onChange({ value: event.target.value })}
        />
        <FieldCellInput
            value={param?.description ?? ''}
            placeholder='Description'
            aria-label={name ? `Description of ${name}` : 'Query param description'}
            onChange={(event) => props.onChange({ description: event.target.value })}
        />
        <FieldDeleteButton
            fieldName={name}
            placeholder={!param}
            onClick={props.onRemove}
        />
    </FieldRow>;
};

const PathParamRow = (props: {
    param: PathParam,
    onChange: (value: string) => void
}) => {
    const { name, value } = props.param;

    return <FieldRow gridColumns={PARAM_COLUMNS} data-field-row=''>
        <span />
        <PathParamName title={`:${name} in the URL's path`}>:{ name }</PathParamName>
        <FieldCellInput
            value={decodePathValue(value)}
            placeholder='Value'
            aria-label={`Value of path param ${name}`}
            onChange={(event) => props.onChange(event.target.value)}
        />
        <span />
        <FieldDeleteButton fieldName={name} placeholder={true} onClick={() => {}} />
    </FieldRow>;
};

/**
 * The Params tab: the URL's query params as a table that edits the URL (and follows it as
 * it's typed), plus the path's :name params when it has some.
 */
export const ParamsPanel = observer((props: { requestInput: RequestInput }) => {
    const { requestInput } = props;
    const tableRef = React.useRef<HTMLDivElement>(null);
    const headingId = React.useId();
    const [isBulkEdit, setIsBulkEdit] = React.useState(false);
    const [bulkText, setBulkText] = React.useState('');

    const params = getQueryParams(requestInput.url, requestInput.extras.queryParams);
    const pathParams = getPathParams(requestInput.url, requestInput.extras.pathTemplate);

    const updateParam = (index: number, change: Partial<QueryParam>) => {
        setQueryParams(requestInput, index === params.length
            ? [...params, { name: '', value: '', enabled: true, ...change }]
            : params.map((param, i) => i === index ? { ...param, ...change } : param)
        );
    };

    const removeParam = (index: number) => {
        setQueryParams(requestInput, params.filter((_param, i) => i !== index));
        focusRowAfterRemoval(tableRef.current, index);
    };

    const toggleBulkEdit = () => {
        if (!isBulkEdit) {
            const text = params
                .filter(p => p.name.trim() !== '')
                .map(p => `${p.enabled ? '' : '// '}${p.name}: ${p.value}`)
                .join('\n');
            setBulkText(text);
            setIsBulkEdit(true);
        } else {
            const lines = bulkText.split('\n');
            const newParams: QueryParam[] = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const isCommented = trimmed.startsWith('//') || trimmed.startsWith('#');
                const clean = isCommented ? trimmed.replace(/^(\/\/|#)\s*/, '') : trimmed;
                const colonIdx = clean.indexOf(':');
                if (colonIdx > 0) {
                    newParams.push({
                        name: clean.slice(0, colonIdx).trim(),
                        value: clean.slice(colonIdx + 1).trim(),
                        enabled: !isCommented,
                        description: ''
                    });
                }
            }
            setQueryParams(requestInput, newParams);
            setIsBulkEdit(false);
        }
    };

    // Rows are keyed by position, so the empty last row keeps its inputs (and the focus)
    // when typing turns it into a param
    const rows = [...params, undefined].map((param, index) =>
        <QueryParamRow
            key={index}
            param={param}
            onChange={(change) => updateParam(index, change)}
            onRemove={() => removeParam(index)}
        />
    );

    return <PanelScroll>
        <PanelSection aria-labelledby={`${headingId}-query`}>
            <ToolbarRow>
                <ToolbarTitle id={`${headingId}-query`}>Query params ({params.filter(p => p.enabled && p.name).length})</ToolbarTitle>
                <ToolbarButton onClick={toggleBulkEdit}>
                    {isBulkEdit ? 'Key-Value Edit' : 'Bulk Edit'}
                </ToolbarButton>
            </ToolbarRow>

            {isBulkEdit ? (
                <BulkTextarea
                    placeholder={"param_name: param_value\n// disabled_param: value"}
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                />
            ) : (
                <FieldTable ref={tableRef} onKeyDown={onFieldTableKeyDown}>
                    { rows }
                </FieldTable>
            )}
        </PanelSection>

        { pathParams.length > 0 && <PanelSection aria-labelledby={`${headingId}-path`}>
            <PanelSectionHeading id={`${headingId}-path`}>Path params</PanelSectionHeading>
            <FieldTable onKeyDown={onFieldTableKeyDown}>
                { pathParams.map((param, index) =>
                    <PathParamRow
                        key={index}
                        param={param}
                        onChange={(value) => setPathParamValue(requestInput, index, value)}
                    />
                ) }
            </FieldTable>
        </PanelSection> }

        <PanelNote>
            { params.length === 0 && pathParams.length === 0
                ? <>Params you add here go after <code>?</code> in the URL, and params typed in the
                    URL show up here. A part of the path like <code>/users/:id</code> becomes a path param.</>
                : <>Values are sent as written, <code>{'{{variables}}'}</code> included. Untick a
                    param to leave it out of the URL but keep it here.</>
            }
        </PanelNote>
    </PanelScroll>;
});
