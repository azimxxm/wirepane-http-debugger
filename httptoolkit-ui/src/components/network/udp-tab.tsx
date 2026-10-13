import * as React from 'react';
import { observer } from 'mobx-react';

import { VpnNetworkStore } from '../../model/interception/vpn-network';

// Placeholder from the lead's contract stubs (docs/plans/2026-10-13-rust-network-tools.md): the
// tool that owns this tab replaces it.
export const UdpTab = observer((_props: { store: VpnNetworkStore }) =>
    <p>Coming soon.</p>
);
