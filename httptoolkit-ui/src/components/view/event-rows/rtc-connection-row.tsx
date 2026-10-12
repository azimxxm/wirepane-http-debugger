import * as React from 'react';
import { observer } from 'mobx-react';

import { ArrowIcon, Icon } from '../../../icons';
import { RTCConnection } from '../../../types';
import { DeviceCell } from '../../devices/device-marker'; // wirepane: device markers
import { OptionalColumnCells, RowAttentionMarker, TypeCell } from './list-columns'; // wirepane: list columns

import {
    TrafficEventListRow,
    RowPin,
    EventTypeColumn,
    Source,
    RTCConnectionDetails,
    ConnectedSpinnerIcon,
    CommonRowProps,
    InlineStatus,
    SourceIcon,
    RowDetail
} from './event-row-components';

export const RTCConnectionRow = observer((p: {
    rowProps: CommonRowProps,
    event: RTCConnection
}) => {
    const { event } = p;
    const { category, pinned } = event;

    return <TrafficEventListRow
        role="row"
        aria-label={
            `${
                event.closeState ? 'Closed' : 'Open'
            } RTC connection from ${
                event.clientURL
            } to ${
                event.remoteURL ?? 'an unknown peer'
            } opened by ${
                event.source.summary
            }`
        }
        {...p.rowProps}
    >
        <RowPin pinned={pinned}/>
        <RowAttentionMarker event={event} />
        <EventTypeColumn role='gridcell'>
            { !event.closeState && <ConnectedSpinnerIcon /> } WebRTC
        </EventTypeColumn>
        <TypeCell event={event} />
        <Source role='gridcell' title={event.source.summary}>
            <Icon
                {...event.source.icon}
                fixedWidth={true}
            />
        </Source>
        <DeviceCell event={event} />
        <RTCConnectionDetails role='gridcell'>
            {
                event.clientURL
            } <ArrowIcon direction='right' /> {
                event.remoteURL || '?'
            }
        </RTCConnectionDetails>
        <OptionalColumnCells event={event} />
    </TrafficEventListRow>;
});

export function rtcConnectionPreviewContent(event: RTCConnection): React.ReactNode {
    return <>
        {!event.closeState && <InlineStatus status={undefined} />}
        <span>WebRTC</span>
        <SourceIcon {...event.source.icon} fixedWidth />
        <RowDetail>{event.clientURL} → {event.remoteURL || '?'}</RowDetail>
    </>;
}
