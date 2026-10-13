//! wirepane-tunnel: Wirepane's VPN-mode sidecar.
//!
//! A userspace WireGuard server (no root, no TUN device) that turns a phone's traffic into TCP
//! and UDP flows. Every TCP flow is handed to Mockttp over SOCKS5 with tags, so the proxy knows
//! the real destination and which phone the traffic came from. See the README for the contract.

pub mod core;
pub mod events;
pub mod features;
pub mod frontend;
pub mod net;
pub mod state;

use std::collections::HashSet;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use boringtun::x25519::{PublicKey, StaticSecret};
use data_encoding::BASE64;
use mitmproxy::shutdown;
use serde_json::{Value, json};
use tokio::sync::{mpsc, watch};
use tokio::task::JoinHandle;

use crate::core::hooks::Hooks;
use crate::core::quic::QuicDriver;
use crate::core::stats::CoreStats;
use crate::core::{Core, CoreConfig, QuicMode};
use crate::events::EventSink;
use crate::features::capture::CaptureSummary;
use crate::features::conditions::Conditions;
use crate::features::dns_rules::{DnsAction, DnsRule, DnsRules};
use crate::features::quic::QuicGateway;
use crate::frontend::ikev2::listener::{Ikev2Peers, Ikev2Side, Ikev2SideParams};
use crate::frontend::wireguard::{self, WgDirectory, WgPeers, WireGuardParams, lock};
use crate::net::TunnelNet;
use crate::state::{StateFile, StoredPeer};

pub const PEER_KIND_WIREGUARD: &str = "wireguard";
/// iOS's built-in VPN (T1, docs/ikev2.md): no extra app, a profile instead of a WireGuard config.
pub const PEER_KIND_IKEV2: &str = "ikev2";
const KEEPALIVE_SECONDS: u16 = 25;
const MAX_NAME_CHARS: usize = 64;
/// Limits for what `set-conditions` and `set-dns-rules` accept, so a bad command can't ask for
/// something silly (a day of latency, a million rules).
const MAX_DELAY_MS: u64 = 60_000;
const MAX_KBPS: u64 = 10_000_000;
const MAX_DNS_RULES: usize = 10_000;
const MAX_PEER_ID_CHARS: usize = 64;

#[derive(Debug, Clone)]
pub struct TunnelConfig {
    pub wireguard: SocketAddr,
    pub state_path: PathBuf,
    /// Mockttp's proxy address, "host:port".
    pub socks: String,
    /// The address phones dial, written into the client config. Defaults to the bind address.
    pub endpoint_host: Option<String>,
    pub tunnel_net: TunnelNet,
    pub quic: QuicMode,
    pub allow_loopback: bool,
    /// The Wirepane CA (PEM files): the QUIC gateway signs its leaf certificates with it.
    pub ca_cert: Option<PathBuf>,
    pub ca_key: Option<PathBuf>,
    /// The IKEv2 front-end's IKE address (UDP 500 for real phones, NAT-T is then 4500), used
    /// when `frontend::ikev2::supported()` (docs/ikev2.md §7).
    pub ikev2: Option<SocketAddr>,
}

#[derive(Debug, Clone)]
pub struct PeerAdded {
    pub peer: String,
    pub name: String,
    pub kind: String,
    pub tunnel_ip: Ipv4Addr,
    pub config: String,
    /// IKEv2 phones only: the identities and the secret for the profile (docs/ikev2.md §7).
    pub ikev2: Option<Value>,
}

impl PeerAdded {
    pub fn to_event(&self) -> Value {
        let mut event = json!({
            "event": "peer-added",
            "peer": self.peer,
            "name": self.name,
            "kind": self.kind,
            "tunnelIp": self.tunnel_ip.to_string(),
            "config": self.config,
        });
        if let (Some(object), Some(ikev2)) = (event.as_object_mut(), &self.ikev2) {
            object.insert("ikev2".to_string(), ikev2.clone());
        }
        event
    }
}

pub struct Tunnel {
    config: TunnelConfig,
    events: EventSink,
    server_private: StaticSecret,
    server_public: PublicKey,
    listen: SocketAddr,
    state: Mutex<StateFile>,
    peers: Arc<Mutex<WgPeers>>,
    ikev2_peers: Arc<Mutex<Ikev2Peers>>,
    /// Running when `--ikev2` was given and its ports could be bound.
    ikev2: Option<Ikev2Side>,
    socks: Arc<Mutex<String>>,
    core_stats: Arc<CoreStats>,
    hooks: Arc<Hooks>,
    started: Instant,
    shutdown_tx: watch::Sender<()>,
    frontend_task: Option<JoinHandle<Result<()>>>,
    core_task: JoinHandle<()>,
}

