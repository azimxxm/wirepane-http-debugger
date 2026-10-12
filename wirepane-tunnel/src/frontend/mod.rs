//! Front-ends turn phones' packets into TCP/UDP flows for the core. This module is the one
//! boundary between them: a front-end owns its peers and packets, the core only sees
//! `mitmproxy::messages::TransportEvent`s (new flows) and `TransportCommand`s (data, close), plus
//! this small directory to find out which phone a flow came from.
//!
//! Today there is one front-end, WireGuard. The IKEv2 one added later plugs in the same way.

pub mod wireguard;

use std::net::{IpAddr, Ipv4Addr};

use tokio::sync::watch;

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
