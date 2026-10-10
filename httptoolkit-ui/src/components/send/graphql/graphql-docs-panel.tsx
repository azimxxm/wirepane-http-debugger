import * as React from 'react';
import { action, computed, observable, reaction } from 'mobx';
import { disposeOnUnmount, observer } from 'mobx-react';
import { ArrowLeft, MagnifyingGlass, X } from '@phosphor-icons/react';
import {
    astFromValue,
    GraphQLArgument,
    GraphQLInputType,
    GraphQLNamedType,
    GraphQLSchema,
    GraphQLType,
    isEnumType,
    isInputObjectType,
    isInterfaceType,
    isListType,
    isNonNullType,
    isObjectType,
    isUnionType,
    print
} from 'graphql';

import { css, styled } from '../../../styles';
import { UnstyledButton } from '../../common/inputs';
import { Markdown } from '../../common/text-content';
import {
    fieldsOf,
    rootTypes,
    SchemaField,
    schemaTypes,
    searchSchema,
    typeKindLabel
} from '../../../model/send/graphql/schema-docs';

/**
 * The schema docs: root types, then types, fields and arguments with their descriptions,
 * and a search over type and field names.
 */

interface DocsLocation {
    typeName: string;
    fieldName?: string;
}

const PanelContainer = styled.aside<{ overlay: boolean }>`
    flex: 0 0 300px;
    min-width: 200px;
    max-width: 40%;
    min-height: 0;

    /* In a very narrow card the docs float over the editors, which are too narrow to share */
    ${p => p.overlay && css`
        position: absolute;
        top: 0;
        right: 0;
        bottom: 0;
        z-index: 2;
        width: min(320px, 100%);
        max-width: none;
        box-shadow: ${p.theme.floatingShadow};
    `}

    display: flex;
    flex-direction: column;

    border-left: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};
    font-size: ${p => p.theme.textInputFontSize};
`;

const PanelHeader = styled.div`
    flex-shrink: 0;
    height: 36px;
    padding: 0 4px 0 8px;

    display: flex;
    align-items: center;
    gap: 4px;

    border-bottom: 1px solid ${p => p.theme.containerBorder};

    h3 {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;

        font-weight: 600;
    }
`;

const HeaderButton = styled(UnstyledButton)`
    flex-shrink: 0;
    width: 28px;
    height: 28px;
    border-radius: 6px;

    display: inline-flex;
    align-items: center;
    justify-content: center;

    color: ${p => p.theme.mainLowlightColor};

    &:hover {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

const SearchBox = styled.label`
    flex-shrink: 0;
    margin: 8px 8px 0;
    height: 28px;
    padding: 0 8px;
    border-radius: 6px;

    display: flex;
    align-items: center;
    gap: 6px;

    color: ${p => p.theme.mainLowlightColor};
    background-color: ${p => p.theme.inputBackground};
    border: 1px solid ${p => p.theme.containerBorder};

    &:focus-within {
        border-color: ${p => p.theme.inputBorder};
    }

    input {
        flex: 1 1 auto;
        min-width: 0;
        border: none;
        outline: none;
        background: transparent;

        color: ${p => p.theme.inputColor};
        font-family: ${p => p.theme.fontFamily};
        font-size: ${p => p.theme.textInputFontSize};

        &::placeholder {
            color: ${p => p.theme.inputPlaceholderColor};
        }
    }
`;

const PanelBody = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 12px 16px;
    line-height: 1.45;
`;

const Kicker = styled.div`
    margin-top: 10px;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const Title = styled.h4`
    margin-bottom: 6px;
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textSize};
    font-weight: 500;
    overflow-wrap: break-word;
`;

const SectionTitle = styled.h5`
    margin: 14px 0 4px;
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const Description = styled.div`
    margin: 2px 0 0;
    color: ${p => p.theme.mainLowlightColor};
    overflow-wrap: break-word;
`;

const Deprecation = styled.div`
    margin-top: 2px;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.warning};
`;

const EntryList = styled.ul`
    margin: 0;
    padding: 0;
    list-style: none;
`;

const Entry = styled.li`
    padding: 4px 0;
    border-bottom: 1px solid ${p => p.theme.containerBorder};

    &:last-child {
        border-bottom: none;
    }
`;

