//! WireGuard front-end.
//!
//! Derived from mitmproxy_rs v0.12.11, `src/packet_sources/wireguard.rs`
//! (MIT License, Copyright (c) the mitmproxy_rs authors). Changes: peers can be added and removed
//! while running; packets are only accepted from the tunnel address their peer owns (like
//! AllowedIPs), so one phone can't poison another's routing; no `unwrap` on peer or endpoint
//! lookups (unknown peers and peers without a known endpoint are dropped); an unknown peer's
//! datagram never reaches another peer; IPv6 is dropped (v1); malformed TCP/UDP is filtered before
//! it reaches the smoltcp network task, because that task stops on a few bad inputs.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex, MutexGuard, PoisonError};
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Result, anyhow};
use boringtun::noise::{Packet, Tunn, TunnResult, handshake::parse_handshake_anon};
use boringtun::x25519::{PublicKey, StaticSecret};
use mitmproxy::messages::{
    NetworkCommand, NetworkEvent, SmolPacket, TransportCommand, TransportEvent, TunnelInfo,
};
use mitmproxy::network::{MAX_PACKET_SIZE, add_network_layer};
use mitmproxy::shutdown;
use serde_json::{Value, json};
use smoltcp::wire::{IpProtocol, Ipv4Packet, TcpPacket, UdpPacket};
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use super::{PeerDirectory, PeerView};
use crate::events::EventSink;

/// WireGuard adds up to 80 bytes (IPv6 outer header) to every packet.
const WG_HEADER_SIZE: usize = 80;
/// Same value mitmproxy uses for the WireGuard persistent keepalive.
const KEEPALIVE_SECONDS: u16 = 25;

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    // A panic while holding the lock must not take the whole sidecar down with it.
    mutex.lock().unwrap_or_else(PoisonError::into_inner)
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

struct WgPeer {
    id: String,
    name: String,
    tunnel_ip: Ipv4Addr,
    public_key: PublicKey,
    tunn: Tunn,
    endpoint: Option<SocketAddr>,
    last_handshake_ms: Option<u64>,
    removed_tx: watch::Sender<bool>,
}

#[derive(Debug, Clone)]
pub struct PeerSummary {
    pub peer: String,
    pub name: String,
    pub tunnel_ip: Ipv4Addr,
    pub endpoint: Option<SocketAddr>,
    pub last_handshake_ms: Option<u64>,
}

#[derive(Default)]
struct Outcome {
    /// Datagrams to send back to the sender (handshake replies, queued packets).
    replies: Vec<Vec<u8>>,
    /// A decrypted packet for the network layer.
    inbound: Option<SmolPacket>,
    /// A `peer` event to emit.
    peer_event: Option<Value>,
}

/// All peers of the WireGuard front-end. Shared between the packet task and the command side.
#[derive(Default)]
pub struct WgPeers {
    by_index: HashMap<u32, WgPeer>,
    by_key: HashMap<PublicKey, u32>,
    by_ip: HashMap<Ipv4Addr, u32>,
    next_index: u32,
}

impl WgPeers {
    pub fn add(
        &mut self,
        server_private: &StaticSecret,
        id: &str,
        name: &str,
        tunnel_ip: Ipv4Addr,
        public_key: PublicKey,
    ) {
        // Indexes are never reused: a late packet for a removed peer can't match a new one.
        self.next_index += 1;
        let index = self.next_index;
        let tunn = Tunn::new(
            server_private.clone(),
            public_key,
            None,
            Some(KEEPALIVE_SECONDS),
            index,
            None,
        );
        let (removed_tx, _) = watch::channel(false);
        self.by_key.insert(public_key, index);
        self.by_ip.insert(tunnel_ip, index);
        self.by_index.insert(
            index,
            WgPeer {
                id: id.to_string(),
                name: name.to_string(),
                tunnel_ip,
                public_key,
                tunn,
                endpoint: None,
                last_handshake_ms: None,
                removed_tx,
            },
        );
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let Some(index) = self
            .by_index
            .iter()
            .find(|(_, peer)| peer.id == id)
            .map(|(index, _)| *index)
        else {
            return false;
        };
        if let Some(peer) = self.by_index.remove(&index) {
            self.by_key.remove(&peer.public_key);
            self.by_ip.remove(&peer.tunnel_ip);
            peer.removed_tx.send(true).ok();
        }
        true
    }

