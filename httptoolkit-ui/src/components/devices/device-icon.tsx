import * as React from 'react';
import {
    type Icon as PhosphorIconComponent,
    AndroidLogo,
    AppleLogo,
    Devices,
    Laptop,
    LinuxLogo,
    WifiHigh,
    WindowsLogo
} from '@phosphor-icons/react';

import { DeviceType } from '../../model/devices/device-model';

// Phones by platform (like the Intercept cards), computers by shape, so this Mac
// doesn't look like the iPhones next to it
const DEVICE_ICONS: { [type in DeviceType]: PhosphorIconComponent } = {
    iphone: AppleLogo,
    ipad: AppleLogo,
    ios: AppleLogo,
    android: AndroidLogo,
    mac: Laptop,
    windows: WindowsLogo,
    linux: LinuxLogo,
    other: WifiHigh // Something on the network that hasn't said what it is
};

export const DeviceIcon = (props: {
    type: DeviceType | 'all',
    size?: number,
    className?: string
}) => {
    const IconComponent = props.type === 'all' ? Devices : DEVICE_ICONS[props.type];
    return <IconComponent className={props.className} size={props.size ?? 16} aria-hidden={true} />;
};