fn generate_secret() -> Result<StaticSecret> {
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|e| anyhow!("no random bytes available: {e}"))?;
    // Clamp like `wg genkey`, so every client app derives the same public key.
    bytes[0] &= 248;
    bytes[31] &= 127;
    bytes[31] |= 64;
    Ok(StaticSecret::from(bytes))
}

fn decode_key(text: &str) -> Result<[u8; 32]> {
    let bytes = BASE64
        .decode(text.trim().as_bytes())
        .map_err(|e| anyhow!("bad base64 key: {e}"))?;
    bytes
        .try_into()
        .map_err(|_| anyhow!("a WireGuard key must be 32 bytes"))
}

fn encode_key(bytes: [u8; 32]) -> String {
    BASE64.encode(&bytes)
}

fn clean_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(MAX_NAME_CHARS)
        .collect();
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        "Phone".to_string()
    } else {
        cleaned.to_string()
    }
}

fn valid_socks_addr(addr: &str) -> bool {
    match addr.rsplit_once(':') {
        Some((host, port)) => !host.is_empty() && port.parse::<u16>().is_ok_and(|p| p != 0),
        None => false,
    }
}

impl Tunnel {
    pub async fn start(config: TunnelConfig, events: EventSink) -> Result<Tunnel> {
        if !valid_socks_addr(&config.socks) {
            bail!("--socks must look like host:port, got {:?}", config.socks);
        }

        let state = match StateFile::load(&config.state_path)? {
            Some(state) => state,
            None => StateFile::fresh(encode_key(generate_secret()?.to_bytes())),
        };
        let server_private = StaticSecret::from(decode_key(&state.server_private_key)?);
        let server_public = PublicKey::from(&server_private);
        // Written right away: the file exists (mode 0600) and the server key is stable from now on.
        state.save(&config.state_path)?;

        let peers = Arc::new(Mutex::new(WgPeers::new(&server_public)));
        let ikev2_peers = Arc::new(Mutex::new(Ikev2Peers::default()));
        for stored in &state.peers {
            let tunnel_ip: Ipv4Addr = stored
                .tunnel_ip
                .parse()
                .with_context(|| format!("bad tunnel address for peer {}", stored.peer))?;
            // IKEv2 phones have no WireGuard key; their secret is derived from the server key.
            if stored.kind == PEER_KIND_IKEV2 {
                let secret = frontend::ikev2::profile_secret(&server_private.to_bytes(), &stored.peer);
                lock(&ikev2_peers).add(&stored.peer, &stored.name, tunnel_ip, secret);
                continue;
            }
            let public = PublicKey::from(decode_key(&stored.public_key)?);
            lock(&peers).add(&server_private, &stored.peer, &stored.name, tunnel_ip, public);
        }

        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let (flows_tx, flows_rx) = mpsc::channel(256);
        // ICMP errors for blocked QUIC travel from the core to the front-end through this.
        let (injector_tx, injector_rx) = mpsc::channel(256);
        let (shutdown_tx, shutdown_rx) = shutdown::channel();

        let hooks = Arc::new(Hooks::new(config.quic).with_events(events.clone()));
        // The capture names each phone's interface after its device.
        for stored in &state.peers {
            hooks.set_peer_name(&stored.peer, &stored.name);
        }
        let socks = Arc::new(Mutex::new(config.socks.clone()));
        let quic_driver = start_quic_gateway(&config, socks.clone(), &events, injector_tx.clone());

        let ikev2_shutdown = shutdown_rx.clone();
        let frontend = wireguard::start(
            WireGuardParams {
                listen: config.wireguard,
                server_private: server_private.clone(),
                peers: peers.clone(),
                events: events.clone(),
                injected: injector_rx,
                hooks: hooks.clone(),
            },
            flows_tx,
            commands_rx,
            shutdown_rx,
        )
        .await?;

        let core = Arc::new(Core::new(
            CoreConfig {
                net: config.tunnel_net,
                quic: config.quic,
                allow_loopback: config.allow_loopback,
            },
            Arc::new(WgDirectory(peers.clone())),
            events.clone(),
            socks.clone(),
            commands_tx,
            injector_tx,
            hooks.clone(),
            quic_driver.clone(),
        ));
        let core_stats = core.stats.clone();
        let core_task = tokio::spawn(async move {
            // The gateway's timers live as long as the core does.
            let timers = quic_driver.map(|driver| tokio::spawn(driver.run()));
            core::run(core, flows_rx).await;
            if let Some(timers) = timers {
                timers.abort();
            }
        });

        // IKEv2 phones get their own listener, network layer and core (docs/ikev2.md §7). Port 500
        // can be taken (the Mac's own VPN client), so a failure only turns IKEv2 off.
        let ikev2 = match config.ikev2 {
            // `--ikev2` only counts when the build supports it (README, `capabilities.ikev2`).
            Some(ike) if frontend::ikev2::supported() => {
                let params = Ikev2SideParams {
                    ike,
                    peers: ikev2_peers.clone(),
                    core: CoreConfig {
                        net: config.tunnel_net,
                        quic: config.quic,
                        allow_loopback: config.allow_loopback,
                    },
                    events: events.clone(),
                    socks: socks.clone(),
                    hooks: hooks.clone(),
                };
                match frontend::ikev2::listener::start_side(params, ikev2_shutdown).await {
                    Ok(side) => Some(side),
                    Err(error) => {
                        events.error(format!("IKEv2 is off: {error:#}"));
                        None
                    }
                }
            }
            _ => None,
        };

        events.emit(json!({
            "event": "ready",
            "listen": frontend.local_addr.to_string(),
            "publicKey": encode_key(server_public.to_bytes()),
            "capabilities": capabilities(),
            // Where IKEv2 phones connect, or null when IKEv2 is off.
            "ikev2": ikev2.as_ref().map(|side| json!({
                "ike": side.ike_addr.to_string(),
                "natT": side.nat_t_addr.to_string(),
            })),
        }));

        Ok(Tunnel {
            config,
            events,
            server_private,
            server_public,
            listen: frontend.local_addr,
            state: Mutex::new(state),
            peers,
            ikev2_peers,
            ikev2,
            socks,
            core_stats,
            hooks,
            started: Instant::now(),
            shutdown_tx,
            frontend_task: Some(frontend.task),
            core_task,
        })
    }

