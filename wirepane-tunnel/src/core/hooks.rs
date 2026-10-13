//! The network tools' hooks (docs/plans/2026-10-13-rust-network-tools.md).
//!
//! What the server sets at run time (network conditions per phone, DNS rules, the QUIC mode) and
//! the running capture live here, shared by the front-ends (every IP packet both ways goes through
//! `on_packet`) and the core (DNS answers, UDP/443). The tools themselves live in `features/`;
//! this file only decides when each one is asked.

use std::cmp::Ordering as CmpOrdering;
use std::collections::{BinaryHeap, HashMap};
use std::io;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use super::QuicMode;
use crate::features::Direction;
use crate::features::capture::{CaptureSummary, PcapWriter};
use crate::features::conditions::{Conditions, Shaper, Verdict};
use crate::features::dns_rules::{DnsAction, DnsRules};
use crate::frontend::wireguard::lock;

/// Packets held back by a shaper wait in a queue of at most this many; more are dropped, like a
/// router's full buffer, so a slow link can never eat the Mac's memory.
pub const MAX_DELAYED_PACKETS: usize = 20_000;

pub struct Hooks {
    quic: Mutex<QuicMode>,
    dns_rules: Mutex<Arc<DnsRules>>,
    shapers: Mutex<HashMap<String, Shaper>>,
    capture: Mutex<Option<PcapWriter>>,
    /// True while any phone has conditions or a capture runs. Lets the packet path skip the locks.
    packets_hooked: AtomicBool,
    /// Test-only: a verdict for every packet instead of the shapers' (the shaper stub says Now).
    #[cfg(test)]
    forced_verdict: Mutex<Option<Verdict>>,
    /// Test-only: a DNS decision for every name instead of the rules' (the rules stub never matches).
    #[cfg(test)]
    forced_dns: Mutex<Option<DnsAction>>,
}

impl Hooks {
    pub fn new(quic: QuicMode) -> Self {
        Self {
            quic: Mutex::new(quic),
            dns_rules: Mutex::new(Arc::new(DnsRules::default())),
            shapers: Mutex::new(HashMap::new()),
            capture: Mutex::new(None),
            packets_hooked: AtomicBool::new(false),
            #[cfg(test)]
            forced_verdict: Mutex::new(None),
            #[cfg(test)]
            forced_dns: Mutex::new(None),
        }
    }

    pub fn quic_mode(&self) -> QuicMode {
        *lock(&self.quic)
    }

    pub fn set_quic_mode(&self, mode: QuicMode) {
        *lock(&self.quic) = mode;
    }

    /// Replaces every DNS rule at once; returns how many there are now.
    pub fn set_dns_rules(&self, rules: DnsRules) -> usize {
        let count = rules.len();
        *lock(&self.dns_rules) = Arc::new(rules);
        count
    }

    /// The rule's action for a queried name, if one matches.
    pub fn dns_decide(&self, name: &str) -> Option<DnsAction> {
        #[cfg(test)]
        if let Some(forced) = lock(&self.forced_dns).clone() {
            return Some(forced);
        }
        // Cloned out of the lock, so a long rule list never holds up a rule change.
        let rules = lock(&self.dns_rules).clone();
        rules.decide(name).cloned()
    }

    /// `None` takes a phone's conditions off again.
    pub fn set_conditions(&self, peer: &str, conditions: Option<Conditions>) {
        let mut shapers = lock(&self.shapers);
        match conditions {
            Some(conditions) => {
                shapers.insert(peer.to_string(), Shaper::new(conditions));
            }
            None => {
                shapers.remove(peer);
            }
        }
        drop(shapers);
        self.update_packets_hooked();
    }

    pub fn conditions(&self, peer: &str) -> Option<Conditions> {
        lock(&self.shapers).get(peer).map(Shaper::conditions)
    }

