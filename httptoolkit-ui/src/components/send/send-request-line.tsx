import * as React from 'react';
import { Method } from 'mockttp';
import * as HarFormat from 'har-format';
import { parseCurlCommand } from 'curl-as-har-request';

import { styled } from '../../styles';
import { Icon } from '../../icons';

import { getMethodThemeColor } from '../../model/events/categorization';
import { messageDialog } from '../../model/ui/dialogs'; // wirepane

import { Ctrl, isMac } from '../../util/ui';
import { Button, Select, TextInput } from '../common/inputs';
import { IconButton } from '../common/icon-button';
import { WEBSOCKET_OPTION } from '../../model/send/websocket/request-type';
import { useTypeSwitchFocus } from './websocket/use-type-switch-focus';

type MethodName = keyof typeof Method;
const validMethods = Object.values(Method)
    .filter(
        value => typeof value === 'string'
    ) as Array<MethodName>;

export const SendRequestLineContainer = styled.form`
    background-color: ${p => p.theme.mainBackground};
    flex-grow: 0;
    display: flex;

    z-index: 1;
    border-bottom: 1px solid ${p => p.theme.containerBorder};
`;

export const MethodSelectArrow = styled(Icon).attrs(() => ({
    icon: ['fas', 'chevron-down']
}))`
    position: absolute;
    top: 50%;
    right: 8px;
    transform: translateY(-50%);

    color: ${p => p.theme.mainColor};
    opacity: ${p => p.theme.lowlightTextOpacity};
    font-size: ${p => p.theme.textInputFontSize};

    pointer-events: none;
`;

export const MethodSelect = styled(Select)<{ httpMethod: string }>`
    border-radius: 0;
    border: none;
    &:not(:focus-visible) { outline: none; }
    appearance: none;

    border-left: 5px solid ${p => getMethodThemeColor(p.httpMethod, p.theme)};

    padding: 5px 0 5px 15px;
    font-size: ${p => p.theme.textInputFontSize};

    height: 100%;
    width: 100%;

    color: ${p => p.theme.mainColor};
    background-color: ${p => p.theme.mainLowlightBackground};
`;

export const MethodSelectContainer = styled.div`
    position: relative;
    font-size: ${p => p.theme.textSize};

    flex-shrink: 0;
    flex-grow: 0;
    flex-basis: 105px;

    /* wirepane: the method & the URL share one control border, and one focus ring around
       both. Each half draws its side of the ring (clip-path cuts the shared edge). */
    margin: 5px 0 5px 6px;
    border: 1px solid ${p => p.theme.inputBorder};
    border-right: none;
    border-radius: 6px 0 0 6px;

    > select {
        border-radius: 5px 0 0 5px;
    }

    &:has(select:focus-visible),
    form:has(> input:focus-visible) > & {
        box-shadow: 0 0 0 2px ${p => p.theme.focusRing};
        clip-path: inset(-3px 0 -3px -3px);

        > select {
            outline: none;
        }
    }

    &:focus-within {
        > svg {
            color: ${p => p.theme.popColor};
            opacity: 1;
        }

        > select {
            font-weight: bold;
        }
    }
`;

export const UrlInput = styled(TextInput)`
    flex-basis: 100%;
    flex-grow: 1;

    /* wirepane: the right half of the method & URL field (see MethodSelectContainer) */
    height: 30px;
    margin: 5px 0;
    border: 1px solid ${p => p.theme.inputBorder};
    border-left-color: ${p => p.theme.containerBorder};
    border-radius: 0 6px 6px 0;

    padding: 0 10px;

    font-size: ${p => p.theme.textSize};

    &:focus:not(:focus-visible) {
        outline: none;
    }

    &:focus-visible,
    form:has(> div select:focus-visible) > & {
        outline: none;
        box-shadow: 0 0 0 2px ${p => p.theme.focusRing};
        clip-path: inset(-3px -3px -3px 0);
    }
`;

const CopySnippetButton = styled(IconButton)`
    flex-shrink: 0;
    padding: 5px 12px;

    font-size: ${p => p.theme.textSize};
`;

// A labelled accent button, inset from the bar's edges so its focus ring has room:
export const SendButton = styled(Button)`
    flex-shrink: 0;
    min-width: 88px;
    margin: 5px 6px 5px 4px;
    padding: 0 14px;
    border-radius: 6px;

    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;

    font-size: ${p => p.theme.textInputFontSize};
    font-weight: 600;

    > svg {
        padding: 0;
    }
`;

export const SendShortcut = styled.kbd`
    font-family: inherit;
    font-weight: 400;
`;

const SEND_SHORTCUT = isMac ? '⌘↵' : 'Ctrl+↵';

