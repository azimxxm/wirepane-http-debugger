import * as _ from 'lodash';
import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { CheckCircle, Eye, EyeSlash, Lock, LockOpen, Trash } from '@phosphor-icons/react';

import { styled } from '../../styles';

import { CollectionsStore } from '../../model/collections/collections-store';
import {
    BrunoCollection,
    BrunoEnvironment,
    BrunoEnvironmentVariable,
    BrunoVariable
} from '../../model/collections/collection-types';

import { ActionButton } from '../common/action-button';
import { UnstyledButton } from '../common/inputs';
import { CollectionDialog, DialogTextInput, ErrorText, HintText, useDialogAction } from './dialog-frame';

interface DraftVariable {
    key: string;
    original?: BrunoEnvironmentVariable & BrunoVariable;
    originalText?: string;
    name: string;
    value: string;
    enabled: boolean;
    secret: boolean;
}

interface DraftEnvironment {
    key: string;
    name: string;
    variables: DraftVariable[];
}

// The list entry for the collection's own variables, which every environment can override
const COLLECTION_VARIABLES = 'collection';

// Names become file names on the server, so they can't have characters files can't
const INVALID_NAME_CHARACTERS = /[<>:"/\\|?*\u0000-\u001f\u007f]/;

let nextKey = 0;
const newKey = () => `draft-${nextKey++}`;

const variableText = (value: unknown) =>
    typeof value === 'string' ? value
    : value === undefined || value === null ? ''
    : typeof value === 'object' ? JSON.stringify(value)
    : String(value);

const toDraftVariable = (variable: BrunoEnvironmentVariable & BrunoVariable): DraftVariable => ({
    key: newKey(),
    original: variable,
    originalText: variableText(variable.value),
    name: variable.name ?? '',
    value: variableText(variable.value),
    enabled: variable.enabled !== false,
    secret: variable.secret === true
});

const emptyVariable = (name = '', secret = false): DraftVariable =>
    ({ key: newKey(), name, value: '', enabled: true, secret });

// Names like authToken, apiKey or password are usually secrets, so they start out as one
const looksSecret = (name: string) => /(token|secret|password|passwd|pwd|key|session|cookie|credential|auth)/i.test(name);

const isBlank = (variable: DraftVariable) => !variable.name.trim() && !variable.value;

// Keeps a value's original type (e.g. a number) when its text wasn't changed
const draftValue = (variable: DraftVariable): unknown =>
    variable.original && variable.value === variable.originalText ? variable.original.value : variable.value;

function toEnvironment(draft: DraftEnvironment, original: BrunoEnvironment | undefined): BrunoEnvironment {
    return {
        ...original,
        name: draft.name.trim(),
        variables: draft.variables.filter((variable) => !isBlank(variable)).map((variable) => ({
            ..._.pick(variable.original, ['uid']),
            name: variable.name.trim(),
            value: draftValue(variable),
            type: 'text',
            enabled: variable.enabled,
            secret: variable.secret
        }))
    };
}

const toCollectionVariables = (variables: DraftVariable[]): BrunoVariable[] =>
    variables.filter((variable) => !isBlank(variable)).map((variable) => ({
        ..._.omit(variable.original, ['secret', 'type']),
        name: variable.name.trim(),
        value: draftValue(variable),
        enabled: variable.enabled
    }));

function environmentNameProblem(name: string, otherNames: string[]): string | undefined {
    const trimmed = name.trim();
    if (!trimmed) return 'Environments need a name.';
    if (INVALID_NAME_CHARACTERS.test(trimmed)) return 'Names can\'t use < > : " / \\ | ? or *.';
    if (/^\./.test(trimmed) || /[. ]$/.test(trimmed)) return 'Names can\'t start with a dot or end with a dot or space.';
    if (otherNames.some((other) => other.trim().toLowerCase() === trimmed.toLowerCase())) {
        return `There's already an environment called “${trimmed}”.`;
    }
    return undefined;
}

function variablesProblem(variables: DraftVariable[]): string | undefined {
    const named = variables.filter((variable) => !isBlank(variable));
    if (named.some((variable) => !variable.name.trim())) return 'Every variable with a value needs a name.';

    const names = named.map((variable) => variable.name.trim());
    const repeated = names.find((name, index) => names.indexOf(name) !== index);
    return repeated ? `“${repeated}” is listed twice: keep one.` : undefined;
}

// --- Layout ---------------------------------------------------------------------------

const EditorLayout = styled.div`
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    min-height: 360px;
    border-radius: 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    overflow: hidden;
`;

const ListColumn = styled.div`
    padding: 8px;
    background-color: ${p => p.theme.mainLowlightBackground};
    border-right: 1px solid ${p => p.theme.containerBorder};

    display: flex;
    flex-direction: column;
    gap: 6px;
`;

const EnvironmentList = styled.div`
    display: flex;
    flex-direction: column;
    gap: 2px;
`;

const ListHeading = styled.p`
    padding: 10px 8px 4px;
    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const ListEntry = styled(UnstyledButton)<{ isSelected: boolean }>`
    height: 30px;
    padding: 0 8px;
    border-radius: 6px;

    display: flex;
    align-items: center;
    gap: 6px;
    text-align: left;

    > span {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    > svg {
        flex-shrink: 0;
        color: ${p => p.isSelected ? p.theme.selectionColor : p.theme.popColor};
    }

    ${p => p.isSelected
        ? `
            color: ${p.theme.selectionColor};
            background-color: ${p.theme.selectionBackground};
        `
        : `
            &:hover {
                background-color: ${p.theme.rowHover};
            }
        `
    }
`;

const EditorPane = styled.div`
    min-width: 0;
    padding: 12px 16px 16px;

    display: flex;
    flex-direction: column;
    gap: 12px;
`;

const PaneHeader = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;

    > input {
        flex: 1 1 auto;
    }
`;

const VariableGrid = styled.div`
    display: grid;
    grid-template-columns: 20px minmax(80px, 1fr) minmax(120px, 1.6fr) auto;
    align-items: center;
    gap: 6px 8px;
`;

const GridHeading = styled.span`
    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const ValueCell = styled.div`
    display: flex;
    align-items: center;
    gap: 4px;

    > input {
        flex: 1 1 auto;
        min-width: 0;
        font-family: ${p => p.theme.monoFontFamily};
    }
`;

const NameInput = styled(DialogTextInput)<{ isHighlighted: boolean }>`
    font-family: ${p => p.theme.monoFontFamily};

    ${p => p.isHighlighted && `
        border-color: ${p.theme.warningColor};
        background-color: ${p.theme.warningBackground};
    `}
`;

const RowButtons = styled.div`
    display: flex;
    align-items: center;
    gap: 2px;
`;

const SmallIconButton = styled(UnstyledButton)<{ isPressed?: boolean }>`
    width: 26px;
    height: 26px;
    border-radius: 6px;
    flex-shrink: 0;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.isPressed ? p.theme.popColor : p.theme.mainLowlightColor};
    background-color: ${p => p.isPressed ? p.theme.selectionInactiveBackground : 'transparent'};

    &:hover {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

const Checkbox = styled.input.attrs(() => ({ type: 'checkbox' }))`
    margin: 0;
    accent-color: ${p => p.theme.popColor};
`;

const AddButtonRow = styled.div`
    display: flex;
    gap: 8px;
`;

// --- Rows -------------------------------------------------------------------------------

const VariableRow = (props: {
    variable: DraftVariable,
    allowSecret: boolean,
    isHighlighted: boolean,
    autoFocus: boolean,
    onChange: (change: Partial<DraftVariable>) => void,
    onRemove: () => void
}) => {
    const { variable } = props;
    const [isRevealed, setRevealed] = React.useState(false);
    const isMasked = variable.secret && !isRevealed;
    // A row that already has its name starts at its value
    const focusValue = props.autoFocus && !!variable.name.trim();

    return <>
        <Checkbox
            checked={variable.enabled}
            title={variable.enabled ? 'Used when sending. Untick to turn it off.' : 'Turned off: tick to use it'}
            aria-label={`Use ${variable.name || 'this variable'}`}
            onChange={(event) => props.onChange({ enabled: event.target.checked })}
        />
        <NameInput
            value={variable.name}
            placeholder='name'
            aria-label='Variable name'
            isHighlighted={props.isHighlighted && !variable.value}
            autoFocus={props.autoFocus && !focusValue}
            spellCheck={false}
            onChange={(event) => props.onChange({ name: event.target.value })}
        />
        <ValueCell>
            <DialogTextInput
                type={isMasked ? 'password' : 'text'}
                autoFocus={focusValue}
                value={variable.value}
                placeholder={variable.secret ? 'secret value' : 'value'}
                aria-label={`Value of ${variable.name || 'this variable'}`}
                autoComplete='off'
                spellCheck={false}
                onChange={(event) => props.onChange({ value: event.target.value })}
            />
            { variable.secret && <SmallIconButton
                title={isRevealed ? 'Hide the value' : 'Show the value'}
                aria-label={isRevealed ? 'Hide the value' : 'Show the value'}
                onClick={() => setRevealed(!isRevealed)}
            >
                { isRevealed ? <EyeSlash size={16} /> : <Eye size={16} /> }
            </SmallIconButton> }
        </ValueCell>
        <RowButtons>
            { props.allowSecret && <SmallIconButton
                isPressed={variable.secret}
                aria-pressed={variable.secret}
                title={variable.secret
                    ? 'Secret: masked here, kept only on this Mac and never exported. Click to make it a normal value.'
                    : 'Mark as secret: masked, kept only on this Mac and never exported'}
                aria-label='Secret'
                onClick={() => props.onChange({ secret: !variable.secret })}
            >
                { variable.secret ? <Lock size={16} weight='fill' /> : <LockOpen size={16} /> }
            </SmallIconButton> }
            <SmallIconButton title='Remove this variable' aria-label='Remove this variable' onClick={props.onRemove}>
                <Trash size={16} />
            </SmallIconButton>
        </RowButtons>
    </>;
};

const VariableTable = (props: {
    variables: DraftVariable[],
    allowSecret: boolean,
    highlighted: string[],
    focusKey?: string,
    onChange: (variables: DraftVariable[]) => void
}) => {
    const update = (key: string, change: Partial<DraftVariable>) =>
        props.onChange(props.variables.map((variable) => variable.key === key ? { ...variable, ...change } : variable));

    return <VariableGrid>
        <span />
        <GridHeading>Name</GridHeading>
        <GridHeading>Value</GridHeading>
        <span />
        { props.variables.map((variable) =>
            <VariableRow
                key={variable.key}
                variable={variable}
                allowSecret={props.allowSecret}
                isHighlighted={props.highlighted.includes(variable.name.trim())}
                autoFocus={variable.key === props.focusKey}
                onChange={(change) => update(variable.key, change)}
                onRemove={() => props.onChange(props.variables.filter((other) => other.key !== variable.key))}
            />
        ) }
    </VariableGrid>;
};

// --- Dialog -----------------------------------------------------------------------------

function initialDrafts(collection: BrunoCollection) {
    return {
        environments: collection.environments.map((environment): DraftEnvironment => ({
            key: newKey(),
            name: environment.name,
            variables: environment.variables.map(toDraftVariable)
        })),
        collectionVariables: (collection.root?.request?.vars?.req ?? []).map(toDraftVariable)
    };
}

/**
 * Edits a collection's environments (name, value, secret) and its collection variables,
 * and picks the active environment. Changes are saved together.
 */
export const EnvironmentsDialog = observer((props: {
    collectionsStore: CollectionsStore,
    collection: BrunoCollection,
    highlightVariables?: string[],
    onClose: () => void
}) => {
    const { collectionsStore, collection } = props;
    const highlighted = props.highlightVariables ?? [];

    const [initial] = React.useState(() => initialDrafts(collection));
    const originals = React.useMemo(() => new Map(
        initial.environments.map((draft, index) => [draft.key, collection.environments[index]])
    ), [initial]);

    const activeIndex = collection.environments.findIndex((environment) =>
        environment === collectionsStore.activeEnvironment(collection)
    );
    const initialActiveKey = initial.environments[activeIndex]?.key;

    // Opened from an "unset variables" warning: the missing variables get empty rows in the
    // active environment (or a new one), where secrets can be kept off exports
    const [opening] = React.useState(() => {
        const missingRows = (variables: DraftVariable[]) => highlighted
            .filter((name) => !variables.some((variable) => variable.name.trim() === name))
            .map((name) => emptyVariable(name, looksSecret(name)));

        if (!highlighted.length) {
            return { environments: initial.environments, activeKey: initialActiveKey, focusKey: undefined };
        }

        const target = initial.environments.find((draft) => draft.key === initialActiveKey) ?? initial.environments[0];
        if (!target) {
            const added = missingRows([]);
            const draft: DraftEnvironment = { key: newKey(), name: 'Development', variables: added };
            return { environments: [draft], activeKey: draft.key, focusKey: added[0]?.key };
        }

        const added = missingRows(target.variables);
        const firstEmpty = target.variables.find((variable) => highlighted.includes(variable.name.trim()) && !variable.value);
        return {
            environments: initial.environments.map((draft) =>
                draft === target ? { ...draft, variables: [...draft.variables, ...added] } : draft
            ),
            activeKey: initialActiveKey ?? target.key,
            focusKey: (firstEmpty ?? added[0])?.key
        };
    });

    const [environments, setEnvironments] = React.useState(opening.environments);
    const [collectionVariables, setCollectionVariables] = React.useState(initial.collectionVariables);
    const [activeKey, setActiveKey] = React.useState<string | undefined>(opening.activeKey);
    const [selectedKey, setSelectedKey] = React.useState<string>(
        opening.activeKey ?? opening.environments[0]?.key ?? COLLECTION_VARIABLES
    );
    const [focusKey, setFocusKey] = React.useState<string | undefined>(opening.focusKey);

    const selectedEnvironment = environments.find((draft) => draft.key === selectedKey);
    const selectedVariables = selectedEnvironment?.variables ?? collectionVariables;

    const setSelectedVariables = (variables: DraftVariable[]) => {
        if (!selectedEnvironment) setCollectionVariables(variables);
        else setEnvironments(environments.map((draft) => draft.key === selectedKey ? { ...draft, variables } : draft));
    };

    const addVariable = () => {
        const variable = emptyVariable();
        setFocusKey(variable.key);
        setSelectedVariables([...selectedVariables, variable]);
    };

    const addEnvironment = () => {
        const names = environments.map((draft) => draft.name);
        let name = environments.length ? 'New environment' : 'Development';
        for (let counter = 2; names.some((other) => other.toLowerCase() === name.toLowerCase()); counter++) {
            name = `New environment ${counter}`;
        }
        const draft: DraftEnvironment = { key: newKey(), name, variables: [emptyVariable('baseUrl')] };
        setEnvironments([...environments, draft]);
        setSelectedKey(draft.key);
        if (!activeKey) setActiveKey(draft.key);
    };

    const removeEnvironment = (key: string) => {
        const remaining = environments.filter((draft) => draft.key !== key);
        setEnvironments(remaining);
        if (activeKey === key) setActiveKey(undefined);
        setSelectedKey(remaining[0]?.key ?? COLLECTION_VARIABLES);
    };

    const problem = environments.map((draft) =>
        environmentNameProblem(draft.name, environments.filter((other) => other !== draft).map((other) => other.name)) ??
        variablesProblem(draft.variables)
    ).find(Boolean) ?? variablesProblem(collectionVariables);

    const { start: save, isRunning, error } = useDialogAction(async () => {
        const activeName = environments.find((draft) => draft.key === activeKey)?.name.trim();
        await collectionsStore.saveVariables(
            collection.uid,
            environments.map((draft) => toEnvironment(draft, originals.get(draft.key))),
            toCollectionVariables(collectionVariables),
            activeName
        );
        props.onClose();
    });
    const canSave = !problem && !isRunning;

    return <CollectionDialog
        title={`Environments for ${collection.name}`}
        subtitle='Fill in {{variables}} per environment, e.g. a different baseUrl for staging and production. The active one is used when sending.'
        width={820}
        onClose={props.onClose}
        onSubmit={canSave ? save : undefined}
        footer={<>
            <span className='footer-note'>Secret values stay on this Mac and are never exported.</span>
            <ActionButton onClick={props.onClose}>Cancel</ActionButton>
            <ActionButton variant='primary' disabled={!canSave} onClick={save}>Save</ActionButton>
        </>}
    >
        <EditorLayout>
            <ListColumn>
                <EnvironmentList role='listbox' aria-label='Environments'>
                    <ListEntry
                        role='option'
                        aria-selected={selectedKey === COLLECTION_VARIABLES}
                        isSelected={selectedKey === COLLECTION_VARIABLES}
                        onClick={() => setSelectedKey(COLLECTION_VARIABLES)}
                    >
                        <span>Collection variables</span>
                    </ListEntry>

                    <ListHeading>Environments</ListHeading>
                    { environments.map((draft) =>
                        <ListEntry
                            key={draft.key}
                            role='option'
                            aria-selected={selectedKey === draft.key}
                            isSelected={selectedKey === draft.key}
                            title={draft.key === activeKey ? `${draft.name} (active)` : draft.name}
                            onClick={() => setSelectedKey(draft.key)}
                        >
                            <span>{ draft.name || 'Unnamed' }</span>
                            { draft.key === activeKey && <CheckCircle size={14} weight='fill' aria-label='Active' /> }
                        </ListEntry>
                    ) }
                </EnvironmentList>
                <ActionButton variant='ghost' icon='Plus' onClick={addEnvironment}>New environment</ActionButton>
            </ListColumn>

            <EditorPane>
                { selectedEnvironment
                    ? <PaneHeader>
                        <DialogTextInput
                            value={selectedEnvironment.name}
                            aria-label='Environment name'
                            spellCheck={false}
                            onChange={(event) => setEnvironments(environments.map((draft) =>
                                draft.key === selectedKey ? { ...draft, name: event.target.value } : draft
                            ))}
                        />
                        { activeKey === selectedKey
                            ? <ActionButton variant='ghost' icon='Check' disabled>Active</ActionButton>
                            : <ActionButton onClick={() => setActiveKey(selectedKey)}>Use this one</ActionButton>
                        }
                        <ActionButton
                            variant='ghost'
                            icon='Trash'
                            title='Delete this environment'
                            onClick={() => removeEnvironment(selectedKey)}
                        />
                    </PaneHeader>
                    : <HintText>
                        Used by every environment. When an environment sets the same name, its value wins.
                    </HintText>
                }

                <VariableTable
                    variables={selectedVariables}
                    allowSecret={!!selectedEnvironment}
                    highlighted={highlighted}
                    focusKey={focusKey}
                    onChange={setSelectedVariables}
                />
                <AddButtonRow>
                    <ActionButton variant='ghost' icon='Plus' onClick={addVariable}>Add variable</ActionButton>
                </AddButtonRow>

                { !environments.length && !selectedEnvironment && <HintText>
                    No environments yet. Add one to keep values like baseUrl and authToken apart per server.
                </HintText> }
            </EditorPane>
        </EditorLayout>

        { problem && <ErrorText role='alert'>{ problem }</ErrorText> }
        { error && <ErrorText role='alert'>{ error }</ErrorText> }
    </CollectionDialog>;
});
