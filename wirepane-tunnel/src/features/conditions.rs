//! Network Conditions (T2): latency, jitter, bandwidth and packet loss for one phone.

use std::time::Instant;

use super::Direction;

/// What the user picked for a phone. Zero means "no limit" for the bandwidths.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Conditions {
    pub latency_ms: u32,
    pub jitter_ms: u32,
    pub down_kbps: u32,
    pub up_kbps: u32,
    /// 0.0 to 100.0
    pub loss_pct: f32,
}

/// What to do with one packet.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Now,
    At(Instant),
    Drop,
}

/// Keeps the per-phone state (queues, token buckets) between packets.
#[derive(Debug)]
pub struct Shaper {
    conditions: Conditions,
}

impl Shaper {
    pub fn new(conditions: Conditions) -> Self {
        Shaper { conditions }
    }

    pub fn conditions(&self) -> Conditions {
        self.conditions
    }

    /// Called for every IP packet of the phone, in order. Stub: everything goes through at once.
    pub fn admit(&mut self, _direction: Direction, _len: usize, _now: Instant) -> Verdict {
        Verdict::Now
    }
}
