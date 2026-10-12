import * as React from 'react';
import { action } from 'mobx';
import { observer } from 'mobx-react-lite';

import { CollectedEvent, HttpExchangeView } from '../../../types';
import { styled } from '../../../styles';
import { copyToClipboard } from '../../../util/ui';
import { toAccelerator } from '../../../util/shortcuts';
import { MOCK_RESPONSE_SHORTCUT, RESEND_REQUEST_SHORTCUT } from '../../../model/ui/app-actions';
import { logError } from '../../../errors';

import { UiStore } from '../../../model/ui/ui-store';
import { ContextMenuItem } from '../../../model/ui/context-menu';
import { getMethodThemeColor } from '../../../model/events/categorization';
import { getStatusMessage } from '../../../model/http/http-docs';
import { generateCodeSnippet } from '../../../model/ui/export';
import {
    DEFAULT_SNIPPET_FORMAT_KEY,
    getCodeSnippetOptionFromKey
} from '../../../model/ui/snippet-formats';

import { ActionButton } from '../../common/action-button';
import { StatusPill } from './exchange-pills';

export const DETAILS_HEADER_HEIGHT = 44;

// As the pane narrows, the actions give way in steps. Mock response & Resend, the hand-offs to
// Modify & Send, keep their labels down to 480px, and every shortcut stays in the tooltips:
//   full     Mock response ⌘M · Resend ⌘R · Breakpoint · More ▾
//   compact  Mock response ⌘M · Resend ⌘R · More ▾ (Breakpoint moves into More)
//   labels   Mock response · Resend · More ▾
//   icons    the Mock & Resend icons · More ▾
export type HeaderDensity = 'full' | 'compact' | 'labels' | 'icons';

export function getHeaderDensity(width: number | undefined): HeaderDensity {
    if (width === undefined || width >= 760) return 'full';
    if (width >= 640) return 'compact';
    if (width >= 480) return 'labels';
    return 'icons';
}

const showsBreakpointButton = (density: HeaderDensity) => density === 'full';

const COPIED_FEEDBACK_MS = 1500;

const HeaderContainer = styled.div<{ density: HeaderDensity }>`
    flex-shrink: 0;
    box-sizing: border-box;
    height: ${DETAILS_HEADER_HEIGHT}px;
    padding: 0 12px 0 16px;

    display: flex;
    align-items: center;
    gap: 12px;

    background-color: ${p => p.theme.mainBackground};
    border-bottom: 1px solid ${p => p.theme.containerBorder};

    ${p => (p.density === 'labels' || p.density === 'icons') && `
        .action-shortcut {
            display: none;
        }
    `}

    ${p => p.density === 'icons' && `
        button:not([data-keeps-label]) .action-label {
            display: none;
        }
    `}
`;

// Which request this is: the method & path first, then the host, which gives way first
const RequestSummary = styled.div`
    flex: 1 1 auto;
    min-width: 0;

    display: flex;
    align-items: center;
    gap: 8px;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    white-space: nowrap;
`;

const Method = styled.span<{ httpMethod: string }>`
    flex-shrink: 0;
    font-weight: 600;
    color: ${p => getMethodThemeColor(p.httpMethod, p.theme)};
`;

// The path, then the host in a quieter colour. They share one ellipsis at the end, so the host
// gives way first, and the path only once the host is gone.
const RequestTarget = styled.span`
    flex: 0 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;

    font-weight: 500;
    color: ${p => p.theme.mainColor};
`;

const RequestHost = styled.span`
    font-weight: 400;
    color: ${p => p.theme.mainLowlightColor};
`;

const HeaderActions = styled.div`
    flex-shrink: 0;

    display: flex;
    align-items: center;
    gap: 6px;
`;

const CopiedNote = styled.span`
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
    white-space: nowrap;
`;

const ExchangeStatus = observer((props: { exchange: HttpExchangeView }) => {
    const { response } = props.exchange;

    if (response === undefined) {
        return <StatusPill status={undefined}>Pending…</StatusPill>;
    } else if (response === 'aborted') {
        return <StatusPill status='aborted'>Failed</StatusPill>;
    } else {
        const message = response.statusMessage || getStatusMessage(response.statusCode);
        return <StatusPill status={response.statusCode}>
            { `${response.statusCode} ${message}`.trim() }
        </StatusPill>;
    }
});

