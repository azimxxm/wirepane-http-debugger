//! The shared core: it takes flows from a front-end and does the same for every kind of phone.
//!
//! - TCP: SOCKS5 to Mockttp (custom-metadata tags, then CONNECT to the original IP:port), then
//!   pipe both ways with half-close.
//! - DNS on the tunnel's DNS address: answered on the host, names remembered per phone.
//! - UDP/443 (QUIC): blocked by default so apps fall back to TCP, which Mockttp can decrypt.
//! - Other UDP: relayed from a host socket with an idle timeout.

pub mod dns;
pub mod socks;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use mitmproxy::messages::{ConnectionId, TransportCommand, TransportEvent};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::sleep;

use crate::events::EventSink;
use crate::frontend::{PeerDirectory, PeerView};
use crate::frontend::wireguard::lock;
use crate::net::TunnelNet;
use socks::Target;

const PIPE_CHUNK: u32 = 32 * 1024;
const UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const NAME_TTL: Duration = Duration::from_secs(600);
const NAME_CAP: usize = 20_000;
/// A flow that fails right after the SYN must not close before the phone's handshake is done: the
/// SYN would be dropped and the phone would retry for a long time instead of seeing a clean close.
const FAILED_FLOW_CLOSE_DELAY: Duration = Duration::from_millis(250);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuicMode {
    Block,
    Relay,
}

pub struct CoreConfig {
    pub net: TunnelNet,
    pub quic: QuicMode,
    /// Test-only: lets flows reach 127.0.0.0/8. Off by default, because a phone must never reach
    /// the Mac's local services (the server API, the Mockttp admin port) through the tunnel.
    pub allow_loopback: bool,
}

struct NameEntry {
    name: String,
    expires: Instant,
}

pub struct Core {
    pub cfg: CoreConfig,
    dir: Arc<dyn PeerDirectory>,
    pub events: EventSink,
    socks: Arc<Mutex<String>>,
    names: Mutex<HashMap<(Ipv4Addr, Ipv4Addr), NameEntry>>,
    flow_ids: AtomicU64,
    commands: mpsc::UnboundedSender<TransportCommand>,
}

impl Core {
    pub fn new(
        cfg: CoreConfig,
        dir: Arc<dyn PeerDirectory>,
        events: EventSink,
        socks: Arc<Mutex<String>>,
        commands: mpsc::UnboundedSender<TransportCommand>,
    ) -> Self {
        Self {
            cfg,
            dir,
            events,
            socks,
            names: Mutex::new(HashMap::new()),
            flow_ids: AtomicU64::new(1),
            commands,
        }
    }

    /// Remembers which name a phone got an address for, to tag its flows later.
    pub fn remember_name(&self, phone: Ipv4Addr, name: &str, addresses: &[Ipv4Addr]) {
        let mut names = lock(&self.names);
        if names.len() >= NAME_CAP {
            let now = Instant::now();
            names.retain(|_, entry| entry.expires > now);
            if names.len() >= NAME_CAP {
                names.clear();
            }
        }
        for address in addresses {
            names.insert(
                (phone, *address),
                NameEntry {
                    name: name.to_string(),
                    expires: Instant::now() + NAME_TTL,
                },
            );
        }
    }

    fn name_for(&self, phone: Ipv4Addr, address: Ipv4Addr) -> Option<String> {
        let names = lock(&self.names);
        names
            .get(&(phone, address))
            .filter(|entry| entry.expires > Instant::now())
            .map(|entry| entry.name.clone())
    }

    /// Destinations a phone can't reach through the tunnel.
    fn is_forbidden(&self, ip: Ipv4Addr) -> bool {
        if ip.is_loopback() && self.cfg.allow_loopback {
            return false;
        }
        ip.is_loopback()
            || ip.is_unspecified()
            || ip.is_multicast()
            || ip.is_broadcast()
            || self.cfg.net.contains(ip)
    }
}

/// One flow of a phone, with the channel to push data and commands into the network task.
pub struct Flow {
    pub id: ConnectionId,
    pub src: SocketAddr,
    pub dst: SocketAddr,
    pub commands: mpsc::UnboundedSender<TransportCommand>,
}

impl Flow {
    /// Asks for the next chunk of data from the phone. An empty chunk or a dropped sender means
    /// the phone side is finished. Only one read may be outstanding per flow.
    pub fn read(&self, max: u32) -> Option<oneshot::Receiver<Vec<u8>>> {
        let (tx, rx) = oneshot::channel();
        self.commands
            .send(TransportCommand::ReadData(self.id, max, tx))
            .ok()?;
        Some(rx)
    }

