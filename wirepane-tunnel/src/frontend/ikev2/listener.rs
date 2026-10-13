//! The IO side of the IKEv2 front-end: the two UDP sockets (IKE on 500, NAT-T on 4500), the
//! responder's clock, and the phones' secrets and addresses. Every protocol decision is the
//! responder's (`responder.rs`); this only moves bytes between sockets, the responder and the
//! channels to the shared network layer (docs/ikev2.md §7).

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow};
use mitmproxy::messages::{NetworkCommand, NetworkEvent, SmolPacket, TunnelInfo};
use mitmproxy::network::{MAX_PACKET_SIZE, add_network_layer};
use mitmproxy::shutdown;
use serde_json::json;
use smoltcp::wire::Ipv4Packet;
use tokio::net::UdpSocket;
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;
use tokio::time::{MissedTickBehavior, interval};

use super::responder::{Credentials, Output, PeerSecret, Port, Responder, ResponderConfig, DEFAULT_MAX_HALF_OPEN};
use super::{SERVER_IDENTITY, peer_from_identity};
use crate::core::hooks::{DelayQueue, Hooks, MAX_DELAYED_PACKETS};
use crate::core::stats::CoreStats;
use crate::core::{self, Core, CoreConfig};
use crate::events::EventSink;
use crate::features::Direction;
use crate::features::conditions::Verdict;
use crate::frontend::wireguard::{PeerSummary, lock, now_ms};
use crate::frontend::{InjectedPacket, PeerDirectory, PeerView};

/// Timeouts and revocations are checked this often.
const TICK: Duration = Duration::from_millis(250);

struct Ikev2Peer {
    name: String,
    tunnel_ip: Ipv4Addr,
    /// The profile's `SharedSecret` text; its bytes are the IKE PSK.
    secret: String,
    endpoint: Option<SocketAddr>,
    last_handshake_ms: Option<u64>,
    /// Plaintext bytes from the phone and to it, like WireGuard's per-peer counters.
    bytes_up: u64,
    bytes_down: u64,
    removed_tx: watch::Sender<bool>,
}

/// The IKEv2 phones. Shared between the command side (add, remove, list) and the packet task.
#[derive(Default)]
pub struct Ikev2Peers {
    by_id: HashMap<String, Ikev2Peer>,
    by_ip: HashMap<Ipv4Addr, String>,
    /// Removed peers whose SAs the packet task still has to end.
    removed: Vec<String>,
}

impl Ikev2Peers {
    pub fn add(&mut self, id: &str, name: &str, tunnel_ip: Ipv4Addr, secret: String) {
        let (removed_tx, _) = watch::channel(false);
        self.by_ip.insert(tunnel_ip, id.to_string());
        self.by_id.insert(
            id.to_string(),
            Ikev2Peer {
                name: name.to_string(),
                tunnel_ip,
                secret,
                endpoint: None,
                last_handshake_ms: None,
                bytes_up: 0,
                bytes_down: 0,
                removed_tx,
            },
        );
    }

    /// Revokes a phone: its flows end now, its SAs on the next tick (at most 250 ms later).
    pub fn remove(&mut self, id: &str) -> bool {
        let Some(peer) = self.by_id.remove(id) else { return false };
        self.by_ip.remove(&peer.tunnel_ip);
        peer.removed_tx.send(true).ok();
        self.removed.push(id.to_string());
        true
    }

    pub fn contains(&self, id: &str) -> bool {
        self.by_id.contains_key(id)
    }

    pub fn summaries(&self) -> Vec<PeerSummary> {
        let mut list: Vec<PeerSummary> = self
            .by_id
            .iter()
            .map(|(id, peer)| PeerSummary {
                peer: id.clone(),
                name: peer.name.clone(),
                tunnel_ip: peer.tunnel_ip,
                endpoint: peer.endpoint,
                last_handshake_ms: peer.last_handshake_ms,
                bytes_up: peer.bytes_up,
                bytes_down: peer.bytes_down,
            })
            .collect();
        list.sort_by_key(|p| p.tunnel_ip);
        list
    }

    fn view(&self, tunnel_ip: Ipv4Addr) -> Option<PeerView> {
        let id = self.by_ip.get(&tunnel_ip)?;
        let peer = self.by_id.get(id)?;
        Some(PeerView {
            id: id.clone(),
            name: peer.name.clone(),
            endpoint_ip: peer.endpoint.map(|e| e.ip()),
            removed: peer.removed_tx.subscribe(),
        })
    }

    fn secret(&self, id: &str) -> Option<PeerSecret> {
        let peer = self.by_id.get(id)?;
        Some(PeerSecret {
            peer: id.to_string(),
            psk: peer.secret.as_bytes().to_vec(),
            tunnel_ip: peer.tunnel_ip,
        })
    }
}

/// The core's view of the IKEv2 phones.
pub struct Ikev2Directory(pub Arc<Mutex<Ikev2Peers>>);

impl PeerDirectory for Ikev2Directory {
    fn lookup(&self, tunnel_ip: Ipv4Addr) -> Option<PeerView> {
        lock(&self.0).view(tunnel_ip)
    }
}

