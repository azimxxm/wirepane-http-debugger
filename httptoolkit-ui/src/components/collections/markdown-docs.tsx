import * as React from 'react';

import { styled } from '../../styles';
import { fromMarkdown } from '../../model/ui/markdown';

// Rendered docs. The HTML comes from fromMarkdown, which sanitizes it with DOMPurify.
const MarkdownContent = styled.div`
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.55;
    color: ${p => p.theme.mainColor};
    overflow-wrap: anywhere;
    user-select: text;
    cursor: auto;

    > :first-child { margin-top: 0; }
    > :last-child { margin-bottom: 0; }

    p, ul, ol, pre, table, blockquote {
        margin: 0 0 10px;
    }

    h1, h2, h3, h4, h5, h6 {
        margin: 16px 0 8px;
        font-weight: 600;
        line-height: 1.3;
    }

    h1 { font-size: ${p => p.theme.subHeadingSize}; }
    h2 { font-size: ${p => p.theme.textSize}; }
    h3, h4, h5, h6 { font-size: ${p => p.theme.textInputFontSize}; }

    ul, ol {
        padding-left: 20px;
    }
    ul { list-style: disc; }
    ol { list-style: decimal; }
    li + li { margin-top: 2px; }

    code {
        font-family: ${p => p.theme.monoFontFamily};
        font-size: ${p => p.theme.smallPrintSize};
        padding: 1px 4px;
        border-radius: 4px;
        background-color: ${p => p.theme.mainLowlightBackground};
    }

    pre {
        padding: 10px 12px;
        border-radius: 6px;
        overflow-x: auto;
        background-color: ${p => p.theme.mainLowlightBackground};
        border: 1px solid ${p => p.theme.containerBorder};

        code {
            padding: 0;
            background: none;
        }
    }

    blockquote {
        padding-left: 12px;
        border-left: 3px solid ${p => p.theme.containerBorder};
        color: ${p => p.theme.mainLowlightColor};
    }

    table {
        border-collapse: collapse;
    }

    th, td {
        padding: 4px 8px;
        border: 1px solid ${p => p.theme.containerBorder};
        text-align: left;
    }

    th {
        font-weight: 600;
        background-color: ${p => p.theme.mainLowlightBackground};
    }

    a[href] {
        color: ${p => p.theme.linkColor};
    }

    img {
        max-width: 100%;
    }

    hr {
        border: none;
        border-top: 1px solid ${p => p.theme.containerBorder};
        margin: 12px 0;
    }
`;

export const MarkdownView = (props: { docs: string, className?: string }) => {
    const html = React.useMemo(() => fromMarkdown(props.docs, { linkify: true }), [props.docs]);
    return html
        ? <MarkdownContent className={props.className} dangerouslySetInnerHTML={html} />
        : null;
};

export const MarkdownTextArea = styled.textarea`
    width: 100%;
    box-sizing: border-box;
    padding: 10px 12px;
    border-radius: 6px;
    resize: vertical;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.55;
    color: ${p => p.theme.inputColor};
    background-color: ${p => p.theme.inputBackground};
    border: 1px solid ${p => p.theme.inputBorder};

    &::placeholder {
        color: ${p => p.theme.inputPlaceholderColor};
    }

    &:focus {
        outline-offset: -1px;
    }
`;

// A two-way switch, e.g. Preview | Edit
const SegmentedRoot = styled.div`
    flex-shrink: 0;
    display: inline-flex;
    padding: 2px;
    border-radius: 7px;
    background-color: ${p => p.theme.mainLowlightBackground};
    border: 1px solid ${p => p.theme.containerBorder};
`;

const Segment = styled.button.attrs(() => ({ type: 'button' }))<{ isActive: boolean }>`
    height: 22px;
    padding: 0 10px;
    border: none;
    border-radius: 5px;

    font-family: inherit;
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 500;
    cursor: pointer;

    color: ${p => p.isActive ? p.theme.mainColor : p.theme.mainLowlightColor};
    background-color: ${p => p.isActive ? p.theme.mainBackground : 'transparent'};
    box-shadow: ${p => p.isActive ? `0 0 0 1px ${p.theme.containerBorder}` : 'none'};

    &:hover {
        color: ${p => p.theme.mainColor};
    }
`;

export function SegmentedControl<T extends string>(props: {
    value: T,
    options: ReadonlyArray<{ value: T, label: string, title?: string }>,
    onChange: (value: T) => void,
    'aria-label': string
}) {
    return <SegmentedRoot role='radiogroup' aria-label={props['aria-label']}>
        { props.options.map((option) =>
            <Segment
                key={option.value}
                role='radio'
                aria-checked={option.value === props.value}
                isActive={option.value === props.value}
                title={option.title}
                onClick={() => props.onChange(option.value)}
            >
                { option.label }
            </Segment>
        ) }
    </SegmentedRoot>;
}
