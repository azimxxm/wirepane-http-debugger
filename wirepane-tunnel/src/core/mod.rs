//! The shared core: it takes flows from a front-end and does the same for every kind of phone.
//!
//! - TCP: SOCKS5 to Mockttp (custom-metadata tags, then CONNECT to the original IP:port), then
//!   pipe both ways with half-close.
//! - DNS on the tunnel's DNS address: answered on the host, names remembered per phone.
//! - UDP/443 (QUIC): blocked by default so apps fall back to TCP, which Mockttp can decrypt. Every
//!   blocked datagram is answered with an ICMP port unreachable, so the fallback is immediate.
//! - Other UDP: relayed from a host socket with an idle timeout.

pub mod dns;
pub mod hooks;
pub mod icmp;
pub mod quic;
pub mod socks;
pub mod stats;

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Result, anyhow, bail};
use mitmproxy::messages::{ConnectionId, TransportCommand, TransportEvent};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpStream, UdpSocket};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::time::{MissedTickBehavior, interval_at, sleep, timeout_at};

use crate::events::EventSink;
use crate::features::fingerprint;
use crate::frontend::wireguard::lock;
use crate::frontend::{InjectedPacket, PacketInjector, PeerDirectory, PeerView};
use crate::net::TunnelNet;
use hooks::Hooks;
use quic::QuicDriver;
use socks::Target;
use stats::{ActiveFlow, CoreStats};

const PIPE_CHUNK: u32 = 32 * 1024;
const UDP_IDLE_TIMEOUT: Duration = Duration::from_secs(60);
const NAME_TTL: Duration = Duration::from_secs(600);
const NAME_CAP: usize = 20_000;
/// A flow that fails right after the SYN must not close before the phone's handshake is done: the
/// SYN would be dropped and the phone would retry for a long time instead of seeing a clean close.
const FAILED_FLOW_CLOSE_DELAY: Duration = Duration::from_millis(250);
/// A relayed UDP flow reports its counters at most this often, and only when they changed.
const UDP_UPDATE_INTERVAL: Duration = Duration::from_secs(1);
/// A blocked QUIC flow gets at most one ICMP error per this long: a client that retries its Initial
/// packet every few milliseconds needs one error, not a stream of them.
const ICMP_MIN_GAP: Duration = Duration::from_millis(100);
/// How long a new TCP flow waits for the phone's first bytes (a TLS ClientHello, for the JA4
/// fingerprint and the SNI tag) before it goes on without them. Protocols where the server speaks
/// first wait this long once.
const FIRST_BYTES_WAIT: Duration = Duration::from_millis(300);
/// A ClientHello is one TLS record: at most 16 KiB plus its 5-byte header.
const FIRST_BYTES_MAX: usize = 16 * 1024 + 5;
const MAX_TAG_VALUE_CHARS: usize = 253;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuicMode {
    Block,
    Relay,
    /// HTTP/3 is terminated by the QUIC gateway (T7). Without one this works like Block.
    Decrypt,
}

impl QuicMode {
    pub fn parse(text: &str) -> Option<QuicMode> {
        match text {
            "block" => Some(QuicMode::Block),
            "relay" => Some(QuicMode::Relay),
            "decrypt" => Some(QuicMode::Decrypt),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            QuicMode::Block => "block",
            QuicMode::Relay => "relay",
            QuicMode::Decrypt => "decrypt",
        }
    }
}

pub struct CoreConfig {
    pub net: TunnelNet,
    /// The QUIC mode at start; `set-quic` changes it later through `Core::hooks`.
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
    /// Raw packets for phones (ICMP errors) go to the front-end through this.
    injector: PacketInjector,
    pub stats: Arc<CoreStats>,
    /// The network tools' settings and capture, shared with the front-ends.
    pub hooks: Arc<Hooks>,
    /// Terminates HTTP/3 in QUIC mode `decrypt`; None when this build or setup can't.
    quic: Option<Arc<QuicDriver>>,
}

