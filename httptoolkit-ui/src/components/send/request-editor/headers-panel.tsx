import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { action } from 'mobx';

import { styled } from '../../../styles';
import { RawHeaders } from '../../../types';
import { RequestInput } from '../../../model/send/send-request-model';
import { getHeaderSuggestions, getValueSuggestions } from './headers/header-autocomplete';
import { PanelNote, PanelScroll } from './panel-layout';
import {
    FieldCellInput,
    FieldDeleteButton,
    FieldEnabledCheckbox,
    FieldRow,
    FieldTable,
    focusRowAfterRemoval,
    onFieldTableKeyDown
} from '../body/field-table';

// Grid: [Checkbox 20px] [Key 1.5fr] [Value 2fr] [Description 1.5fr] [Delete min-content]
const HEADER_COLUMNS = '20px minmax(0, 1.5fr) minmax(0, 2fr) minmax(0, 1.5fr) min-content';

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

const ToolbarActions = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
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

const TableHeaderRow = styled.div`
    display: grid;
    grid-template-columns: ${HEADER_COLUMNS};
    gap: 5px;
    align-items: center;
    padding-bottom: 6px;
    border-bottom: 1px solid ${p => p.theme.containerBorder};
    margin-bottom: 4px;
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
    user-select: none;
`;

const HeaderColTitle = styled.div`
    padding-left: 2px;
`;

const AutocompleteContainer = styled.div`
    position: relative;
    display: flex;
    flex-direction: column;
    width: 100%;
`;

const SuggestionsDropdown = styled.ul`
    position: absolute;
    top: 100%;
    left: 0;
    right: 0;
    min-width: 260px;
    max-height: 220px;
    overflow-y: auto;
    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    z-index: 1000;
    padding: 4px 0;
    margin: 2px 0 0;
    list-style: none;
`;

const SuggestionItem = styled.li<{ isSelected?: boolean }>`
    padding: 6px 12px;
    font-size: ${p => p.theme.smallPrintSize};
    font-family: ${p => p.theme.monoFontFamily};
    cursor: pointer;
    color: ${p => p.isSelected ? p.theme.popColor : p.theme.mainColor};
    background-color: ${p => p.isSelected ? p.theme.rowHover : 'transparent'};
    display: flex;
    align-items: center;
    justify-content: space-between;

    &:hover {
        background-color: ${p => p.theme.rowHover};
        color: ${p => p.theme.popColor};
    }
`;

