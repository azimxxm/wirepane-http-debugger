import * as React from 'react';
import { observer } from 'mobx-react';

import { VpnNetworkStore } from '../../model/interception/vpn-network';

// Placeholder from the lead's contract stubs (docs/plans/2026-10-13-rust-network-tools.md): T4
// replaces it with the DNS rules editor, which T3's DNS tab shows above the query list.
export const DnsRulesEditor = observer((_props: { store: VpnNetworkStore }) => null);
