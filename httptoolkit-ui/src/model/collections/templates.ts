// {{variable}} placeholders, as used by Bruno and Postman. Names are trimmed: {{ id }} is {{id}}.
const TEMPLATE_PATTERN = /\{\{([^{}]*)\}\}/g;

export const hasTemplate = (text: string) => text.includes('{{') && new RegExp(TEMPLATE_PATTERN.source).test(text);

export interface TemplatePart {
    // Literal text, or the name of a {{variable}}
    text: string;
    isVariable: boolean;
}

// Splits text into literal runs and {{variables}}, in order
export function splitTemplate(text: string): TemplatePart[] {
    const parts: TemplatePart[] = [];
    const pattern = new RegExp(TEMPLATE_PATTERN.source, 'g');
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) parts.push({ text: text.slice(lastIndex, match.index), isVariable: false });
        parts.push({ text: match[1].trim(), isVariable: true });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), isVariable: false });
    return parts;
}

export const templateVariableNames = (text: string): string[] =>
    splitTemplate(text).filter((part) => part.isVariable && part.text).map((part) => part.text);

// Rebuilds a template, transforming only the literal text between its {{variables}}
export const mapTemplateLiterals = (text: string, transform: (literal: string) => string) =>
    splitTemplate(text)
        .map((part) => part.isVariable ? `{{${part.text}}}` : transform(part.text))
        .join('');
