import * as React from 'react';
import * as polished from 'polished';
import { action } from 'mobx';
import { observer } from 'mobx-react-lite';

import { CollectedEvent, HttpExchangeView } from '../../../types';
import { styled } from '../../../styles';
import { copyToClipboard } from '../../../util/ui';
import { toAccelerator } from '../../../util/shortcuts';
import { logError } from '../../../errors';

import { UiStore } from '../../../model/ui/ui-store';
import { ContextMenuItem } from '../../../model/ui/context-menu';
import { getMethodThemeColor, getStatusColor } from '../../../model/events/categorization';
import { getStatusMessage } from '../../../model/http/http-docs';
import { generateCodeSnippet } from '../../../model/ui/export';
import {
    DEFAULT_SNIPPET_FORMAT_KEY,
    getCodeSnippetOptionFromKey
} from '../../../model/ui/snippet-formats';

import { ActionButton } from '../../common/action-button';

export const DETAILS_HEADER_HEIGHT = 44;

// As the pane narrows, the buttons drop their shortcut hints, then the secondary
// labels, and finally every label (they all stay in the tooltips):
type HeaderDensity = 'full' | 'no-shortcuts' | 'primary-label' | 'icons';

function getDensity(width: number | undefined): HeaderDensity {
    if (width === undefined || width >= 760) return 'full';
    if (width >= 640) return 'no-shortcuts';
    if (width >= 480) return 'primary-label';
    return 'icons';
}

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

    ${p => p.density !== 'full' && `
        .action-shortcut {
            display: none;
        }
    `}

    ${p => p.density === 'primary-label' && `
        button:not([data-primary]) .action-label {
            display: none;
        }
    `}

    ${p => p.density === 'icons' && `
        .action-label {
            display: none;
        }
    `}
`;

const RequestSummary = styled.div`
    flex: 1 1 auto;
    min-width: 0;

    display: flex;
    align-items: center;
    gap: 8px;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
`;

const Method = styled.span<{ httpMethod: string }>`
    flex-shrink: 0;
    font-weight: 600;
    color: ${p => getMethodThemeColor(p.httpMethod, p.theme)};
`;

const RequestUrl = styled.span`
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;

    color: ${p => p.theme.mainColor};
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
        return <StatusPill status={undefined} label='Pending…' />;
    } else if (response === 'aborted') {
        return <StatusPill status='aborted' label='Failed' />;
    } else {
        const message = response.statusMessage || getStatusMessage(response.statusCode);
        return <StatusPill
            status={response.statusCode}
            label={`${response.statusCode} ${message}`.trim()}
        />;
    }
});

const StatusPill = styled((props: {
    className?: string,
    status: number | 'aborted' | undefined,
    label: string
}) => <span className={props.className}>{ props.label }</span>)`
    flex-shrink: 0;
    padding: 2px 8px;
    border-radius: 10px;

    font-family: ${p => p.theme.fontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    font-weight: 600;
    white-space: nowrap;

    ${p => {
        const color = p.status === undefined
            ? p.theme.containerWatermark
            : getStatusColor(p.status, p.theme);

        return `
            color: ${color};
            background-color: ${polished.rgba(color, 0.12)};
            border: 1px solid ${polished.rgba(color, 0.35)};
        `;
    }}
`;

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
    const density = getDensity(useElementWidth(containerRef));

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
            <RequestUrl>
                { request.parsedUrl.host }{ request.parsedUrl.pathname }{ request.parsedUrl.search }
            </RequestUrl>
            <ExchangeStatus exchange={exchange} />
        </RequestSummary>

        <HeaderActions>
            { copied && <CopiedNote aria-live='polite'>Copied as cURL</CopiedNote> }

            <ActionButton
                variant='primary'
                data-primary={true}
                icon='Pencil'
                shortcut='Cmd+M'
                title='Create a Modify rule that mocks this response'
                disabled={!isPlainHttp}
                onClick={() => props.onBuildRuleFromExchange(exchange)}
            >
                Mock response
            </ActionButton>
            { props.onPrepareToResendRequest &&
                <ActionButton
                    icon='PaperPlaneTilt'
                    shortcut='Cmd+R'
                    title='Open this request in Send, to edit & resend it'
                    disabled={!isPlainHttp}
                    onClick={() => props.onPrepareToResendRequest!(exchange)}
                >
                    Resend
                </ActionButton>
            }
            <ActionButton
                icon='PauseCircle'
                title='Create a Modify rule that pauses matching requests, so you can edit them'
                disabled={!isPlainHttp}
                onClick={props.onCreateBreakpoint}
            >
                Breakpoint
            </ActionButton>
            <ActionButton
                trailingIcon='CaretDown'
                title='More actions'
                aria-haspopup='menu'
                onClick={openMoreMenu}
            >
                More
            </ActionButton>
        </HeaderActions>
    </HeaderContainer>;
});