    pub fn listen_addr(&self) -> SocketAddr {
        self.listen
    }

    pub fn public_key(&self) -> String {
        encode_key(self.server_public.to_bytes())
    }

    /// The task that runs the front-end. If it ends, the tunnel is dead and the process should exit.
    pub fn take_frontend_task(&mut self) -> Option<JoinHandle<Result<()>>> {
        self.frontend_task.take()
    }

    fn client_config(&self, private: &StaticSecret, tunnel_ip: Ipv4Addr) -> String {
        let endpoint_host = self.config.endpoint_host.clone().unwrap_or_else(|| {
            if self.listen.ip().is_unspecified() {
                "127.0.0.1".to_string()
            } else {
                self.listen.ip().to_string()
            }
        });
        format!(
            "[Interface]\nPrivateKey = {}\nAddress = {}/32\nDNS = {}\n\n[Peer]\nPublicKey = {}\nAllowedIPs = 0.0.0.0/0, ::/0\nEndpoint = {}:{}\nPersistentKeepalive = {}\n",
            encode_key(private.to_bytes()),
            tunnel_ip,
            self.config.tunnel_net.dns_ip(),
            self.public_key(),
            endpoint_host,
            self.listen.port(),
            KEEPALIVE_SECONDS,
        )
    }

    pub fn add_peer(&self, name: &str, kind: &str) -> Result<PeerAdded> {
        if kind == PEER_KIND_IKEV2 {
            return self.add_ikev2_peer(name);
        }
        if kind != PEER_KIND_WIREGUARD {
            bail!("unsupported peer kind {kind:?}, only \"wireguard\" and \"ikev2\" work today");
        }
        let name = clean_name(name);
        let mut state = lock(&self.state);

        let used: HashSet<Ipv4Addr> = state
            .peers
            .iter()
            .filter_map(|p| p.tunnel_ip.parse().ok())
            .collect();
        let tunnel_ip = self.config.tunnel_net.allocate(&used)?;
        let id = format!("p{}", state.next_peer);
        let private = generate_secret()?;
        let public = PublicKey::from(&private);

        // Saved before it goes live, so a failed write can't leave a peer that vanishes on restart.
        let mut next = state.clone();
        next.next_peer += 1;
        next.peers.push(StoredPeer {
            peer: id.clone(),
            name: name.clone(),
            kind: kind.to_string(),
            tunnel_ip: tunnel_ip.to_string(),
            private_key: encode_key(private.to_bytes()),
            public_key: encode_key(public.to_bytes()),
        });
        next.save(&self.config.state_path)?;
        *state = next;

        lock(&self.peers).add(&self.server_private, &id, &name, tunnel_ip, public);
        self.hooks.set_peer_name(&id, &name);
        Ok(PeerAdded {
            ikev2: None,
            config: self.client_config(&private, tunnel_ip),
            peer: id,
            name,
            kind: kind.to_string(),
            tunnel_ip,
        })
    }

