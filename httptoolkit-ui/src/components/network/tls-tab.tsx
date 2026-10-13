import * as React from 'react';
// mobx-react's observer makes a class of a function component, and then hooks can't be used
import { observer } from 'mobx-react-lite';

import { styled } from '../../styles';
import { VpnNetworkStore } from '../../model/interception/vpn-network';
import { VpnMetadataLoader, VpnPeerNames } from '../../model/devices/vpn-peer-names';
import {
    Ja4Count,
    Ja4Group,
    describeJa4,
    groupTlsHellosByJa4
} from '../../model/interception/vpn-ja4';
import { UnstyledButton } from '../common/inputs';
import { CopyableMonoValue } from '../common/text-content';

// A fingerprint seen from many places would otherwise make its card very long
const SNIS_SHOWN_AT_FIRST = 6;

// --- Layout ---

const TabLayout = styled.div`
    display: flex;
    flex-direction: column;
    gap: 16px;

    font-size: ${p => p.theme.textSize};
    line-height: 1.5;
    color: ${p => p.theme.mainColor};
`;

const Panel = styled.section`
    box-sizing: border-box;
    min-width: 0;
    padding: 20px;

    background-color: ${p => p.theme.mainBackground};
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 8px;
`;

const PanelTitle = styled.h2`
    font-size: ${p => p.theme.subHeadingSize};
    font-weight: 600;
    line-height: 1.3;
`;

const Lowlight = styled.p`
    margin-top: 4px;
    color: ${p => p.theme.mainLowlightColor};
`;

const EmptyState = styled.div`
    margin-top: 16px;
    max-width: 62ch;
    color: ${p => p.theme.mainLowlightColor};

    > p + p {
        margin-top: 8px;
    }
`;

// --- One fingerprint ---

const GroupList = styled.ul`
    margin-top: 16px;
    padding: 0;
    list-style: none;

    display: flex;
    flex-direction: column;
    gap: 12px;
`;

const GroupCard = styled.li`
    box-sizing: border-box;
    padding: 14px 16px;

    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 6px;
`;

const GroupHeader = styled.div`
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: space-between;
    gap: 4px 16px;
`;

const Ja4Value = styled(CopyableMonoValue)`
    font-size: ${p => p.theme.textSize};
`;

const Count = styled.span`
    white-space: nowrap;
    font-weight: 600;
`;

const Description = styled.p`
    margin-top: 2px;
    color: ${p => p.theme.mainLowlightColor};
`;

const Facts = styled.dl`
    margin: 10px 0 0;

    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    gap: 6px 14px;
    align-items: baseline;

    > dt {
        color: ${p => p.theme.mainLowlightColor};
    }

    > dd {
        margin: 0;
        min-width: 0;

        display: flex;
        flex-wrap: wrap;
        gap: 4px 6px;
        align-items: center;
    }
`;

const Chip = styled.span`
    padding: 1px 8px;
    border: 1px solid ${p => p.theme.containerBorder};
    border-radius: 4px;

    font-family: ${p => p.theme.monoFontFamily};
    font-size: ${p => p.theme.textInputFontSize};
    word-break: break-all;

    > span {
        margin-left: 6px;
        font-family: ${p => p.theme.fontFamily};
        color: ${p => p.theme.mainLowlightColor};
    }
`;

const Muted = styled.span`
    color: ${p => p.theme.mainLowlightColor};
`;

const ShowMoreButton = styled(UnstyledButton)`
    padding: 1px 4px;
    border-radius: 4px;
    color: ${p => p.theme.popColor};
    font-size: ${p => p.theme.textInputFontSize};

    &:hover {
        text-decoration: underline;
    }

    &:focus-visible {
        outline: 2px solid ${p => p.theme.focusRing};
        outline-offset: 2px;
    }
`;

const plural = (count: number, one: string, many: string) =>
    `${count} ${count === 1 ? one : many}`;

const CountedChip = (p: { item: Ja4Count, label?: string }) =>
    <Chip>{ p.label ?? p.item.value }<span>{ p.item.count }</span></Chip>;

