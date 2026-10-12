import type { EventsStore } from '../events/events-store';
import type { ProxyStore } from '../proxy-store';
import type { SendStore } from '../send/send-store';
import type { DevicesStore } from '../devices/devices-store';
import type { CollectionsStore } from '../collections/collections-store';
import type { UiStore } from './ui-store';

import {
    serverVersion,
    versionSatisfies,
    MODIFY_RULE_SERVER_RANGE,
    SERVER_SEND_API_SUPPORTED
} from '../../services/service-versions';
import { isEditable } from '../../util/ui';
import { toHotkeys } from '../../util/shortcuts';
import { getProxyAddress } from './proxy-address';
import { TOGGLE_SIDE_PANEL_SHORTCUT } from '../../components/common/side-panel';
import { ANDROID_SETUP_PATH, IPHONE_SETUP_PATH } from '../../components/intercept/phone/phone-setup-routes';

/**
 * The app actions: everything the command palette (⌘K) lists and the desktop's menu bar
 * offers, with their shortcuts. The desktop menu (httptoolkit-desktop/src/app-action-menus.ts)
 * sends these ids, so keep them stable.
 */
export const APP_ACTION_IDS = [
    'request-mock-response',
    'request-resend',
    'request-copy-curl',
    'request-pin',
    'go-intercept',
    'go-view',
    'go-modify',
    'go-send',
    'go-settings',
    'command-palette',
    'toggle-recording',
    'clear-traffic',
    'copy-proxy-address',
    'import-har',
    'export-har',
    'connect-iphone',
    'connect-android',
    'connect-ai',
    'toggle-devices-panel',
    'new-send-tab',
    'toggle-collections-panel',
    'open-docs',
    'report-issue'
] as const;

export type AppActionId = typeof APP_ACTION_IDS[number];

export type AppActionSection = 'This request' | 'Go' | 'Capture' | 'Connect' | 'View' | 'Send' | 'Help';
// The selected request's commands come first, as they're the likeliest reason to open the palette
export const APP_ACTION_SECTIONS: readonly AppActionSection[] = [
    'This request', 'Go', 'Capture', 'Connect', 'View', 'Send', 'Help'
];

export const DOCS_URL = 'https://httptoolkit.com/docs';
export const REPORT_ISSUE_URL = 'https://github.com/azimxxm/wirepane-http-debugger/issues/new';

// Shortcuts in util/shortcuts.ts's format: 'Cmd' is ⌘ on macOS and Ctrl elsewhere.
export const GO_INTERCEPT_SHORTCUT = 'Cmd+1';
export const GO_VIEW_SHORTCUT = 'Cmd+2';
export const GO_MODIFY_SHORTCUT = 'Cmd+3';
export const GO_SEND_SHORTCUT = 'Cmd+4';
export const SETTINGS_SHORTCUT = 'Cmd+,'; // ⌘9 still works too
export const COMMAND_PALETTE_SHORTCUT = 'Cmd+K';
export const TOGGLE_RECORDING_SHORTCUT = 'Cmd+Shift+R';
export const CLEAR_TRAFFIC_SHORTCUT = 'Cmd+Shift+Backspace';
export const IMPORT_HAR_SHORTCUT = 'Cmd+O';
export const NEW_SEND_TAB_SHORTCUT = 'Cmd+T';
// View binds these itself (view-page.tsx), as they act on its selection:
export const MOCK_RESPONSE_SHORTCUT = 'Cmd+M';
export const RESEND_REQUEST_SHORTCUT = 'Cmd+R';
export const PIN_REQUEST_SHORTCUT = 'Cmd+P';

export interface AppAction {
    readonly id: AppActionId;
    readonly section: AppActionSection;
    readonly label: string;
    // A short second line in the palette:
    readonly description?: string;
    // More words the palette search matches:
    readonly keywords?: readonly string[];
    // Shown in the palette, the menu bar & tooltips:
    readonly shortcut?: string;
    // The react-hotkeys-hook keys that run this action from any page. Page-specific shortcuts
    // (like the side panels' ⌘⌥S) are bound by their pages instead.
    readonly hotkeys?: string;
    // Not listed in the palette: the palette itself, and the request commands without a request
    readonly hiddenInPalette?: boolean;
    readonly enabled: boolean;
    // False when a shortcut pressed in this element belongs to it instead, like ⌘K in a code editor
    shortcutAllowedIn?(element: Element | null): boolean;
    run(): void;
}