/// Both front-ends' phones for the core: WireGuard first, then IKEv2. They never share a tunnel
/// address (one allocator hands out both kinds), so the order doesn't matter.
pub struct CombinedDirectory(pub Arc<dyn PeerDirectory>, pub Arc<dyn PeerDirectory>);

impl PeerDirectory for CombinedDirectory {
    fn lookup(&self, tunnel_ip: Ipv4Addr) -> Option<PeerView> {
        self.0.lookup(tunnel_ip).or_else(|| self.1.lookup(tunnel_ip))
    }
}

/// The NAT-T port that goes with an IKE port: 4500 for the real 500 (iOS can't be told other
/// ports), any free port otherwise (tests).
pub fn nat_t_address(ike: SocketAddr) -> SocketAddr {
    let port = if ike.port() == 500 { 4500 } else { 0 };
    SocketAddr::new(ike.ip(), port)
}

/// A decrypted packet as the shared network layer takes it, like the WireGuard front-end does.
pub fn network_event(packet: Vec<u8>, from: SocketAddr, local: SocketAddr) -> Option<NetworkEvent> {
    let packet = SmolPacket::from(Ipv4Packet::new_checked(packet).ok()?);
    Some(NetworkEvent::ReceivePacket {
        packet,
        tunnel_info: TunnelInfo::WireGuard {
            src_addr: from,
            dst_addr: local,
        },
    })
}

struct SharedCredentials(Arc<Mutex<Ikev2Peers>>);

impl Credentials for SharedCredentials {
    fn lookup(&self, _id_type: u8, id: &[u8]) -> Option<PeerSecret> {
        lock(&self.0).secret(peer_from_identity(id)?)
    }
}

pub struct Ikev2Params {
    /// IKE (UDP 500 for real phones: iOS can't be told another port).
    pub ike: SocketAddr,
    /// NAT-T (UDP 4500 for real phones): IKE after IKE_SA_INIT, and all ESP.
    pub nat_t: SocketAddr,
    pub peers: Arc<Mutex<Ikev2Peers>>,
    pub events: EventSink,
    /// INTERNAL_IP4_DNS for every phone (the tunnel's DNS address).
    pub dns: Ipv4Addr,
    /// Decrypted, checked IPv4 packets from phones, with the peer id and the phone's address.
    pub inbound: mpsc::Sender<(String, Vec<u8>, SocketAddr)>,
    /// IPv4 packets for IKEv2 phones: the network layer's replies and the core's ICMP errors.
    pub outbound: mpsc::Receiver<Vec<u8>>,
}

pub struct Ikev2Frontend {
    pub ike_addr: SocketAddr,
    pub nat_t_addr: SocketAddr,
    pub task: JoinHandle<Result<()>>,
}

/// Binds both sockets and starts the packet task.
pub async fn start(params: Ikev2Params, shutdown: shutdown::Receiver) -> Result<Ikev2Frontend> {
    let ike = UdpSocket::bind(params.ike)
        .await
        .map_err(|e| anyhow!("cannot bind UDP {} for IKEv2: {e}", params.ike))?;
    let nat_t = UdpSocket::bind(params.nat_t)
        .await
        .map_err(|e| anyhow!("cannot bind UDP {} for IKEv2 NAT-T: {e}", params.nat_t))?;
    let ike_addr = ike.local_addr()?;
    let nat_t_addr = nat_t.local_addr()?;
    let responder = Responder::new(
        ResponderConfig {
            server_id: SERVER_IDENTITY.to_string(),
            dns: params.dns,
            max_half_open: DEFAULT_MAX_HALF_OPEN,
        },
        SharedCredentials(params.peers.clone()),
    );
    let task = Ikev2Task {
        ike,
        nat_t,
        responder,
        peers: params.peers,
        events: params.events,
        inbound: params.inbound,
        outbound: params.outbound,
        shutdown,
    };
    Ok(Ikev2Frontend {
        ike_addr,
        nat_t_addr,
        task: tokio::spawn(task.run()),
    })
}

struct Ikev2Task {
    ike: UdpSocket,
    nat_t: UdpSocket,
    responder: Responder<SharedCredentials>,
    peers: Arc<Mutex<Ikev2Peers>>,
    events: EventSink,
    inbound: mpsc::Sender<(String, Vec<u8>, SocketAddr)>,
    outbound: mpsc::Receiver<Vec<u8>>,
    shutdown: shutdown::Receiver,
}