const Signature = styled.div`
    font-family: ${p => p.theme.monoFontFamily};
    overflow-wrap: break-word;
    color: ${p => p.theme.mainLowlightColor};
`;

const LinkButton = styled(UnstyledButton)`
    padding: 0;
    font-family: ${p => p.theme.monoFontFamily};
    text-align: left;
    color: ${p => p.theme.popColor};

    &:hover {
        text-decoration: underline;
    }
`;

const NameButton = styled(LinkButton)`
    color: ${p => p.theme.mainColor};
    font-weight: 500;
`;

const Note = styled.p`
    margin-top: 12px;
    color: ${p => p.theme.mainLowlightColor};
`;

const Faint = styled.span`
    color: ${p => p.theme.containerWatermark};
    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.smallPrintSize};
`;

// Field signatures list the arguments inline only while they stay short
const MAX_INLINE_ARGUMENTS = 2;

type OpenType = (typeName: string) => void;
type OpenField = (typeName: string, fieldName: string) => void;

// A type reference like [Country!]!, with the named type as a link
const TypeRef = (props: { type: GraphQLType, onOpenType: OpenType }): JSX.Element => {
    const { type, onOpenType } = props;
    if (isNonNullType(type)) return <><TypeRef type={type.ofType} onOpenType={onOpenType} />!</>;
    if (isListType(type)) return <>[<TypeRef type={type.ofType} onOpenType={onOpenType} />]</>;
    return <LinkButton title={`Show ${type.name}`} onClick={() => onOpenType(type.name)}>{ type.name }</LinkButton>;
};

function defaultValueText(argument: GraphQLArgument | SchemaField): string | undefined {
    if (!('defaultValue' in argument) || argument.defaultValue === undefined) return undefined;
    try {
        const valueNode = astFromValue(argument.defaultValue, argument.type as GraphQLInputType);
        return valueNode ? print(valueNode) : undefined;
    } catch {
        return undefined; // A default that doesn't fit its type: the schema is odd, the docs just skip it
    }
}

const DescriptionText = (props: { text: string | null | undefined }) =>
    props.text ? <Description><Markdown content={props.text} linkify={true} /></Description> : null;

const DeprecationText = (props: { reason: string | null | undefined }) =>
    props.reason ? <Deprecation>Deprecated: { props.reason }</Deprecation> : null;

const argumentsOf = (field: SchemaField): readonly GraphQLArgument[] => 'args' in field ? field.args : [];

const FieldEntry = (props: {
    parentType: GraphQLNamedType,
    field: SchemaField,
    // In search results, fields from different types are listed together
    showParentType?: boolean,
    onOpenType: OpenType,
    onOpenField: OpenField
}) => {
    const { parentType, field, showParentType, onOpenType, onOpenField } = props;
    const args = argumentsOf(field);
    const defaultValue = defaultValueText(field);

    return <Entry>
        <Signature>
            { showParentType && <>
                <LinkButton title={`Show ${parentType.name}`} onClick={() => onOpenType(parentType.name)}>
                    { parentType.name }
                </LinkButton>.
            </> }
            <NameButton
                title={`Show ${parentType.name}.${field.name}`}
                onClick={() => onOpenField(parentType.name, field.name)}
            >{ field.name }</NameButton>
            { args.length > 0 && (args.length <= MAX_INLINE_ARGUMENTS
                ? <>({ args.map((arg, index) => <React.Fragment key={arg.name}>
                    { index > 0 && ', ' }{ arg.name }: <TypeRef type={arg.type} onOpenType={onOpenType} />
                </React.Fragment>) })</>
                : '(…)'
            ) }
            : <TypeRef type={field.type} onOpenType={onOpenType} />
            { defaultValue !== undefined && <> = { defaultValue }</> }
        </Signature>
        <DescriptionText text={field.description} />
        <DeprecationText reason={field.deprecationReason} />
    </Entry>;
};

const TypeEntry = (props: { type: GraphQLNamedType, label?: string, onOpenType: OpenType }) =>
    <Entry>
        <Signature>
            { props.label && <>{ props.label }: </> }
            <LinkButton title={`Show ${props.type.name}`} onClick={() => props.onOpenType(props.type.name)}>
                { props.type.name }
            </LinkButton> <Faint>{ typeKindLabel(props.type) }</Faint>
        </Signature>
    </Entry>;