    pub fn capture_start(&self, path: &Path) -> io::Result<()> {
        let mut capture = lock(&self.capture);
        if capture.is_some() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "a capture is already running"));
        }
        *capture = Some(PcapWriter::create(path)?);
        drop(capture);
        self.update_packets_hooked();
        Ok(())
    }

    /// Ends the running capture. Err(NotFound) when none runs.
    pub fn capture_stop(&self) -> io::Result<CaptureSummary> {
        let writer = lock(&self.capture).take();
        self.update_packets_hooked();
        match writer {
            Some(writer) => writer.finish(),
            None => Err(io::Error::new(io::ErrorKind::NotFound, "no capture is running")),
        }
    }

    pub fn is_capturing(&self) -> bool {
        lock(&self.capture).is_some()
    }

    fn update_packets_hooked(&self) {
        let hooked = !lock(&self.shapers).is_empty() || lock(&self.capture).is_some();
        self.packets_hooked.store(hooked, Ordering::Relaxed);
    }

    /// Whether `on_packet` can do anything at all right now.
    pub fn packets_hooked(&self) -> bool {
        #[cfg(test)]
        if lock(&self.forced_verdict).is_some() {
            return true;
        }
        self.packets_hooked.load(Ordering::Relaxed)
    }

    /// Every IP packet of a phone, both ways: its shaper decides when it may go on, and a packet
    /// that goes on (now or later) is written to the running capture. A dropped one isn't, like a
    /// packet lost on the link.
    pub fn on_packet(&self, peer: &str, direction: Direction, packet: &[u8], now: Instant) -> Verdict {
        if !self.packets_hooked() {
            return Verdict::Now;
        }
        let verdict = self.verdict(peer, direction, packet.len(), now);
        if verdict != Verdict::Drop
            && let Some(writer) = lock(&self.capture).as_mut()
            && let Err(error) = writer.write_packet(peer, direction, packet, SystemTime::now())
        {
            log::debug!("cannot write a packet to the capture: {error}");
        }
        verdict
    }

    fn verdict(&self, peer: &str, direction: Direction, len: usize, now: Instant) -> Verdict {
        #[cfg(test)]
        if let Some(forced) = *lock(&self.forced_verdict) {
            return forced;
        }
        match lock(&self.shapers).get_mut(peer) {
            Some(shaper) => shaper.admit(direction, len, now),
            None => Verdict::Now,
        }
    }

    #[cfg(test)]
    pub fn force_verdict(&self, verdict: Option<Verdict>) {
        *lock(&self.forced_verdict) = verdict;
    }

    #[cfg(test)]
    pub fn force_dns(&self, action: Option<DnsAction>) {
        *lock(&self.forced_dns) = action;
    }
}

struct Delayed<T> {
    at: Instant,
    seq: u64,
    item: T,
}

impl<T> PartialEq for Delayed<T> {
    fn eq(&self, other: &Self) -> bool {
        self.at == other.at && self.seq == other.seq
    }
}

impl<T> Eq for Delayed<T> {}

impl<T> PartialOrd for Delayed<T> {
    fn partial_cmp(&self, other: &Self) -> Option<CmpOrdering> {
        Some(self.cmp(other))
    }
}

impl<T> Ord for Delayed<T> {
    // Reversed, so the max-heap gives the earliest packet first; equal times keep arrival order.
    fn cmp(&self, other: &Self) -> CmpOrdering {
        (other.at, other.seq).cmp(&(self.at, self.seq))
    }
}

/// Packets a shaper held back (`Verdict::At`), in the order they become due.
pub struct DelayQueue<T> {
    heap: BinaryHeap<Delayed<T>>,
    next_seq: u64,
    cap: usize,
}

impl<T> DelayQueue<T> {
    pub fn new(cap: usize) -> Self {
        Self { heap: BinaryHeap::new(), next_seq: 0, cap }
    }

    /// False (and the item is dropped) when the queue is full.
    pub fn push(&mut self, at: Instant, item: T) -> bool {
        if self.heap.len() >= self.cap {
            return false;
        }
        self.next_seq += 1;
        self.heap.push(Delayed { at, seq: self.next_seq, item });
        true
    }

    pub fn next_due(&self) -> Option<Instant> {
        self.heap.peek().map(|delayed| delayed.at)
    }

    pub fn pop_due(&mut self, now: Instant) -> Option<T> {
        if self.heap.peek().is_some_and(|delayed| delayed.at <= now) {
            self.heap.pop().map(|delayed| delayed.item)
        } else {
            None
        }
    }

    pub fn len(&self) -> usize {
        self.heap.len()
    }

