//! The network tools' hooks (docs/plans/2026-10-13-rust-network-tools.md).
//!
//! What the server sets at run time (network conditions per phone, DNS rules, the QUIC mode) and
//! the running capture live here, shared by the front-ends (every IP packet both ways goes through
//! `admit`, and through `released` when a delayed one leaves) and the core (DNS answers, UDP/443).
//! The tools themselves live in `features/`; this file only decides when each one is asked.

use std::cmp::Ordering as CmpOrdering;
use std::collections::{BinaryHeap, HashMap};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Instant, SystemTime};

use serde_json::json;

use super::QuicMode;
use crate::core::stats::CoreStats;
use crate::events::EventSink;
use crate::features::Direction;
use crate::features::capture::{CaptureSummary, PcapWriter};
use crate::features::conditions::{Conditions, Shaper, Verdict};
use crate::features::dns_rules::{DnsAction, DnsRules};
use crate::frontend::wireguard::lock;

/// Packets held back by a shaper wait in a queue of at most this many; more are dropped, like a
/// router's full buffer, so a slow link can never eat the Mac's memory.
pub const MAX_DELAYED_PACKETS: usize = 20_000;
/// ...and holding at most this many bytes in all: a phone can send packets of up to 64 kB, so the
/// count alone would allow over a gigabyte.
pub const MAX_DELAYED_BYTES: usize = 64 * 1024 * 1024;

pub struct Hooks {
    quic: Mutex<QuicMode>,
    dns_rules: Mutex<Arc<DnsRules>>,
    shapers: Mutex<HashMap<String, Shaper>>,
    capture: Mutex<Option<PcapWriter>>,
    /// How the last capture ended when it ended on its own, until the owner's `capture-stop` asks.
    ended_capture: Mutex<Option<CaptureSummary>>,
    /// Phone id -> the name its owner gave it, for the capture's interface names.
    peer_names: Mutex<HashMap<String, String>>,
    /// Where a capture that ends on its own says so (`capture-stopped`).
    events: Option<EventSink>,
    /// Global packet and drop counters.
    pub stats: Option<Arc<CoreStats>>,
    /// True while any phone has conditions or a capture runs. Lets the packet path skip the locks.
    packets_hooked: AtomicBool,
    /// Test-only: a verdict for every packet instead of the shapers' (the shaper stub says Now).
    #[cfg(test)]
    forced_verdict: Mutex<Option<Verdict>>,
    /// Test-only: a DNS decision for every name instead of the rules' (the rules stub never matches).
    #[cfg(test)]
    forced_dns: Mutex<Option<DnsAction>>,
    /// Test-only: a smaller size limit for the captures that start from now on.
    #[cfg(test)]
    capture_limit: Mutex<Option<u64>>,
}

impl Hooks {
    pub fn new(quic: QuicMode) -> Self {
        Self {
            quic: Mutex::new(quic),
            dns_rules: Mutex::new(Arc::new(DnsRules::default())),
            shapers: Mutex::new(HashMap::new()),
            capture: Mutex::new(None),
            ended_capture: Mutex::new(None),
            peer_names: Mutex::new(HashMap::new()),
            events: None,
            stats: None,
            packets_hooked: AtomicBool::new(false),
            #[cfg(test)]
            forced_verdict: Mutex::new(None),
            #[cfg(test)]
            forced_dns: Mutex::new(None),
            #[cfg(test)]
            capture_limit: Mutex::new(None),
        }
    }

    /// Where a capture that ends on its own (the size limit) reports it.
    pub fn with_events(mut self, events: EventSink) -> Self {
        self.events = Some(events);
        self
    }

    /// Attaches the global core stats to count shaper and queue drops.
    pub fn with_stats(mut self, stats: Arc<CoreStats>) -> Self {
        self.stats = Some(stats);
        self
    }