/**
 * The request selected in View, for the "This request" commands.
 */
export interface SelectedRequestCommands {
    // WebSockets can't be mocked, resent or copied as cURL, only pinned
    readonly isPlainHttp: boolean;
    readonly isPinned: boolean;
    mockResponse(): void;
    resend(): void;
    copyAsCurl(): void;
    togglePinned(): void;
}

export interface AppActionDeps {
    eventsStore: Pick<EventsStore, 'events' | 'isPaused' | 'togglePause' | 'clearInterceptedData'>;
    proxyStore: Pick<ProxyStore, 'httpProxyPort' | 'toolPaths'>;
    sendStore: Pick<SendStore, 'addRequestInput'>;
    devicesStore: Pick<DevicesStore, 'panelOpen' | 'togglePanel' | 'showPanel'>;
    collectionsStore: Pick<CollectionsStore, 'panelOpen' | 'togglePanel'>;
    uiStore: Pick<UiStore, 'clearSelection' | 'openMcpModal'>;

    currentPath(): string;
    navigate(path: string): void;
    openUrl(url: string): void;
    toggleCommandPalette(): void;
    copyProxyAddress(): void;
    importHar(): void;
    exportHar(): void;
    canVisitModify(): boolean;
    canVisitSend(): boolean;
    // The single request selected in View, if any
    selectedRequest(): SelectedRequestCommands | undefined;
}

// Modify & Send need a recent enough server. Both show while its version is still unknown, so
// they don't flicker in the (usual) case where it's fine.
export const canVisitModify = () =>
    serverVersion.state !== 'fulfilled' ||
    versionSatisfies(serverVersion.value, MODIFY_RULE_SERVER_RANGE);

export const canVisitSend = () =>
    serverVersion.state !== 'fulfilled' ||
    versionSatisfies(serverVersion.value, SERVER_SEND_API_SUPPORTED);

export const canUseMcp = (proxyStore: Pick<ProxyStore, 'toolPaths'>) =>
    (proxyStore.toolPaths?.mcp?.length ?? 0) > 0;

const isInCodeEditor = (element: Element | null) => !!element?.closest?.('.monaco-editor');

// The page shortcuts upstream always had listen for Ctrl and Cmd on every platform: 'Cmd+1'
// becomes 'Ctrl+1, Cmd+1'
const withCtrlToo = (shortcut: string) => `${shortcut.replace('Cmd', 'Ctrl')}, ${shortcut}`;

const pluralRequests = (count: number) =>
    `${count.toLocaleString()} request${count === 1 ? '' : 's'}`;

