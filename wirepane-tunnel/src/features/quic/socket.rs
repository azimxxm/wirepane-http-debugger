//! A virtual UDP socket for quinn. Datagrams come in through `QuicGateway::on_datagram` instead of
//! the network, and what quinn sends waits in a queue until the gateway's caller takes it and
//! delivers it to the phone through the tunnel.
//!
//! Both queues are bounded. A full queue drops the datagram, which QUIC treats like packet loss,
//! so a stalled caller or a flood from a phone can never grow memory without limit.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io::{self, IoSliceMut};
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::pin::Pin;
use std::sync::{Arc, Mutex};
use std::task::{Context, Poll, Waker};

use quinn::udp::{RecvMeta, Transmit};
use quinn::{AsyncUdpSocket, UdpPoller};
use tokio::sync::Notify;

use crate::frontend::wireguard::lock;

use super::OutDatagram;

/// Datagrams from phones that quinn has not read yet.
pub const MAX_INBOUND: usize = 4096;
/// Datagrams for phones that the caller has not taken yet (about 10 MB at 1200 bytes each).
pub const MAX_OUTBOUND: usize = 8192;
/// Remembered (phone address, server IP) pairs, to answer from the port the phone dialled.
const MAX_ROUTES: usize = 8192;
/// quinn's idea of its own port. It only matters when a route was forgotten.
const DEFAULT_PORT: u16 = 443;

struct Inbound {
    src: SocketAddr,
    dst: SocketAddr,
    payload: Vec<u8>,
}

#[derive(Default)]
struct State {
    inbound: VecDeque<Inbound>,
    recv_waker: Option<Waker>,
    outbound: VecDeque<OutDatagram>,
    ports: HashMap<(SocketAddr, IpAddr), u16>,
    closed: bool,
    dropped_inbound: u64,
    dropped_outbound: u64,
}

#[derive(Default)]
pub struct VirtualSocket {
    state: Mutex<State>,
    /// Rings whenever a datagram for a phone is queued, for a caller that wants to send it at once.
    pub ready: Arc<Notify>,
}

impl fmt::Debug for VirtualSocket {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("VirtualSocket")
    }
}

impl VirtualSocket {
    /// Queues a datagram from a phone for quinn. Returns false when it was dropped.
    pub fn push_inbound(&self, src: SocketAddr, dst: SocketAddr, payload: &[u8]) -> bool {
        let waker = {
            let mut state = lock(&self.state);
            if state.closed {
                return false;
            }
            if state.inbound.len() >= MAX_INBOUND {
                state.dropped_inbound += 1;
                return false;
            }
            if state.ports.len() >= MAX_ROUTES && !state.ports.contains_key(&(src, dst.ip())) {
                state.ports.clear();
            }
            state.ports.insert((src, dst.ip()), dst.port());
            state.inbound.push_back(Inbound { src, dst, payload: payload.to_vec() });
            state.recv_waker.take()
        };
        if let Some(waker) = waker {
            waker.wake();
        }
        true
    }

    /// Everything quinn sent since the last call, oldest first.
    pub fn take_outbound(&self) -> Vec<OutDatagram> {
        lock(&self.state).outbound.drain(..).collect()
    }

    pub fn has_outbound(&self) -> bool {
        !lock(&self.state).outbound.is_empty()
    }

    /// The server port a phone dialled for this server IP (443 unless it said otherwise).
    pub fn port_for(&self, phone: SocketAddr, server: IpAddr) -> u16 {
        lock(&self.state).ports.get(&(phone, server)).copied().unwrap_or(DEFAULT_PORT)
    }

    /// Stops taking datagrams and lets quinn's receive task sleep for good.
    pub fn close(&self) {
        let mut state = lock(&self.state);
        state.closed = true;
        state.inbound.clear();
        state.outbound.clear();
        state.recv_waker = None;
    }

    #[cfg(test)]
    pub fn queued(&self) -> (usize, usize, u64, u64) {
        let state = lock(&self.state);
        (state.inbound.len(), state.outbound.len(), state.dropped_inbound, state.dropped_outbound)
    }

    fn queue_outbound(&self, from: SocketAddr, to: SocketAddr, payload: &[u8]) {
        let mut state = lock(&self.state);
        if state.closed {
            return;
        }
        if state.outbound.len() >= MAX_OUTBOUND {
            state.dropped_outbound += 1;
            return;
        }
        state.outbound.push_back((from, to, payload.to_vec()));
        drop(state);
        self.ready.notify_one();
    }
}

/// The tunnel never pushes back: a full queue drops instead (see the module comment).
#[derive(Debug)]
struct AlwaysWritable;

impl UdpPoller for AlwaysWritable {
    fn poll_writable(self: Pin<&mut Self>, _cx: &mut Context) -> Poll<io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

impl AsyncUdpSocket for VirtualSocket {
    fn create_io_poller(self: Arc<Self>) -> Pin<Box<dyn UdpPoller>> {
        Box::pin(AlwaysWritable)
    }

    fn try_send(&self, transmit: &Transmit) -> io::Result<()> {
        // quinn answers from the address the phone sent to (RecvMeta::dst_ip below), so the reply
        // looks like it comes from the real server.
        let Some(src_ip) = transmit.src_ip else {
            log::debug!("HTTP/3: dropped a datagram without a source address");
            return Ok(());
        };
        let from = SocketAddr::new(src_ip, self.port_for(transmit.destination, src_ip));
        let segment = transmit
            .segment_size
            .filter(|size| *size > 0)
            .unwrap_or(transmit.contents.len().max(1));
        for datagram in transmit.contents.chunks(segment) {
            self.queue_outbound(from, transmit.destination, datagram);
        }
        Ok(())
    }

    fn poll_recv(
        &self,
        cx: &mut Context,
        bufs: &mut [IoSliceMut<'_>],
        meta: &mut [RecvMeta],
    ) -> Poll<io::Result<usize>> {
        let mut state = lock(&self.state);
        if state.inbound.is_empty() {
            state.recv_waker = Some(cx.waker().clone());
            return Poll::Pending;
        }
        let mut count = 0;
        for (buf, meta) in bufs.iter_mut().zip(meta.iter_mut()) {
            let Some(datagram) = state.inbound.pop_front() else {
                break;
            };
            // quinn's buffers hold a full UDP payload; a longer datagram can't come from IPv4 UDP.
            let len = datagram.payload.len().min(buf.len());
            buf[..len].copy_from_slice(&datagram.payload[..len]);
            meta.addr = datagram.src;
            meta.len = len;
            meta.stride = len;
            meta.ecn = None;
            meta.dst_ip = Some(datagram.dst.ip());
            count += 1;
        }
        Poll::Ready(Ok(count))
    }

    fn local_addr(&self) -> io::Result<SocketAddr> {
        Ok(SocketAddr::new(IpAddr::V4(Ipv4Addr::UNSPECIFIED), DEFAULT_PORT))
    }
}
