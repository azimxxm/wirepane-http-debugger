import * as React from 'react';
import { observer } from 'mobx-react-lite';
import { format as formatDate } from 'date-fns';

import { css, styled } from '../../../styles';
import { PhosphorIcon } from '../../../icons';
import { getReadableSize, isProbablyUtf8 } from '../../../util/buffer';
import { formatShortcut } from '../../../util/shortcuts';

import {
    isLogEntry,
    WebSocketLogEntry,
    WebSocketLogItem,
    WebSocketLogNote,
    WebSocketSession
} from '../../../model/send/websocket/websocket-session';
import { hexDump, messagePreview, prettyJson } from '../../../model/send/websocket/websocket-messages';

import { Pill, PillSelector } from '../../common/pill';
import { IconButton } from '../../common/icon-button';
import { TextInput, UnstyledButton } from '../../common/inputs';
import { CopyButtonPill } from '../../common/copy-button';
import { SendCardSection } from '../send-card-section';

type ViewMode = 'text' | 'json' | 'hex' | 'base64';

const VIEW_MODE_NAMES: { [mode in ViewMode]: string } = {
    text: 'Text',
    json: 'JSON',
    hex: 'Hex',
    base64: 'Base64'
};

// Expanded messages show at most this much, so a huge one doesn't freeze the page
const MAX_SHOWN_CHARACTERS = 1_000_000;
const MAX_HEX_BYTES = 64 * 1024;
const MAX_BASE64_BYTES = MAX_SHOWN_CHARACTERS / 4 * 3;
// How close to the bottom counts as "at the bottom", for following new messages
const STICK_TO_BOTTOM_PX = 24;

const formatTime = (timestamp: number) => formatDate(new Date(timestamp), 'HH:mm:ss.SSS');

const LogCard = styled(SendCardSection)`
    padding-bottom: 0;

    > header {
        margin-bottom: 12px !important;
    }
`;

const FilterInput = styled(TextInput)`
    flex: 0 1 220px;
    min-width: 80px;
`;

const LogList = styled.div`
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;

    margin: 0 -20px;
    border-top: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainLowlightBackground};

    font-size: ${p => p.theme.textInputFontSize};
`;

const RowButton = styled(UnstyledButton)<{ expanded: boolean }>`
    width: 100%;
    padding: 5px 14px 5px 10px;

    display: flex;
    align-items: center;
    gap: 10px;

    text-align: left;
    border-bottom: 1px solid ${p => p.theme.containerBorder};

    ${p => p.expanded && css`
        background-color: ${p => p.theme.mainBackground};
    `}

    &:hover {
        background-color: ${p => p.theme.rowHover};
    }

    &:focus:not(:focus-visible) {
        outline: none;
    }

    ${Pill} {
        flex-shrink: 0;
        font-size: ${p => p.theme.tinyTextSize};
    }
`;

const Direction = styled.span<{ direction: 'sent' | 'received' }>`
    flex-shrink: 0;
    display: flex;

    color: ${p => p.direction === 'sent'
        ? p.theme.popColor
        : p.theme.info
    };
`;

const Time = styled.span`
    flex-shrink: 0;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const Preview = styled.span`
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;

    font-family: ${p => p.theme.monoFontFamily};
`;

const SendState = styled.span<{ failed: boolean }>`
    flex-shrink: 0;
    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.failed ? p.theme.error : p.theme.mainLowlightColor};
`;

const NoteRow = styled.div<{ tone: WebSocketLogNote['tone'] }>`
    padding: 4px 14px;

    display: flex;
    gap: 10px;

    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.tone === 'error' ? p.theme.error : p.theme.mainLowlightColor};
    border-bottom: 1px solid ${p => p.theme.containerBorder};

    > span:last-child {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
`;

const ListMessage = styled.p`
    padding: 16px 14px;
    text-align: center;
    color: ${p => p.theme.mainLowlightColor};
`;

const ExpandedMessage = styled.div`
    padding: 8px 14px 12px 36px;
    background-color: ${p => p.theme.mainBackground};
    border-bottom: 1px solid ${p => p.theme.containerBorder};
`;

const ExpandedToolbar = styled.div`
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 8px;

    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};

    > :first-child {
        margin-right: auto;
    }