export const SendRequestLine = (props: {
    updateFromHar: (harRequest: HarFormat.Request) => void;

    method: string;
    updateMethod: (method: string) => void;

    url: string;
    updateUrl: (url: string) => void;

    isSending: boolean;
    sendRequest: () => void;

    showCopyAsSnippetMenu: (event: React.MouseEvent) => void;

    // wirepane: adds a WebSocket entry to the method picker, which switches the tab to WebSocket
    onSelectWebSocket?: () => void;
}) => {
    const updateMethodFromEvent = React.useCallback((changeEvent: React.ChangeEvent<HTMLSelectElement>) => {
        // wirepane: the WebSocket entry changes the request type, not the method
        if (changeEvent.target.value === WEBSOCKET_OPTION) return props.onSelectWebSocket?.();
        props.updateMethod(changeEvent.target.value);
    }, [props.updateMethod, props.onSelectWebSocket]);

    // wirepane: keeps the focus when the URL or the picker switches the tab to WebSocket and back
    const methodSelectRef = React.useRef<HTMLSelectElement>(null);
    const urlInputRef = React.useRef<HTMLInputElement>(null);
    useTypeSwitchFocus(methodSelectRef, urlInputRef);

    const updateUrlFromEvent = React.useCallback((changeEvent: React.ChangeEvent<HTMLInputElement>) => {
        props.updateUrl(changeEvent.target.value);
    }, [props.updateUrl]);

    const prepopulateUrl = React.useCallback((focusEvent: React.FocusEvent<HTMLInputElement>) => {
        const inputField = focusEvent.target;
        if (!inputField.value) inputField.value = 'https://';
    }, []);

    const sendRequest = React.useCallback((event: React.SyntheticEvent<HTMLElement>) => {
        event.preventDefault();
        props.sendRequest();
        return false;
    }, [props.sendRequest]);

    const onPaste = React.useCallback((event: React.ClipboardEvent<HTMLInputElement>) => {
        const pastedText = event.clipboardData.getData('text/plain');

        // wirepane: a pasted URL replaces the 'https://' that focusing an empty field adds
        if (event.currentTarget.value === 'https://' && /^\s*[a-z][a-z0-9+.-]*:\/\//i.test(pastedText)) {
            event.preventDefault();
            props.updateUrl(pastedText.trim());
            return;
        }

        if (pastedText.match(/^\s*curl /)) {
            event.preventDefault();

            // Looks like you've pasted a curl command, try to parse it to HAR, then
            // generate a request from there:
            try {
                // For now we use the first command, we could pop into multiple tabs if
                // we want to support multiple commands here later:
                const harRequest = parseCurlCommand(pastedText)[0];
                if (!harRequest.url) {
                    throw new Error('Could not extract URL from pasted curl command.');
                }
                props.updateFromHar(harRequest);
            } catch (e: any) {
                console.log(e);
                messageDialog({ // wirepane: our own dialog instead of alert()
                    title: "Couldn't read that cURL command",
                    message: `Check that you pasted the whole command, with its URL.\n\n${e.message || e}`
                });
            }
        }
    }, [props.updateFromHar, props.updateUrl]);

    return <SendRequestLineContainer
        className='ignores-expanded' // This always shows, even if something is expanded
        onSubmit={sendRequest}
    >
        <MethodSelectContainer>
            <MethodSelect
                ref={methodSelectRef}
                value={props.method}
                onChange={updateMethodFromEvent}
                httpMethod={props.method}
            >
                { validMethods.map((methodOption) =>
                    <option
                        key={methodOption}
                        value={methodOption}
                    >
                        { methodOption }
                    </option>
                ) }
                { props.onSelectWebSocket && <option value={WEBSOCKET_OPTION}>WebSocket</option> }
            </MethodSelect>
            <MethodSelectArrow />
        </MethodSelectContainer>
        <UrlInput
            ref={urlInputRef}
            // {{variables}} aren't URL syntax until they're filled in when sending
            type={/\{\{.*\}\}/.test(props.url) ? 'text' : 'url'}
            spellCheck='false'
            placeholder='Enter a URL or paste a cURL command'
            required={true}

            value={props.url}
            onFocus={prepopulateUrl}
            onChange={updateUrlFromEvent}
            onPaste={onPaste}
        />
        <CopySnippetButton
            title='Copy this request as a code snippet'
            icon={['far', 'copy']}
            disabled={!props.url}
            onClick={props.showCopyAsSnippetMenu}
        />
        <SendButton
            type='submit'
            disabled={props.isSending}
            title={`Send this request (${Ctrl}+Enter)`}
            aria-keyshortcuts={isMac ? 'Meta+Enter' : 'Control+Enter'}
        >
            { props.isSending
                ? <Icon spin fixedWidth={true} icon={['fas', 'spinner']} />
                : <>Send <SendShortcut aria-hidden='true'>{ SEND_SHORTCUT }</SendShortcut></>
            }
        </SendButton>
    </SendRequestLineContainer>;

};