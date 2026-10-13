import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';
import { SidebarSimple } from '@phosphor-icons/react';

import { styled } from '../../styles';
import { formatShortcut } from '../../util/shortcuts';
import { appHistory } from '../../routing';

import { UiStore } from '../../model/ui/ui-store';
import {
    DEFAULT_DEVICES_PANEL_WIDTH,
    DevicesStore,
    MAX_DEVICES_PANEL_WIDTH,
    MIN_DEVICES_PANEL_WIDTH
} from '../../model/devices/devices-store';

import { ActionButton } from '../common/action-button';
import {
    CollapsedPanelStrip,
    PanelHeader,
    PanelResizeHandle,
    PanelRoot,
    PanelScroller,
    PanelSizing,
    PanelToggleShortcut,
    PanelToolButton,
    TOGGLE_SIDE_PANEL_SHORTCUT,
    usePanelResize
} from '../common/side-panel';
import { ANDROID_SETUP_PATH, IPHONE_SETUP_PATH } from '../intercept/phone/phone-setup-routes';

import { DeviceIcon } from './device-icon';
import { DeviceTree } from './device-tree';

const ConnectHint = styled.div`
    margin: 6px 12px 12px;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    background-color: ${p => p.theme.mainBackground};

    h3 {
        font-size: ${p => p.theme.textInputFontSize};
        font-weight: 600;
        color: ${p => p.theme.mainColor};
    }

    p {
        margin-top: 4px;
        font-size: ${p => p.theme.smallPrintSize};
        line-height: 1.5;
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const HintActions = styled.div`
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
`;

// The collapsed strip's toggle, with a count once there's traffic from more than one device
const ShowPanelButton = styled(PanelToolButton)`
    position: relative;
`;

const DeviceCountBadge = styled.span`
    position: absolute;
    top: -2px;
    right: -3px;
    min-width: 15px;
    height: 15px;
    padding: 0 4px;
    border-radius: 8px;
    box-sizing: border-box;

    font-size: ${p => p.theme.tinyTextSize};
    font-weight: 600;
    line-height: 15px;
    text-align: center;
    font-variant-numeric: tabular-nums;

    color: ${p => p.theme.mainBackground};
    background-color: ${p => p.theme.mainLowlightColor};
`;

// In the collapsed strip: says the list only shows one device, and opens the panel
const SelectionMarker = styled(PanelToolButton)`
    color: ${p => p.theme.popColor};
    background-color: ${p => p.theme.selectionInactiveBackground};

    &:hover {
        color: ${p => p.theme.popColor};
    }
`;

// No phone has sent anything yet: where to go to connect one
const ConnectPhoneHint = () => <ConnectHint>
    <h3>Connect a phone</h3>
    <p>Each phone or tablet gets its own row here, with only its requests.</p>
    <HintActions>
        <ActionButton
            title='Set up an iPhone or iPad on the same Wi-Fi'
            onClick={() => appHistory.navigate(IPHONE_SETUP_PATH)}
        >
            Connect iPhone
        </ActionButton>
        <ActionButton
            title='Set up an Android device'
            onClick={() => appHistory.navigate(ANDROID_SETUP_PATH)}
        >
            Connect Android
        </ActionButton>
    </HintActions>
</ConnectHint>;

/**
 * The Devices panel on the left of View: All devices, this machine, then every phone or
 * computer that sent traffic. Selecting one filters the list, together with the filter
 * box. Like the Collections panel in Send, it collapses to a thin strip and keeps its width.
 */
export const DevicesPanel = inject('devicesStore', 'uiStore')(observer((props: {
    devicesStore?: DevicesStore,
    uiStore?: UiStore
}) => {
    const store = props.devicesStore!;
    const sizing: PanelSizing = {
        width: store.panelWidth,
        minWidth: MIN_DEVICES_PANEL_WIDTH,
        maxWidth: MAX_DEVICES_PANEL_WIDTH,
        defaultWidth: DEFAULT_DEVICES_PANEL_WIDTH,
        setWidth: store.setPanelWidth
    };
    const { width, handleProps } = usePanelResize(sizing);
    const toggleLabel = formatShortcut(TOGGLE_SIDE_PANEL_SHORTCUT);
    const { selection } = store;

    if (!store.panelOpen) {
        const selectedDevice = selection && store.getListedDevice(selection.deviceKey);
        const selectionLabel = selection && `Showing only ${store.describeSelection(selection)}`;
        // Hidden while everything is from this machine, so only other devices make it worth a count
        const deviceCount = store.devices.length;
        const countLabel = deviceCount > 1 ? `, ${deviceCount} devices` : '';

        return <CollapsedPanelStrip aria-label='Devices (hidden)'>
            <PanelToggleShortcut onToggle={store.togglePanel} />
            <ShowPanelButton
                title={`Show devices${countLabel} (${toggleLabel})`}
                aria-label={`Show devices${countLabel}`}
                aria-expanded={false}
                onClick={store.togglePanel}
            >
                <SidebarSimple size={18} />
                { deviceCount > 1 && <DeviceCountBadge aria-hidden={true}>{ deviceCount }</DeviceCountBadge> }
            </ShowPanelButton>
            { selection && <SelectionMarker
                title={`${selectionLabel}. Click to show the Devices panel.`}
                aria-label={`${selectionLabel}. Show devices`}
                onClick={store.showPanel}
            >
                <DeviceIcon type={selectedDevice?.type ?? 'all'} size={18} />
            </SelectionMarker> }
        </CollapsedPanelStrip>;
    }

    // The hint is for when only this machine is listed. A pinned device keeps its row without traffic.
    const listsOtherDevices = store.otherDevices.length > 0 ||
        store.pinnedDevices.some((device) => !device.isThisMachine);

    return <PanelRoot aria-label='Devices' style={{ width }}>
        <PanelToggleShortcut onToggle={store.togglePanel} />
        <PanelHeader>
            <h2>Devices</h2>
            <PanelToolButton
                title={`Hide devices (${toggleLabel})`}
                aria-label='Hide devices'
                aria-expanded={true}
                onClick={store.togglePanel}
            >
                <SidebarSimple size={16} />
            </PanelToolButton>
        </PanelHeader>

        <PanelScroller>
            <DeviceTree devicesStore={store} uiStore={props.uiStore!} />
            { !listsOtherDevices && <ConnectPhoneHint /> }
        </PanelScroller>

        <PanelResizeHandle label='Resize devices' width={width} sizing={sizing} handleProps={handleProps} />
    </PanelRoot>;
}));

const WorkspaceRoot = styled.div`
    position: relative;
    height: 100%;

    display: flex;
    flex-direction: row;
`;

const WorkspaceMain = styled.div`
    position: relative; /* The split pane inside fills this */
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
`;

/**
 * View's list & details, with the Devices panel on their left.
 */
export const DevicesWorkspace = (props: { children: React.ReactNode }) => <WorkspaceRoot>
    <DevicesPanel />
    <WorkspaceMain>{ props.children }</WorkspaceMain>
</WorkspaceRoot>;