export function buildAppActions(deps: AppActionDeps): AppAction[] {
    const {
        eventsStore,
        proxyStore,
        sendStore,
        devicesStore,
        collectionsStore,
        uiStore
    } = deps;

    const isOnPage = (path: string) => {
        const current = deps.currentPath();
        return current === path || current.startsWith(`${path}/`);
    };

    // Only in View, where the selection is on screen
    const selectedRequest = () => isOnPage('/view') ? deps.selectedRequest() : undefined;

    type RequestText = string | ((request: SelectedRequestCommands | undefined) => string);
    const textFor = (text: RequestText) => typeof text === 'function' ? text(selectedRequest()) : text;

    const forRequest = (id: AppActionId, action: {
        label: RequestText,
        description: RequestText,
        keywords: string[],
        shortcut?: string,
        enabled?: (request: SelectedRequestCommands) => boolean,
        run: (request: SelectedRequestCommands) => void
    }): AppAction => ({
        id,
        section: 'This request',
        keywords: action.keywords,
        shortcut: action.shortcut,
        get label() { return textFor(action.label); },
        get description() { return textFor(action.description); },
        get hiddenInPalette() { return !selectedRequest(); },
        get enabled() {
            const request = selectedRequest();
            return !!request && (action.enabled?.(request) ?? true);
        },
        run: () => {
            const request = selectedRequest();
            if (request) action.run(request);
        }
    });

    const goTo = (
        id: AppActionId,
        path: string,
        label: string,
        shortcut: string,
        keywords: string[],
        enabled: () => boolean = () => true
    ): AppAction => ({
        id,
        section: 'Go',
        label,
        keywords,
        shortcut,
        hotkeys: withCtrlToo(shortcut),
        get enabled() { return enabled(); },
        run: () => deps.navigate(path)
    });

    return [
        forRequest('request-mock-response', {
            label: 'Mock response',
            description: 'A Modify rule that answers with this response',
            keywords: ['rule', 'stub', 'fake', 'modify'],
            shortcut: MOCK_RESPONSE_SHORTCUT,
            enabled: (request) => request.isPlainHttp && deps.canVisitModify(),
            run: (request) => request.mockResponse()
        }),
        forRequest('request-resend', {
            label: 'Resend',
            description: 'Edit it and send it again, in Send',
            keywords: ['repeat', 'replay', 'retry', 'send', 'edit'],
            shortcut: RESEND_REQUEST_SHORTCUT,
            enabled: (request) => request.isPlainHttp && deps.canVisitSend(),
            run: (request) => request.resend()
        }),
        forRequest('request-copy-curl', {
            label: 'Copy as cURL',
            description: 'A curl command that sends this request',
            keywords: ['curl', 'clipboard', 'snippet', 'command', 'terminal'],
            enabled: (request) => request.isPlainHttp,
            run: (request) => request.copyAsCurl()
        }),
        forRequest('request-pin', {
            label: (request) => request?.isPinned ? 'Unpin' : 'Pin',
            description: (request) => request?.isPinned
                ? 'Clear deletes it again'
                : 'Pinned requests stay when you clear the list',
            keywords: ['keep', 'star', 'bookmark', 'unpin'],
            shortcut: PIN_REQUEST_SHORTCUT,
            run: (request) => request.togglePinned()
        }),

        goTo('go-intercept', '/intercept', 'Go to Intercept', GO_INTERCEPT_SHORTCUT,
            ['connect', 'sources', 'clients', 'browser', 'terminal']),
        goTo('go-view', '/view', 'Go to View', GO_VIEW_SHORTCUT,
            ['traffic', 'requests', 'list', 'inspect']),
        goTo('go-modify', '/modify', 'Go to Modify', GO_MODIFY_SHORTCUT,
            ['rules', 'mock', 'rewrite', 'breakpoint'], deps.canVisitModify),
        goTo('go-send', '/send', 'Go to Send', GO_SEND_SHORTCUT,
            ['request', 'api client', 'curl'], deps.canVisitSend),
        {
            id: 'go-settings',
            section: 'Go',
            label: 'Open Settings',
            keywords: ['preferences', 'options', 'theme', 'proxy port', 'https'],
            shortcut: SETTINGS_SHORTCUT,
            hotkeys: `${toHotkeys(SETTINGS_SHORTCUT)}, Ctrl+9, Cmd+9`,
            enabled: true,
            run: () => deps.navigate('/settings')
        },
        {
            id: 'command-palette',
            section: 'Go',
            label: 'Command palette',
            shortcut: COMMAND_PALETTE_SHORTCUT,
            hotkeys: toHotkeys(COMMAND_PALETTE_SHORTCUT),
            hiddenInPalette: true,
            enabled: true,
            // Monaco uses ⌘K to start its own shortcuts, like ⌘K ⌘0 to fold everything
            shortcutAllowedIn: (element) => !isInCodeEditor(element),
            run: () => deps.toggleCommandPalette()
        },

        {
            id: 'toggle-recording',
            section: 'Capture',
            get label() { return eventsStore.isPaused ? 'Resume recording' : 'Pause recording'; },
            get description() {
                return eventsStore.isPaused
                    ? 'Add new traffic to View again'
                    : "Traffic keeps flowing, but View doesn't add it";
            },
            keywords: ['pause', 'resume', 'record', 'stop', 'start'],
            shortcut: TOGGLE_RECORDING_SHORTCUT,
            hotkeys: withCtrlToo(TOGGLE_RECORDING_SHORTCUT),
            enabled: true,
            run: () => eventsStore.togglePause()
        },
        {
            id: 'clear-traffic',
            section: 'Capture',
            label: 'Clear traffic',
            get description() {
                const { events } = eventsStore;
                return events.length === 0
                    ? 'Nothing captured yet'
                : events.every((event) => event.pinned)
                    ? 'Only pinned requests are left, and they stay'
                : 'Pinned requests are kept';
            },
            keywords: ['delete', 'remove', 'reset', 'empty'],
            shortcut: CLEAR_TRAFFIC_SHORTCUT,
            hotkeys: 'Ctrl+Shift+Delete, Cmd+Shift+Delete, Ctrl+Shift+Backspace, Cmd+Shift+Backspace',
            get enabled() { return eventsStore.events.some((event) => !event.pinned); },
            // View binds this shortcut itself. Elsewhere it never fires while typing.
            shortcutAllowedIn: (element) =>
                !isOnPage('/view') && !isEditable(element) && !isInCodeEditor(element),
            run: () => {
                uiStore.clearSelection();
                eventsStore.clearInterceptedData(false);
            }
        },
        {
            id: 'copy-proxy-address',
            section: 'Capture',
            label: 'Copy proxy address',
            get description() { return getProxyAddress(proxyStore); },
            keywords: ['port', 'clipboard', 'url', 'host'],
            enabled: true,
            run: () => deps.copyProxyAddress()
        },
        {
            id: 'import-har',
            section: 'Capture',
            label: 'Import HAR…',
            description: 'Add requests & responses from a HAR file to View',
            keywords: ['open', 'load', 'file', 'archive'],
            shortcut: IMPORT_HAR_SHORTCUT,
            hotkeys: toHotkeys(IMPORT_HAR_SHORTCUT),
            enabled: true,
            run: () => deps.importHar()
        },
        {
            id: 'export-har',
            section: 'Capture',
            label: 'Export HAR…',
            get description() {
                const count = eventsStore.events.length;
                return count > 0
                    ? `Save all ${pluralRequests(count)} as a HAR file`
                    : 'Nothing captured yet';
            },
            keywords: ['save', 'download', 'file', 'archive', 'share'],
            get enabled() { return eventsStore.events.length > 0; },
            run: () => deps.exportHar()
        },

        {
            id: 'connect-iphone',
            section: 'Connect',
            label: 'Connect an iPhone or iPad',
            description: 'Proxy settings & the certificate for a phone on this Wi-Fi',
            keywords: ['ios', 'phone', 'mobile', 'apple', 'certificate'],
            enabled: true,
            run: () => deps.navigate(IPHONE_SETUP_PATH)
        },
        {
            id: 'connect-android',
            section: 'Connect',
            label: 'Connect an Android device',
            description: 'With a QR code, ADB or manual proxy settings',
            keywords: ['phone', 'mobile', 'adb', 'tablet'],
            enabled: true,
            run: () => deps.navigate(ANDROID_SETUP_PATH)
        },
        {
            id: 'connect-ai',
            section: 'Connect',
            label: 'Connect an AI assistant',
            description: 'Let MCP clients read & drive Wirepane',
            keywords: ['mcp', 'claude', 'cursor', 'ai', 'llm'],
            get enabled() { return canUseMcp(proxyStore); },
            run: () => uiStore.openMcpModal()
        },

        {
            id: 'toggle-devices-panel',
            section: 'View',
            get label() {
                return isOnPage('/view') && devicesStore.panelOpen
                    ? 'Hide the Devices panel'
                    : 'Show the Devices panel';
            },
            description: 'Requests from each phone & computer, one device at a time',
            keywords: ['devices', 'phones', 'sidebar', 'filter'],
            // The panel's own shortcut, which only works in View:
            get shortcut() { return isOnPage('/view') ? TOGGLE_SIDE_PANEL_SHORTCUT : undefined; },
            enabled: true,
            run: () => {
                if (isOnPage('/view')) {
                    devicesStore.togglePanel();
                } else {
                    deps.navigate('/view');
                    devicesStore.showPanel();
                }
            }
        },

        {
            id: 'new-send-tab',
            section: 'Send',
            label: 'New request tab',
            keywords: ['send', 'request', 'tab', 'create'],
            shortcut: NEW_SEND_TAB_SHORTCUT,
            hotkeys: toHotkeys(NEW_SEND_TAB_SHORTCUT),
            get enabled() { return deps.canVisitSend(); },
            run: () => {
                sendStore.addRequestInput();
                deps.navigate('/send');
            }
        },
        {
            id: 'toggle-collections-panel',
            section: 'Send',
            get label() {
                return isOnPage('/send') && collectionsStore.panelOpen
                    ? 'Hide the Collections panel'
                    : 'Show the Collections panel';
            },
            description: 'Saved requests, folders & environments',
            keywords: ['collections', 'saved', 'sidebar', 'postman', 'bruno'],
            get shortcut() { return isOnPage('/send') ? TOGGLE_SIDE_PANEL_SHORTCUT : undefined; },
            get enabled() { return deps.canVisitSend(); },
            run: () => {
                if (isOnPage('/send')) {
                    collectionsStore.togglePanel();
                } else {
                    deps.navigate('/send');
                    if (!collectionsStore.panelOpen) collectionsStore.togglePanel();
                }
            }
        },

        {
            id: 'open-docs',
            section: 'Help',
            label: 'Open documentation',
            description: "HTTP Toolkit's guides, which also cover Wirepane",
            keywords: ['help', 'docs', 'guide', 'manual'],
            enabled: true,
            run: () => deps.openUrl(DOCS_URL)
        },
        {
            id: 'report-issue',
            section: 'Help',
            label: 'Report an issue',
            description: 'Bugs & feature ideas, on GitHub',
            keywords: ['feedback', 'bug', 'github', 'feature', 'suggest'],
            enabled: true,
            run: () => deps.openUrl(REPORT_ISSUE_URL)
        }
    ];
}

