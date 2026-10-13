//! Front-ends turn phones' packets into TCP/UDP flows for the core. This module is the one
//! boundary between them: a front-end owns its peers and packets, the core only sees
//! `mitmproxy::messages::TransportEvent`s (new flows) and `TransportCommand`s (data, close), plus
//! this small directory to find out which phone a flow came from.
//!
//! Today there is one front-end, WireGuard. The IKEv2 one added later plugs in the same way.

pub mod wireguard;

use std::net::{IpAddr, Ipv4Addr};

use tokio::sync::{mpsc, watch};

/// What the core needs to know about the phone behind a flow.
#[derive(Clone)]
pub struct PeerView {
    pub id: String,
    pub name: String,
    /// The phone's LAN address as the front-end sees it (not the tunnel address).
    pub endpoint_ip: Option<IpAddr>,
    /// Turns true when the peer is removed, so the core can end its flows.
    pub removed: watch::Receiver<bool>,
}

pub trait PeerDirectory: Send + Sync {
    /// Finds the peer that owns a tunnel address.
    fn lookup(&self, tunnel_ip: Ipv4Addr) -> Option<PeerView>;
}

/// A raw IPv4 packet the core wants delivered to a phone, for example the ICMP error for a blocked
/// QUIC datagram. The front-end encrypts it for the peer that owns `to` and drops it when that
/// peer is gone or has no known address.
pub struct InjectedPacket {
    pub to: Ipv4Addr,
    pub packet: Vec<u8>,
}

/// How the core hands packets to the front-end. Bounded and sent with `try_send`, so a burst of
/// errors can never grow a queue.
pub type PacketInjector = mpsc::Sender<InjectedPacket>;
