import { expect } from '../../../test-setup';

import { formatShortcut } from '../../../../src/util/shortcuts';
import {
    AppAction,
    AppActionDeps,
    AppActionId,
    AppActionRunner,
    APP_ACTION_IDS,
    APP_ACTION_SECTIONS,
    buildAppActions,
    DOCS_URL,
    REPORT_ISSUE_URL
} from '../../../../src/model/ui/app-actions';
import { searchCommands } from '../../../../src/model/ui/command-search';

const REQUEST_ACTION_IDS: AppActionId[] = [
    'request-mock-response',
    'request-resend',
    'request-copy-curl',
    'request-pin'
];

// Fake stores & app functions that record what the actions do with them
function buildTestActions(initial: {
    path?: string,
    events?: Array<{ pinned: boolean }>,
    isPaused?: boolean,
    devicesPanelOpen?: boolean,
    collectionsPanelOpen?: boolean,
    mcpPaths?: string[],
    canVisitModify?: boolean,
    canVisitSend?: boolean,
    // The request selected in View: plain HTTP or a WebSocket, pinned or not
    selected?: { isPlainHttp: boolean, isPinned: boolean }
} = {}) {
    const state = {
        path: '/intercept',
        events: [] as Array<{ pinned: boolean }>,
        isPaused: false,
        devicesPanelOpen: true,
        collectionsPanelOpen: true,
        mcpPaths: ['/bin/mcp'],
        canVisitModify: true,
        canVisitSend: true,
        selected: undefined as { isPlainHttp: boolean, isPinned: boolean } | undefined,
        ...initial
    };
    const calls: string[] = [];

    const deps: AppActionDeps = {
        eventsStore: {
            get events() { return state.events; },
            get isPaused() { return state.isPaused; },
            togglePause: () => { state.isPaused = !state.isPaused; calls.push('togglePause'); },
            clearInterceptedData: (clearPinned: boolean) => { calls.push(`clearInterceptedData:${clearPinned}`); }
        } as unknown as AppActionDeps['eventsStore'],
        proxyStore: {
            httpProxyPort: 8000,
            get toolPaths() { return { mcp: state.mcpPaths }; }
        } as unknown as AppActionDeps['proxyStore'],
        sendStore: {
            addRequestInput: () => { calls.push('addRequestInput'); }
        } as unknown as AppActionDeps['sendStore'],
        devicesStore: {
            get panelOpen() { return state.devicesPanelOpen; },
            togglePanel: () => { state.devicesPanelOpen = !state.devicesPanelOpen; calls.push('devices.togglePanel'); },
            showPanel: () => { state.devicesPanelOpen = true; calls.push('devices.showPanel'); }
        } as unknown as AppActionDeps['devicesStore'],
        collectionsStore: {
            get panelOpen() { return state.collectionsPanelOpen; },
            togglePanel: () => { state.collectionsPanelOpen = !state.collectionsPanelOpen; calls.push('collections.togglePanel'); }
        } as unknown as AppActionDeps['collectionsStore'],
        uiStore: {
            clearSelection: () => { calls.push('clearSelection'); },
            openMcpModal: () => { calls.push('openMcpModal'); }
        } as unknown as AppActionDeps['uiStore'],

        currentPath: () => state.path,
        navigate: (path: string) => { state.path = path; calls.push(`navigate:${path}`); },
        openUrl: (url: string) => { calls.push(`openUrl:${url}`); },
        toggleCommandPalette: () => { calls.push('toggleCommandPalette'); },
        copyProxyAddress: () => { calls.push('copyProxyAddress'); },
        importHar: () => { calls.push('importHar'); },
        exportHar: () => { calls.push('exportHar'); },
        canVisitModify: () => state.canVisitModify,
        canVisitSend: () => state.canVisitSend,
        selectedRequest: () => state.selected && {
            ...state.selected,
            mockResponse: () => { calls.push('request.mockResponse'); },
            resend: () => { calls.push('request.resend'); },
            copyAsCurl: () => { calls.push('request.copyAsCurl'); },
            togglePinned: () => { calls.push('request.togglePinned'); }
        }
    };

    const actions = buildAppActions(deps);
    const action = (id: AppActionId) => actions.find((a) => a.id === id)!;

    return { actions, action, state, calls };
}

