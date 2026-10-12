import * as React from 'react';
import { X } from '@phosphor-icons/react';

import { styled } from '../../styles';

import { AppModal } from '../common/modal';
import { UnstyledButton } from '../common/inputs';

const DialogRoot = styled(AppModal)`
    max-width: calc(100vw - 48px);
    max-height: calc(100vh - 48px);

    color: ${p => p.theme.mainColor};
    background-color: ${p => p.theme.modalColor};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 10px;
    box-shadow: ${p => p.theme.floatingShadow};
`;

const DialogForm = styled.form`
    position: relative;
    max-width: 100%;
    max-height: calc(100vh - 50px);

    display: flex;
    flex-direction: column;
`;

const DialogHeader = styled.header`
    flex-shrink: 0;
    padding: 16px 56px 12px 24px; /* Leaves room for the close button */

    h1 {
        font-size: ${p => p.theme.subHeadingSize};
        font-weight: 600;
        line-height: 1.3;
    }
`;

const DialogSubtitle = styled.p`
    margin-top: 4px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainLowlightColor};
`;

// Last in the DOM (but shown top right), so opening a dialog focuses its first field instead
const CloseButton = styled(UnstyledButton)`
    position: absolute;
    top: 14px;
    right: 16px;
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

const DialogBody = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    padding: 4px 24px 20px;

    display: flex;
    flex-direction: column;
    gap: 14px;

    font-size: ${p => p.theme.textInputFontSize};
`;

const DialogFooter = styled.footer`
    flex-shrink: 0;
    padding: 12px 16px 16px 24px;
    border-top: 1px solid ${p => p.theme.containerBorder};

    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 8px;

    > .footer-note {
        margin-right: auto;
        font-size: ${p => p.theme.smallPrintSize};
        color: ${p => p.theme.mainLowlightColor};
    }
`;

/**
 * The frame every collections dialog uses: a title (and purpose line), a scrolling body,
 * and the actions at the bottom. Escape and the close button call onClose, and Enter
 * in a single-line field calls onSubmit.
 */
export const CollectionDialog = (props: {
    title: string,
    subtitle?: React.ReactNode,
    width: number,
    onClose: () => void,
    onSubmit?: () => void,
    footer?: React.ReactNode,
    // Alerts & confirmations (DialogHost) are 'alertdialog's, described by their message
    role?: 'dialog' | 'alertdialog',
    describedBy?: string,
    children: React.ReactNode
}) => {
    const titleId = React.useId();
    const { onSubmit } = props;

    const onKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLFormElement>) => {
        const target = event.target as HTMLElement;
        if (event.key !== 'Enter' || event.nativeEvent.isComposing || !onSubmit) return;
        if (target.tagName !== 'INPUT' || (target as HTMLInputElement).type === 'checkbox') return;

        event.preventDefault();
        onSubmit();
    }, [onSubmit]);

    return <DialogRoot
        onClose={props.onClose}
        aria-labelledby={titleId}
        role={props.role}
        aria-describedby={props.describedBy}
    >
        <DialogForm
            style={{ width: props.width }}
            onSubmit={(event) => { event.preventDefault(); onSubmit?.(); }}
            onKeyDown={onKeyDown}
        >
            <DialogHeader>
                <h1 id={titleId}>{ props.title }</h1>
                { props.subtitle && <DialogSubtitle>{ props.subtitle }</DialogSubtitle> }
            </DialogHeader>
            <DialogBody>{ props.children }</DialogBody>
            { props.footer && <DialogFooter>{ props.footer }</DialogFooter> }
            <CloseButton title='Close (Esc)' aria-label='Close' onClick={props.onClose}>
                <X size={16} weight='bold' />
            </CloseButton>
        </DialogForm>
    </DialogRoot>;
};

// A labelled form row: the label on the left, the control on the right
export const FieldRow = styled.label`
    display: grid;
    grid-template-columns: 96px minmax(0, 1fr);
    align-items: center;
    gap: 12px;

    > span:first-child {
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const controlStyles = `
    width: 100%;
    height: 30px;
    box-sizing: border-box;
    padding: 0 10px;
    border-radius: 6px;
`;

export const DialogTextInput = styled.input.attrs((p: { type?: string }) => ({ type: p.type || 'text' }))`
    ${controlStyles}

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.textInputFontSize};
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

export const DialogSelect = styled.select`
    ${controlStyles}

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    color: ${p => p.theme.inputColor};
    background-color: ${p => p.theme.inputBackground};
    border: 1px solid ${p => p.theme.inputBorder};

    &:focus {
        outline-offset: -1px;
    }
`;

export const HintText = styled.p`
    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.5;
    color: ${p => p.theme.mainLowlightColor};
`;

export const ErrorText = styled.p`
    padding: 8px 10px;
    border-radius: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    line-height: 1.45;
    color: ${p => p.theme.mainColor};
    background-color: ${p => p.theme.warningBackground};
    border: 1px solid ${p => p.theme.warningColor};
`;

export const SectionTitle = styled.h2`
    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;
    color: ${p => p.theme.mainColor};
`;

// Runs an async action from a dialog: tracks progress, and keeps the error to show it
export function useDialogAction<A extends unknown[]>(run: (...args: A) => Promise<unknown>) {
    const [isRunning, setRunning] = React.useState(false);
    const [error, setError] = React.useState<string | undefined>();
    const isMounted = React.useRef(true);
    React.useEffect(() => () => { isMounted.current = false; }, []);

    const start = React.useCallback(async (...args: A) => {
        setRunning(true);
        setError(undefined);
        try {
            await run(...args);
        } catch (e) {
            if (isMounted.current) setError(e instanceof Error ? e.message : String(e));
        } finally {
            if (isMounted.current) setRunning(false);
        }
    }, [run]);

    return { start, isRunning, error };
}
