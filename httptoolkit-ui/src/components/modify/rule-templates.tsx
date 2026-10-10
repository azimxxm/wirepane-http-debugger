import * as React from 'react';

import { styled } from '../../styles';
import { IconKey, PhosphorIcon } from '../../icons';

import { RULE_TEMPLATES, RuleTemplate } from '../../model/rules/rule-templates';
import { DEFAULT_RULE_GROUP_ID } from '../../model/traffic-summary';

import { UnstyledButton } from '../common/inputs';

const TEMPLATE_ICONS: { [templateId: string]: IconKey } = {
    'mock-response': 'ArrowBendUpLeft',
    'rewrite-request-headers': 'PencilSimpleLine',
    'breakpoint': 'PauseCircle',
    'map-local-file': 'File',
    'redirect-host': 'ArrowsLeftRight',
    'fail-request': 'Prohibit'
};

const TemplatesSection = styled.section`
    padding: 24px 40px 4px;
`;

const TemplatesTitle = styled.h2`
    margin-bottom: 10px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
`;

const TemplateGrid = styled.ul`
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 12px;
`;

const TemplateCard = styled(UnstyledButton)`
    width: 100%;
    height: 100%;
    box-sizing: border-box;
    padding: 14px 16px;

    display: grid;
    grid-template-columns: 20px 1fr;
    grid-template-rows: auto auto;
    column-gap: 12px;
    row-gap: 4px;
    align-items: start;

    text-align: left;
    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;

    transition: border-color 0.12s, background-color 0.12s;

    &:hover {
        border-color: ${p => p.theme.inputBorder};
        background-color: ${p => p.theme.rowHover};
    }

    > svg {
        grid-row: 1 / span 2;
        color: ${p => p.theme.popColor};
    }
`;

const TemplateTitle = styled.span`
    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.25;
    color: ${p => p.theme.mainColor};
`;

const TemplateDescription = styled.span`
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.4;
    color: ${p => p.theme.mainLowlightColor};
`;

/**
 * Shown on Modify while there are no rules of your own: the common jobs as one-click
 * starting points, each creating a pre-filled rule to edit.
 */
export const RuleTemplateGrid = (props: {
    onCreate: (template: RuleTemplate) => void
}) => <TemplatesSection aria-labelledby='rule-templates-heading'>
    <TemplatesTitle id='rule-templates-heading'>Start from a template</TemplatesTitle>
    <TemplateGrid>
        { RULE_TEMPLATES.map((template) =>
            <li key={template.id}>
                <TemplateCard onClick={() => props.onCreate(template)}>
                    <PhosphorIcon icon={TEMPLATE_ICONS[template.id]} size={20} aria-hidden={true} />
                    <TemplateTitle>{ template.title }</TemplateTitle>
                    <TemplateDescription>{ template.description }</TemplateDescription>
                </TemplateCard>
            </li>
        ) }
    </TemplateGrid>
</TemplatesSection>;

const Subtitle = styled.span`
    margin-left: 12px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 400;
    color: ${p => p.theme.mainLowlightColor};
`;

/**
 * Explains the built-in "Default rules" group next to its title. Renders nothing
 * for any other group.
 */
export const RuleGroupSubtitle = (props: { groupId: string }) =>
    props.groupId === DEFAULT_RULE_GROUP_ID
        ? <Subtitle>
            Built in: serve the CA certificate and the test page, and pass all other traffic through unchanged.
        </Subtitle>
        : null;