    pub fn write(&self, data: Vec<u8>) -> bool {
        self.commands
            .send(TransportCommand::WriteData(self.id, data))
            .is_ok()
    }

    /// Waits until the network stack took all written data (back-pressure for fast senders).
    pub async fn drain(&self) -> bool {
        let (tx, rx) = oneshot::channel();
        if self
            .commands
            .send(TransportCommand::DrainWriter(self.id, tx))
            .is_err()
        {
            return false;
        }
        rx.await.is_ok()
    }

    /// `half_close = true` sends a FIN but keeps reading what the phone still sends.
    pub fn close(&self, half_close: bool) {
        self.commands
            .send(TransportCommand::CloseConnection(self.id, half_close))
            .ok();
    }
}

/// Consumes new flows from the front-end until it shuts down.
pub async fn run(core: Arc<Core>, mut flows: mpsc::Receiver<TransportEvent>) {
    while let Some(event) = flows.recv().await {
        let TransportEvent::ConnectionEstablished {
            connection_id,
            src_addr,
            dst_addr,
            command_tx,
            ..
        } = event;
        let flow = Flow {
            id: connection_id,
            src: src_addr,
            dst: dst_addr,
            commands: command_tx.unwrap_or_else(|| core.commands.clone()),
        };
        let core = core.clone();
        if connection_id.is_tcp() {
            tokio::spawn(tcp_flow(core, flow));
        } else {
            tokio::spawn(udp_flow(core, flow));
        }
    }
}

fn flow_tags(peer: &PeerView, name: Option<String>) -> Vec<String> {
    let mut tags = vec![
        "wirepane-vpn".to_string(),
        format!("wirepane-vpn-peer:{}", peer.id),
    ];
    if let Some(ip) = peer.endpoint_ip {
        tags.push(format!("wirepane-vpn-endpoint:{ip}"));
    }
    if let Some(name) = name {
        tags.push(format!("wirepane-vpn-name:{name}"));
    }
    tags
}

fn v4(addr: SocketAddr) -> Option<Ipv4Addr> {
    match addr.ip() {
        IpAddr::V4(ip) => Some(ip),
        IpAddr::V6(_) => None,
    }
}

async fn tcp_flow(core: Arc<Core>, flow: Flow) {
    if let Err(error) = tcp_flow_inner(&core, &flow).await {
        log::debug!("TCP flow {} -> {} ended: {error:#}", flow.src, flow.dst);
        sleep(FAILED_FLOW_CLOSE_DELAY).await;
    }
    flow.close(false);
}

async fn tcp_flow_inner(core: &Arc<Core>, flow: &Flow) -> Result<()> {
    let (Some(phone), Some(dst_ip)) = (v4(flow.src), v4(flow.dst)) else {
        bail!("only IPv4 is handled");
    };
    let peer = core
        .dir
        .lookup(phone)
        .ok_or_else(|| anyhow!("no peer owns {phone}"))?;

    if dst_ip == core.cfg.net.dns_ip() && flow.dst.port() == 53 {
        return dns::tcp_flow(core, flow, &peer, phone).await;
    }

    let (target, name) = if dst_ip == core.cfg.net.cert_ip() {
        // The proxy answers wirepane.cert itself, so it has to get the host name, not an IP.
        (
            Target::Host(dns::CERT_HOST.to_string(), flow.dst.port()),
            Some(dns::CERT_HOST.to_string()),
        )
    } else {
        if core.is_forbidden(dst_ip) {
            bail!("destination {dst_ip} is not allowed");
        }
        (Target::Ip(flow.dst), core.name_for(phone, dst_ip))
    };

    let proxy = lock(&core.socks).clone();
    let upstream = socks::connect(&proxy, &flow_tags(&peer, name), &target).await?;
    pipe(flow, upstream, peer.removed.clone()).await
}

/// Copies bytes both ways. A FIN from one side is passed on as a half-close, and the other
/// direction keeps going until it ends too.
async fn pipe(flow: &Flow, upstream: TcpStream, mut removed: watch::Receiver<bool>) -> Result<()> {
    let (mut upstream_read, mut upstream_write) = upstream.into_split();

    let to_upstream = async {
        while let Some(read) = flow.read(PIPE_CHUNK) {
            match read.await {
                Ok(data) if !data.is_empty() => upstream_write.write_all(&data).await?,
                _ => break,
            }
        }
        // The phone sent a FIN (or is gone): tell the proxy no more data is coming.
        upstream_write.shutdown().await.ok();
        Ok::<(), anyhow::Error>(())
    };

    let to_phone = async {
        let mut buffer = vec![0u8; PIPE_CHUNK as usize];
        loop {
            let read = upstream_read.read(&mut buffer).await?;
            if read == 0 {
                break;
            }
            if !flow.write(buffer[..read].to_vec()) || !flow.drain().await {
                return Ok::<(), anyhow::Error>(());
            }
        }
        flow.close(true);
        Ok(())
    };

    tokio::select! {
        result = async { tokio::try_join!(to_upstream, to_phone).map(|_| ()) } => result,
        _ = removed.changed() => Ok(()),
    }
}