    /// An IKEv2 phone: the same id and address allocation as WireGuard peers, but no keypair. Its
    /// secret is derived from the server key, so nothing secret is stored for it.
    fn add_ikev2_peer(&self, name: &str) -> Result<PeerAdded> {
        if self.ikev2.is_none() {
            bail!("IKEv2 is not running (start with --ikev2)");
        }
        let name = clean_name(name);
        let mut state = lock(&self.state);
        let used: HashSet<Ipv4Addr> = state
            .peers
            .iter()
            .filter_map(|p| p.tunnel_ip.parse().ok())
            .collect();
        let tunnel_ip = self.config.tunnel_net.allocate(&used)?;
        let id = format!("p{}", state.next_peer);
        // Unused by IKEv2, but older builds read a WireGuard key for every stored peer and would
        // not start without one; with a fresh key nobody holds they just see an idle peer.
        let unused = generate_secret()?;
        let mut next = state.clone();
        next.next_peer += 1;
        next.peers.push(StoredPeer {
            peer: id.clone(),
            name: name.clone(),
            kind: PEER_KIND_IKEV2.to_string(),
            tunnel_ip: tunnel_ip.to_string(),
            private_key: encode_key(unused.to_bytes()),
            public_key: encode_key(PublicKey::from(&unused).to_bytes()),
        });
        next.save(&self.config.state_path)?;
        *state = next;

        let server_key = self.server_private.to_bytes();
        let secret = frontend::ikev2::profile_secret(&server_key, &id);
        lock(&self.ikev2_peers).add(&id, &name, tunnel_ip, secret);
        self.hooks.set_peer_name(&id, &name);
        Ok(PeerAdded {
            ikev2: Some(frontend::ikev2::peer_added_details(&server_key, &id)),
            config: String::new(),
            peer: id,
            name,
            kind: PEER_KIND_IKEV2.to_string(),
            tunnel_ip,
        })
    }

    pub fn remove_peer(&self, peer: &str) -> Result<()> {
        let mut state = lock(&self.state);
        if !state.peers.iter().any(|p| p.peer == peer) {
            bail!("unknown peer {peer:?}");
        }
        let mut next = state.clone();
        next.peers.retain(|p| p.peer != peer);
        next.save(&self.config.state_path)?;
        *state = next;
        lock(&self.peers).remove(peer);
        lock(&self.ikev2_peers).remove(peer);
        self.hooks.forget_peer_name(peer);
        Ok(())
    }

    pub fn list_peers(&self) -> Value {
        let state = lock(&self.state);
        let mut live = lock(&self.peers).summaries();
        live.extend(lock(&self.ikev2_peers).summaries());
        let peers: Vec<Value> = state
            .peers
            .iter()
            .map(|stored| {
                let summary = live.iter().find(|p| p.peer == stored.peer);
                json!({
                    "peer": stored.peer,
                    "name": stored.name,
                    "kind": stored.kind,
                    "tunnelIp": stored.tunnel_ip,
                    "endpoint": summary.and_then(|p| p.endpoint).map(|e| e.to_string()),
                    "lastHandshake": summary.and_then(|p| p.last_handshake_ms),
                })
            })
            .collect();
        json!({ "event": "peers", "peers": peers })
    }

