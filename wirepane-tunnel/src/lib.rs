//! wirepane-tunnel: Wirepane's VPN-mode sidecar.
//!
//! A userspace WireGuard server (no root, no TUN device) that turns a phone's traffic into TCP
//! and UDP flows. Every TCP flow is handed to Mockttp over SOCKS5 with tags, so the proxy knows
//! the real destination and which phone the traffic came from. See the README for the contract.

pub mod core;
pub mod events;
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

use crate::core::stats::CoreStats;
use crate::core::{Core, CoreConfig, QuicMode};
use crate::events::EventSink;
use crate::frontend::wireguard::{self, WgDirectory, WgPeers, WireGuardParams, lock};
use crate::net::TunnelNet;
use crate::state::{StateFile, StoredPeer};

pub const PEER_KIND_WIREGUARD: &str = "wireguard";
const KEEPALIVE_SECONDS: u16 = 25;
const MAX_NAME_CHARS: usize = 64;

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
}

#[derive(Debug, Clone)]
pub struct PeerAdded {
    pub peer: String,
    pub name: String,
    pub kind: String,
    pub tunnel_ip: Ipv4Addr,
    pub config: String,
}

impl PeerAdded {
    pub fn to_event(&self) -> Value {
        json!({
            "event": "peer-added",
            "peer": self.peer,
            "name": self.name,
            "kind": self.kind,
            "tunnelIp": self.tunnel_ip.to_string(),
            "config": self.config,
        })
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
    socks: Arc<Mutex<String>>,
    core_stats: Arc<CoreStats>,
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
        for stored in &state.peers {
            let tunnel_ip: Ipv4Addr = stored
                .tunnel_ip
                .parse()
                .with_context(|| format!("bad tunnel address for peer {}", stored.peer))?;
            let public = PublicKey::from(decode_key(&stored.public_key)?);
            lock(&peers).add(&server_private, &stored.peer, &stored.name, tunnel_ip, public);
        }

        let (commands_tx, commands_rx) = mpsc::unbounded_channel();
        let (flows_tx, flows_rx) = mpsc::channel(256);
        // ICMP errors for blocked QUIC travel from the core to the front-end through this.
        let (injector_tx, injector_rx) = mpsc::channel(256);
        let (shutdown_tx, shutdown_rx) = shutdown::channel();

        let frontend = wireguard::start(
            WireGuardParams {
                listen: config.wireguard,
                server_private: server_private.clone(),
                peers: peers.clone(),
                events: events.clone(),
                injected: injector_rx,
            },
            flows_tx,
            commands_rx,
            shutdown_rx,
        )
        .await?;

        let socks = Arc::new(Mutex::new(config.socks.clone()));
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
        ));
        let core_stats = core.stats.clone();
        let core_task = tokio::spawn(core::run(core, flows_rx));

        events.emit(json!({
            "event": "ready",
            "listen": frontend.local_addr.to_string(),
            "publicKey": encode_key(server_public.to_bytes()),
        }));

        Ok(Tunnel {
            config,
            events,
            server_private,
            server_public,
            listen: frontend.local_addr,
            state: Mutex::new(state),
            peers,
            socks,
            core_stats,
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
        if kind != PEER_KIND_WIREGUARD {
            bail!("unsupported peer kind {kind:?}, only \"wireguard\" works today");
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
        Ok(PeerAdded {
            config: self.client_config(&private, tunnel_ip),
            peer: id,
            name,
            kind: kind.to_string(),
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
        Ok(())
    }

    pub fn list_peers(&self) -> Value {
        let state = lock(&self.state);
        let live = lock(&self.peers).summaries();
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
        let live = lock(&self.peers).summaries();
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

    /// Stops the front-end and the core. Open flows are dropped.
    pub async fn shutdown(self) {
        self.shutdown_tx.send(()).ok();
        if let Some(task) = self.frontend_task {
            let _ = tokio::time::timeout(Duration::from_secs(2), task).await;
        }
        self.core_task.abort();
    }
}