    /// Counts an externally dropped packet (e.g. from a full DelayQueue).
    pub fn count_dropped_packet(&self) {
        if let Some(stats) = &self.stats {
            stats.packets_dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// The name a phone's owner gave it. The capture names the phone's interface after it.
    pub fn set_peer_name(&self, peer: &str, name: &str) {
        lock(&self.peer_names).insert(peer.to_string(), name.to_string());
    }

    pub fn forget_peer_name(&self, peer: &str) {
        lock(&self.peer_names).remove(peer);
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

    /// `None` takes a phone's conditions off again. The phone keeps its shaper's place in the queue:
    /// the first packets after a change wait behind the ones the old conditions still hold back, so a
    /// change never lets a newer packet overtake an older one.
    pub fn set_conditions(&self, peer: &str, conditions: Option<Conditions>) {
        let now = Instant::now();
        let mut shapers = lock(&self.shapers);
        match (conditions, shapers.get_mut(peer)) {
            (Some(conditions), Some(shaper)) => shaper.set_conditions(conditions),
            (Some(conditions), None) => {
                shapers.insert(peer.to_string(), Shaper::new(conditions));
            }
            // Off while packets still wait in the queue: the shaper stays, with no conditions, and
            // `verdict` removes it once the last of them is out.
            (None, Some(shaper)) if !shaper.is_idle(now) => shaper.set_conditions(Conditions::default()),
            (None, _) => {
                shapers.remove(peer);
            }
        }
        drop(shapers);
        self.update_packets_hooked();
    }

    pub fn conditions(&self, peer: &str) -> Option<Conditions> {
        // A phone whose conditions are off may still have a shaper, for the packets left in the queue.
        lock(&self.shapers).get(peer).map(Shaper::conditions).filter(|conditions| !conditions.is_off())
    }

    /// Starts the capture and returns the path it really writes to: `path`, or the next free numbered
    /// name when that file exists, because a capture never replaces another one.
    pub fn capture_start(&self, path: &Path) -> io::Result<PathBuf> {
        let mut capture = lock(&self.capture);
        if capture.is_some() {
            return Err(io::Error::new(io::ErrorKind::AlreadyExists, "a capture is already running"));
        }
        let writer = PcapWriter::create(path)?;
        #[cfg(test)]
        let writer = match *lock(&self.capture_limit) {
            Some(bytes) => writer.with_size_limit(bytes),
            None => writer,
        };
        let real_path = writer.path().to_path_buf();
        *capture = Some(writer);
        drop(capture);
        *lock(&self.ended_capture) = None;
        self.update_packets_hooked();
        Ok(real_path)
    }

    /// Ends the running capture. Err(NotFound) when none runs. A capture that ended on its own
    /// (see `end_capture`) answers here once, with its summary, so a Stop that comes late still
    /// gets the capture's numbers.
    pub fn capture_stop(&self) -> io::Result<CaptureSummary> {
        let writer = lock(&self.capture).take();
        self.update_packets_hooked();
        match writer {
            Some(writer) => writer.finish(),
            None => lock(&self.ended_capture)
                .take()
                .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no capture is running")),
        }
    }

    /// Ends the running capture on the sidecar's own account, say because the helper is leaving: the
    /// file is finished (its buffered tail written) and a `capture-stopped` event with the reason
    /// goes to the parent. Does nothing when no capture runs.
    pub fn end_capture(&self, reason: &'static str) {
        let writer = lock(&self.capture).take();
        if let Some(writer) = writer {
            self.finish_by_itself(writer, reason);
        }
    }

    /// Finishes a writer that is no longer in `capture` and tells the parent how the capture ended.
    fn finish_by_itself(&self, writer: PcapWriter, reason: &'static str) {
        self.update_packets_hooked();
        let event = match writer.finish() {
            Ok(mut summary) => {
                summary.reason = Some(reason);
                *lock(&self.ended_capture) = Some(summary.clone());
                summary.to_event()
            }
            Err(error) => json!({
                "event": "error",
                "message": format!("the capture ended ({reason}), but its file is incomplete: {error}"),
            }),
        };
        if let Some(events) = &self.events {
            events.emit(event);
        }
    }

    pub fn is_capturing(&self) -> bool {
        lock(&self.capture).is_some()
    }

    fn update_packets_hooked(&self) {
        let hooked = !lock(&self.shapers).is_empty() || lock(&self.capture).is_some();
        self.packets_hooked.store(hooked, Ordering::Relaxed);
    }

    /// Whether `admit` can do anything at all right now.
    pub fn packets_hooked(&self) -> bool {
        #[cfg(test)]
        if lock(&self.forced_verdict).is_some() {
            return true;
        }
        self.packets_hooked.load(Ordering::Relaxed)
    }

    /// Every IP packet of a phone, both ways: its shaper decides when it may go on. A packet that
    /// goes on at once is written to the running capture; a dropped one isn't, like a packet lost
    /// on the link. A delayed one (`Verdict::At`) isn't yet: the front-end that holds it calls
    /// `released` when it really sends it on, so the capture has the time the packet left, and
    /// never one that a full queue dropped.
    pub fn admit(&self, peer: &str, direction: Direction, packet: &[u8], now: Instant) -> Verdict {
        if !self.packets_hooked() {
            return Verdict::Now;
        }
        let verdict = self.verdict(peer, direction, packet.len(), now);
        if verdict == Verdict::Now {
            self.write_to_capture(peer, direction, packet);
        } else if verdict == Verdict::Drop {
            if let Some(stats) = &self.stats {
                stats.shaper_dropped.fetch_add(1, Ordering::Relaxed);
                stats.packets_dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
        verdict
    }

    /// A packet that `admit` delayed is being sent on now.
    pub fn released(&self, peer: &str, direction: Direction, packet: &[u8]) {
        self.write_to_capture(peer, direction, packet);
    }

    /// Like `admit`, but a delayed packet goes to the capture at once, when it is queued. For a
    /// front-end that doesn't tell `released` when its delayed packets leave (the IKEv2 one).
    pub fn on_packet(&self, peer: &str, direction: Direction, packet: &[u8], now: Instant) -> Verdict {
        let verdict = self.admit(peer, direction, packet, now);
        if matches!(verdict, Verdict::At(_)) {
            self.write_to_capture(peer, direction, packet);
        }
        verdict
    }

    fn write_to_capture(&self, peer: &str, direction: Direction, packet: &[u8]) {
        let mut capture = lock(&self.capture);
        let Some(writer) = capture.as_mut() else {
            return;
        };
        let name_of = |peer: &str| lock(&self.peer_names).get(peer).cloned();
        match writer.write_packet_named(peer, direction, packet, SystemTime::now(), name_of) {
            Ok(()) => {}
            // The capture is full. It ends here, under the lock that saw it, so it can't be the end
            // of some other capture that was started in the meantime.
            Err(_) if writer.is_full() => {
                let full = capture.take();
                drop(capture);
                if let Some(full) = full {
                    self.finish_by_itself(full, "size limit");
                }
            }
            Err(error) => log::debug!("cannot write a packet to the capture: {error}"),
        }
    }

    fn verdict(&self, peer: &str, direction: Direction, len: usize, now: Instant) -> Verdict {
        #[cfg(test)]
        if let Some(forced) = *lock(&self.forced_verdict) {
            return forced;
        }
        let mut shapers = lock(&self.shapers);
        let Some(shaper) = shapers.get_mut(peer) else {
            return Verdict::Now;
        };
        let verdict = shaper.admit(direction, len, now);
        // Conditions taken off (see `set_conditions`) leave their shaper here until the last packet
        // it delayed is out of the queue.
        let finished = shaper.conditions().is_off() && shaper.is_idle(now);
        if finished {
            shapers.remove(peer);
        }
        drop(shapers);
        if finished {
            self.update_packets_hooked();
        }
        verdict
    }

    #[cfg(test)]
    pub fn force_verdict(&self, verdict: Option<Verdict>) {
        *lock(&self.forced_verdict) = verdict;
    }

    #[cfg(test)]
    pub fn force_dns(&self, action: Option<DnsAction>) {
        *lock(&self.forced_dns) = action;
    }

    #[cfg(test)]
    pub fn set_capture_limit(&self, bytes: Option<u64>) {
        *lock(&self.capture_limit) = bytes;
    }
}

struct Delayed<T> {
    at: Instant,
    seq: u64,
    bytes: usize,
    peer: Option<String>,
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

/// Packets a shaper held back (`Verdict::At`), in the order they become due. At most `cap` of
/// them, and at most `MAX_DELAYED_BYTES` bytes of the ones pushed with their size.
pub struct DelayQueue<T> {
    heap: BinaryHeap<Delayed<T>>,
    next_seq: u64,
    cap: usize,
    /// Bytes of the queued items that were pushed with a size.
    bytes: usize,
    max_bytes: usize,
    /// Items refused because the queue was full, since it was made.
    dropped: u64,
    peer_counts: HashMap<String, usize>,
    peer_bytes: HashMap<String, usize>,
}

impl<T> DelayQueue<T> {
    pub fn new(cap: usize) -> Self {
        Self {
            heap: BinaryHeap::new(),
            next_seq: 0,
            cap,
            bytes: 0,
            max_bytes: MAX_DELAYED_BYTES,
            dropped: 0,
            peer_counts: HashMap::new(),
            peer_bytes: HashMap::new(),
        }
    }

    /// The same queue with another byte budget.
    pub fn with_byte_budget(mut self, max_bytes: usize) -> Self {
        self.max_bytes = max_bytes;
        self
    }

    /// Queues an item the byte budget doesn't know about. False (and the item is dropped, and
    /// counted) when the queue is full.
    pub fn push(&mut self, at: Instant, item: T) -> bool {
        self.push_peer_bytes(at, item, 0, None)
    }

    /// Queues an item of `bytes` bytes. False (and the item is dropped, and counted) when the queue
    /// is full, by count or by bytes.
    pub fn push_bytes(&mut self, at: Instant, item: T, bytes: usize) -> bool {
        self.push_peer_bytes(at, item, bytes, None)
    }

    /// Queues an item of `bytes` bytes for `peer`. False (and the item is dropped, and counted)
    /// when the queue is full, by count or by bytes, or when a single peer exceeds fair share.
    pub fn push_peer_bytes(&mut self, at: Instant, item: T, bytes: usize, peer: Option<&str>) -> bool {
        if self.heap.len() >= self.cap || self.bytes.saturating_add(bytes) > self.max_bytes {
            self.dropped += 1;
            return false;
        }

        // Fair share per phone: if multiple peers are active in the queue, no single peer may
        // monopolize more than 75% of the total budget or capacity.
        if let Some(p) = peer {
            if self.peer_counts.len() > 1 || (!self.peer_counts.contains_key(p) && !self.peer_counts.is_empty()) {
                let max_peer_share = (self.max_bytes * 3) / 4;
                let max_peer_count = (self.cap * 3) / 4;
                let current_bytes = self.peer_bytes.get(p).copied().unwrap_or(0);
                let current_count = self.peer_counts.get(p).copied().unwrap_or(0);
                if current_bytes.saturating_add(bytes) > max_peer_share || current_count >= max_peer_count {
                    self.dropped += 1;
                    return false;
                }
            }
            *self.peer_counts.entry(p.to_string()).or_default() += 1;
            *self.peer_bytes.entry(p.to_string()).or_default() += bytes;
        }

        self.next_seq += 1;
        self.bytes += bytes;
        self.heap.push(Delayed {
            at,
            seq: self.next_seq,
            bytes,
            peer: peer.map(str::to_string),
            item,
        });
        true
    }

    pub fn next_due(&self) -> Option<Instant> {
        self.heap.peek().map(|delayed| delayed.at)
    }

    pub fn pop_due(&mut self, now: Instant) -> Option<T> {
        if self.heap.peek().is_some_and(|delayed| delayed.at <= now) {
            let delayed = self.heap.pop()?;
            self.bytes -= delayed.bytes;
            if let Some(p) = &delayed.peer {
                if let Some(count) = self.peer_counts.get_mut(p) {
                    if *count <= 1 {
                        self.peer_counts.remove(p);
                    } else {
                        *count -= 1;
                    }
                }
                if let Some(b) = self.peer_bytes.get_mut(p) {
                    if *b <= delayed.bytes {
                        self.peer_bytes.remove(p);
                    } else {
                        *b -= delayed.bytes;
                    }
                }
            }
            Some(delayed.item)
        } else {
            None
        }
    }

    pub fn len(&self) -> usize {
        self.heap.len()
    }

    /// Bytes of the queued items that were pushed with a size.
    pub fn bytes(&self) -> usize {
        self.bytes
    }

    /// Queued bytes for a specific peer.
    pub fn peer_bytes(&self, peer: &str) -> usize {
        self.peer_bytes.get(peer).copied().unwrap_or(0)
    }

    /// Queued packet count for a specific peer.
    pub fn peer_count(&self, peer: &str) -> usize {
        self.peer_counts.get(peer).copied().unwrap_or(0)
    }

    /// How many items the queue has refused for being full, since it was made.
    pub fn dropped(&self) -> u64 {
        self.dropped
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
    use crate::features::conditions::QUEUE_GRACE;
    use crate::features::dns_rules::DnsRule;

    /// An event sink that keeps what it is sent.
    fn event_log() -> (EventSink, Arc<Mutex<Vec<serde_json::Value>>>) {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink = {
            let seen = seen.clone();
            EventSink::from_fn(move |value| lock(&seen).push(value))
        };
        (sink, seen)
    }

    fn count_in(bytes: &[u8], needle: &[u8]) -> usize {
        bytes.windows(needle.len()).filter(|window| *window == needle).count()
    }

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
        assert_eq!(queue.dropped(), 1, "the refused packet is counted");
    }

    #[test]
    fn the_delay_queue_also_keeps_to_a_byte_budget() {
        let now = Instant::now();
        let mut queue = DelayQueue::new(100).with_byte_budget(1_000);
        assert!(queue.push_bytes(now, "a", 600));
        assert!(queue.push_bytes(now, "b", 400));
        assert_eq!(queue.bytes(), 1_000);
        assert!(!queue.push_bytes(now, "c", 1), "the budget is used up");
        assert_eq!((queue.len(), queue.dropped()), (2, 1));

        // Leaving the queue gives the bytes back
        assert_eq!(queue.pop_due(now), Some("a"));
        assert_eq!(queue.bytes(), 400);
        assert!(queue.push_bytes(now, "d", 600));
        assert!(!queue.push_bytes(now, "e", 601));
        assert_eq!(queue.dropped(), 2);

        // An item pushed without a size only counts against the number of items
        assert!(queue.push(now, "f"));
        assert_eq!(queue.bytes(), 1_000);
        assert_eq!(DelayQueue::<u8>::new(1).max_bytes, MAX_DELAYED_BYTES);
    }

    #[test]
    fn full_size_packets_fill_the_byte_budget_long_before_the_packet_count() {
        let now = Instant::now();
        let mut queue = DelayQueue::new(MAX_DELAYED_PACKETS);
        let mut held = 0usize;
        while queue.push_bytes(now, (), 65_535) {
            held += 1;
        }
        // By count alone 20,000 packets of 64 kB would be 1.3 GB
        assert!(held * 65_535 <= MAX_DELAYED_BYTES, "{held} packets hold more than the budget");
        assert!((1000..MAX_DELAYED_PACKETS).contains(&held), "{held} packets");
        assert_eq!(queue.dropped(), 1);
    }

    #[test]
    fn fair_share_delay_queue_prevents_a_single_peer_from_starving_others() {
        let now = Instant::now();
        // A queue with 10 packet capacity and 1000 byte budget
        let mut queue = DelayQueue::new(10).with_byte_budget(1_000);
        // Peer 1 pushes up to its fair share (75% = 750 bytes, or 7 packets)
        for i in 0..7 {
            assert!(queue.push_peer_bytes(now, i, 100, Some("p1")), "p1 packet {i} should be accepted");
        }
        // Now peer 2 tries to queue a packet
        assert!(queue.push_peer_bytes(now, 100, 100, Some("p2")), "p2 packet should be accepted");
        // Peer 1 tries to push an 8th packet (800 bytes > 750 max share)
        assert!(!queue.push_peer_bytes(now, 8, 100, Some("p1")), "p1 exceeds fair share and is dropped");
        assert_eq!(queue.peer_count("p1"), 7);
        assert_eq!(queue.peer_count("p2"), 1);
        assert_eq!(queue.peer_bytes("p1"), 700);
        assert_eq!(queue.peer_bytes("p2"), 100);

        // Once p1 drains one packet, p1 can push again
        assert_eq!(queue.pop_due(now), Some(0));
        assert_eq!(queue.peer_count("p1"), 6);
        assert!(queue.push_peer_bytes(now, 9, 100, Some("p1")));
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
    fn on_packet_writes_a_delayed_packet_to_the_capture_when_it_is_queued() {
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
    fn a_delayed_packet_reaches_the_capture_when_it_is_released_and_not_before() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = Hooks::new(QuicMode::Block);
        let now = Instant::now();
        let due = now + Duration::from_millis(50);

        // Queued but never released (a full queue dropped it, or the helper stopped): not captured
        hooks.capture_start(&dir.path().join("a.pcapng")).unwrap();
        hooks.force_verdict(Some(Verdict::At(due)));
        assert_eq!(hooks.admit("p1", Direction::ToPhone, &[0u8; 60], now), Verdict::At(due));
        hooks.force_verdict(Some(Verdict::Now));
        assert_eq!(hooks.admit("p1", Direction::FromPhone, &[0u8; 40], now), Verdict::Now);
        let summary = hooks.capture_stop().unwrap();
        assert_eq!((summary.packets, summary.bytes), (1, 40), "only the packet that went on at once");

        // Released: captured then
        hooks.capture_start(&dir.path().join("b.pcapng")).unwrap();
        hooks.force_verdict(Some(Verdict::At(due)));
        hooks.admit("p1", Direction::ToPhone, &[0u8; 60], now);
        hooks.force_verdict(None);
        hooks.released("p1", Direction::ToPhone, &[0u8; 60]);
        let summary = hooks.capture_stop().unwrap();
        assert_eq!((summary.packets, summary.bytes), (1, 60));

        // Nothing to write to: releasing does nothing
        hooks.released("p1", Direction::ToPhone, &[0u8; 60]);
        assert!(!hooks.is_capturing());
    }

    #[test]
    fn changing_a_phones_conditions_never_lets_a_new_packet_overtake_the_delayed_ones() {
        let hooks = Hooks::new(QuicMode::Block);
        let start = Instant::now();
        hooks.set_conditions("p1", Some(Conditions { latency_ms: 500, ..Conditions::default() }));
        let Verdict::At(first) = hooks.admit("p1", Direction::ToPhone, &[0u8; 100], start) else {
            panic!("500 ms of latency delays the packet");
        };

        // Faster conditions: the next packet still leaves after the first one
        hooks.set_conditions("p1", Some(Conditions { latency_ms: 1, ..Conditions::default() }));
        let Verdict::At(second) = hooks.admit("p1", Direction::ToPhone, &[0u8; 100], start + Duration::from_millis(10)) else {
            panic!("the packet has to wait for the delayed one");
        };
        assert!(second > first, "{second:?} must come after {first:?}");

        // Taken off, with those two still in the queue: the same
        hooks.set_conditions("p1", None);
        assert!(hooks.packets_hooked(), "the phone's packets still go through the shaper");
        assert_eq!(hooks.conditions("p1"), None, "but it has no conditions any more");
        let Verdict::At(third) = hooks.admit("p1", Direction::ToPhone, &[0u8; 100], start + Duration::from_millis(20)) else {
            panic!("the packet has to wait for the delayed ones");
        };
        assert!(third > second);

        // The queue is empty (the last packet is long out): the phone is plain again
        let quiet = third + QUEUE_GRACE + Duration::from_millis(1);
        assert_eq!(hooks.admit("p1", Direction::ToPhone, &[0u8; 100], quiet), Verdict::Now);
        assert!(!hooks.packets_hooked(), "the fast path is back");
    }

    #[test]
    fn taking_conditions_off_with_nothing_in_the_queue_removes_the_shaper_at_once() {
        let hooks = Hooks::new(QuicMode::Block);
        hooks.set_conditions("p1", Some(Conditions { latency_ms: 200, ..Conditions::default() }));
        hooks.set_conditions("p1", None);
        assert!(!hooks.packets_hooked());

        // The same when a packet was delayed, but is long out
        let start = Instant::now();
        hooks.set_conditions("p1", Some(Conditions { latency_ms: 200, ..Conditions::default() }));
        hooks.admit("p1", Direction::FromPhone, &[0u8; 100], start);
        hooks.set_conditions("p1", None);
        assert!(hooks.packets_hooked());
        assert_eq!(hooks.admit("p1", Direction::FromPhone, &[0u8; 100], start + Duration::from_secs(2)), Verdict::Now);
        assert!(!hooks.packets_hooked());
    }

    #[test]
    fn the_capture_names_a_phone_after_its_device() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = Hooks::new(QuicMode::Block);
        hooks.set_peer_name("p1", "Azim's iPhone");
        let path = dir.path().join("names.pcapng");
        hooks.capture_start(&path).unwrap();
        let now = Instant::now();
        hooks.on_packet("p1", Direction::FromPhone, &[0x45; 40], now);
        hooks.on_packet("p2", Direction::FromPhone, &[0x45; 40], now);
        hooks.capture_stop().unwrap();

        let bytes = std::fs::read(&path).unwrap();
        assert_eq!(count_in(&bytes, b"Azim's iPhone"), 1, "the name of p1 is its interface name");
        assert_eq!(count_in(&bytes, b"p1"), 1, "and its id is the description");
        assert_eq!(count_in(&bytes, b"p2"), 2, "a phone without a name is called by its id");

        // A forgotten phone is called by its id from then on
        hooks.forget_peer_name("p1");
        let next = dir.path().join("forgotten.pcapng");
        hooks.capture_start(&next).unwrap();
        hooks.on_packet("p1", Direction::FromPhone, &[0x45; 40], now);
        hooks.capture_stop().unwrap();
        let bytes = std::fs::read(&next).unwrap();
        assert_eq!(count_in(&bytes, b"Azim's iPhone"), 0);
        assert_eq!(count_in(&bytes, b"p1"), 2);
    }

    #[test]
    fn a_capture_never_replaces_an_earlier_file_and_says_where_it_really_is() {
        let dir = tempfile::tempdir().unwrap();
        let hooks = Hooks::new(QuicMode::Block);
        let path = dir.path().join("wirepane-2026-10-13_12-24-27.pcapng");
        assert_eq!(hooks.capture_start(&path).unwrap(), path);
        let first = hooks.capture_stop().unwrap();
        assert_eq!(first.path, path);

        // The same second again
        let second_path = hooks.capture_start(&path).unwrap();
        assert_eq!(second_path, dir.path().join("wirepane-2026-10-13_12-24-27-2.pcapng"));
        assert_eq!(hooks.capture_stop().unwrap().path, second_path);
        assert!(path.is_file() && second_path.is_file());
    }

    #[test]
    fn a_capture_that_reaches_the_size_limit_ends_and_says_so() {
        let dir = tempfile::tempdir().unwrap();
        let (events, seen) = event_log();
        let hooks = Hooks::new(QuicMode::Block).with_events(events);
        hooks.set_capture_limit(Some(1_500));
        let path = dir.path().join("full.pcapng");
        hooks.capture_start(&path).unwrap();

        let now = Instant::now();
        let mut sent = 0u64;
        while hooks.is_capturing() {
            hooks.on_packet("p1", Direction::FromPhone, &[0x45; 100], now);
            sent += 1;
            assert!(sent < 1000, "the limit never came");
        }
        assert!(!hooks.packets_hooked(), "the packet path is free again");
        assert!(std::fs::metadata(&path).unwrap().len() <= 1_500);

        let stopped: Vec<_> = lock(&seen).iter().filter(|event| event["event"] == "capture-stopped").cloned().collect();
        assert_eq!(stopped.len(), 1, "{stopped:?}");
        let stopped = &stopped[0];
        assert_eq!(stopped["reason"], "size limit");
        assert_eq!(stopped["path"], path.to_str().unwrap());
        let packets = stopped["packets"].as_u64().unwrap();
        assert!((3..sent).contains(&packets), "{packets} packets of the {sent} sent fit");
        assert_eq!(stopped["bytes"], packets * 100);

        // Later packets go nowhere and nothing more is said
        hooks.on_packet("p1", Direction::FromPhone, &[0x45; 100], now);
        assert_eq!(lock(&seen).len(), 1);

        // A Stop from the owner that comes late still gets the numbers, once
        let late = hooks.capture_stop().unwrap();
        assert_eq!((late.packets, late.reason), (packets, Some("size limit")));
        assert_eq!(hooks.capture_stop().unwrap_err().kind(), io::ErrorKind::NotFound);

        // A capture after that starts clean
        hooks.set_capture_limit(None);
        hooks.capture_start(&dir.path().join("next.pcapng")).unwrap();
        assert_eq!(hooks.capture_stop().unwrap().reason, None);
        assert_eq!(hooks.capture_stop().unwrap_err().kind(), io::ErrorKind::NotFound);
    }

    #[test]
    fn ending_the_capture_for_the_helper_writes_the_buffered_tail_and_reports_it() {
        let dir = tempfile::tempdir().unwrap();
        let (events, seen) = event_log();
        let hooks = Hooks::new(QuicMode::Block).with_events(events);

        // No capture: nothing happens and nothing is said
        hooks.end_capture("helper stopped");
        assert!(lock(&seen).is_empty());

        let path = dir.path().join("stopped.pcapng");
        hooks.capture_start(&path).unwrap();
        let now = Instant::now();
        for _ in 0..5 {
            hooks.on_packet("p1", Direction::FromPhone, &[0x45; 40], now);
        }
        let before = std::fs::metadata(&path).unwrap().len();
        hooks.end_capture("helper stopped");
        assert!(std::fs::metadata(&path).unwrap().len() > before, "the packets still in the buffer were written");
        assert!(!hooks.is_capturing());
        assert!(!hooks.packets_hooked());

        let seen = lock(&seen);
        assert_eq!(seen.len(), 1, "{seen:?}");
        assert_eq!(seen[0]["event"], "capture-stopped");
        assert_eq!(seen[0]["reason"], "helper stopped");
        assert_eq!((seen[0]["packets"].as_u64(), seen[0]["bytes"].as_u64()), (Some(5), Some(200)));
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