describe('App actions', () => {

    describe('the registry', () => {

        it('has every id exactly once', () => {
            const { actions } = buildTestActions();
            const ids = actions.map((action) => action.id);

            expect(new Set(ids).size).to.equal(ids.length);
            expect(ids.slice().sort()).to.deep.equal(APP_ACTION_IDS.slice().sort());
        });

        it('puts every action in a known section, with a label', () => {
            const { actions } = buildTestActions();

            actions.forEach((action) => {
                expect(APP_ACTION_SECTIONS).to.include(action.section);
                expect(action.label).to.be.a('string').and.not.equal('');
            });
        });

        it('formats the shortcuts for macOS and for other platforms', () => {
            const { action } = buildTestActions();
            const shortcut = (id: AppActionId, mac: boolean) => formatShortcut(action(id).shortcut!, mac);

            expect(shortcut('go-intercept', true)).to.equal('⌘1');
            expect(shortcut('go-view', true)).to.equal('⌘2');
            expect(shortcut('go-modify', true)).to.equal('⌘3');
            expect(shortcut('go-send', true)).to.equal('⌘4');
            expect(shortcut('go-settings', true)).to.equal('⌘,');
            expect(shortcut('command-palette', true)).to.equal('⌘K');
            expect(shortcut('toggle-recording', true)).to.equal('⌘⇧R');
            expect(shortcut('clear-traffic', true)).to.equal('⌘⇧⌫');
            expect(shortcut('import-har', true)).to.equal('⌘O');
            expect(shortcut('new-send-tab', true)).to.equal('⌘T');

            expect(shortcut('go-settings', false)).to.equal('Ctrl+,');
            expect(shortcut('toggle-recording', false)).to.equal('Ctrl+Shift+R');
            expect(shortcut('clear-traffic', false)).to.equal('Ctrl+Shift+Backspace');
        });

        it('keeps the page shortcuts upstream had, on Ctrl and Cmd', () => {
            const { action } = buildTestActions();

            expect(action('go-view').hotkeys).to.equal('Ctrl+2, Cmd+2');
            expect(action('toggle-recording').hotkeys).to.equal('Ctrl+Shift+R, Cmd+Shift+R');
            // ⌘9 still opens Settings, next to the new ⌘,
            expect(action('go-settings').hotkeys).to.contain('Ctrl+9, Cmd+9');
        });

        it("doesn't list the palette in the palette, or request commands without a request", () => {
            const { actions, state } = buildTestActions({ path: '/view' });
            const hiddenIds = () => actions.filter((action) => action.hiddenInPalette).map((action) => action.id);

            expect(hiddenIds()).to.deep.equal([...REQUEST_ACTION_IDS, 'command-palette']);

            state.selected = { isPlainHttp: true, isPinned: false };
            expect(hiddenIds()).to.deep.equal(['command-palette']);
        });

        it('shows the request shortcuts, which View binds itself', () => {
            const { action } = buildTestActions();

            expect(formatShortcut(action('request-mock-response').shortcut!, true)).to.equal('⌘M');
            expect(formatShortcut(action('request-resend').shortcut!, true)).to.equal('⌘R');
            expect(formatShortcut(action('request-pin').shortcut!, true)).to.equal('⌘P');
            REQUEST_ACTION_IDS.forEach((id) => expect(action(id).hotkeys).to.equal(undefined));
        });

        it('only shows the side panel shortcut on its own page', () => {
            const { action, state } = buildTestActions({ path: '/intercept' });
            expect(action('toggle-devices-panel').shortcut).to.equal(undefined);

            state.path = '/view/some-event';
            expect(action('toggle-devices-panel').shortcut).to.equal('Cmd+Alt+S');
            expect(action('toggle-collections-panel').shortcut).to.equal(undefined);
        });

    });

    describe('enabled states', () => {

        it('exports only once something was captured', () => {
            const { action, state } = buildTestActions();
            expect(action('export-har').enabled).to.equal(false);

            state.events = [{ pinned: false }];
            expect(action('export-har').enabled).to.equal(true);
            expect(action('export-har').description).to.contain('1 request');
        });

        it('clears only when there are unpinned requests', () => {
            const { action, state } = buildTestActions();
            expect(action('clear-traffic').enabled).to.equal(false);

            state.events = [{ pinned: true }];
            expect(action('clear-traffic').enabled).to.equal(false);
            expect(action('clear-traffic').description).to.contain('Only pinned');

            state.events = [{ pinned: true }, { pinned: false }];
            expect(action('clear-traffic').enabled).to.equal(true);
        });

        it('follows the server version for Modify & Send', () => {
            const { action, state } = buildTestActions({ canVisitModify: false, canVisitSend: false });

            expect(action('go-modify').enabled).to.equal(false);
            expect(action('go-send').enabled).to.equal(false);
            expect(action('new-send-tab').enabled).to.equal(false);
            expect(action('toggle-collections-panel').enabled).to.equal(false);

            state.canVisitModify = true;
            state.canVisitSend = true;
            expect(action('go-modify').enabled).to.equal(true);
            expect(action('new-send-tab').enabled).to.equal(true);
        });

        it('connects AI assistants only when the MCP tool is there', () => {
            const { action, state } = buildTestActions({ mcpPaths: [] });
            expect(action('connect-ai').enabled).to.equal(false);

            state.mcpPaths = ['/bin/mcp'];
            expect(action('connect-ai').enabled).to.equal(true);
        });

    });

    describe('the selected request', () => {

        it('lists its commands first in the palette', () => {
            const { actions } = buildTestActions({
                path: '/view/some-event',
                selected: { isPlainHttp: true, isPinned: false }
            });
            const shown = actions.filter((action) => !action.hiddenInPalette);
            const groups = searchCommands(shown, '', APP_ACTION_SECTIONS);

            expect(groups[0].section).to.equal('This request');
            expect(groups[0].matches.map((match) => match.command.label))
                .to.deep.equal(['Mock response', 'Resend', 'Copy as cURL', 'Pin']);
        });

        it('only offers them in View', () => {
            const { action, state } = buildTestActions({
                path: '/send',
                selected: { isPlainHttp: true, isPinned: false }
            });
            expect(action('request-resend').hiddenInPalette).to.equal(true);
            expect(action('request-resend').enabled).to.equal(false);

            state.path = '/view/some-event';
            expect(action('request-resend').hiddenInPalette).to.equal(false);
            expect(action('request-resend').enabled).to.equal(true);
        });

        it('runs them on the selected request', () => {
            const { action, calls } = buildTestActions({
                path: '/view',
                selected: { isPlainHttp: true, isPinned: false }
            });

            REQUEST_ACTION_IDS.forEach((id) => action(id).run());
            expect(calls).to.deep.equal([
                'request.mockResponse',
                'request.resend',
                'request.copyAsCurl',
                'request.togglePinned'
            ]);
        });

        it('only pins a WebSocket, and says when it would unpin', () => {
            const { action } = buildTestActions({
                path: '/view',
                selected: { isPlainHttp: false, isPinned: true }
            });

            expect(action('request-mock-response').enabled).to.equal(false);
            expect(action('request-resend').enabled).to.equal(false);
            expect(action('request-copy-curl').enabled).to.equal(false);
            expect(action('request-pin').enabled).to.equal(true);
            expect(action('request-pin').label).to.equal('Unpin');
        });

        it('follows the server version for mocking & resending', () => {
            const { action } = buildTestActions({
                path: '/view',
                selected: { isPlainHttp: true, isPinned: false },
                canVisitModify: false,
                canVisitSend: false
            });

            expect(action('request-mock-response').enabled).to.equal(false);
            expect(action('request-resend').enabled).to.equal(false);
            expect(action('request-copy-curl').enabled).to.equal(true);
        });

        it('does nothing without a selected request', () => {
            const { action, calls } = buildTestActions({ path: '/view' });

            REQUEST_ACTION_IDS.forEach((id) => action(id).run());
            expect(calls).to.deep.equal([]);
        });

    });

    describe('running', () => {

        it('goes to pages', () => {
            const { action, calls } = buildTestActions();

            action('go-view').run();
            action('go-settings').run();
            action('connect-iphone').run();
            action('connect-android').run();

            expect(calls).to.deep.equal([
                'navigate:/view',
                'navigate:/settings',
                'navigate:/intercept/iphone',
                'navigate:/intercept/android'
            ]);
        });

        it('pauses & resumes recording, and says which it will do', () => {
            const { action, calls } = buildTestActions();
            expect(action('toggle-recording').label).to.equal('Pause recording');

            action('toggle-recording').run();
            expect(calls).to.deep.equal(['togglePause']);
            expect(action('toggle-recording').label).to.equal('Resume recording');
        });

        it('clears traffic but keeps pinned requests', () => {
            const { action, calls } = buildTestActions({ events: [{ pinned: false }] });

            action('clear-traffic').run();
            expect(calls).to.deep.equal(['clearSelection', 'clearInterceptedData:false']);
        });

        it('toggles the Devices panel in View, and opens View to show it from elsewhere', () => {
            const { action, calls, state } = buildTestActions({ path: '/view', devicesPanelOpen: true });
            expect(action('toggle-devices-panel').label).to.equal('Hide the Devices panel');

            action('toggle-devices-panel').run();
            expect(calls).to.deep.equal(['devices.togglePanel']);

            state.path = '/send';
            calls.length = 0;
            expect(action('toggle-devices-panel').label).to.equal('Show the Devices panel');
            action('toggle-devices-panel').run();
            expect(calls).to.deep.equal(['navigate:/view', 'devices.showPanel']);
        });

        it('opens Send to show a closed Collections panel', () => {
            const { action, calls } = buildTestActions({ path: '/view', collectionsPanelOpen: false });

            action('toggle-collections-panel').run();
            expect(calls).to.deep.equal(['navigate:/send', 'collections.togglePanel']);
        });

        it('opens a new Send tab', () => {
            const { action, calls } = buildTestActions();

            action('new-send-tab').run();
            expect(calls).to.deep.equal(['addRequestInput', 'navigate:/send']);
        });

        it('hands file, clipboard & link work to the app', () => {
            const { action, calls } = buildTestActions({ events: [{ pinned: false }] });

            action('copy-proxy-address').run();
            action('import-har').run();
            action('export-har').run();
            action('open-docs').run();
            action('report-issue').run();
            action('connect-ai').run();
            action('command-palette').run();

            expect(calls).to.deep.equal([
                'copyProxyAddress',
                'importHar',
                'exportHar',
                `openUrl:${DOCS_URL}`,
                `openUrl:${REPORT_ISSUE_URL}`,
                'openMcpModal',
                'toggleCommandPalette'
            ]);
            expect(REPORT_ISSUE_URL).to.equal('https://github.com/azimxxm/wirepane-http-debugger/issues/new');
        });

    });

    describe('shortcut guards', () => {

        let editor: HTMLElement;
        let input: HTMLInputElement;

        beforeEach(() => {
            editor = document.createElement('div');
            editor.className = 'monaco-editor';
            editor.appendChild(document.createElement('textarea'));
            input = document.createElement('input');
            document.body.append(editor, input);
        });

        afterEach(() => {
            editor.remove();
            input.remove();
        });

        it("leaves ⌘K to code editors, which use it for their own shortcuts", () => {
            const { action } = buildTestActions();
            const palette = action('command-palette');

            expect(palette.shortcutAllowedIn!(editor.querySelector('textarea'))).to.equal(false);
            expect(palette.shortcutAllowedIn!(input)).to.equal(true);
            expect(palette.shortcutAllowedIn!(document.body)).to.equal(true);
        });

        it("never clears traffic while typing, and leaves View's own shortcut alone", () => {
            const { action, state } = buildTestActions({ path: '/send' });
            const clear = action('clear-traffic');

            expect(clear.shortcutAllowedIn!(document.body)).to.equal(true);
            expect(clear.shortcutAllowedIn!(input)).to.equal(false);
            expect(clear.shortcutAllowedIn!(editor.querySelector('textarea'))).to.equal(false);

            state.path = '/view';
            expect(clear.shortcutAllowedIn!(document.body)).to.equal(false);
        });

    });

});