impl Ikev2Task {
    async fn run(mut self) -> Result<()> {
        let mut ike_buf = vec![0u8; MAX_PACKET_SIZE];
        let mut nat_t_buf = vec![0u8; MAX_PACKET_SIZE];
        let mut timer = interval(TICK);
        timer.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = self.shutdown.recv() => return Ok(()),
                _ = timer.tick() => self.on_tick().await,
                received = self.ike.recv_from(&mut ike_buf) => match received {
                    Ok((len, from)) => self.on_datagram(Port::Ike, &ike_buf[..len], from).await,
                    Err(error) => log::debug!("ikev2: UDP receive error: {error}"),
                },
                received = self.nat_t.recv_from(&mut nat_t_buf) => match received {
                    Ok((len, from)) => self.on_datagram(Port::NatT, &nat_t_buf[..len], from).await,
                    Err(error) => log::debug!("ikev2: UDP receive error: {error}"),
                },
                Some(packet) = self.outbound.recv() => {
                    self.count_down(&packet);
                    let sealed = catch_unwind(AssertUnwindSafe(|| self.responder.encapsulate(&packet)))
                        .unwrap_or_else(|_| {
                            log::error!("ikev2: panic while encrypting a packet, dropped it");
                            None
                        });
                    if let Some(output) = sealed {
                        self.deliver(vec![output]).await;
                    }
                }
            }
        }
    }

    fn count_down(&self, packet: &[u8]) {
        let Ok(ip) = Ipv4Packet::new_checked(packet) else { return };
        let mut peers = lock(&self.peers);
        let Some(id) = peers.by_ip.get(&ip.dst_addr()).cloned() else { return };
        if let Some(entry) = peers.by_id.get_mut(&id) {
            entry.bytes_down += packet.len() as u64;
        }
    }

    async fn on_datagram(&mut self, via: Port, data: &[u8], from: SocketAddr) {
        let now = Instant::now();
        let outputs = catch_unwind(AssertUnwindSafe(|| self.responder.handle_datagram(via, data, from, now)))
            .unwrap_or_else(|_| {
                log::error!("ikev2: panic while handling a datagram from {from}, dropped it");
                Vec::new()
            });
        self.deliver(outputs).await;
    }

    async fn on_tick(&mut self) {
        let removed = std::mem::take(&mut lock(&self.peers).removed);
        let mut outputs = Vec::new();
        for peer in removed {
            outputs.extend(self.responder.remove_peer(&peer));
        }
        outputs.extend(self.responder.tick(Instant::now()));
        self.deliver(outputs).await;
    }

    async fn deliver(&mut self, outputs: Vec<Output>) {
        for output in outputs {
            match output {
                Output::Send { via, to, datagram } => {
                    let socket = match via {
                        Port::Ike => &self.ike,
                        Port::NatT => &self.nat_t,
                    };
                    if let Err(error) = socket.send_to(&datagram, to).await {
                        log::debug!("ikev2: cannot send to {to}: {error}");
                    }
                }
                Output::Packet { peer, packet } => {
                    // A phone removed a moment ago may still have an SA until the next tick.
                    let endpoint = {
                        let mut peers = lock(&self.peers);
                        let Some(entry) = peers.by_id.get_mut(&peer) else { continue };
                        // IKEv2 has no handshake every 2 minutes like WireGuard, so "lastHandshake"
                        // is the last authenticated packet: the UI's "connected" check keeps working.
                        entry.last_handshake_ms = Some(now_ms());
                        entry.bytes_up += packet.len() as u64;
                        entry.endpoint
                    };
                    let Some(endpoint) = endpoint else { continue };
                    if self.inbound.try_send((peer, packet, endpoint)).is_err() {
                        log::warn!("ikev2: dropping an incoming packet, the network task is behind");
                    }
                }
                Output::Up { peer, endpoint, .. } => {
                    let event = {
                        let mut peers = lock(&self.peers);
                        let Some(entry) = peers.by_id.get_mut(&peer) else { continue };
                        entry.endpoint = Some(endpoint);
                        entry.last_handshake_ms = Some(now_ms());
                        json!({
                            "event": "peer",
                            "peer": peer,
                            "endpoint": endpoint.to_string(),
                            "lastHandshake": entry.last_handshake_ms,
                        })
                    };
                    self.events.emit(event);
                }
                Output::Down { peer } => log::info!("ikev2: the tunnel of {peer} ended"),
            }
        }
    }
}

// --- The IKEv2 side of the tunnel: listener, network layer and core ---

/// What `Tunnel` passes in to run IKEv2 phones next to the WireGuard ones.
pub struct Ikev2SideParams {
    /// The IKE address from `--ikev2` (UDP 500 for real phones); NAT-T follows `nat_t_address`.
    pub ike: SocketAddr,
    pub peers: Arc<Mutex<Ikev2Peers>>,
    pub core: CoreConfig,
    pub events: EventSink,
    pub socks: Arc<Mutex<String>>,
    pub hooks: Arc<Hooks>,
}

pub struct Ikev2Side {
    pub ike_addr: SocketAddr,
    pub nat_t_addr: SocketAddr,
    /// The IKEv2 phones' flow counters (the WireGuard core has its own).
    pub stats: Arc<CoreStats>,
    tasks: Vec<JoinHandle<()>>,
    listener: tokio::task::AbortHandle,
}