function useElementWidth(ref: React.RefObject<HTMLElement>) {
    const [width, setWidth] = React.useState<number | undefined>(undefined);

    React.useEffect(() => {
        const element = ref.current;
        if (!element) return;

        const observer = new ResizeObserver((entries) => {
            setWidth(entries[0].contentRect.width);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [ref]);

    return width;
}

/**
 * The top of the HTTP details pane: what this request is, and the hand-offs to
 * the rest of the flow (mock it in Modify, resend it from Send, pause it).
 */
export const HttpDetailsHeader = observer((props: {
    exchange: HttpExchangeView,
    uiStore: UiStore,

    onBuildRuleFromExchange: (exchange: HttpExchangeView) => void,
    onPrepareToResendRequest?: (exchange: HttpExchangeView) => void,
    onSaveToCollection?: (exchanges: HttpExchangeView[]) => void,
    onCreateBreakpoint: () => void,
    onScrollToEvent: (event: CollectedEvent) => void,
    onDelete: (event: CollectedEvent) => void
}) => {
    const { exchange } = props;
    const { request } = exchange;

    const containerRef = React.useRef<HTMLDivElement>(null);
    const density = getHeaderDensity(useElementWidth(containerRef));

    const [copied, setCopied] = React.useState(false);
    React.useEffect(() => {
        if (!copied) return;
        const timer = setTimeout(() => setCopied(false), COPIED_FEEDBACK_MS);
        return () => clearTimeout(timer);
    }, [copied]);

    // WebSockets can't be mocked, resent or paused by these HTTP rules:
    const isPlainHttp = exchange.isHttp() && !exchange.isWebSocket();

    // Pinning & deleting act on the collected event, not just this view of it
    const collectedEvent = exchange.downstream;

    const openMoreMenu = (event: React.MouseEvent) => {
        const curlFormat = getCodeSnippetOptionFromKey(DEFAULT_SNIPPET_FORMAT_KEY);

        const items: Array<ContextMenuItem<HttpExchangeView>> = [
            // Too narrow for its own button:
            ...(!showsBreakpointButton(density) ? [{
                type: 'option' as const,
                label: 'Add a Breakpoint',
                enabled: isPlainHttp,
                callback: props.onCreateBreakpoint
            }] : []),
            {
                type: 'option',
                label: 'Copy as cURL',
                enabled: isPlainHttp,
                callback: async (data) => {
                    try {
                        await copyToClipboard(
                            await generateCodeSnippet(data, curlFormat, { waitForBodyDecoding: true })
                        );
                        setCopied(true);
                    } catch (e) {
                        logError(e);
                    }
                }
            },
            ...(props.onSaveToCollection ? [{
                type: 'option' as const,
                label: 'Save to Collection…',
                accelerator: toAccelerator('Cmd+Shift+S'),
                enabled: isPlainHttp,
                callback: (data: HttpExchangeView) => props.onSaveToCollection!([data])
            }] : []),
            {
                type: 'option',
                label: collectedEvent.pinned ? 'Unpin' : 'Pin',
                accelerator: toAccelerator('Cmd+P'),
                callback: action(() => { collectedEvent.pinned = !collectedEvent.pinned; })
            },
            {
                type: 'option',
                label: 'Show in List',
                callback: () => props.onScrollToEvent(collectedEvent)
            },
            { type: 'separator' },
            {
                type: 'option',
                label: 'Delete',
                accelerator: toAccelerator('Cmd+Backspace'),
                callback: () => props.onDelete(collectedEvent)
            }
        ];

        props.uiStore.handleContextMenuEvent(event, items, exchange);
    };

    return <HeaderContainer
        ref={containerRef}
        density={density}
        role='group'
        aria-label='Request actions'
    >
        <RequestSummary title={request.url}>
            <Method httpMethod={request.method}>{ request.method }</Method>
            <RequestTarget>
                { request.parsedUrl.pathname }{ request.parsedUrl.search }{ ' ' }
                <RequestHost>{ request.parsedUrl.host }</RequestHost>
            </RequestTarget>
            <ExchangeStatus exchange={exchange} />
        </RequestSummary>

        <HeaderActions>
            { copied && <CopiedNote aria-live='polite'>Copied as cURL</CopiedNote> }

            <ActionButton
                variant='primary'
                icon='Pencil'
                shortcut={MOCK_RESPONSE_SHORTCUT}
                title='Mock this response with a Modify rule'
                aria-label='Mock response'
                disabled={!isPlainHttp}
                onClick={() => props.onBuildRuleFromExchange(exchange)}
            >
                Mock response
            </ActionButton>
            { props.onPrepareToResendRequest &&
                <ActionButton
                    icon='PaperPlaneTilt'
                    shortcut={RESEND_REQUEST_SHORTCUT}
                    title='Edit and resend in Send'
                    aria-label='Resend'
                    disabled={!isPlainHttp}
                    onClick={() => props.onPrepareToResendRequest!(exchange)}
                >
                    Resend
                </ActionButton>
            }
            { showsBreakpointButton(density) &&
                <ActionButton
                    icon='PauseCircle'
                    title='Pause matching requests with a Modify rule, so you can edit them'
                    disabled={!isPlainHttp}
                    onClick={props.onCreateBreakpoint}
                >
                    Breakpoint
                </ActionButton>
            }
            <ActionButton
                trailingIcon='CaretDown'
                title='More actions'
                aria-haspopup='menu'
                data-keeps-label={true}
                onClick={openMoreMenu}
            >
                More
            </ActionButton>
        </HeaderActions>
    </HeaderContainer>;
});
