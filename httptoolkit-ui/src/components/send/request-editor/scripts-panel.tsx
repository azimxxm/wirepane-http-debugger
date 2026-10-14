import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { action } from 'mobx';

import { styled, css } from '../../../styles';
import { RequestInput } from '../../../model/send/send-request-model';
import { PanelNote, PanelScroll } from './panel-layout';

const ScriptsContainer = styled.div`
    display: flex;
    flex-direction: column;
    gap: 12px;
    height: 100%;
    min-height: 380px;
`;

const ScriptsHeader = styled.div`
    display: flex;
    justify-content: space-between;
    align-items: center;
    border-bottom: 1px solid ${p => p.theme.containerBorder};
    padding-bottom: 8px;
`;

const SubTabGroup = styled.div`
    display: flex;
    gap: 6px;
`;

const SubTabButton = styled.button.attrs(() => ({ type: 'button' }))<{ isActive: boolean }>`
    background: none;
    border: none;
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 500;
    padding: 6px 12px;
    border-radius: 4px;
    cursor: pointer;
    color: ${p => p.isActive ? p.theme.popColor : p.theme.mainLowlightColor};
    background-color: ${p => p.isActive ? p.theme.rowHover : 'transparent'};

    &:hover {
        color: ${p => p.theme.mainColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

const ContentSplit = styled.div`
    display: flex;
    flex-direction: row;
    gap: 16px;
    flex: 1 1 auto;
    min-height: 280px;
`;

const EditorArea = styled.div`
    flex: 1 1 auto;
    display: flex;
    flex-direction: column;
    min-width: 0;
`;

const ScriptTextarea = styled.textarea`
    flex: 1 1 auto;
    width: 100%;
    min-height: 260px;
    border-radius: 4px;
    padding: 12px;
    box-sizing: border-box;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};
    color: ${p => p.theme.mainColor};
    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.5;
    resize: none;

    &:focus {
        outline: none;
        border-color: ${p => p.theme.popColor};
    }
`;

const SnippetsSidebar = styled.div`
    width: 260px;
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    gap: 6px;
    border-left: 1px solid ${p => p.theme.containerBorder};
    padding-left: 16px;
    overflow-y: auto;
`;

const SnippetHeading = styled.div`
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    color: ${p => p.theme.mainLowlightColor};
    margin-bottom: 4px;
`;

const SnippetButton = styled.button.attrs(() => ({ type: 'button' }))`
    background: none;
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 4px;
    padding: 6px 10px;
    text-align: left;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainColor};
    cursor: pointer;
    transition: 0.1s;

    &:hover {
        border-color: ${p => p.theme.popColor};
        color: ${p => p.theme.popColor};
        background-color: ${p => p.theme.rowHover};
    }
`;

interface Snippet {
    title: string;
    code: string;
    stage: 'both' | 'post';
}

const SNIPPETS: Snippet[] = [
    {
        title: 'Status code: Code is 200',
        stage: 'post',
        code: `pm.test("Status code is 200", function () {\n    pm.response.to.have.status(200);\n});\n`
    },
    {
        title: 'Response time is less than 200ms',
        stage: 'post',
        code: `pm.test("Response time is less than 200ms", function () {\n    pm.expect(pm.response.responseTime).to.be.below(200);\n});\n`
    },
    {
        title: 'Response body: JSON value check',
        stage: 'post',
        code: `pm.test("Response has expected data", function () {\n    var jsonData = pm.response.json();\n    pm.expect(jsonData).to.be.an('object');\n});\n`
    },
    {
        title: 'Set an environment variable',
        stage: 'both',
        code: `pm.environment.set("variable_name", "value");\n`
    },
    {
        title: 'Get an environment variable',
        stage: 'both',
        code: `var value = pm.environment.get("variable_name");\n`
    },
    {
        title: 'Status code: Successful 2xx',
        stage: 'post',
        code: `pm.test("Successful POST request", function () {\n    pm.expect(pm.response.code).to.be.oneOf([200, 201, 202]);\n});\n`
    }
];

export const ScriptsPanel = observer((props: { requestInput: RequestInput }) => {
    const { requestInput } = props;
    const scripts = requestInput.extras.scripts;
    const [subTab, setSubTab] = React.useState<'before' | 'after'>('after');

    const activeCode = subTab === 'before' ? scripts.preRequest : scripts.postResponse;

    const onCodeChange = action((value: string) => {
        if (subTab === 'before') {
            scripts.preRequest = value;
        } else {
            scripts.postResponse = value;
        }
    });

    const insertSnippet = action((code: string) => {
        const current = subTab === 'before' ? scripts.preRequest : scripts.postResponse;
        const separator = current.trim() ? '\n\n' : '';
        onCodeChange(current + separator + code);
    });

    const visibleSnippets = SNIPPETS.filter(s => s.stage === 'both' || (subTab === 'after' && s.stage === 'post'));

    return <PanelScroll>
        <ScriptsContainer>
            <ScriptsHeader>
                <SubTabGroup>
                    <SubTabButton
                        isActive={subTab === 'before'}
                        onClick={() => setSubTab('before')}
                    >
                        Before request
                    </SubTabButton>
                    <SubTabButton
                        isActive={subTab === 'after'}
                        onClick={() => setSubTab('after')}
                    >
                        After response (Tests)
                    </SubTabButton>
                </SubTabGroup>
            </ScriptsHeader>

            <ContentSplit>
                <EditorArea>
                    <ScriptTextarea
                        placeholder={
                            subTab === 'before'
                                ? "// Code written here runs before the request is sent.\n// You can set variables, calculate timestamps or hash tokens."
                                : "// Tests written here run after receiving the response.\n// Example:\npm.test(\"Status is 200\", () => pm.expect(pm.response.status).to.equal(200));"
                        }
                        value={activeCode}
                        onChange={(e) => onCodeChange(e.target.value)}
                        spellCheck={false}
                    />
                </EditorArea>

                <SnippetsSidebar>
                    <SnippetHeading>Snippets</SnippetHeading>
                    {visibleSnippets.map((snippet) => (
                        <SnippetButton
                            key={snippet.title}
                            onClick={() => insertSnippet(snippet.code)}
                        >
                            {snippet.title}
                        </SnippetButton>
                    ))}
                </SnippetsSidebar>
            </ContentSplit>

            <PanelNote>
                {subTab === 'before'
                    ? 'Use JavaScript to dynamically set headers or parameters before sending.'
                    : 'Use pm.test() or bru.setEnvVar() to assert response values and chain tokens.'
                }
            </PanelNote>
        </ScriptsContainer>
    </PanelScroll>;
});