impl Ikev2Side {
    /// Stops everything at once (the shutdown signal does the same, a moment later).
    pub fn abort(&self) {
        self.listener.abort();
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// Starts the IKEv2 phones' side: the UDP listener, its own smoltcp network layer and its own
/// core, which shares the SOCKS address, the events and the hooks (DNS rules, QUIC mode, capture,
/// loss) with the WireGuard side. A layer of its own keeps the WireGuard front-end untouched;
/// connection ids are per layer, so each core talks only to its own (docs/ikev2.md §7).
pub async fn start_side(params: Ikev2SideParams, shutdown: shutdown::Receiver) -> Result<Ikev2Side> {
    let (commands_tx, commands_rx) = mpsc::unbounded_channel();
    let (flows_tx, flows_rx) = mpsc::channel(256);
    let (injector_tx, injector_rx) = mpsc::channel(256);
    let (inbound_tx, inbound_rx) = mpsc::channel(256);
    let (outbound_tx, outbound_rx) = mpsc::channel(256);

    let frontend = start(
        Ikev2Params {
            ike: params.ike,
            nat_t: nat_t_address(params.ike),
            peers: params.peers.clone(),
            events: params.events.clone(),
            dns: params.core.net.dns_ip(),
            inbound: inbound_tx,
            outbound: outbound_rx,
        },
        shutdown.clone(),
    )
    .await?;
    let (network_task, net_tx, net_rx) = add_network_layer(flows_tx, commands_rx, shutdown.clone());

    let core = Arc::new(Core::new(
        params.core,
        Arc::new(Ikev2Directory(params.peers.clone())),
        params.events.clone(),
        params.socks,
        commands_tx,
        injector_tx,
        params.hooks.clone(),
        // HTTP/3 decryption injects into the WireGuard front-end; IKEv2 phones get block or relay.
        None,
    ));
    let stats = core.stats.clone();
    let core_task = tokio::spawn(core::run(core, flows_rx));
    let pump = Pump {
        delayed: DelayQueue::new(MAX_DELAYED_PACKETS),
        inbound: inbound_rx,
        net_tx,
        net_rx,
        injected: injector_rx,
        outbound: outbound_tx,
        peers: params.peers,
        hooks: params.hooks,
        local: frontend.nat_t_addr,
        shutdown,
    };
    let events = params.events;
    let listener_abort = frontend.task.abort_handle();
    let listener = frontend.task;
    let pump_task = tokio::spawn(async move {
        let ended = tokio::select! {
            ended = pump.run(network_task) => ended,
            ended = listener => ended.unwrap_or_else(|error| Err(anyhow!("the IKEv2 listener failed: {error}"))),
        };
        if let Err(error) = ended {
            events.error(format!("IKEv2 stopped: {error:#}"));
        }
    });
    Ok(Ikev2Side {
        ike_addr: frontend.ike_addr,
        nat_t_addr: frontend.nat_t_addr,
        stats,
        tasks: vec![core_task, pump_task],
        listener: listener_abort,
    })
}

/// A packet a phone's network conditions hold back until it is due. The phone's id goes with it,
/// for the capture when the packet is released.
enum Held {
    FromPhone(String, Vec<u8>, SocketAddr),
    ToPhone(String, Vec<u8>),
}

async fn sleep_until_due(due: Option<Instant>) {
    match due {
        Some(due) => tokio::time::sleep_until(tokio::time::Instant::from_std(due)).await,
        None => std::future::pending().await,
    }
}

/// Moves packets between the listener and the network layer, through the same per-phone hooks
/// as the WireGuard side: network conditions (delay, bandwidth, loss) and the capture.
struct Pump {
    delayed: DelayQueue<Held>,
    inbound: mpsc::Receiver<(String, Vec<u8>, SocketAddr)>,
    net_tx: mpsc::Sender<NetworkEvent>,
    net_rx: mpsc::Receiver<NetworkCommand>,
    injected: mpsc::Receiver<InjectedPacket>,
    outbound: mpsc::Sender<Vec<u8>>,
    peers: Arc<Mutex<Ikev2Peers>>,
    hooks: Arc<Hooks>,
    local: SocketAddr,
    shutdown: shutdown::Receiver,
}

impl Pump {
    async fn run(mut self, mut network_task: JoinHandle<Result<()>>) -> Result<()> {
        loop {
            let next_due = self.delayed.next_due();
            tokio::select! {
                _ = self.shutdown.recv() => return Ok(()),
                exit = &mut network_task => {
                    return match exit {
                        Ok(result) => result,
                        Err(error) => Err(anyhow!("the IKEv2 network task panicked: {error}")),
                    };
                }
                _ = sleep_until_due(next_due), if next_due.is_some() => self.release_due(),
                Some((peer, packet, from)) = self.inbound.recv() => {
                    match self.hooks.admit(&peer, Direction::FromPhone, &packet, Instant::now()) {
                        Verdict::Now => self.to_network(packet, from),
                        Verdict::At(due) => {
                            let size = packet.len();
                            self.hold(due, Held::FromPhone(peer.clone(), packet, from), size);
                        }
                        Verdict::Drop => {}
                    }
                }
                Some(NetworkCommand::SendPacket(packet)) = self.net_rx.recv() => self.to_phone(packet.into_inner()),
                Some(InjectedPacket { packet, .. }) = self.injected.recv() => self.to_phone(packet),
            }
        }
    }

    fn hold(&mut self, due: Instant, held: Held, bytes: usize) {
        if !self.delayed.push_bytes(due, held, bytes) {
            log::debug!("ikev2: the delay queue is full, dropped {} packets so far", self.delayed.dropped());
        }
    }

    fn release_due(&mut self) {
        let now = Instant::now();
        while let Some(held) = self.delayed.pop_due(now) {
            match held {
                Held::FromPhone(peer, packet, from) => {
                    self.hooks.released(&peer, Direction::FromPhone, &packet);
                    self.to_network(packet, from);
                }
                Held::ToPhone(peer, packet) => {
                    self.hooks.released(&peer, Direction::ToPhone, &packet);
                    self.send_to_listener(&peer, packet);
                }
            }
        }
    }

    fn to_network(&self, packet: Vec<u8>, from: SocketAddr) {
        if let Some(event) = network_event(packet, from, self.local)
            && self.net_tx.try_send(event).is_err()
        {
            log::warn!("ikev2: dropping an incoming packet, the network task is behind");
        }
    }

    fn to_phone(&mut self, packet: Vec<u8>) {
        let Ok(ip) = Ipv4Packet::new_checked(&packet) else { return };
        let Some(peer) = lock(&self.peers).by_ip.get(&ip.dst_addr()).cloned() else { return };
        match self.hooks.admit(&peer, Direction::ToPhone, &packet, Instant::now()) {
            Verdict::Now => self.send_to_listener(&peer, packet),
            Verdict::At(due) => {
                let size = packet.len();
                self.hold(due, Held::ToPhone(peer, packet), size);
            }
            Verdict::Drop => {}
        }
    }

    fn send_to_listener(&self, peer: &str, packet: Vec<u8>) {
        if self.outbound.try_send(packet).is_err() {
            log::debug!("ikev2: dropping a packet for {peer}, the listener is behind");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::frontend::ikev2::profile_secret;
    use crate::frontend::ikev2::responder::tests::{Phone, udp_packet};
    use crate::frontend::ikev2::wire::DH_ECP_256;

    const TIMEOUT: Duration = Duration::from_secs(5);

    async fn receive(socket: &UdpSocket) -> Vec<u8> {
        let mut buf = vec![0u8; 4096];
        let (len, _) = tokio::time::timeout(TIMEOUT, socket.recv_from(&mut buf))
            .await
            .expect("an answer in time")
            .expect("receive");
        buf.truncate(len);
        buf
    }

    /// The whole path through real UDP sockets on loopback: IKE_SA_INIT on the IKE port,
    /// IKE_AUTH and ESP on the NAT-T port, a packet each way, then revocation.
    #[tokio::test]
    async fn handshake_and_esp_over_real_sockets() {
        let peers = Arc::new(Mutex::new(Ikev2Peers::default()));
        let secret = profile_secret(&[7; 32], "p1");
        lock(&peers).add("p1", "iPhone", Ipv4Addr::new(10, 73, 0, 2), secret.clone());

        let seen = Arc::new(Mutex::new(Vec::new()));
        let events = {
            let seen = seen.clone();
            EventSink::from_fn(move |value| lock(&seen).push(value))
        };
        let (inbound_tx, mut inbound_rx) = mpsc::channel(16);
        let (outbound_tx, outbound_rx) = mpsc::channel(16);
        let (shutdown_tx, shutdown_rx) = shutdown::channel();
        let frontend = start(
            Ikev2Params {
                ike: "127.0.0.1:0".parse().expect("address"),
                nat_t: "127.0.0.1:0".parse().expect("address"),
                peers: peers.clone(),
                events,
                dns: Ipv4Addr::new(10, 73, 0, 53),
                inbound: inbound_tx,
                outbound: outbound_rx,
            },
            shutdown_rx,
        )
        .await
        .expect("listener starts");

        let phone_ike = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let phone_nat_t = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let mut phone = Phone::new(DH_ECP_256);
        phone.psk = secret.into_bytes();
        phone.expected_address = phone_ike.local_addr().expect("address");

        phone_ike.send_to(&phone.sa_init(None), frontend.ike_addr).await.expect("send");
        let answer = receive(&phone_ike).await;
        phone.read_sa_init(&answer);

        phone_nat_t.send_to(&phone.auth_request(), frontend.nat_t_addr).await.expect("send");
        let answer = receive(&phone_nat_t).await;
        phone.read_auth(&answer);
        let phone_address = phone_nat_t.local_addr().expect("address");
        assert!(lock(&seen).iter().any(|event| event["event"] == "peer" && event["peer"] == "p1"
            && event["endpoint"] == phone_address.to_string()));

        // Phone to Mac.
        let packet = udp_packet(Ipv4Addr::new(10, 73, 0, 2), Ipv4Addr::new(1, 1, 1, 1));
        let packet_len = packet.len();
        let esp = phone.esp.as_mut().expect("ESP").seal(&packet).expect("seal");
        phone_nat_t.send_to(&esp, frontend.nat_t_addr).await.expect("send");
        let (peer, inner, from) = tokio::time::timeout(TIMEOUT, inbound_rx.recv())
            .await
            .expect("a packet in time")
            .expect("a packet");
        assert_eq!((peer.as_str(), inner, from), ("p1", packet, phone_address));

        // Mac to phone.
        let reply = udp_packet(Ipv4Addr::new(1, 1, 1, 1), Ipv4Addr::new(10, 73, 0, 2));
        outbound_tx.send(reply.clone()).await.expect("queue");
        let esp = receive(&phone_nat_t).await;
        assert_eq!(phone.esp.as_mut().expect("ESP").open(&esp).expect("phone decrypts"), reply);
        let summary = lock(&peers).summaries()[0].clone();
        assert_eq!(summary.endpoint, Some(phone_address));
        assert_eq!((summary.bytes_up, summary.bytes_down), (packet_len as u64, reply.len() as u64));

        // Removing the phone cuts it off: nothing more reaches the network layer.
        assert!(lock(&peers).remove("p1"));
        tokio::time::sleep(TICK * 2).await;
        let esp = phone.esp.as_mut().expect("ESP").seal(&udp_packet(Ipv4Addr::new(10, 73, 0, 2), Ipv4Addr::new(1, 1, 1, 1))).expect("seal");
        phone_nat_t.send_to(&esp, frontend.nat_t_addr).await.expect("send");
        assert!(tokio::time::timeout(Duration::from_millis(500), inbound_rx.recv()).await.is_err());

        shutdown_tx.send(()).ok();
        tokio::time::timeout(TIMEOUT, frontend.task)
            .await
            .expect("the task stops")
            .expect("no panic")
            .expect("clean exit");
    }

    /// A DNS query for wirepane.cert from the phone's tunnel address to the tunnel's DNS, with
    /// real IPv4 and UDP checksums.
    fn dns_query(src: Ipv4Addr, dns: Ipv4Addr) -> Vec<u8> {
        let mut query = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in ["wirepane", "cert"] {
            query.push(label.len() as u8);
            query.extend_from_slice(label.as_bytes());
        }
        query.extend_from_slice(&[0, 0, 1, 0, 1]);
        let udp_len = 8 + query.len();
        let total = 20 + udp_len;
        let mut packet = vec![0x45, 0, (total >> 8) as u8, total as u8, 0, 1, 0, 0, 64, 17, 0, 0];
        packet.extend_from_slice(&src.octets());
        packet.extend_from_slice(&dns.octets());
        let sum = |data: &[u8], mut acc: u32| {
            for pair in data.chunks(2) {
                let high = u32::from(pair[0]) << 8;
                let low = u32::from(*pair.get(1).unwrap_or(&0));
                acc += high | low;
            }
            while acc > 0xffff {
                acc = (acc & 0xffff) + (acc >> 16);
            }
            acc
        };
        let header_checksum = !(sum(&packet, 0) as u16);
        packet[10..12].copy_from_slice(&header_checksum.to_be_bytes());
        let mut udp = Vec::new();
        udp.extend_from_slice(&40001u16.to_be_bytes());
        udp.extend_from_slice(&53u16.to_be_bytes());
        udp.extend_from_slice(&(udp_len as u16).to_be_bytes());
        udp.extend_from_slice(&[0, 0]);
        udp.extend_from_slice(&query);
        let mut pseudo = Vec::new();
        pseudo.extend_from_slice(&src.octets());
        pseudo.extend_from_slice(&dns.octets());
        pseudo.extend_from_slice(&[0, 17]);
        pseudo.extend_from_slice(&(udp_len as u16).to_be_bytes());
        let udp_checksum = !(sum(&udp, sum(&pseudo, 0)) as u16);
        udp[6..8].copy_from_slice(&udp_checksum.to_be_bytes());
        packet.extend_from_slice(&udp);
        packet
    }

    /// The full IKEv2 side as `Tunnel` runs it: listener, network layer, core. The phone asks the
    /// tunnel's DNS for wirepane.cert through ESP and gets the core's answer back through ESP.
    #[tokio::test]
    async fn dns_through_the_core_over_ikev2() {
        let peers = Arc::new(Mutex::new(Ikev2Peers::default()));
        let secret = profile_secret(&[9; 32], "p2");
        lock(&peers).add("p2", "iPhone", Ipv4Addr::new(10, 73, 0, 3), secret.clone());
        let net = crate::net::TunnelNet::parse("10.73.0.0/24").expect("net");
        let seen = Arc::new(Mutex::new(Vec::new()));
        let events = {
            let seen = seen.clone();
            EventSink::from_fn(move |value| lock(&seen).push(value))
        };
        let (shutdown_tx, shutdown_rx) = shutdown::channel();
        let hooks = Arc::new(Hooks::new(crate::core::QuicMode::Block));
        let side = start_side(
            Ikev2SideParams {
                ike: "127.0.0.1:0".parse().expect("address"),
                peers: peers.clone(),
                core: CoreConfig {
                    net,
                    quic: crate::core::QuicMode::Block,
                    allow_loopback: false,
                },
                events,
                socks: Arc::new(Mutex::new("127.0.0.1:9".to_string())),
                hooks: hooks.clone(),
            },
            shutdown_rx,
        )
        .await
        .expect("the IKEv2 side starts");

        let phone_ike = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let phone_nat_t = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let mut phone = Phone::new(DH_ECP_256);
        phone.identity = b"p2.wirepane".to_vec();
        phone.psk = secret.into_bytes();
        phone.expected_address = phone_ike.local_addr().expect("address");
        phone_ike.send_to(&phone.sa_init(None), side.ike_addr).await.expect("send");
        let answer = receive(&phone_ike).await;
        phone.read_sa_init(&answer);
        phone_nat_t.send_to(&phone.auth_request(), side.nat_t_addr).await.expect("send");
        let answer = receive(&phone_nat_t).await;
        phone.read_auth_for(&answer, Ipv4Addr::new(10, 73, 0, 3));

        let query = dns_query(Ipv4Addr::new(10, 73, 0, 3), net.dns_ip());
        let esp = phone.esp.as_mut().expect("ESP").seal(&query).expect("seal");
        phone_nat_t.send_to(&esp, side.nat_t_addr).await.expect("send");
        let reply = receive(&phone_nat_t).await;
        let inner = phone.esp.as_mut().expect("ESP").open(&reply).expect("phone decrypts");
        let ip = Ipv4Packet::new_checked(&inner[..]).expect("IPv4");
        assert_eq!(ip.src_addr(), net.dns_ip());
        assert_eq!(ip.dst_addr(), Ipv4Addr::new(10, 73, 0, 3));
        // The answer carries wirepane.cert's virtual address.
        assert!(inner.windows(4).any(|w| w == net.cert_ip().octets()), "the answer names {}", net.cert_ip());
        assert!(lock(&seen).iter().any(|event| event["event"] == "dns" && event["name"] == "wirepane.cert"));

        // Network conditions apply to IKEv2 phones too: 150 ms each way.
        hooks.set_conditions(
            "p2",
            Some(crate::features::conditions::Conditions {
                latency_ms: 150,
                jitter_ms: 0,
                down_kbps: 0,
                up_kbps: 0,
                loss_pct: 0.0,
            }),
        );
        let sent = Instant::now();
        let esp = phone.esp.as_mut().expect("ESP").seal(&query).expect("seal");
        phone_nat_t.send_to(&esp, side.nat_t_addr).await.expect("send");
        let reply = receive(&phone_nat_t).await;
        assert!(sent.elapsed() >= Duration::from_millis(280), "delayed both ways, took {:?}", sent.elapsed());
        assert!(phone.esp.as_mut().expect("ESP").open(&reply).is_ok());

        shutdown_tx.send(()).ok();
        side.abort();
    }

    #[test]
    fn ports_and_network_events() {
        let ike: SocketAddr = "0.0.0.0:500".parse().expect("address");
        assert_eq!(nat_t_address(ike), "0.0.0.0:4500".parse().expect("address"));
        assert_eq!(nat_t_address("127.0.0.1:0".parse().expect("address")).port(), 0);
        let from: SocketAddr = "192.168.1.20:4500".parse().expect("address");
        let packet = udp_packet(Ipv4Addr::new(10, 73, 0, 2), Ipv4Addr::new(1, 1, 1, 1));
        assert!(network_event(packet, from, ike).is_some());
        assert!(network_event(vec![0x45, 0, 0], from, ike).is_none());
    }

    #[tokio::test]
    async fn the_directory_finds_phones_by_tunnel_address() {
        let peers = Arc::new(Mutex::new(Ikev2Peers::default()));
        lock(&peers).add("p5", "iPad", Ipv4Addr::new(10, 73, 0, 6), profile_secret(&[1; 32], "p5"));
        let directory = Ikev2Directory(peers.clone());
        let view = directory.lookup(Ipv4Addr::new(10, 73, 0, 6)).expect("found");
        assert_eq!((view.id.as_str(), view.name.as_str()), ("p5", "iPad"));
        assert!(directory.lookup(Ipv4Addr::new(10, 73, 0, 7)).is_none());
        let removed = view.removed.clone();
        assert!(lock(&peers).remove("p5"));
        assert!(*removed.borrow());
        assert!(directory.lookup(Ipv4Addr::new(10, 73, 0, 6)).is_none());
        let credentials = SharedCredentials(peers.clone());
        assert!(credentials.lookup(2, b"p5.wirepane").is_none());

        // The combined directory asks both sides.
        lock(&peers).add("p6", "iPad", Ipv4Addr::new(10, 73, 0, 7), profile_secret(&[1; 32], "p6"));
        let empty: Arc<dyn PeerDirectory> = Arc::new(Ikev2Directory(Arc::new(Mutex::new(Ikev2Peers::default()))));
        let both = CombinedDirectory(empty, Arc::new(Ikev2Directory(peers)));
        assert_eq!(both.lookup(Ipv4Addr::new(10, 73, 0, 7)).map(|v| v.id), Some("p6".to_string()));
    }

    /// Connects a test phone to an IKEv2 side and asks the tunnel's DNS for wirepane.cert.
    async fn connect_and_resolve(ike: SocketAddr, nat_t: SocketAddr, identity: &str, psk: &str, address: Ipv4Addr) -> bool {
        let phone_ike = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let phone_nat_t = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let mut phone = Phone::new(DH_ECP_256);
        phone.identity = identity.as_bytes().to_vec();
        phone.psk = psk.as_bytes().to_vec();
        phone.expected_address = phone_ike.local_addr().expect("address");
        phone_ike.send_to(&phone.sa_init(None), ike).await.expect("send");
        let answer = receive(&phone_ike).await;
        phone.read_sa_init(&answer);
        phone_nat_t.send_to(&phone.auth_request(), nat_t).await.expect("send");
        let answer = receive(&phone_nat_t).await;
        phone.read_auth_for(&answer, address);
        let net = crate::net::TunnelNet::parse("10.73.0.0/24").expect("net");
        let query = dns_query(address, net.dns_ip());
        let esp = phone.esp.as_mut().expect("ESP").seal(&query).expect("seal");
        phone_nat_t.send_to(&esp, nat_t).await.expect("send");
        let mut buf = vec![0u8; 4096];
        match tokio::time::timeout(Duration::from_secs(2), phone_nat_t.recv_from(&mut buf)).await {
            Ok(Ok((len, _))) => {
                let inner = phone.esp.as_mut().expect("ESP").open(&buf[..len]).expect("phone decrypts");
                inner.windows(4).any(|w| w == net.cert_ip().octets())
            }
            _ => false,
        }
    }

    /// The whole sidecar library as main.rs runs it: `--ikev2`, add-peer with kind ikev2, a phone
    /// that connects with what the event says, a restart that keeps it, and removal.
    #[tokio::test]
    async fn the_tunnel_serves_ikev2_phones() {
        let dir = tempfile::tempdir().expect("temp dir");
        let config = crate::TunnelConfig {
            wireguard: "127.0.0.1:0".parse().expect("address"),
            state_path: dir.path().join("state.json"),
            socks: "127.0.0.1:9".to_string(),
            endpoint_host: None,
            tunnel_net: crate::net::TunnelNet::parse("10.73.0.0/24").expect("net"),
            quic: crate::core::QuicMode::Block,
            allow_loopback: false,
            ca_cert: None,
            ca_key: None,
            ikev2: Some("127.0.0.1:0".parse().expect("address")),
        };
        let start = |config: crate::TunnelConfig| async move {
            let seen = Arc::new(Mutex::new(Vec::new()));
            let events = {
                let seen = seen.clone();
                EventSink::from_fn(move |value| lock(&seen).push(value))
            };
            let tunnel = crate::Tunnel::start(config, events).await.expect("the tunnel starts");
            let ready = lock(&seen).iter().find(|e| e["event"] == "ready").cloned().expect("ready");
            let ike: SocketAddr = ready["ikev2"]["ike"].as_str().expect("ike").parse().expect("address");
            let nat_t: SocketAddr = ready["ikev2"]["natT"].as_str().expect("natT").parse().expect("address");
            (tunnel, ike, nat_t)
        };

        let (tunnel, ike, nat_t) = start(config.clone()).await;
        let added = tunnel.add_peer("Test iPhone", crate::PEER_KIND_IKEV2).expect("added").to_event();
        assert_eq!(added["kind"], "ikev2");
        let peer = added["peer"].as_str().expect("peer").to_string();
        let identity = added["ikev2"]["localId"].as_str().expect("localId").to_string();
        let psk = added["ikev2"]["psk"].as_str().expect("psk").to_string();
        let address: Ipv4Addr = added["tunnelIp"].as_str().expect("tunnelIp").parse().expect("address");
        assert_eq!(identity, format!("{peer}.wirepane"));
        assert!(connect_and_resolve(ike, nat_t, &identity, &psk, address).await, "DNS answered over IKEv2");
        let listed = tunnel.list_peers();
        let entry = listed["peers"].as_array().expect("peers").iter().find(|p| p["peer"] == peer.as_str()).cloned().expect("listed");
        assert_eq!(entry["kind"], "ikev2");
        assert!(entry["endpoint"].is_string(), "the phone's address is known");
        tunnel.shutdown().await;

        // After a restart the stored IKEv2 phone still connects with the same secret.
        let (tunnel, ike, nat_t) = start(config.clone()).await;
        assert!(connect_and_resolve(ike, nat_t, &identity, &psk, address).await, "still works after a restart");
        tunnel.remove_peer(&peer).expect("removed");
        tokio::time::sleep(TICK * 2).await;
        let phone_ike = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        let mut phone = Phone::new(DH_ECP_256);
        phone.identity = identity.as_bytes().to_vec();
        phone.psk = psk.as_bytes().to_vec();
        phone.expected_address = phone_ike.local_addr().expect("address");
        phone_ike.send_to(&phone.sa_init(None), ike).await.expect("send");
        let answer = receive(&phone_ike).await;
        phone.read_sa_init(&answer);
        let phone_nat_t = UdpSocket::bind("127.0.0.1:0").await.expect("bind");
        phone_nat_t.send_to(&phone.auth_request(), nat_t).await.expect("send");
        let answer = receive(&phone_nat_t).await;
        let payloads = phone.decrypt(&answer, crate::frontend::ikev2::wire::IKE_AUTH);
        let notify = crate::frontend::ikev2::wire::parse_notify(&payloads[0].1).expect("notify");
        assert_eq!(notify.kind, crate::frontend::ikev2::wire::N_AUTHENTICATION_FAILED, "a removed phone is refused");
        tunnel.shutdown().await;

        // Without --ikev2 there is no IKEv2 peer to add.
        let mut plain_config = config.clone();
        plain_config.ikev2 = None;
        plain_config.state_path = dir.path().join("other.json");
        let plain = crate::Tunnel::start(plain_config, EventSink::from_fn(|_| {})).await.expect("starts");
        assert!(plain.add_peer("x", crate::PEER_KIND_IKEV2).is_err());
        plain.shutdown().await;
    }
}