`;

const ExpandedContent = styled.pre`
    max-height: 420px;
    overflow: auto;
    padding: 8px 10px;

    white-space: pre-wrap;
    word-break: break-all;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.smallPrintSize};
    line-height: 1.45;

    border-radius: 4px;
    background-color: ${p => p.theme.mainLowlightBackground};
    border: 1px solid ${p => p.theme.containerBorder};
`;

const ErrorText = styled.p`
    margin-bottom: 8px;
    color: ${p => p.theme.error};
`;

function viewModesFor(entry: WebSocketLogEntry): ViewMode[] {
    if (entry.isBinary) return isProbablyUtf8(entry.data)
        ? ['text', 'hex', 'base64']
        : ['hex', 'base64', 'text'];

    return prettyJson(entry.text) !== undefined
        ? ['json', 'text']
        : ['text'];
}

const limitText = (text: string) => text.length > MAX_SHOWN_CHARACTERS
    ? { text: text.slice(0, MAX_SHOWN_CHARACTERS), partial: true }
    : { text, partial: false };

// The message as shown, and whether that's only its start
function renderContent(entry: WebSocketLogEntry, mode: ViewMode): { text: string, partial: boolean } {
    switch (mode) {
        case 'json':
            return limitText(prettyJson(entry.text) ?? entry.text);
        case 'hex':
            return { text: hexDump(entry.data, MAX_HEX_BYTES), partial: entry.data.byteLength > MAX_HEX_BYTES };
        case 'base64':
            return {
                text: entry.data.subarray(0, MAX_BASE64_BYTES).toString('base64'),
                partial: entry.data.byteLength > MAX_BASE64_BYTES
            };
        case 'text':
            return limitText(entry.text);
    }
}

// A message in full, below its row: pretty JSON, text, or binary as hex or base64
const ExpandedEntry = observer((props: { entry: WebSocketLogEntry }) => {
    const { entry } = props;
    const modes = React.useMemo(() => viewModesFor(entry), [entry]);
    const [mode, setMode] = React.useState<ViewMode>(modes[0]);

    const content = React.useMemo(() => renderContent(entry, mode), [entry, mode]);

    return <ExpandedMessage>
        { entry.sendError && <ErrorText>Not sent: { entry.sendError }</ErrorText> }
        <ExpandedToolbar>
            <span>
                { entry.direction === 'sent' ? 'Sent' : 'Received' } at { formatTime(entry.timestamp) },{' '}
                { getReadableSize(entry.data.byteLength) }{ entry.isBinary ? ', binary' : '' }
                { content.partial ? ' (only its start is shown)' : '' }
            </span>
            { modes.length > 1 && <PillSelector<ViewMode>
                value={mode}
                options={modes}
                onChange={setMode}
                nameFormatter={(viewMode) => VIEW_MODE_NAMES[viewMode]}
            /> }
            <CopyButtonPill content={content.text}>Copy</CopyButtonPill>
        </ExpandedToolbar>
        <ExpandedContent>{ content.text }</ExpandedContent>
    </ExpandedMessage>;
});

const LogEntryRow = observer((props: {
    entry: WebSocketLogEntry,
    expanded: boolean,
    onToggle: (entryId: number) => void
}) => {
    const { entry, expanded } = props;
    const preview = React.useMemo(() => messagePreview(entry.data, entry.isBinary), [entry]);

    return <>
        <RowButton
            expanded={expanded}
            aria-expanded={expanded}
            onClick={() => props.onToggle(entry.id)}
            title={expanded ? 'Hide this message' : 'Show this message in full'}
        >
            <Direction
                direction={entry.direction}
                aria-label={entry.direction === 'sent' ? 'Sent' : 'Received'}
                title={entry.direction === 'sent' ? 'Sent' : 'Received'}
            >
                <PhosphorIcon icon={entry.direction === 'sent' ? 'ArrowRight' : 'ArrowLeft'} size='14px' />
            </Direction>
            <Time>{ formatTime(entry.timestamp) }</Time>
            <Preview>{ preview || (entry.data.byteLength === 0 ? '(empty)' : '') }</Preview>
            { entry.sendState === 'sending' && <SendState failed={false}>Sending</SendState> }
            { entry.sendState === 'failed' && <SendState failed={true} title={entry.sendError}>Not sent</SendState> }
            { entry.isBinary && <Pill>Binary</Pill> }
            <Pill>{ getReadableSize(entry.data.byteLength) }</Pill>
        </RowButton>
        { expanded && <ExpandedEntry entry={entry} /> }
    </>;
});

const LogNoteRow = (props: { note: WebSocketLogNote }) =>
    <NoteRow tone={props.note.tone}>
        <Time>{ formatTime(props.note.timestamp) }</Time>
        <span title={props.note.text}>{ props.note.text }</span>
    </NoteRow>;

/**
 * Every message sent and received, newest at the bottom (followed while you're at the
 * bottom), with a filter. Click a message to see it in full.
 */
export const WebSocketMessageLog = observer((props: { session: WebSocketSession }) => {
    const { session } = props;
    const items = session.visibleLog;
    const lastItem: WebSocketLogItem | undefined = items[items.length - 1];

    const listRef = React.useRef<HTMLDivElement>(null);
    const stickToBottom = React.useRef(true);

    const onScroll = React.useCallback(() => {
        const list = listRef.current;
        if (!list) return;
        stickToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < STICK_TO_BOTTOM_PX;
    }, []);

    // New messages scroll into view, unless you've scrolled up to read older ones
    React.useLayoutEffect(() => {
        const list = listRef.current;
        if (list && stickToBottom.current) list.scrollTop = list.scrollHeight;
    }, [items.length, lastItem?.id]);

    const onFilterChange = React.useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
        session.setFilter(event.target.value);
    }, [session]);

    const onFilterKeyDown = React.useCallback((event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key === 'Escape' && session.filter) {
            event.stopPropagation();
            session.setFilter('');
        }
    }, [session]);

    const messageCount = session.messages.length;

    return <LogCard
        ariaLabel='Messages section'
        collapsed={false}
        headerAlignment='left'
    >
        <header>
            <IconButton
                icon='Broom'
                title='Clear the message log'
                disabled={session.log.length === 0}
                onClick={session.clear}
            />
            <FilterInput
                type='search'
                value={session.filter}
                onChange={onFilterChange}
                onKeyDown={onFilterKeyDown}
                placeholder='Filter messages'
                aria-label='Filter messages'
            />
            <Pill>{ messageCount } message{ messageCount === 1 ? '' : 's' }</Pill>
            <h1>Messages</h1>
        </header>
        <LogList
            ref={listRef}
            onScroll={onScroll}
            role='log'
            aria-label='WebSocket messages'
        >
            { session.droppedCount > 0 && !session.filter && <ListMessage>
                { session.droppedCount } older log { session.droppedCount === 1 ? 'entry was' : 'entries were' } dropped, to save memory.
            </ListMessage> }
            { items.map((item) => isLogEntry(item)
                ? <LogEntryRow
                    key={item.id}
                    entry={item}
                    expanded={session.expandedEntryId === item.id}
                    onToggle={session.toggleExpanded}
                />
                : <LogNoteRow key={item.id} note={item} />
            ) }
            { items.length === 0 && <ListMessage>{
                session.filter
                    ? `No messages contain "${session.filter}".`
                    : session.isOpen
                        ? `No messages yet. Write one on the left and press Send or ${formatShortcut('Cmd+Enter')}.`
                        : 'No messages.'
            }</ListMessage> }
        </LogList>
    </LogCard>;
});