    pub fn is_empty(&self) -> bool {
        self.heap.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use std::net::Ipv4Addr;
    use std::time::Duration;

    use super::*;
    use crate::features::dns_rules::DnsRule;

    #[test]
    fn the_delay_queue_gives_the_earliest_first_and_keeps_order_for_equal_times() {
        let start = Instant::now();
        let mut queue = DelayQueue::new(10);
        assert!(queue.push(start + Duration::from_millis(30), "c"));
        assert!(queue.push(start + Duration::from_millis(10), "a"));
        assert!(queue.push(start + Duration::from_millis(10), "b"));
        assert_eq!(queue.next_due(), Some(start + Duration::from_millis(10)));
        assert_eq!(queue.pop_due(start), None, "nothing is due yet");
        let later = start + Duration::from_millis(20);
        assert_eq!(queue.pop_due(later), Some("a"));
        assert_eq!(queue.pop_due(later), Some("b"));
        assert_eq!(queue.pop_due(later), None);
        assert_eq!(queue.pop_due(start + Duration::from_millis(30)), Some("c"));
        assert!(queue.is_empty());
    }

    #[test]
    fn a_full_delay_queue_drops_new_packets() {
        let now = Instant::now();
        let mut queue = DelayQueue::new(2);
        assert!(queue.push(now, 1));
        assert!(queue.push(now, 2));
        assert!(!queue.push(now, 3));
        assert_eq!(queue.len(), 2);
    }

    #[test]
    fn packets_pass_untouched_without_conditions_or_capture() {
        let hooks = Hooks::new(QuicMode::Block);
        assert!(!hooks.packets_hooked());
        assert_eq!(hooks.on_packet("p1", Direction::FromPhone, &[0x45; 40], Instant::now()), Verdict::Now);
    }

    #[test]
    fn conditions_turn_the_packet_hook_on_and_off() {
        let hooks = Hooks::new(QuicMode::Block);
        let slow = Conditions { latency_ms: 200, ..Conditions::default() };
        hooks.set_conditions("p1", Some(slow));
        assert!(hooks.packets_hooked());
        assert_eq!(hooks.conditions("p1"), Some(slow));
        assert_eq!(hooks.conditions("p2"), None);
        hooks.set_conditions("p1", None);
        assert!(!hooks.packets_hooked());
        assert_eq!(hooks.conditions("p1"), None);
    }

    #[test]
    fn the_capture_gets_every_packet_that_goes_on_but_not_dropped_ones() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("test.pcapng");
        let hooks = Hooks::new(QuicMode::Block);
        hooks.capture_start(&path).unwrap();
        assert!(hooks.is_capturing());
        assert!(hooks.capture_start(&path).is_err(), "only one capture at a time");

        let now = Instant::now();
        assert_eq!(hooks.on_packet("p1", Direction::FromPhone, &[0u8; 40], now), Verdict::Now);
        hooks.force_verdict(Some(Verdict::At(now + Duration::from_millis(50))));
        assert_eq!(
            hooks.on_packet("p1", Direction::ToPhone, &[0u8; 60], now),
            Verdict::At(now + Duration::from_millis(50))
        );
        hooks.force_verdict(Some(Verdict::Drop));
        assert_eq!(hooks.on_packet("p1", Direction::ToPhone, &[0u8; 1000], now), Verdict::Drop);
        hooks.force_verdict(None);

        let summary = hooks.capture_stop().unwrap();
        assert_eq!(summary.path, path);
        assert_eq!(summary.packets, 2, "the dropped packet isn't in the capture");
        assert_eq!(summary.bytes, 100);
        assert!(!hooks.is_capturing());
        assert!(!hooks.packets_hooked());
        assert_eq!(hooks.capture_stop().unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn dns_rules_and_the_quic_mode_can_change_while_running() {
        let hooks = Hooks::new(QuicMode::Block);
        assert_eq!(hooks.dns_decide("ads.example.com"), None);
        let rules = DnsRules::new(vec![DnsRule {
            pattern: "api.test".into(),
            action: DnsAction::Answer(Ipv4Addr::new(192, 168, 0, 10)),
        }])
        .unwrap();
        assert_eq!(hooks.set_dns_rules(rules), 1);
        assert_eq!(hooks.set_dns_rules(DnsRules::default()), 0);

        hooks.set_quic_mode(QuicMode::Decrypt);
        assert_eq!(hooks.quic_mode(), QuicMode::Decrypt);
    }
}