export type AppActionSource =
    | 'keyboard' // A shortcut the page handled
    | 'palette'
    | 'menu' // A click in the desktop's menu bar
    | 'menu-shortcut'; // A shortcut the desktop's menu bar handled

// A key press reaches the page first, and the menu bar only if the page didn't handle it. Some
// platforms might still send both, so the second of a pair this close together is dropped.
const SAME_KEY_PRESS_MS = 500;

const isShortcutSource = (source: AppActionSource) =>
    source === 'keyboard' || source === 'menu-shortcut';

/**
 * Runs app actions from shortcuts, the palette and the desktop's menu bar, making sure that one
 * key press never runs an action twice.
 */
export class AppActionRunner {

    private lastShortcut: { id: string, source: AppActionSource, at: number } | undefined;

    constructor(
        readonly actions: readonly AppAction[],
        private readonly options: {
            beforeRun?: (action: AppAction) => void,
            now?: () => number,
            focusedElement?: () => Element | null
        } = {}
    ) {}

    get(id: string): AppAction | undefined {
        return this.actions.find((action) => action.id === id);
    }

    /**
     * Runs the action unless it's disabled, or this is the same key press arriving twice.
     * Returns whether it ran.
     */
    run(id: string, source: AppActionSource): boolean {
        const action = this.get(id);
        if (!action) return false;

        if (isShortcutSource(source)) {
            const now = (this.options.now ?? Date.now)();
            const last = this.lastShortcut;
            if (last && last.id === id && last.source !== source && now - last.at < SAME_KEY_PRESS_MS) {
                this.lastShortcut = undefined;
                return false;
            }
            this.lastShortcut = { id, source, at: now };

            // The page checks this for its own key presses, before it takes them:
            if (source === 'menu-shortcut' && action.shortcutAllowedIn) {
                const focused = (this.options.focusedElement ?? (() => document.activeElement))();
                if (!action.shortcutAllowedIn(focused)) return false;
            }
        }

        if (!action.enabled) return false;

        this.options.beforeRun?.(action);
        action.run();
        return true;
    }
}
