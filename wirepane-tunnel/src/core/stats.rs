//! Counters behind the `stats` command. Plain atomics, so counting never takes a lock.

use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};

#[derive(Default)]
pub struct CoreStats {
    pub tcp_opened: AtomicU64,
    pub tcp_active: AtomicU64,
    pub tcp_bytes_up: AtomicU64,
    pub tcp_bytes_down: AtomicU64,
    pub udp_opened: AtomicU64,
    pub udp_active: AtomicU64,
    pub udp_packets_up: AtomicU64,
    pub udp_packets_down: AtomicU64,
    pub udp_bytes_up: AtomicU64,
    pub udp_bytes_down: AtomicU64,
    pub dns_queries: AtomicU64,
    pub quic_blocked: AtomicU64,
    pub quic_icmp_sent: AtomicU64,
    pub packets_dropped: AtomicU64,
    pub shaper_dropped: AtomicU64,
}

impl CoreStats {
    pub fn add(counter: &AtomicU64, amount: usize) {
        counter.fetch_add(amount as u64, Ordering::Relaxed);
    }

    pub fn to_json(&self) -> Value {
        let get = |counter: &AtomicU64| counter.load(Ordering::Relaxed);
        json!({
            "tcp": {
                "flowsOpened": get(&self.tcp_opened),
                "flowsActive": get(&self.tcp_active),
                "bytesUp": get(&self.tcp_bytes_up),
                "bytesDown": get(&self.tcp_bytes_down),
            },
            "udp": {
                "flowsOpened": get(&self.udp_opened),
                "flowsActive": get(&self.udp_active),
                "packetsUp": get(&self.udp_packets_up),
                "packetsDown": get(&self.udp_packets_down),
                "bytesUp": get(&self.udp_bytes_up),
                "bytesDown": get(&self.udp_bytes_down),
            },
            "dns": { "queries": get(&self.dns_queries) },
            "quic": { "blocked": get(&self.quic_blocked), "icmpSent": get(&self.quic_icmp_sent) },
            "dropped": { "total": get(&self.packets_dropped), "shaper": get(&self.shaper_dropped) },
        })
    }
}

/// Counts a flow as active until it is dropped, so every way out of a flow task is covered.
pub struct ActiveFlow<'a>(&'a AtomicU64);

impl<'a> ActiveFlow<'a> {
    pub fn start(opened: &AtomicU64, active: &'a AtomicU64) -> Self {
        opened.fetch_add(1, Ordering::Relaxed);
        active.fetch_add(1, Ordering::Relaxed);
        Self(active)
    }
}

impl Drop for ActiveFlow<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::Relaxed);
    }
}
