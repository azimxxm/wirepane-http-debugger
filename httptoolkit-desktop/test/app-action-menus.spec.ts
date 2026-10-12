import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import type { MenuItemConstructorOptions, WebContents } from 'electron';

import {
    APP_ACTION_CHANNEL,
    AppActionSender,
    buildCaptureMenu,
    buildGoMenu,
    buildReportIssueItem,
    buildSettingsItem,
    REPORT_ISSUE_URL,
    sendAppActionTo
} from '../src/app-action-menus.ts';

// Unit tests for the menu bar's app action entries: no Electron needed, as they're plain templates

type SentAction = [string, { triggeredByAccelerator: boolean }];

function buildTestMenus() {
    const sent: SentAction[] = [];
    const send: AppActionSender = (actionId, details) => { sent.push([actionId, details]); };

    return {
        sent,
        go: buildGoMenu(send),
        capture: buildCaptureMenu(send),
        settings: buildSettingsItem(send)
    };
}

const itemsOf = (menu: MenuItemConstructorOptions) => menu.submenu as MenuItemConstructorOptions[];

const describeItems = (menu: MenuItemConstructorOptions) => itemsOf(menu).map((item) =>
    item.type === 'separator' ? '---' : `${item.id} | ${item.label} | ${item.accelerator ?? ''}`
);

const click = (item: MenuItemConstructorOptions, triggeredByAccelerator: boolean) =>
    (item.click as Function)(undefined, undefined, { triggeredByAccelerator });

test.describe('Menu bar app actions', () => {

    test('the Go menu has the pages and the command palette', () => {
        const { go } = buildTestMenus();

        expect(go.label).toBe('&Go');
        expect(describeItems(go)).toEqual([
            'go-intercept | Intercept | CmdOrCtrl+1',
            'go-view | View | CmdOrCtrl+2',
            'go-modify | Modify | CmdOrCtrl+3',
            'go-send | Send | CmdOrCtrl+4',
            '---',
            'command-palette | Command Palette… | CmdOrCtrl+K'
        ]);
    });

    test('the Capture menu has recording, traffic & HAR files', () => {
        const { capture } = buildTestMenus();

        expect(capture.label).toBe('&Capture');
        expect(describeItems(capture)).toEqual([
            'toggle-recording | Pause/Resume Recording | CmdOrCtrl+Shift+R',
            'clear-traffic | Clear Traffic | CmdOrCtrl+Shift+Backspace',
            '---',
            'copy-proxy-address | Copy Proxy Address | ',
            '---',
            'import-har | Import HAR… | CmdOrCtrl+O',
            'export-har | Export HAR… | '
        ]);
    });

    test('Settings is on ⌘,', () => {
        const { settings } = buildTestMenus();
        expect(`${settings.id} | ${settings.label} | ${settings.accelerator}`)
            .toBe('go-settings | Settings… | CmdOrCtrl+,');
    });

    test("the shortcuts are only shown on Windows & Linux, as the page handles them itself", () => {
        const { go, capture, settings } = buildTestMenus();
        const actionItems = [...itemsOf(go), ...itemsOf(capture), settings]
            .filter((item) => item.type !== 'separator');

        actionItems.forEach((item) => expect(item.registerAccelerator, item.label).toBe(false));
    });

    test('clicks send the action id, and say whether a shortcut did it', () => {
        const { go, capture, sent } = buildTestMenus();

        click(itemsOf(go)[1], false);
        click(itemsOf(capture)[0], true);

        expect(sent).toEqual([
            ['go-view', { triggeredByAccelerator: false }],
            ['toggle-recording', { triggeredByAccelerator: true }]
        ]);
    });

    test("every id is one of the UI's app actions", () => {
        const { go, capture, settings } = buildTestMenus();
        const menuIds = [...itemsOf(go), ...itemsOf(capture), settings]
            .map((item) => item.id)
            .filter((id): id is string => !!id);

        const registrySource = fs.readFileSync(path.join(
            import.meta.dirname, '..', '..', 'httptoolkit-ui', 'src', 'model', 'ui', 'app-actions.ts'
        ), 'utf8');
        const idList = registrySource.match(/APP_ACTION_IDS = \[([\s\S]*?)\] as const/)![1];
        const uiIds = Array.from(idList.matchAll(/'([a-z-]+)'/g), (match) => match[1]);

        expect(uiIds.length).toBeGreaterThan(10);
        menuIds.forEach((id) => expect(uiIds, id).toContain(id));
    });

    test('the preload listens on the same channel', () => {
        const preloadSource = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'preload.cts'), 'utf8');
        expect(preloadSource).toContain(`'${APP_ACTION_CHANNEL}'`);
    });

    test('Report an Issue opens our own issues page', () => {
        const opened: string[] = [];
        const item = buildReportIssueItem((url) => opened.push(url));

        (item.click as Function)();

        expect(item.label).toBe('Report an Issue…');
        expect(opened).toEqual(['https://github.com/azimxxm/wirepane/issues/new']);
        expect(REPORT_ISSUE_URL).toBe(opened[0]);
    });

});

test.describe('Sending app actions to a window', () => {

    function fakeContents(options: { destroyed?: boolean, scriptFails?: boolean } = {}) {
        const calls: unknown[][] = [];
        const contents = {
            isDestroyed: () => !!options.destroyed,
            executeJavaScript: async (code: string, userGesture: boolean) => {
                calls.push(['executeJavaScript', code, userGesture]);
                if (options.scriptFails) throw new Error('Not loaded');
            },
            send: (...args: unknown[]) => { calls.push(['send', ...args]); }
        } as unknown as WebContents;
        return { contents, calls };
    }

    test('gives the page a user gesture first, so it can open file pickers', async () => {
        const { contents, calls } = fakeContents();

        await sendAppActionTo(contents, 'import-har', { triggeredByAccelerator: false });

        expect(calls).toEqual([
            ['executeJavaScript', 'void 0', true],
            ['send', APP_ACTION_CHANNEL, 'import-har', { triggeredByAccelerator: false }]
        ]);
    });

    test("still sends the action if the page can't run scripts yet", async () => {
        const { contents, calls } = fakeContents({ scriptFails: true });

        await sendAppActionTo(contents, 'go-view', { triggeredByAccelerator: true });

        expect(calls[1]).toEqual(['send', APP_ACTION_CHANNEL, 'go-view', { triggeredByAccelerator: true }]);
    });

    test('sends nothing to a closed window', async () => {
        const { contents, calls } = fakeContents({ destroyed: true });

        await sendAppActionTo(contents, 'go-view', { triggeredByAccelerator: false });

        expect(calls).toEqual([]);
    });

});