const SchemaOverview = (props: { schema: GraphQLSchema, onOpenType: OpenType }) => <>
    <SectionTitle>Root types</SectionTitle>
    <EntryList>
        { rootTypes(props.schema).map(({ label, type }) =>
            <TypeEntry key={label} label={label} type={type} onOpenType={props.onOpenType} />
        ) }
    </EntryList>
    <SectionTitle>All types</SectionTitle>
    <EntryList>
        { schemaTypes(props.schema).map((type) =>
            <TypeEntry key={type.name} type={type} onOpenType={props.onOpenType} />
        ) }
    </EntryList>
</>;

const TypeDocs = (props: {
    schema: GraphQLSchema,
    type: GraphQLNamedType,
    onOpenType: OpenType,
    onOpenField: OpenField
}) => {
    const { schema, type, onOpenType, onOpenField } = props;
    const fields = fieldsOf(type);
    const interfaces = isObjectType(type) || isInterfaceType(type) ? type.getInterfaces() : [];
    const possibleTypes = isUnionType(type) || isInterfaceType(type) ? schema.getPossibleTypes(type) : [];

    return <>
        <Kicker>{ typeKindLabel(type) }</Kicker>
        <Title>{ type.name }</Title>
        <DescriptionText text={type.description} />

        { interfaces.length > 0 && <>
            <SectionTitle>Implements</SectionTitle>
            <EntryList>
                { interfaces.map((iface) => <TypeEntry key={iface.name} type={iface} onOpenType={onOpenType} />) }
            </EntryList>
        </> }

        { fields.length > 0 && <>
            <SectionTitle>{ isInputObjectType(type) ? 'Input fields' : 'Fields' }</SectionTitle>
            <EntryList>
                { fields.map((field) => <FieldEntry
                    key={field.name}
                    parentType={type}
                    field={field}
                    onOpenType={onOpenType}
                    onOpenField={onOpenField}
                />) }
            </EntryList>
        </> }

        { possibleTypes.length > 0 && <>
            <SectionTitle>{ isUnionType(type) ? 'Possible types' : 'Implemented by' }</SectionTitle>
            <EntryList>
                { possibleTypes.map((possible) =>
                    <TypeEntry key={possible.name} type={possible} onOpenType={onOpenType} />
                ) }
            </EntryList>
        </> }

        { isEnumType(type) && <>
            <SectionTitle>Values</SectionTitle>
            <EntryList>
                { type.getValues().map((value) => <Entry key={value.name}>
                    <Signature>{ value.name }</Signature>
                    <DescriptionText text={value.description} />
                    <DeprecationText reason={value.deprecationReason} />
                </Entry>) }
            </EntryList>
        </> }
    </>;
};

const FieldDocs = (props: {
    type: GraphQLNamedType,
    field: SchemaField,
    onOpenType: OpenType
}) => {
    const { type, field, onOpenType } = props;
    const args = argumentsOf(field);

    return <>
        <Kicker>
            Field of <LinkButton title={`Show ${type.name}`} onClick={() => onOpenType(type.name)}>
                { type.name }
            </LinkButton>
        </Kicker>
        <Title>{ field.name }</Title>
        <DescriptionText text={field.description} />
        <DeprecationText reason={field.deprecationReason} />

        <SectionTitle>Type</SectionTitle>
        <Signature><TypeRef type={field.type} onOpenType={onOpenType} /></Signature>

        { args.length > 0 && <>
            <SectionTitle>Arguments</SectionTitle>
            <EntryList>
                { args.map((arg) => {
                    const defaultValue = defaultValueText(arg);
                    return <Entry key={arg.name}>
                        <Signature>
                            { arg.name }: <TypeRef type={arg.type} onOpenType={onOpenType} />
                            { defaultValue !== undefined && <> = { defaultValue }</> }
                        </Signature>
                        <DescriptionText text={arg.description} />
                        <DeprecationText reason={arg.deprecationReason} />
                    </Entry>;
                }) }
            </EntryList>
        </> }
    </>;
};