impl Core {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        cfg: CoreConfig,
        dir: Arc<dyn PeerDirectory>,
        events: EventSink,
        socks: Arc<Mutex<String>>,
        commands: mpsc::UnboundedSender<TransportCommand>,
        injector: PacketInjector,
        hooks: Arc<Hooks>,
        quic: Option<Arc<QuicDriver>>,
    ) -> Self {
        Self {
            cfg,
            dir,
            events,
            socks,
            names: Mutex::new(HashMap::new()),
            flow_ids: AtomicU64::new(1),
            commands,
            injector,
            stats: Arc::new(CoreStats::default()),
            hooks,
            quic,
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
    let _active = ActiveFlow::start(&core.stats.tcp_opened, &core.stats.tcp_active);
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

    // The phone's first bytes come before the SOCKS connection, so its TLS fingerprint can be
    // a tag on it. They are sent upstream first, so nothing is lost.
    let first = read_first_bytes(flow).await;
    let mut tags = flow_tags(&peer, name);
    if let Some(hello) = fingerprint::parse_client_hello(&first.data) {
        core.events.emit(json!({
            "event": "tls-hello",
            "peer": peer.id,
            "dst": flow.dst.to_string(),
            "sni": hello.sni,
            "alpn": hello.alpn,
            "ja4": hello.ja4,
        }));
        if let Some(sni) = hello.sni.as_deref().and_then(tag_value) {
            tags.push(format!("wirepane-vpn-sni:{sni}"));
        }
        if let Some(ja4) = tag_value(&hello.ja4) {
            tags.push(format!("wirepane-vpn-ja4:{ja4}"));
        }
    }

    let proxy = lock(&core.socks).clone();
    let upstream = socks::connect(&proxy, &tags, &target).await?;
    pipe(&core.stats, flow, upstream, peer.removed.clone(), first).await
}

/// What a TCP flow's phone sent before the SOCKS connection was made.
pub struct FirstBytes {
    pub data: Vec<u8>,
    /// A read still waiting when time ran out: the pipe takes it over, as only one read may be
    /// outstanding per flow.
    pending: Option<oneshot::Receiver<Vec<u8>>>,
    /// The phone finished (FIN) or went away before sending more.
    ended: bool,
}

/// Reads the phone's first bytes for up to `FIRST_BYTES_WAIT`: one chunk, or more while they are
/// the start of a TLS record that isn't complete yet (a big ClientHello spans several segments).
async fn read_first_bytes(flow: &Flow) -> FirstBytes {
    let deadline = tokio::time::Instant::now() + FIRST_BYTES_WAIT;
    let mut data = Vec::new();
    loop {
        let Some(mut read) = flow.read(PIPE_CHUNK) else {
            return FirstBytes { data, pending: None, ended: true };
        };
        match timeout_at(deadline, &mut read).await {
            Ok(Ok(chunk)) if !chunk.is_empty() => {
                data.extend_from_slice(&chunk);
                if !incomplete_tls_record(&data) {
                    return FirstBytes { data, pending: None, ended: false };
                }
            }
            Ok(_) => return FirstBytes { data, pending: None, ended: true },
            Err(_) => return FirstBytes { data, pending: Some(read), ended: false },
        }
    }
}

/// True while `data` is the start of a TLS handshake record that has more bytes to come.
fn incomplete_tls_record(data: &[u8]) -> bool {
    if data.is_empty() || data[0] != 0x16 || data.len() >= FIRST_BYTES_MAX {
        return false;
    }
    if data.len() < 5 {
        return true;
    }
    if data[1] != 0x03 {
        return false;
    }
    data.len() < 5 + usize::from(u16::from_be_bytes([data[3], data[4]]))
}

/// A value from the phone's ClientHello, if it is safe to put in a tag (host name and JA4 chars).
fn tag_value(text: &str) -> Option<&str> {
    let ok = !text.is_empty()
        && text.len() <= MAX_TAG_VALUE_CHARS
        && text.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_'));
    ok.then_some(text)
}

/// Copies bytes both ways. A FIN from one side is passed on as a half-close, and the other
/// direction keeps going until it ends too.
async fn pipe(
    stats: &CoreStats,
    flow: &Flow,
    upstream: TcpStream,
    mut removed: watch::Receiver<bool>,
    first: FirstBytes,
) -> Result<()> {
    let (mut upstream_read, mut upstream_write) = upstream.into_split();

    let to_upstream = async {
        let FirstBytes { data, pending, mut ended } = first;
        if !data.is_empty() {
            CoreStats::add(&stats.tcp_bytes_up, data.len());
            upstream_write.write_all(&data).await?;
        }
        if !ended && let Some(read) = pending {
            match read.await {
                Ok(data) if !data.is_empty() => {
                    CoreStats::add(&stats.tcp_bytes_up, data.len());
                    upstream_write.write_all(&data).await?
                }
                _ => ended = true,
            }
        }
        while !ended && let Some(read) = flow.read(PIPE_CHUNK) {
            match read.await {
                Ok(data) if !data.is_empty() => {
                    CoreStats::add(&stats.tcp_bytes_up, data.len());
                    upstream_write.write_all(&data).await?
                }
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
            CoreStats::add(&stats.tcp_bytes_down, read);
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
        let quic_mode = if flow.dst.port() == 443 { Some(core.hooks.quic_mode()) } else { None };
        // Decrypt needs the gateway; a build or setup without one keeps blocking QUIC.
        let gateway = core.quic.clone().filter(|_| quic_mode == Some(QuicMode::Decrypt));
        if dst_ip == core.cfg.net.dns_ip() && flow.dst.port() == 53 {
            dns::udp_flow(&core, &flow, &peer, phone).await;
        } else if quic_mode.is_some() && quic_mode != Some(QuicMode::Relay) && gateway.is_none() {
            quic_blocked(&core, &flow, &peer, phone, dst_ip).await;
        } else if core.is_forbidden(dst_ip) {
            discard(&flow, peer.removed.clone()).await;
        } else if let Some(gateway) = gateway {
            quic::decrypted_flow(&core, &gateway, &flow, &peer).await;
        } else {
            if quic_mode == Some(QuicMode::Relay) {
                core.events.emit(json!({
                    "event": "quic",
                    "peer": peer.id,
                    "dst": flow.dst.to_string(),
                    "action": "relayed",
                }));
            }
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

/// Reports the flow once, then answers every datagram of it (at most one per `ICMP_MIN_GAP`) with
/// an ICMP port unreachable through the tunnel, like a host with nothing on UDP/443 would.
async fn quic_blocked(core: &Core, flow: &Flow, peer: &PeerView, phone: Ipv4Addr, dst_ip: Ipv4Addr) {
    core.events.emit(json!({
        "event": "quic",
        "peer": peer.id,
        "dst": flow.dst.to_string(),
        "action": "blocked",
    }));
    core.stats.quic_blocked.fetch_add(1, Ordering::Relaxed);

    let from = SocketAddrV4::new(phone, flow.src.port());
    let to = SocketAddrV4::new(dst_ip, flow.dst.port());
    let mut removed = peer.removed.clone();
    let mut last_error: Option<Instant> = None;
    while let Some(read) = flow.read(u32::from(u16::MAX)) {
        let datagram = tokio::select! {
            data = read => match data {
                Ok(data) => data,
                Err(_) => return,
            },
            _ = removed.changed() => return,
        };
        if last_error.is_some_and(|sent| sent.elapsed() < ICMP_MIN_GAP) {
            continue;
        }
        last_error = Some(Instant::now());
        let error = InjectedPacket {
            to: phone,
            packet: icmp::port_unreachable(from, to, &datagram),
        };
        if core.injector.try_send(error).is_ok() {
            core.stats.quic_icmp_sent.fetch_add(1, Ordering::Relaxed);
        }
    }
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

    let _active = ActiveFlow::start(&core.stats.udp_opened, &core.stats.udp_active);
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
    // `udp-update` goes out about once a second while data moves, and never for a quiet flow.
    let mut update = interval_at(tokio::time::Instant::now() + UDP_UPDATE_INTERVAL, UDP_UPDATE_INTERVAL);
    update.set_missed_tick_behavior(MissedTickBehavior::Delay);
    let mut reported = (0u64, 0u64);
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
                core.stats.udp_packets_up.fetch_add(1, Ordering::Relaxed);
                CoreStats::add(&core.stats.udp_bytes_up, data.len());
                socket.send(&data).await.ok();
                pending = flow.read(u32::from(u16::MAX));
                idle.as_mut().reset(tokio::time::Instant::now() + UDP_IDLE_TIMEOUT);
            }
            received = socket.recv(&mut buffer) => {
                let Ok(len) = received else { break "error" };
                packets_down += 1;
                bytes_down += len as u64;
                core.stats.udp_packets_down.fetch_add(1, Ordering::Relaxed);
                CoreStats::add(&core.stats.udp_bytes_down, len);
                if !flow.write(buffer[..len].to_vec()) {
                    break "closed";
                }
                idle.as_mut().reset(tokio::time::Instant::now() + UDP_IDLE_TIMEOUT);
            }
            _ = update.tick() => {
                if reported != (packets_up, packets_down) {
                    reported = (packets_up, packets_down);
                    core.events.emit(json!({
                        "event": "udp-update",
                        "flow": flow_id,
                        "peer": peer.id,
                        "packetsUp": packets_up,
                        "packetsDown": packets_down,
                        "bytesUp": bytes_up,
                        "bytesDown": bytes_down,
                    }));
                }
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

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;

    use mitmproxy::messages::ConnectionIdGenerator;
    use serde_json::Value;

    use super::*;
    use crate::features::dns_rules::DnsAction;

    /// A flow whose phone side is played by `chunks`: each read gets the next one, after its
    /// delay. A read past the end never answers.
    fn scripted_flow(chunks: Vec<(u64, Vec<u8>)>) -> Flow {
        let (tx, mut rx) = mpsc::unbounded_channel::<TransportCommand>();
        tokio::spawn(async move {
            let mut chunks = chunks.into_iter();
            let mut parked = Vec::new();
            while let Some(command) = rx.recv().await {
                if let TransportCommand::ReadData(_, _, reply) = command {
                    match chunks.next() {
                        Some((delay_ms, data)) => {
                            sleep(Duration::from_millis(delay_ms)).await;
                            reply.send(data).ok();
                        }
                        None => parked.push(reply),
                    }
                }
            }
        });
        Flow {
            id: ConnectionIdGenerator::tcp().next_id(),
            src: "10.73.0.2:50000".parse().unwrap(),
            dst: "93.184.216.34:443".parse().unwrap(),
            commands: tx,
        }
    }

    fn tls_record(len: usize) -> Vec<u8> {
        let mut record = vec![0x16, 0x03, 0x01];
        record.extend_from_slice(&(len as u16).to_be_bytes());
        record.extend((0..len).map(|i| i as u8));
        record
    }

    #[tokio::test]
    async fn first_bytes_collect_a_tls_record_that_spans_segments() {
        let record = tls_record(2000);
        let flow = scripted_flow(vec![(0, record[..1400].to_vec()), (5, record[1400..].to_vec())]);
        let first = read_first_bytes(&flow).await;
        assert_eq!(first.data, record);
        assert!(first.pending.is_none() && !first.ended);
    }

    #[tokio::test]
    async fn first_bytes_stop_after_one_chunk_of_another_protocol() {
        let flow = scripted_flow(vec![(0, b"GET / HTTP/1.1\r\n".to_vec()), (0, b"more".to_vec())]);
        let first = read_first_bytes(&flow).await;
        assert_eq!(first.data, b"GET / HTTP/1.1\r\n");
        assert!(first.pending.is_none() && !first.ended);
    }

    #[tokio::test]
    async fn a_silent_phone_waits_300_ms_and_the_read_is_kept_for_the_pipe() {
        let flow = scripted_flow(vec![(500, b"late".to_vec())]);
        let started = Instant::now();
        let first = read_first_bytes(&flow).await;
        let waited = started.elapsed();
        assert!(waited >= Duration::from_millis(290) && waited < Duration::from_millis(450), "{waited:?}");
        assert!(first.data.is_empty() && !first.ended);
        let late = first.pending.expect("the read is still pending").await.unwrap();
        assert_eq!(late, b"late", "nothing the phone sent is lost");
    }

    #[tokio::test]
    async fn a_phone_that_closes_at_once_ends_the_first_read() {
        let flow = scripted_flow(vec![(0, Vec::new())]);
        let first = read_first_bytes(&flow).await;
        assert!(first.data.is_empty() && first.ended && first.pending.is_none());
    }

    #[test]
    fn tls_record_lengths_and_tag_values() {
        assert!(incomplete_tls_record(&[0x16]));
        assert!(incomplete_tls_record(&tls_record(100)[..50]));
        assert!(!incomplete_tls_record(&tls_record(100)));
        assert!(!incomplete_tls_record(b"SSH-2.0-OpenSSH"));
        assert!(!incomplete_tls_record(&[0x16, 0x02, 0, 0, 10]));
        assert_eq!(tag_value("api.example.com"), Some("api.example.com"));
        assert_eq!(tag_value("t13d1516h2_8daaf6152771_02713d6af862"), Some("t13d1516h2_8daaf6152771_02713d6af862"));
        assert_eq!(tag_value("evil\"tag"), None);
        assert_eq!(tag_value(""), None);
        assert_eq!(tag_value(&"a".repeat(300)), None);
    }

    struct OnePeer;

    impl PeerDirectory for OnePeer {
        fn lookup(&self, _tunnel_ip: Ipv4Addr) -> Option<PeerView> {
            let (_, removed) = watch::channel(false);
            Some(PeerView { id: "p1".into(), name: "Test".into(), endpoint_ip: None, removed })
        }
    }

    fn test_core(events: Arc<Mutex<Vec<Value>>>) -> Core {
        let (commands, _) = mpsc::unbounded_channel();
        let (injector, _) = mpsc::channel(4);
        Core::new(
            CoreConfig { net: TunnelNet::parse("10.73.0.0/24").unwrap(), quic: QuicMode::Block, allow_loopback: false },
            Arc::new(OnePeer),
            EventSink::from_fn(move |event| lock(&events).push(event)),
            Arc::new(Mutex::new("127.0.0.1:1".into())),
            commands,
            injector,
            Arc::new(Hooks::new(QuicMode::Block)),
            None,
        )
    }

    fn a_query(name: &str) -> Vec<u8> {
        let mut query = vec![0x12, 0x34, 0x01, 0x00, 0, 1, 0, 0, 0, 0, 0, 0];
        for label in name.split('.') {
            query.push(label.len() as u8);
            query.extend_from_slice(label.as_bytes());
        }
        query.extend_from_slice(&[0, 0, 1, 0, 1]);
        query
    }

    #[tokio::test]
    async fn dns_questions_ask_the_rules_first() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let core = test_core(events.clone());
        let peer = core.dir.lookup(Ipv4Addr::new(10, 73, 0, 2)).unwrap();
        let phone = Ipv4Addr::new(10, 73, 0, 2);

        core.hooks.force_dns(Some(DnsAction::Block));
        let blocked = dns::answer(&core, &peer, phone, &a_query("ads.example.com")).await.unwrap();
        assert_eq!(blocked[3] & 0x0F, 3, "NXDOMAIN");

        let fake = Ipv4Addr::new(192, 168, 0, 10);
        core.hooks.force_dns(Some(DnsAction::Answer(fake)));
        let answered = dns::answer(&core, &peer, phone, &a_query("api.test")).await.unwrap();
        assert_eq!(answered[3] & 0x0F, 0, "NOERROR");
        assert_eq!(&answered[answered.len() - 4..], &fake.octets());
        assert_eq!(core.name_for(phone, fake).as_deref(), Some("api.test"), "flows to it get the name tag");

        let events = lock(&events).clone();
        assert_eq!(events.len(), 2);
        assert_eq!(events[0]["event"], "dns");
        assert_eq!(events[0]["rule"], "blocked");
        assert_eq!(events[0]["rcode"], "NXDOMAIN");
        assert_eq!(events[1]["rule"], "answered");
        assert_eq!(events[1]["answers"], serde_json::json!(["192.168.0.10"]));
    }

    #[test]
    fn quic_modes_parse_and_print() {
        for mode in [QuicMode::Block, QuicMode::Relay, QuicMode::Decrypt] {
            assert_eq!(QuicMode::parse(mode.as_str()), Some(mode));
        }
        assert_eq!(QuicMode::parse("BLOCK"), None);
    }
}
