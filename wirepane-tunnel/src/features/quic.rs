//! HTTP/3 decryption (T7): QUIC mode `decrypt` terminates HTTP/3 with a leaf certificate from the
//! Wirepane CA and forwards each request as HTTP/1.1 through SOCKS to Mockttp (tag
//! `wirepane-vpn-h3`), so it shows in View like any other request. Design: `docs/http3.md`.
//!
//! Sans-IO on the outside: the core (T0) feeds the gateway the phone's UDP/443 datagrams and sends
//! back whatever it returns, so the gateway never touches the tunnel itself. Inside, a quinn
//! endpoint runs on a virtual socket (`quic/socket.rs`) with h3 on top, on the core's tokio
//! runtime. Its answers are produced asynchronously, so they are collected by `poll`, which
//! `next_timeout` asks for while anything is going on; `notifier` rings the moment one is queued,
//! for a caller that wants to send it straight away.

mod certs;
mod forward;
mod socket;
#[cfg(test)]
mod tests;

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::sync::{Notify, Semaphore};
use tokio::task::JoinHandle;

use crate::events::EventSink;

/// A UDP datagram for the phone: from (the server address the phone dialled), to (the phone), payload.
pub type OutDatagram = (SocketAddr, SocketAddr, Vec<u8>);

/// While a connection is open (or a datagram came in recently), `next_timeout` asks to be polled
/// this often, so answers that quinn produced in the background reach the phone soon.
const POLL_GAP: Duration = Duration::from_millis(2);
/// How long after the last datagram the gateway keeps asking to be polled with no open connection
/// (quinn may still be answering it, e.g. with a version negotiation or a refusal).
const ACTIVE_AFTER_DATAGRAM: Duration = Duration::from_secs(2);

pub struct QuicGateway {
    shared: Arc<forward::Shared>,
    socket: Arc<socket::VirtualSocket>,
    /// Started on the first datagram, on the runtime that delivers it.
    endpoint: Option<quinn::Endpoint>,
    accept_task: Option<JoinHandle<()>>,
    start_failed: bool,
    last_datagram: Option<Instant>,
}

impl QuicGateway {
    /// `socks` is the live Mockttp address (it changes when the UI's proxy port does).
    pub fn new(ca_cert_pem: &str, ca_key_pem: &str, socks: Arc<Mutex<String>>, events: EventSink) -> anyhow::Result<Self> {
        let issuer = Arc::new(certs::LeafIssuer::new(ca_cert_pem, ca_key_pem)?);
        // Mint one now, so a CA that can't sign is reported when the sidecar starts.
        issuer.leaf_for("wirepane.cert")?;
        let proxy_tls = certs::proxy_tls(issuer.ca_der())?;
        let socket = Arc::new(socket::VirtualSocket::default());
        let shared = Arc::new(forward::Shared {
            issuer,
            socks,
            events,
            transport: Arc::new(forward::transport_config()),
            proxy_tls,
            socket: socket.clone(),
            passthrough: Default::default(),
            peers: Mutex::new(Default::default()),
            requests: Arc::new(Semaphore::new(forward::MAX_REQUESTS)),
        });
        Ok(QuicGateway { shared, socket, endpoint: None, accept_task: None, start_failed: false, last_datagram: None })
    }

    /// A datagram from the phone (`src`, its tunnel address) to `dst` (UDP/443).
    pub fn on_datagram(&mut self, peer: &str, src: SocketAddr, dst: SocketAddr, payload: &[u8], now: Instant) -> Vec<OutDatagram> {
        if self.ensure_endpoint() {
            self.last_datagram = Some(now);
            self.shared.remember_peer(src.ip(), peer);
            if !self.socket.push_inbound(src, dst, payload) {
                log::debug!("HTTP/3: inbound queue full, dropped a datagram from {src}");
            }
        }
        self.socket.take_outbound()
    }

    /// Drives timers (loss detection, idle timeouts) and returns datagrams that became due.
    pub fn poll(&mut self, _now: Instant) -> Vec<OutDatagram> {
        self.socket.take_outbound()
    }

    /// When `poll` next wants to run, if ever.
    pub fn next_timeout(&self) -> Option<Instant> {
        if self.socket.has_outbound() {
            return Some(Instant::now());
        }
        let endpoint = self.endpoint.as_ref()?;
        let recent = self.last_datagram.is_some_and(|at| at.elapsed() < ACTIVE_AFTER_DATAGRAM);
        // quinn keeps its own timers; polling only collects what it already sent.
        (recent || endpoint.open_connections() > 0).then(|| Instant::now() + POLL_GAP)
    }

    /// Rings whenever datagrams for a phone are waiting, so a caller can `poll` at once instead of
    /// waiting for `next_timeout`. Optional: `next_timeout` alone also gets everything out.
    pub fn notifier(&self) -> Arc<Notify> {
        self.socket.ready.clone()
    }

    fn ensure_endpoint(&mut self) -> bool {
        if self.endpoint.is_some() {
            return true;
        }
        if self.start_failed {
            return false;
        }
        let Ok(runtime) = tokio::runtime::Handle::try_current() else {
            log::warn!("HTTP/3: the gateway needs a tokio runtime, dropping the datagram");
            return false;
        };
        let _inside = runtime.enter();
        let shared = &self.shared;
        let started = certs::quic_server_config(shared.issuer.clone(), None, shared.passthrough.clone(), shared.transport.clone())
            .and_then(|server_config| {
                quinn::Endpoint::new_with_abstract_socket(
                    quinn::EndpointConfig::default(),
                    Some(server_config),
                    self.socket.clone(),
                    Arc::new(quinn::TokioRuntime),
                )
                .map_err(anyhow::Error::from)
            });
        match started {
            Ok(endpoint) => {
                self.accept_task = Some(runtime.spawn(forward::accept_loop(endpoint.clone(), self.shared.clone())));
                self.endpoint = Some(endpoint);
                true
            }
            Err(error) => {
                self.start_failed = true;
                self.shared.events.error(format!("HTTP/3 decryption could not start: {error:#}"));
                false
            }
        }
    }
}

impl Drop for QuicGateway {
    fn drop(&mut self) {
        if let Some(endpoint) = &self.endpoint {
            endpoint.close(0u32.into(), b"wirepane: gateway stopped");
        }
        if let Some(task) = self.accept_task.take() {
            task.abort();
        }
        self.socket.close();
    }
}

/// Whether `decrypt` works in this build: yes, the gateway forwards HTTP/3 to Mockttp (tested in
/// `quic/tests.rs` with a real HTTP/3 client).
pub fn decrypt_supported() -> bool {
    true
}