const BulkTextarea = styled.textarea`
    width: 100%;
    min-height: 160px;
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

interface AutocompleteCellInputProps {
    value: string;
    placeholder?: string;
    ariaLabel?: string;
    invalid?: boolean;
    title?: string;
    getSuggestions: (input: string) => string[];
    onChange: (value: string) => void;
    onSelectSuggestion?: (value: string) => void;
    onAdvanceFocus?: () => void;
}

const AutocompleteCellInput = React.forwardRef<HTMLInputElement, AutocompleteCellInputProps>((props, forwardedRef) => {
    const {
        value,
        placeholder,
        ariaLabel,
        invalid,
        title,
        getSuggestions,
        onChange,
        onSelectSuggestion,
        onAdvanceFocus
    } = props;

    const [isOpen, setIsOpen] = React.useState(false);
    const [highlightedIndex, setHighlightedIndex] = React.useState<number>(-1);
    const inputRef = React.useRef<HTMLInputElement | null>(null);
    const dropdownRef = React.useRef<HTMLUListElement | null>(null);

    const setRef = (el: HTMLInputElement | null) => {
        inputRef.current = el;
        if (typeof forwardedRef === 'function') {
            forwardedRef(el);
        } else if (forwardedRef) {
            (forwardedRef as React.MutableRefObject<HTMLInputElement | null>).current = el;
        }
    };

    const suggestions = React.useMemo(() => {
        return getSuggestions(value);
    }, [value, getSuggestions]);

    React.useEffect(() => {
        if (!isOpen || suggestions.length === 0) {
            setHighlightedIndex(-1);
        } else if (highlightedIndex >= suggestions.length) {
            setHighlightedIndex(suggestions.length - 1);
        }
    }, [suggestions, isOpen]);

    React.useEffect(() => {
        if (isOpen && dropdownRef.current && highlightedIndex >= 0) {
            const items = dropdownRef.current.querySelectorAll('li');
            const item = items[highlightedIndex];
            if (item) {
                item.scrollIntoView({ block: 'nearest' });
            }
        }
    }, [highlightedIndex, isOpen]);

    const handleFocus = () => {
        const list = getSuggestions(value);
        if (list.length > 0) {
            setIsOpen(true);
            setHighlightedIndex(0);
        }
    };

    const handleBlur = () => {
        setIsOpen(false);
        setHighlightedIndex(-1);
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
        const nextVal = e.target.value;
        onChange(nextVal);
        const list = getSuggestions(nextVal);
        if (list.length > 0) {
            setIsOpen(true);
            setHighlightedIndex(0);
        } else {
            setIsOpen(false);
            setHighlightedIndex(-1);
        }
    };

    const selectItem = (chosen: string, advance: boolean) => {
        onChange(chosen);
        onSelectSuggestion?.(chosen);
        setIsOpen(false);
        setHighlightedIndex(-1);
        if (advance) {
            onAdvanceFocus?.();
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'ArrowDown') {
            if (isOpen && suggestions.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                setHighlightedIndex(prev => (prev < suggestions.length - 1 ? prev + 1 : 0));
            } else if (suggestions.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                setIsOpen(true);
                setHighlightedIndex(0);
            }
        } else if (e.key === 'ArrowUp') {
            if (isOpen && suggestions.length > 0) {
                e.preventDefault();
                e.stopPropagation();
                setHighlightedIndex(prev => (prev > 0 ? prev - 1 : suggestions.length - 1));
            }
        } else if (e.key === 'Enter') {
            if (isOpen && highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
                e.preventDefault();
                e.stopPropagation();
                selectItem(suggestions[highlightedIndex], true);
            } else {
                setIsOpen(false);
            }
        } else if (e.key === 'Tab') {
            if (isOpen && highlightedIndex >= 0 && highlightedIndex < suggestions.length) {
                selectItem(suggestions[highlightedIndex], false);
            } else {
                setIsOpen(false);
            }
        } else if (e.key === 'Escape') {
            if (isOpen) {
                e.preventDefault();
                e.stopPropagation();
                setIsOpen(false);
                setHighlightedIndex(-1);
            }
        }
    };

    return (
        <AutocompleteContainer>
            <FieldCellInput
                ref={setRef}
                value={value}
                placeholder={placeholder}
                aria-label={ariaLabel}
                invalid={invalid}
                title={title}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onChange={handleChange}
                onKeyDown={handleKeyDown}
            />
            {isOpen && suggestions.length > 0 && (
                <SuggestionsDropdown ref={dropdownRef}>
                    {suggestions.map((item, idx) => (
                        <SuggestionItem
                            key={item}
                            isSelected={idx === highlightedIndex}
                            onMouseEnter={() => setHighlightedIndex(idx)}
                            onMouseDown={(e) => {
                                e.preventDefault();
                                selectItem(item, true);
                            }}
                        >
                            {item}
                        </SuggestionItem>
                    ))}
                </SuggestionsDropdown>
            )}
        </AutocompleteContainer>
    );
});

interface HeaderEntry {
    id: string;
    key: string;
    value: string;
    enabled: boolean;
    description: string;
}

const HeaderRowComponent = observer((props: {
    entry: HeaderEntry | undefined;
    onChange: (change: Partial<HeaderEntry>) => void;
    onRemove: () => void;
}) => {
    const { entry, onChange, onRemove } = props;
    const isNew = !entry;
    const key = entry?.key ?? '';
    const value = entry?.value ?? '';
    const description = entry?.description ?? '';
    const enabled = entry?.enabled ?? true;
    const rowRef = React.useRef<HTMLDivElement>(null);

    const advanceToValue = () => {
        requestAnimationFrame(() => {
            const inputs = rowRef.current?.querySelectorAll<HTMLInputElement>('input[data-field-cell]');
            if (inputs && inputs[1]) {
                inputs[1].focus();
            }
        });
    };

    const advanceToDescription = () => {
        requestAnimationFrame(() => {
            const inputs = rowRef.current?.querySelectorAll<HTMLInputElement>('input[data-field-cell]');
            if (inputs && inputs[2]) {
                inputs[2].focus();
            }
        });
    };

    return (
        <FieldRow
            ref={rowRef}
            gridColumns={HEADER_COLUMNS}
            isDisabled={!isNew && !enabled}
            data-field-row={entry?.id ?? ''}
        >
            <FieldEnabledCheckbox
                enabled={enabled}
                fieldName={key}
                placeholder={isNew}
                onChange={(en) => onChange({ enabled: en })}
            />

            <AutocompleteCellInput
                value={key}
                placeholder="Key"
                ariaLabel="Header name"
                getSuggestions={getHeaderSuggestions}
                onChange={(k) => onChange({ key: k })}
                onAdvanceFocus={advanceToValue}
            />

            <AutocompleteCellInput
                value={value}
                placeholder="Value"
                ariaLabel={key ? `Value of ${key}` : 'Header value'}
                getSuggestions={(v) => getValueSuggestions(key, v)}
                onChange={(val) => onChange({ value: val })}
                onAdvanceFocus={advanceToDescription}
            />

            <FieldCellInput
                value={description}
                placeholder="Description"
                aria-label={key ? `Description of ${key}` : 'Header description'}
                onChange={(e) => onChange({ description: e.target.value })}
            />

            <FieldDeleteButton
                fieldName={key}
                placeholder={isNew}
                onClick={onRemove}
            />
        </FieldRow>
    );
});

export const HeadersPanel = observer((props: {
    requestInput: RequestInput;
    headers: RawHeaders;
    onChange: (headers: RawHeaders) => void;
}) => {
    const { requestInput, headers, onChange } = props;
    const [isBulkEdit, setIsBulkEdit] = React.useState(false);
    const [bulkText, setBulkText] = React.useState('');
    const [emptyRowId, setEmptyRowId] = React.useState(() => crypto.randomUUID());
    const tableRef = React.useRef<HTMLDivElement>(null);

    // Sync entries with requestInput.extras.headerRows or raw headers
    const entries: HeaderEntry[] = React.useMemo(() => {
        if (requestInput.extras.headerRows !== undefined) {
            return requestInput.extras.headerRows.map(row => ({
                id: row.id,
                key: row.name,
                value: row.value,
                enabled: row.enabled,
                description: row.description ?? ''
            }));
        }
        return headers.map(([key, value], idx) => ({
            id: `hdr-${idx}-${key}`,
            key,
            value,
            enabled: true,
            description: ''
        }));
    }, [requestInput.extras.headerRows, headers]);

    const syncToHeaders = action((newEntries: HeaderEntry[]) => {
        requestInput.extras.headerRows = newEntries.map(e => ({
            id: e.id,
            name: e.key,
            value: e.value,
            enabled: e.enabled,
            description: e.description
        }));

        const activeHeaders: RawHeaders = newEntries
            .filter(e => e.enabled && e.key.trim() !== '')
            .map(e => [e.key, e.value]);
        onChange(activeHeaders);
    });

    const onUpdateEntry = (index: number, change: Partial<HeaderEntry>) => {
        if (index === entries.length) {
            // Typing/selecting in placeholder row converts it into a real row
            const newEntry: HeaderEntry = {
                id: emptyRowId,
                key: '',
                value: '',
                enabled: true,
                description: '',
                ...change
            };
            syncToHeaders([...entries, newEntry]);
            setEmptyRowId(crypto.randomUUID());
        } else {
            const updated = [...entries];
            updated[index] = { ...updated[index], ...change };
            syncToHeaders(updated);
        }
    };

    const onRemoveEntry = (index: number) => {
        const updated = entries.filter((_, i) => i !== index);
        syncToHeaders(updated);
        focusRowAfterRemoval(tableRef.current, index);
    };

    const allEnabled = entries.length > 0 && entries.every(e => e.enabled);
    const toggleAllHeaders = (enabled: boolean) => {
        syncToHeaders(entries.map(e => ({ ...e, enabled })));
    };

    const toggleBulkEdit = () => {
        if (!isBulkEdit) {
            // Table -> Text
            const text = entries
                .filter(e => e.key.trim() !== '')
                .map(e => `${e.enabled ? '' : '// '}${e.key}: ${e.value}`)
                .join('\n');
            setBulkText(text);
            setIsBulkEdit(true);
        } else {
            // Text -> Table
            const lines = bulkText.split('\n');
            const newEntries: HeaderEntry[] = [];
            for (const line of lines) {
                const trimmed = line.trim();
                if (!trimmed) continue;
                const isCommented = trimmed.startsWith('//') || trimmed.startsWith('#');
                const clean = isCommented ? trimmed.replace(/^(\/\/|#)\s*/, '') : trimmed;
                const colonIdx = clean.indexOf(':');
                if (colonIdx > 0) {
                    newEntries.push({
                        id: crypto.randomUUID(),
                        key: clean.slice(0, colonIdx).trim(),
                        value: clean.slice(colonIdx + 1).trim(),
                        enabled: !isCommented,
                        description: ''
                    });
                }
            }
            syncToHeaders(newEntries);
            setIsBulkEdit(false);
        }
    };

    const applyPreset = (preset: 'json' | 'form' | 'clear') => {
        if (preset === 'clear') {
            syncToHeaders([]);
        } else if (preset === 'json') {
            syncToHeaders([
                { id: crypto.randomUUID(), key: 'Content-Type', value: 'application/json', enabled: true, description: '' },
                { id: crypto.randomUUID(), key: 'Accept', value: 'application/json', enabled: true, description: '' }
            ]);
        } else if (preset === 'form') {
            syncToHeaders([
                { id: crypto.randomUUID(), key: 'Content-Type', value: 'application/x-www-form-urlencoded', enabled: true, description: '' }
            ]);
        }
    };

    const rows = [
        ...entries.map((entry, index) => (
            <HeaderRowComponent
                key={entry.id}
                entry={entry}
                onChange={(change) => onUpdateEntry(index, change)}
                onRemove={() => onRemoveEntry(index)}
            />
        )),
        <HeaderRowComponent
            key={emptyRowId}
            entry={undefined}
            onChange={(change) => onUpdateEntry(entries.length, change)}
            onRemove={() => {}}
        />
    ];

    return (
        <PanelScroll>
            <ToolbarRow>
                <ToolbarTitle>Headers ({entries.filter(e => e.enabled && e.key).length})</ToolbarTitle>
                <ToolbarActions>
                    <ToolbarButton onClick={toggleBulkEdit}>
                        {isBulkEdit ? 'Key-Value Edit' : 'Bulk Edit'}
                    </ToolbarButton>
                    <ToolbarButton onClick={() => applyPreset('json')}>
                        JSON Preset
                    </ToolbarButton>
                    <ToolbarButton onClick={() => applyPreset('clear')}>
                        Clear
                    </ToolbarButton>
                </ToolbarActions>
            </ToolbarRow>

            {isBulkEdit ? (
                <BulkTextarea
                    placeholder={"Header-Name: Header-Value\n// Disabled-Header: Value"}
                    value={bulkText}
                    onChange={(e) => setBulkText(e.target.value)}
                />
            ) : (
                <FieldTable ref={tableRef} onKeyDown={onFieldTableKeyDown}>
                    <TableHeaderRow>
                        <FieldEnabledCheckbox
                            enabled={allEnabled}
                            fieldName="all headers"
                            placeholder={entries.length === 0}
                            onChange={toggleAllHeaders}
                        />
                        <HeaderColTitle>Key</HeaderColTitle>
                        <HeaderColTitle>Value</HeaderColTitle>
                        <HeaderColTitle>Description</HeaderColTitle>
                        <div />
                    </TableHeaderRow>
                    {rows}
                </FieldTable>
            )}

            <PanelNote>
                <code>Host</code> and <code>Content-Length</code> follow the URL and the body,
                until you change them yourself.
            </PanelNote>
        </PanelScroll>
    );
});