async fn udp_flow(core: Arc<Core>, flow: Flow) {
    if let (Some(phone), Some(dst_ip)) = (v4(flow.src), v4(flow.dst))
        && let Some(peer) = core.dir.lookup(phone)
    {
        if dst_ip == core.cfg.net.dns_ip() && flow.dst.port() == 53 {
            dns::udp_flow(&core, &flow, &peer, phone).await;
        } else if flow.dst.port() == 443 && core.cfg.quic == QuicMode::Block {
            quic_blocked(&core, &flow, &peer).await;
        } else if core.is_forbidden(dst_ip) {
            discard(&flow, peer.removed.clone()).await;
        } else {
            relay(&core, &flow, &peer, phone, dst_ip).await;
        }
    } else {
        // An unknown peer or IPv6: still read the datagrams so the queue can't grow.
        let (_, never_removed) = watch::channel(false);
        discard(&flow, never_removed).await;
    }
    flow.close(false);
}

/// Reads and drops everything until the flow ends.
async fn discard(flow: &Flow, mut removed: watch::Receiver<bool>) {
    while let Some(read) = flow.read(u32::from(u16::MAX)) {
        tokio::select! {
            data = read => if data.is_err() { return },
            _ = removed.changed() => return,
        }
    }
}

async fn quic_blocked(core: &Core, flow: &Flow, peer: &PeerView) {
    core.events.emit(json!({
        "event": "quic",
        "peer": peer.id,
        "dst": flow.dst.to_string(),
        "action": "blocked",
    }));
    discard(flow, peer.removed.clone()).await;
}

/// Forwards a UDP flow through a host socket until it has been idle for a minute.
async fn relay(core: &Core, flow: &Flow, peer: &PeerView, phone: Ipv4Addr, dst_ip: Ipv4Addr) {
    let socket = match UdpSocket::bind("0.0.0.0:0").await {
        Ok(socket) => socket,
        Err(error) => {
            log::debug!("cannot open a UDP relay socket: {error}");
            return;
        }
    };
    if let Err(error) = socket.connect(flow.dst).await {
        log::debug!("cannot connect the UDP relay to {}: {error}", flow.dst);
        return;
    }

    let flow_id = core.flow_ids.fetch_add(1, Ordering::Relaxed);
    core.events.emit(json!({
        "event": "udp-open",
        "flow": flow_id,
        "peer": peer.id,
        "src": flow.src.to_string(),
        "dst": flow.dst.to_string(),
        "name": core.name_for(phone, dst_ip),
    }));

    let mut removed = peer.removed.clone();
    let mut idle = Box::pin(sleep(UDP_IDLE_TIMEOUT));
    let mut buffer = vec![0u8; usize::from(u16::MAX)];
    let (mut packets_up, mut packets_down, mut bytes_up, mut bytes_down) = (0u64, 0u64, 0u64, 0u64);
    let mut pending = flow.read(u32::from(u16::MAX));
    let reason = loop {
        let Some(read) = pending.as_mut() else {
            break "closed";
        };
        tokio::select! {
            data = read => {
                let Ok(data) = data else { break "closed" };
                packets_up += 1;
                bytes_up += data.len() as u64;
                socket.send(&data).await.ok();
                pending = flow.read(u32::from(u16::MAX));
                idle.as_mut().reset(tokio::time::Instant::now() + UDP_IDLE_TIMEOUT);
            }
            received = socket.recv(&mut buffer) => {
                let Ok(len) = received else { break "error" };
                packets_down += 1;
                bytes_down += len as u64;
                if !flow.write(buffer[..len].to_vec()) {
                    break "closed";
                }
                idle.as_mut().reset(tokio::time::Instant::now() + UDP_IDLE_TIMEOUT);
            }
            _ = &mut idle => break "idle",
            _ = removed.changed() => break "peer-removed",
        }
    };

    core.events.emit(json!({
        "event": "udp-close",
        "flow": flow_id,
        "peer": peer.id,
        "reason": reason,
        "packetsUp": packets_up,
        "packetsDown": packets_down,
        "bytesUp": bytes_up,
        "bytesDown": bytes_down,
    }));
}
