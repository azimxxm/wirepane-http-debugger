//! QUIC mode `decrypt`: the core's side of the HTTP/3 gateway (`features::quic`, T7).
//!
//! The gateway is sans-IO. This driver feeds it the phone's UDP/443 datagrams, runs its timers and
//! sends whatever it returns back to the phone through the tunnel, as plain IPv4 UDP packets the
//! front-end encrypts like any other.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::json;
use tokio::sync::Notify;
use tokio::time::sleep_until;

use super::{Core, Flow, icmp};
use crate::features::quic::{OutDatagram, QuicGateway};
use crate::frontend::wireguard::lock;
use crate::frontend::{InjectedPacket, PacketInjector, PeerView};

pub struct QuicDriver {
    gateway: Mutex<QuicGateway>,
    injector: PacketInjector,
    /// Rings when a datagram may have moved the gateway's next timeout.
    wake: Notify,
}

impl QuicDriver {
    pub fn new(gateway: QuicGateway, injector: PacketInjector) -> Arc<Self> {
        Arc::new(Self { gateway: Mutex::new(gateway), injector, wake: Notify::new() })
    }

    /// Hands one datagram of the phone to the gateway and sends its answers.
    pub async fn on_datagram(&self, peer: &str, src: SocketAddr, dst: SocketAddr, payload: &[u8]) {
        let out = lock(&self.gateway).on_datagram(peer, src, dst, payload, Instant::now());
        self.wake.notify_one();
        self.send(out).await;
    }

    async fn send(&self, out: Vec<OutDatagram>) {
        for (from, to, payload) in out {
            let (SocketAddr::V4(from), SocketAddr::V4(to)) = (from, to) else {
                continue; // IPv6 is off in the tunnel
            };
            let packet = InjectedPacket { to: *to.ip(), packet: icmp::udp_datagram(from, to, &payload) };
            // Awaited, unlike the ICMP errors: QUIC data must not be lost to a short burst.
            if self.injector.send(packet).await.is_err() {
                return;
            }
        }
    }

    /// Runs the gateway's timers for as long as the core lives.
    pub async fn run(self: Arc<Self>) {
        loop {
            let next = lock(&self.gateway).next_timeout();
            match next {
                Some(at) => {
                    tokio::select! {
                        _ = sleep_until(tokio::time::Instant::from_std(at)) => {
                            let out = lock(&self.gateway).poll(Instant::now());
                            self.send(out).await;
                        }
                        _ = self.wake.notified() => {}
                    }
                }
                None => self.wake.notified().await,
            }
        }
    }
}

/// A UDP/443 flow in decrypt mode: every datagram goes to the gateway until the flow ends.
pub async fn decrypted_flow(core: &Core, driver: &QuicDriver, flow: &Flow, peer: &PeerView) {
    core.events.emit(json!({
        "event": "quic",
        "peer": peer.id,
        "dst": flow.dst.to_string(),
        "action": "decrypted",
    }));
    let mut removed = peer.removed.clone();
    while let Some(read) = flow.read(u32::from(u16::MAX)) {
        let datagram = tokio::select! {
            data = read => match data {
                Ok(data) => data,
                Err(_) => return,
            },
            _ = removed.changed() => return,
        };
        driver.on_datagram(&peer.id, flow.src, flow.dst, &datagram).await;
    }
}