    pub fn summaries(&self) -> Vec<PeerSummary> {
        let mut list: Vec<PeerSummary> = self
            .by_index
            .values()
            .map(|peer| PeerSummary {
                peer: peer.id.clone(),
                name: peer.name.clone(),
                tunnel_ip: peer.tunnel_ip,
                endpoint: peer.endpoint,
                last_handshake_ms: peer.last_handshake_ms,
            })
            .collect();
        list.sort_by_key(|p| p.tunnel_ip);
        list
    }

    fn handle_datagram(
        &mut self,
        server_private: &StaticSecret,
        server_public: &PublicKey,
        data: &[u8],
        src: SocketAddr,
        buf: &mut [u8],
    ) -> Outcome {
        let mut outcome = Outcome::default();

        let packet = match Tunn::parse_incoming_packet(data) {
            Ok(packet) => packet,
            Err(error) => {
                log::debug!("ignoring invalid WireGuard packet from {src}: {error:?}");
                return outcome;
            }
        };

        let mut is_handshake = false;
        let index = match packet {
            Packet::HandshakeInit(init) => {
                is_handshake = true;
                match parse_handshake_anon(server_private, server_public, &init) {
                    Ok(handshake) => {
                        match self
                            .by_key
                            .get(&PublicKey::from(handshake.peer_static_public))
                        {
                            Some(index) => *index,
                            None => {
                                log::info!("handshake from unknown peer key at {src}, ignored");
                                return outcome;
                            }
                        }
                    }
                    Err(error) => {
                        log::debug!("bad WireGuard handshake from {src}: {error:?}");
                        return outcome;
                    }
                }
            }
            Packet::HandshakeResponse(p) => p.receiver_idx >> 8,
            Packet::PacketCookieReply(p) => p.receiver_idx >> 8,
            Packet::PacketData(p) => p.receiver_idx >> 8,
        };

        let Some(peer) = self.by_index.get_mut(&index) else {
            log::debug!("WireGuard packet for unknown session index from {src}, ignored");
            return outcome;
        };

        let mut authenticated = false;
        let mut result = peer.tunn.decapsulate(Some(src.ip()), data, buf);
        loop {
            match result {
                TunnResult::WriteToNetwork(reply) => {
                    authenticated = true;
                    outcome.replies.push(reply.to_vec());
                    // There may be more queued output for this datagram.
                    result = peer.tunn.decapsulate(None, &[], buf);
                }
                TunnResult::WriteToTunnelV4(plain, _) => {
                    authenticated = true;
                    outcome.inbound = accept_inbound(peer.tunnel_ip, plain);
                    break;
                }
                TunnResult::WriteToTunnelV6(_, _) => {
                    // IPv6 is dropped in v1; the AAAA answers are empty, so apps use IPv4.
                    authenticated = true;
                    break;
                }
                TunnResult::Done => {
                    // Keepalives and handshake responses end here; both are authenticated.
                    authenticated = authenticated || !is_handshake;
                    break;
                }
                TunnResult::Err(error) => {
                    log::debug!("WireGuard decapsulate error from {src}: {error:?}");
                    break;
                }
            }
        }

        // The endpoint only follows authenticated packets, so a forged datagram can't steal it.
        let endpoint_changed = authenticated && peer.endpoint != Some(src);
        if authenticated {
            peer.endpoint = Some(src);
        }
        let handshake_done = is_handshake && !outcome.replies.is_empty();
        if handshake_done {
            peer.last_handshake_ms = Some(now_ms());
        }
        if endpoint_changed || handshake_done {
            outcome.peer_event = Some(json!({
                "event": "peer",
                "peer": peer.id,
                "endpoint": peer.endpoint.map(|e| e.to_string()),
                "lastHandshake": peer.last_handshake_ms,
            }));
        }
        outcome
    }