describe('AppActionRunner', () => {

    function buildRunner(options: { enabled?: boolean, allowed?: boolean } = {}) {
        let now = 1000;
        const ran: string[] = [];
        const beforeRun: string[] = [];

        const testAction = (id: AppActionId): AppAction => ({
            id,
            section: 'Capture',
            label: id,
            enabled: options.enabled ?? true,
            shortcutAllowedIn: options.allowed === false ? () => false : undefined,
            run: () => { ran.push(id); }
        });

        const runner = new AppActionRunner([testAction('toggle-recording'), testAction('go-view')], {
            now: () => now,
            beforeRun: (action) => { beforeRun.push(action.id); },
            focusedElement: () => document.body
        });

        return { runner, ran, beforeRun, advance: (ms: number) => { now += ms; } };
    }

    it('runs an action from anywhere, after beforeRun', () => {
        const { runner, ran, beforeRun } = buildRunner();

        expect(runner.run('toggle-recording', 'palette')).to.equal(true);
        expect(runner.run('go-view', 'menu')).to.equal(true);

        expect(ran).to.deep.equal(['toggle-recording', 'go-view']);
        expect(beforeRun).to.deep.equal(['toggle-recording', 'go-view']);
    });

    it("doesn't run disabled or unknown actions", () => {
        const { runner, ran } = buildRunner({ enabled: false });

        expect(runner.run('toggle-recording', 'palette')).to.equal(false);
        expect(runner.run('no-such-action', 'menu')).to.equal(false);
        expect(ran).to.deep.equal([]);
    });

    it('runs one key press once, when the page and the menu bar both see it', () => {
        const { runner, ran, advance } = buildRunner();

        expect(runner.run('toggle-recording', 'keyboard')).to.equal(true);
        advance(30);
        expect(runner.run('toggle-recording', 'menu-shortcut')).to.equal(false);

        // Whichever arrives first:
        advance(1000);
        expect(runner.run('toggle-recording', 'menu-shortcut')).to.equal(true);
        advance(30);
        expect(runner.run('toggle-recording', 'keyboard')).to.equal(false);

        expect(ran).to.deep.equal(['toggle-recording', 'toggle-recording']);
    });

    it('still runs quick repeated presses, and separate presses', () => {
        const { runner, ran, advance } = buildRunner();

        runner.run('toggle-recording', 'keyboard');
        advance(100);
        runner.run('toggle-recording', 'keyboard'); // Pressed again: pause, then resume
        advance(600);
        runner.run('toggle-recording', 'menu-shortcut'); // A later, separate press
        runner.run('go-view', 'keyboard'); // A different action

        expect(ran).to.deep.equal(['toggle-recording', 'toggle-recording', 'toggle-recording', 'go-view']);
    });

    it('never drops menu clicks', () => {
        const { runner, ran } = buildRunner();

        runner.run('toggle-recording', 'keyboard');
        runner.run('toggle-recording', 'menu');

        expect(ran).to.deep.equal(['toggle-recording', 'toggle-recording']);
    });

    it("skips a menu shortcut that belongs to the focused element", () => {
        const { runner, ran } = buildRunner({ allowed: false });

        expect(runner.run('toggle-recording', 'menu-shortcut')).to.equal(false);
        // A click always runs it:
        expect(runner.run('toggle-recording', 'menu')).to.equal(true);
        expect(ran).to.deep.equal(['toggle-recording']);
    });

});