    /// Counters for the `stats` command: per phone (bytes through its tunnel) and for the flows
    /// the core served. Everything is a running total since the sidecar started.
    pub fn stats(&self) -> Value {
        let mut live = lock(&self.peers).summaries();
        live.extend(lock(&self.ikev2_peers).summaries());
        let peers: Vec<Value> = live
            .iter()
            .map(|peer| {
                json!({
                    "peer": peer.peer,
                    "name": peer.name,
                    "tunnelIp": peer.tunnel_ip.to_string(),
                    "endpoint": peer.endpoint.map(|e| e.to_string()),
                    "lastHandshake": peer.last_handshake_ms,
                    "bytesUp": peer.bytes_up,
                    "bytesDown": peer.bytes_down,
                })
            })
            .collect();
        // "event" comes first, like in every other event line.
        let mut stats = json!({
            "event": "stats",
            "uptimeMs": self.started.elapsed().as_millis() as u64,
            "peers": peers,
        });
        if let (Some(object), Value::Object(counters)) = (stats.as_object_mut(), self.core_stats.to_json()) {
            object.extend(counters);
        }
        stats
    }

    pub fn set_socks(&self, addr: &str) -> Result<()> {
        if !valid_socks_addr(addr) {
            bail!("addr must look like host:port, got {addr:?}");
        }
        *lock(&self.socks) = addr.to_string();
        Ok(())
    }

    pub fn events(&self) -> &EventSink {
        &self.events
    }

    // --- The network tools' commands (see `handle_tool_command`) ---

    pub fn set_conditions(&self, peer: &str, conditions: Option<Conditions>) {
        self.hooks.set_conditions(peer, conditions);
    }

    pub fn set_dns_rules(&self, rules: DnsRules) -> usize {
        self.hooks.set_dns_rules(rules)
    }

    pub fn set_quic_mode(&self, mode: QuicMode) {
        self.hooks.set_quic_mode(mode);
    }

    /// Starts a capture and returns the path it really writes to: a taken name gets a number.
    pub fn capture_start(&self, path: &std::path::Path) -> Result<PathBuf> {
        self.hooks
            .capture_start(path)
            .with_context(|| format!("cannot capture to {}", path.display()))
    }

    pub fn capture_stop(&self) -> Result<CaptureSummary> {
        Ok(self.hooks.capture_stop()?)
    }

    /// The commands of the network tools: `set-conditions`, `set-dns-rules`, `set-quic`,
    /// `capture-start` and `capture-stop`. Returns the reply event, None for any other command,
    /// and Err (for an error event) for a bad one, which changes nothing.
    pub fn handle_tool_command(&self, command: &Value) -> Option<Result<Value>> {
        let result = match command.get("cmd").and_then(Value::as_str)? {
            "set-conditions" => (|| -> Result<Value> {
                let peer = parse_peer_id(command.get("peer"))?;
                let conditions = parse_conditions(command.get("conditions"))?;
                self.set_conditions(&peer, conditions);
                Ok(json!({ "event": "conditions-set", "peer": peer }))
            })(),
            "set-dns-rules" => (|| -> Result<Value> {
                let rules = parse_dns_rules(command.get("rules"))?;
                let count = self.set_dns_rules(rules);
                Ok(json!({ "event": "dns-rules-set", "count": count }))
            })(),
            "set-quic" => (|| -> Result<Value> {
                let mode = command
                    .get("mode")
                    .and_then(Value::as_str)
                    .and_then(QuicMode::parse)
                    .ok_or_else(|| anyhow!("set-quic needs \"mode\": block, relay or decrypt"))?;
                self.set_quic_mode(mode);
                Ok(json!({ "event": "quic-mode", "mode": mode.as_str() }))
            })(),
            "capture-start" => (|| -> Result<Value> {
                let path = command
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|path| !path.is_empty())
                    .ok_or_else(|| anyhow!("capture-start needs \"path\""))?;
                let real_path = self.capture_start(std::path::Path::new(path))?;
                Ok(json!({ "event": "capture-started", "path": real_path.to_string_lossy() }))
            })(),
            "capture-stop" => self.capture_stop().map(|summary| summary.to_event()),
            _ => return None,
        };
        Some(result)
    }

    /// Stops the front-end and the core. Open flows are dropped. A running capture is finished
    /// first, because the process leaves with `process::exit` and the packets still in the capture's
    /// write buffer would be lost; the parent hears about it as a `capture-stopped` event.
    pub async fn shutdown(self) {
        self.hooks.end_capture("helper stopped");
        self.shutdown_tx.send(()).ok();
        if let Some(ikev2) = &self.ikev2 {
            ikev2.abort();
        }
        if let Some(task) = self.frontend_task {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        self.core_task.abort();
    }
}