    fn encapsulate(
        &mut self,
        dst: Ipv4Addr,
        packet: &[u8],
        buf: &mut [u8],
    ) -> Option<(Vec<u8>, SocketAddr)> {
        let index = *self.by_ip.get(&dst)?;
        let peer = self.by_index.get_mut(&index)?;
        // A peer that never sent a datagram has no address to answer to.
        let endpoint = peer.endpoint?;
        match peer.tunn.encapsulate(packet, buf) {
            TunnResult::WriteToNetwork(datagram) => Some((datagram.to_vec(), endpoint)),
            TunnResult::Err(error) => {
                log::debug!("WireGuard encapsulate error for {dst}: {error:?}");
                None
            }
            _ => None,
        }
    }

    fn view(&self, tunnel_ip: Ipv4Addr) -> Option<PeerView> {
        let index = self.by_ip.get(&tunnel_ip)?;
        let peer = self.by_index.get(index)?;
        Some(PeerView {
            id: peer.id.clone(),
            name: peer.name.clone(),
            endpoint_ip: peer.endpoint.map(|e| e.ip()),
            removed: peer.removed_tx.subscribe(),
        })
    }
}

/// Checks a decrypted IPv4 packet before the smoltcp network task sees it.
fn accept_inbound(peer_ip: Ipv4Addr, plain: &[u8]) -> Option<SmolPacket> {
    let packet = Ipv4Packet::new_checked(plain).ok()?;
    // Like WireGuard's AllowedIPs: a phone may only send from its own tunnel address.
    if packet.src_addr() != peer_ip {
        log::debug!("dropping packet from {} that spoofs {}", peer_ip, packet.src_addr());
        return None;
    }
    // Fragments can't be reassembled by this stack.
    if packet.more_frags() || packet.frag_offset() != 0 {
        return None;
    }
    match packet.next_header() {
        IpProtocol::Tcp => {
            let tcp = TcpPacket::new_checked(packet.payload()).ok()?;
            if tcp.src_port() == 0 || tcp.dst_port() == 0 {
                return None;
            }
        }
        IpProtocol::Udp => {
            let udp = UdpPacket::new_checked(packet.payload()).ok()?;
            if udp.src_port() == 0 || udp.dst_port() == 0 {
                return None;
            }
        }
        IpProtocol::Icmp => {}
        _ => return None,
    }
    Some(SmolPacket::from(Ipv4Packet::new_checked(plain.to_vec()).ok()?))
}

/// The core's view of the WireGuard peers.
pub struct WgDirectory(pub Arc<Mutex<WgPeers>>);

impl PeerDirectory for WgDirectory {
    fn lookup(&self, tunnel_ip: Ipv4Addr) -> Option<PeerView> {
        lock(&self.0).view(tunnel_ip)
    }
}

pub struct WireGuardFrontend {
    pub local_addr: SocketAddr,
    pub task: JoinHandle<Result<()>>,
}

pub struct WireGuardParams {
    pub listen: SocketAddr,
    pub server_private: StaticSecret,
    pub peers: Arc<Mutex<WgPeers>>,
    pub events: EventSink,
}

/// Binds the UDP socket and starts the packet task plus mitmproxy's smoltcp network task.
pub async fn start(
    params: WireGuardParams,
    transport_events_tx: mpsc::Sender<TransportEvent>,
    transport_commands_rx: mpsc::UnboundedReceiver<TransportCommand>,
    shutdown: shutdown::Receiver,
) -> Result<WireGuardFrontend> {
    let socket = UdpSocket::bind(params.listen)
        .await
        .map_err(|e| anyhow!("cannot bind UDP {}: {e}", params.listen))?;
    let local_addr = socket.local_addr()?;

    let (network_task, net_tx, net_rx) =
        add_network_layer(transport_events_tx, transport_commands_rx, shutdown.clone());

    let server_public = PublicKey::from(&params.server_private);
    let task = WgTask {
        socket,
        local_addr,
        server_private: params.server_private,
        server_public,
        peers: params.peers,
        events: params.events,
        net_tx,
        net_rx,
        network_task,
        shutdown,
        wg_buf: vec![0u8; MAX_PACKET_SIZE],
    };
    Ok(WireGuardFrontend {
        local_addr,
        task: tokio::spawn(task.run()),
    })
}

