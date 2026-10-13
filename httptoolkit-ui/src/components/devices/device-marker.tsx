import * as React from 'react';
import { inject } from 'mobx-react';
import { observer } from 'mobx-react-lite';

import { styled } from '../../styles';
import { ViewableEvent } from '../../types';

import { DevicesStore } from '../../model/devices/devices-store';

import { DeviceIcon } from './device-icon';
import { VpnShield } from './vpn-badge';

// Sits between Source and Host in View's list, at a fixed width so the header & every
// row line up. Long names end in "…", and the host & path give way first.
export const DEVICE_COLUMN_WIDTH = 84;

const DeviceColumn = styled.div<{ role: 'gridcell' | 'columnheader' }>`
    flex: 0 0 ${DEVICE_COLUMN_WIDTH}px;
    padding: 3px 0;
    overflow: hidden;

    display: flex;
    align-items: center;
    gap: 5px;

    white-space: nowrap;
`;

const DeviceName = styled.span`
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;

    font-size: ${p => p.theme.smallPrintSize};
    color: ${p => p.theme.mainLowlightColor};
`;

const DeviceTypeIcon = styled(DeviceIcon)`
    flex-shrink: 0;
    color: ${p => p.theme.mainLowlightColor};
`;

// Holds the type icon, so a marker can sit on its corner without taking any room from the name
const IconSlot = styled.span`
    position: relative;
    flex-shrink: 0;
    display: inline-flex;
`;

/**
 * The list's Device column header. Only shown while rows have device markers: when
 * traffic came from more than one device and the Devices panel shows all of them.
 */
export const DeviceColumnHeader = inject('devicesStore')(observer((props: {
    devicesStore?: DevicesStore
}) => {
    if (!props.devicesStore!.showDeviceMarkers) return null;
    return <DeviceColumn role='columnheader'>Device</DeviceColumn>;
}));

/**
 * The device that sent a row's request: its type icon & short name ("iPhone", "Pixel 8"),
 * and a VPN shield when the request came through the VPN.
 */
export const DeviceCell = inject('devicesStore')(observer((props: {
    devicesStore?: DevicesStore,
    event: ViewableEvent
}) => {
    const store = props.devicesStore!;
    if (!store.showDeviceMarkers) return null;

    const marker = store.getDeviceMarker(props.event);
    // Only a request that came through the VPN says so: a phone can use the proxy as well
    const vpn = marker && store.describeEventVpn(props.event);
    const origin = marker ? `From ${marker.title}` : 'From an unknown device';
    return <DeviceColumn role='gridcell' title={vpn ? `${origin} · ${vpn}` : origin}>
        { marker && <>
            <IconSlot>
                <DeviceTypeIcon type={marker.type} size={14} />
                { vpn && <VpnShield size={9} weight='fill' role='img' aria-label='VPN' /> }
            </IconSlot>
            <DeviceName>{ marker.name }</DeviceName>
        </> }
    </DeviceColumn>;
}));