const SearchResults = (props: {
    schema: GraphQLSchema,
    search: string,
    onOpenType: OpenType,
    onOpenField: OpenField
}) => {
    const results = searchSchema(props.schema, props.search);
    if (!results.length) return <Note>No types or fields match "{ props.search.trim() }".</Note>;

    return <EntryList aria-label='Search results'>
        { results.map((result) => result.kind === 'type'
            ? <TypeEntry key={`type:${result.type.name}`} type={result.type} onOpenType={props.onOpenType} />
            : <FieldEntry
                key={`field:${result.type.name}.${result.field.name}`}
                parentType={result.type}
                field={result.field}
                showParentType={true}
                onOpenType={props.onOpenType}
                onOpenField={props.onOpenField}
            />
        ) }
    </EntryList>;
};

@observer
export class GraphqlDocsPanel extends React.Component<{
    schema: GraphQLSchema | undefined,
    // Shown instead of the docs while there's no schema
    emptyState: React.ReactNode,
    // Float over the editors instead of sitting next to them
    overlay: boolean,
    onClose: () => void
}> {

    @observable private search = '';
    // Where the reader went, most recent last. Empty for the schema overview.
    @observable private history: DocsLocation[] = [];

    componentDidMount() {
        // A different endpoint's schema starts from its overview
        disposeOnUnmount(this, reaction(() => this.props.schema, action(() => {
            this.history = [];
            this.search = '';
        })));
    }

    @computed
    private get location(): { type: GraphQLNamedType, field?: SchemaField } | undefined {
        const { schema } = this.props;
        const current = this.history[this.history.length - 1];
        if (!schema || !current) return undefined;

        const type = schema.getType(current.typeName);
        if (!type) return undefined;
        const field = current.fieldName
            ? fieldsOf(type).find((candidate) => candidate.name === current.fieldName)
            : undefined;
        return { type, field };
    }

    @action.bound
    private openType(typeName: string) {
        this.history.push({ typeName });
        this.search = '';
    }

    @action.bound
    private openField(typeName: string, fieldName: string) {
        this.history.push({ typeName, fieldName });
        this.search = '';
    }

    @action.bound
    private goBack() {
        this.history.pop();
    }

    @action.bound
    private onSearchChange(event: React.ChangeEvent<HTMLInputElement>) {
        this.search = event.target.value;
    }

    @action.bound
    private onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
        if (event.key === 'Escape' && this.search) {
            event.stopPropagation();
            this.search = '';
        }
    }

    render() {
        const { schema, emptyState, overlay, onClose } = this.props;
        const { location } = this;
        const title = location
            ? (location.field ? `${location.type.name}.${location.field.name}` : location.type.name)
            : 'Schema docs';

        return <PanelContainer aria-label='Schema docs' overlay={overlay}>
            <PanelHeader>
                { this.history.length > 0 && !this.search &&
                    <HeaderButton title='Back' aria-label='Back' onClick={this.goBack}>
                        <ArrowLeft size={16} aria-hidden={true} />
                    </HeaderButton>
                }
                <h3 title={title}>{ title }</h3>
                <HeaderButton title='Close the schema docs' aria-label='Close the schema docs' onClick={onClose}>
                    <X size={16} aria-hidden={true} />
                </HeaderButton>
            </PanelHeader>

            { schema && <SearchBox>
                <MagnifyingGlass size={14} aria-hidden={true} />
                <input
                    type='search'
                    placeholder='Search types and fields'
                    aria-label='Search types and fields'
                    value={this.search}
                    onChange={this.onSearchChange}
                    onKeyDown={this.onSearchKeyDown}
                />
            </SearchBox> }

            <PanelBody>
                { !schema
                    ? emptyState
                : this.search.trim()
                    ? <SearchResults
                        schema={schema}
                        search={this.search}
                        onOpenType={this.openType}
                        onOpenField={this.openField}
                    />
                : !location
                    ? <SchemaOverview schema={schema} onOpenType={this.openType} />
                : location.field
                    ? <FieldDocs type={location.type} field={location.field} onOpenType={this.openType} />
                    : <TypeDocs
                        schema={schema}
                        type={location.type}
                        onOpenType={this.openType}
                        onOpenField={this.openField}
                    />
                }
            </PanelBody>
        </PanelContainer>;
    }
}