struct WgTask {
    socket: UdpSocket,
    local_addr: SocketAddr,
    server_private: StaticSecret,
    server_public: PublicKey,
    peers: Arc<Mutex<WgPeers>>,
    events: EventSink,
    net_tx: mpsc::Sender<NetworkEvent>,
    net_rx: mpsc::Receiver<NetworkCommand>,
    network_task: JoinHandle<Result<()>>,
    shutdown: shutdown::Receiver,
    wg_buf: Vec<u8>,
}

impl WgTask {
    async fn run(mut self) -> Result<()> {
        let mut udp_buf = vec![0u8; MAX_PACKET_SIZE];
        loop {
            tokio::select! {
                _ = self.shutdown.recv() => return Ok(()),
                exit = &mut self.network_task => {
                    return match exit {
                        Ok(Ok(())) => Ok(()),
                        Ok(Err(error)) => Err(error.context("the network task stopped")),
                        Err(error) => Err(anyhow!("the network task panicked: {error}")),
                    };
                }
                received = self.socket.recv_from(&mut udp_buf) => {
                    match received {
                        Ok((len, src)) => self.on_datagram(&udp_buf[..len], src).await,
                        // Some systems report an ICMP error from an earlier send here.
                        Err(error) => log::debug!("UDP receive error: {error}"),
                    }
                }
                command = self.net_rx.recv() => {
                    match command {
                        Some(NetworkCommand::SendPacket(packet)) => self.on_outbound(packet).await,
                        None => return Ok(()),
                    }
                }
            }
        }
    }

    async fn on_datagram(&mut self, data: &[u8], src: SocketAddr) {
        let outcome = catch_unwind(AssertUnwindSafe(|| {
            lock(&self.peers).handle_datagram(
                &self.server_private,
                &self.server_public,
                data,
                src,
                &mut self.wg_buf,
            )
        }))
        .unwrap_or_else(|_| {
            log::error!("panic while handling a WireGuard datagram from {src}, dropped it");
            Outcome::default()
        });

        for reply in outcome.replies {
            if let Err(error) = self.socket.send_to(&reply, src).await {
                log::debug!("cannot send WireGuard reply to {src}: {error}");
            }
        }
        if let Some(event) = outcome.peer_event {
            self.events.emit(event);
        }
        if let Some(packet) = outcome.inbound {
            let event = NetworkEvent::ReceivePacket {
                packet,
                tunnel_info: TunnelInfo::WireGuard {
                    src_addr: src,
                    dst_addr: self.local_addr,
                },
            };
            if self.net_tx.try_send(event).is_err() {
                log::warn!("dropping an incoming packet, the network task is behind");
            }
        }
    }

    async fn on_outbound(&mut self, packet: SmolPacket) {
        let IpAddr::V4(dst) = packet.dst_ip() else {
            return;
        };
        let bytes = packet.into_inner();
        // Tunn::encapsulate panics when the packet doesn't fit the buffer.
        if bytes.len() > MAX_PACKET_SIZE - WG_HEADER_SIZE {
            log::error!("dropping a {} byte packet for {dst}: too large", bytes.len());
            return;
        }
        let sealed = catch_unwind(AssertUnwindSafe(|| {
            lock(&self.peers).encapsulate(dst, &bytes, &mut self.wg_buf)
        }))
        .unwrap_or_else(|_| {
            log::error!("panic while encrypting a packet for {dst}, dropped it");
            None
        });
        if let Some((datagram, endpoint)) = sealed
            && let Err(error) = self.socket.send_to(&datagram, endpoint).await
        {
            log::debug!("cannot send to {endpoint}: {error}");
        }
    }
}