const SniList = (p: { group: Ja4Group }) => {
    const { snis, withoutSni } = p.group;
    const [showAll, setShowAll] = React.useState(false);

    const shown = showAll ? snis : snis.slice(0, SNIS_SHOWN_AT_FIRST);
    const hidden = snis.length - shown.length;

    return <>
        { shown.map((sni) => <CountedChip key={sni.value} item={sni} />) }
        { hidden > 0 && <ShowMoreButton onClick={() => setShowAll(true)}>
            +{ hidden } more
        </ShowMoreButton> }
        { withoutSni > 0 && <Chip title='The app connected to an address, with no name in its hello'>
            no name<span>{ withoutSni }</span>
        </Chip> }
        { snis.length === 0 && withoutSni === 0 && <Muted>-</Muted> }
    </>;
};

// An observer, because the device names fill in later, when the server has answered
const Ja4Card = observer((p: { group: Ja4Group, peerNames: VpnPeerNames }) => {
    const { group, peerNames } = p;
    const description = describeJa4(group.ja4);

    return <GroupCard>
        <GroupHeader>
            <Ja4Value>{ group.ja4 }</Ja4Value>
            <Count>{ plural(group.count, 'handshake', 'handshakes') }</Count>
        </GroupHeader>
        { description && <Description>{ description }</Description> }

        <Facts>
            <dt>Names</dt>
            <dd><SniList group={group} /></dd>

            <dt>Devices</dt>
            <dd>{ group.peers.map((peer) =>
                <CountedChip key={peer.value} item={peer} label={peerNames.nameOf(peer.value)} />
            ) }</dd>

            <dt>Last seen</dt>
            <dd>{ new Date(group.lastSeen).toLocaleTimeString() }</dd>
        </Facts>
    </GroupCard>;
});

/**
 * The TLS tab of the Network page: every TLS handshake the VPN saw, grouped by its JA4
 * fingerprint. One fingerprint is one app or library, so this answers "which app was that?"
 * even for apps that pin their certificates and show up in View as a host only.
 * `loadMetadata` is only for tests: it replaces the call to the server for the device names.
 */
export const TlsTab = observer((props: { store: VpnNetworkStore, loadMetadata?: VpnMetadataLoader }) => {
    const { store, loadMetadata } = props;
    const peerNames = React.useMemo(() => new VpnPeerNames(loadMetadata), [loadMetadata]);

    const hellos = store.tlsHellos;
    const groups = groupTlsHellosByJa4(hellos);

    // Ask the server who each device is, once per device
    const peerIds = Array.from(new Set(hellos.map((hello) => hello.peer))).join(',');
    React.useEffect(() => {
        if (peerIds) peerNames.ensureNamed(peerIds.split(','));
    }, [peerNames, peerIds]);

    return <TabLayout>
        <Panel aria-labelledby='tls-fingerprints-heading'>
            <PanelTitle id='tls-fingerprints-heading'>TLS fingerprints (JA4)</PanelTitle>

            { groups.length > 0
                ? <>
                    <Lowlight>
                        { `${plural(hellos.length, 'handshake', 'handshakes')} from ${plural(groups.length, 'fingerprint', 'fingerprints')}` }
                    </Lowlight>
                    <GroupList aria-label='Fingerprints, the most common first'>
                        { groups.map((group) =>
                            <Ja4Card key={group.ja4} group={group} peerNames={peerNames} />
                        ) }
                    </GroupList>
                </>
                : <EmptyState>
                    <p>No TLS handshakes yet.</p>
                    <p>
                        Every HTTPS connection starts with a hello that tells the server which TLS
                        features the app supports. Its JA4 fingerprint is the same for every
                        connection of one app or library, so it tells apps apart.
                    </p>
                    <p>
                        Apps that pin their certificates show up here too: the fingerprint comes
                        from the hello, before any certificate is checked.
                    </p>
                </EmptyState>
            }
        </Panel>
    </TabLayout>;
});