/// What this build can do, for the server and the UI (sent with `ready`).
pub fn capabilities() -> Value {
    json!({
        "quicDecrypt": features::quic::decrypt_supported(),
        "ikev2": frontend::ikev2::supported(),
    })
}

/// The HTTP/3 gateway for QUIC mode `decrypt`, when this build has one and the CA was given.
/// Without it, decrypt works like block; a problem is reported but never stops the VPN.
fn start_quic_gateway(
    config: &TunnelConfig,
    socks: Arc<Mutex<String>>,
    events: &EventSink,
    injector: frontend::PacketInjector,
) -> Option<Arc<QuicDriver>> {
    if !features::quic::decrypt_supported() {
        return None;
    }
    let (Some(cert_path), Some(key_path)) = (&config.ca_cert, &config.ca_key) else {
        return None;
    };
    let pems = std::fs::read_to_string(cert_path)
        .and_then(|cert| Ok((cert, std::fs::read_to_string(key_path)?)));
    let gateway = match pems {
        Ok((cert, key)) => QuicGateway::new(&cert, &key, socks, events.clone()),
        Err(error) => Err(anyhow!("cannot read the CA files: {error}")),
    };
    match gateway {
        Ok(gateway) => Some(QuicDriver::new(gateway, injector)),
        Err(error) => {
            events.error(format!("HTTP/3 decryption is off: {error:#}"));
            None
        }
    }
}

fn parse_peer_id(value: Option<&Value>) -> Result<String> {
    let peer = value.and_then(Value::as_str).unwrap_or_default();
    let ok = !peer.is_empty()
        && peer.len() <= MAX_PEER_ID_CHARS
        && peer.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_');
    if !ok {
        bail!("set-conditions needs the \"peer\" id");
    }
    Ok(peer.to_string())
}

/// `{"latencyMs", "jitterMs", "downKbps", "upKbps", "lossPct"}` (missing = 0), or null for none.
pub fn parse_conditions(value: Option<&Value>) -> Result<Option<Conditions>> {
    let object = match value {
        None | Some(Value::Null) => return Ok(None),
        Some(Value::Object(object)) => object,
        Some(_) => bail!("\"conditions\" must be an object or null"),
    };
    let whole = |key: &str, max: u64| -> Result<u32> {
        match object.get(key) {
            None | Some(Value::Null) => Ok(0),
            Some(value) => value
                .as_u64()
                .filter(|n| *n <= max)
                .map(|n| n as u32)
                .ok_or_else(|| anyhow!("{key} must be a whole number from 0 to {max}")),
        }
    };
    let loss = match object.get("lossPct") {
        None | Some(Value::Null) => 0.0,
        Some(value) => value
            .as_f64()
            .filter(|pct| (0.0..=100.0).contains(pct))
            .ok_or_else(|| anyhow!("lossPct must be from 0 to 100"))?,
    };
    Ok(Some(Conditions {
        latency_ms: whole("latencyMs", MAX_DELAY_MS)?,
        jitter_ms: whole("jitterMs", MAX_DELAY_MS)?,
        down_kbps: whole("downKbps", MAX_KBPS)?,
        up_kbps: whole("upKbps", MAX_KBPS)?,
        loss_pct: loss as f32,
    }))
}

/// `[{"pattern", "action": "block"}, {"pattern", "action": "answer", "ipv4"}]`.
pub fn parse_dns_rules(value: Option<&Value>) -> Result<DnsRules> {
    let list = value
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("set-dns-rules needs a \"rules\" list"))?;
    if list.len() > MAX_DNS_RULES {
        bail!("at most {MAX_DNS_RULES} DNS rules");
    }
    let mut rules = Vec::with_capacity(list.len());
    for (index, rule) in list.iter().enumerate() {
        let text = |key: &str| rule.get(key).and_then(Value::as_str);
        let pattern = text("pattern")
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .ok_or_else(|| anyhow!("DNS rule {index} has no pattern"))?;
        let action = match text("action") {
            Some("block") => DnsAction::Block,
            Some("answer") => DnsAction::Answer(
                text("ipv4")
                    .and_then(|ip| ip.parse().ok())
                    .ok_or_else(|| anyhow!("DNS rule {index} needs an \"ipv4\" address"))?,
            ),
            _ => bail!("DNS rule {index}: action must be block or answer"),
        };
        rules.push(DnsRule { pattern: pattern.to_ascii_lowercase(), action });
    }
    DnsRules::new(rules).map_err(|error| anyhow!("bad DNS rules: {error}"))
}
