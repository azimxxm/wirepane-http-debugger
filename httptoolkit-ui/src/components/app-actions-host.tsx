import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';

import { appHistory } from '../routing';
import { useHotkeys } from '../util/ui';
import { logError } from '../errors';
import { DesktopApi } from '../services/desktop-api';

import { EventsStore } from '../model/events/events-store';
import { ProxyStore } from '../model/proxy-store';
import { SendStore } from '../model/send/send-store';
import { DevicesStore } from '../model/devices/devices-store';
import { CollectionsStore } from '../model/collections/collections-store';
import { RulesStore } from '../model/rules/rules-store';
import { UiStore } from '../model/ui/ui-store';
import {
    AppAction,
    AppActionRunner,
    buildAppActions,
    canVisitModify,
    canVisitSend
} from '../model/ui/app-actions';
import { copyProxyAddress } from '../model/ui/proxy-address';
import {
    closeCommandPalette,
    commandPaletteState,
    toggleCommandPalette
} from '../model/ui/command-palette-state';
import { getSelectedRequestCommands } from '../model/ui/selected-request-commands';
import { exportHarFile, HarImportProblem, importHarFile } from '../model/events/har-files';

import { HarImportProblemDialog } from './common/har-import-problem-dialog';
import { CommandPalette } from './command-palette';

// One action's app-wide shortcut. Pages bind their own page-specific shortcuts.
const AppActionHotkey = (props: { action: AppAction, runner: AppActionRunner }) => {
    const { action, runner } = props;

    useHotkeys(action.hotkeys!, (event) => {
        // Left alone, without preventDefault, so the focused element (e.g. an editor) gets it
        if (action.shortcutAllowedIn && !action.shortcutAllowedIn(event.target as Element | null)) return;

        event.preventDefault();
        runner.run(action.id, 'keyboard');
    }, [action, runner]);

    return null;
};

/**
 * Runs the app actions (model/ui/app-actions.ts): binds their shortcuts, shows the ⌘K
 * palette, and runs whatever the desktop app's menu bar sends. Mounted once, in App.
 */
export const AppActionsHost = inject(
    'eventsStore',
    'proxyStore',
    'sendStore',
    'devicesStore',
    'collectionsStore',
    'rulesStore',
    'uiStore'
)(observer((props: {
    eventsStore?: EventsStore,
    proxyStore?: ProxyStore,
    sendStore?: SendStore,
    devicesStore?: DevicesStore,
    collectionsStore?: CollectionsStore,
    rulesStore?: RulesStore,
    uiStore?: UiStore
}) => {
    const [problem, setProblem] = React.useState<HarImportProblem | undefined>();

    const runner = React.useMemo(() => {
        const eventsStore = props.eventsStore!;
        const proxyStore = props.proxyStore!;
        const navigate = (path: string) => { appHistory.navigate(path); };

        const actions = buildAppActions({
            eventsStore,
            proxyStore,
            sendStore: props.sendStore!,
            devicesStore: props.devicesStore!,
            collectionsStore: props.collectionsStore!,
            uiStore: props.uiStore!,

            currentPath: () => appHistory.location.pathname,
            navigate,
            // The desktop app opens these in the system browser
            openUrl: (url) => { window.open(url, '_blank', 'noopener,noreferrer'); },
            toggleCommandPalette,
            copyProxyAddress: () => { copyProxyAddress(proxyStore); },
            importHar: () => {
                navigate('/view'); // Where the imported requests show up
                importHarFile(eventsStore).then(setProblem).catch(logError);
            },
            exportHar: () => { exportHarFile(eventsStore.events).catch(logError); },
            canVisitModify,
            canVisitSend,
            selectedRequest: () => getSelectedRequestCommands({
                uiStore: props.uiStore!,
                eventsStore,
                rulesStore: props.rulesStore!,
                sendStore: props.sendStore!,
                navigate
            })
        });

        return new AppActionRunner(actions, {
            // Anything else closes the palette first
            beforeRun: (action) => { if (action.id !== 'command-palette') closeCommandPalette(); }
        });
    }, []);

    // The desktop app's menu bar: clicks, and shortcuts the page didn't take
    React.useEffect(() => DesktopApi.onAppAction?.((actionId, details) => {
        runner.run(actionId, details.triggeredByAccelerator ? 'menu-shortcut' : 'menu');
    }), [runner]);

    // Going to another page any other way (a link, a page's own shortcut, Back) closes it too
    React.useEffect(() => appHistory.listen(() => closeCommandPalette()), []);

    const runFromPalette = React.useCallback((action: AppAction) => {
        closeCommandPalette();
        // Once the palette has closed and given focus back, so the action can move focus itself
        setTimeout(() => runner.run(action.id, 'palette'));
    }, [runner]);

    return <>
        { runner.actions.filter((action) => action.hotkeys).map((action) =>
            <AppActionHotkey key={action.id} action={action} runner={runner} />
        ) }

        { commandPaletteState.isOpen && <CommandPalette
            actions={runner.actions.filter((action) => !action.hiddenInPalette)}
            onRun={runFromPalette}
            onClose={closeCommandPalette}
        /> }

        { problem && <HarImportProblemDialog problem={problem} onClose={() => setProblem(undefined)} /> }
    </>;
}));
