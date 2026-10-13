//! HTTP/3 decryption (T7): QUIC mode `decrypt` terminates HTTP/3 with a leaf certificate from the
//! Wirepane CA and forwards each request as HTTP/1.1 through SOCKS to Mockttp (tag
//! `wirepane-vpn-h3`), so it shows in View like any other request.
//!
//! Sans-IO on purpose: the core (T0) feeds the gateway the phone's UDP/443 datagrams and sends
//! back whatever it returns, so the gateway never touches the tunnel itself. Inside, T7 is free
//! (e.g. quinn-proto + h3, its own tokio tasks for the SOCKS side, more files under `quic/`).

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use crate::events::EventSink;

/// A UDP datagram for the phone: from (the server address the phone dialled), to (the phone), payload.
pub type OutDatagram = (SocketAddr, SocketAddr, Vec<u8>);

pub struct QuicGateway {
    _socks: Arc<Mutex<String>>,
    _events: EventSink,
}

impl QuicGateway {
    /// `socks` is the live Mockttp address (it changes when the UI's proxy port does).
    pub fn new(_ca_cert_pem: &str, _ca_key_pem: &str, socks: Arc<Mutex<String>>, events: EventSink) -> anyhow::Result<Self> {
        Ok(QuicGateway { _socks: socks, _events: events })
    }

    /// A datagram from the phone (`src`, its tunnel address) to `dst` (UDP/443).
    pub fn on_datagram(&mut self, _peer: &str, _src: SocketAddr, _dst: SocketAddr, _payload: &[u8], _now: Instant) -> Vec<OutDatagram> {
        Vec::new()
    }

    /// Drives timers (loss detection, idle timeouts) and returns datagrams that became due.
    pub fn poll(&mut self, _now: Instant) -> Vec<OutDatagram> {
        Vec::new()
    }

    /// When `poll` next wants to run, if ever.
    pub fn next_timeout(&self) -> Option<Instant> {
        None
    }
}

/// Whether `decrypt` works in this build. Stub: no, so the core keeps blocking QUIC.
pub fn decrypt_supported() -> bool {
    false
}
