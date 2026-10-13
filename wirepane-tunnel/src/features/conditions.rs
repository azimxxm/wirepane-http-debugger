//! Network Conditions (T2): latency, jitter, bandwidth and packet loss for one phone.
//!
//! A `Shaper` is a small simulation of a bad network link. The core calls `admit` for every IP
//! packet of a phone (both directions, in order) and gets back what to do with it: send it now,
//! send it at a later instant, or drop it. The shaper never sleeps and never reads the clock
//! itself: the caller passes `now`, so tests can drive it with a fake clock.
//!
//! What it does to one packet, in this order:
//!
//! 1. Random loss (`loss_pct`). A lost packet is dropped before it costs any bandwidth.
//! 2. Bandwidth (`down_kbps` for `ToPhone`, `up_kbps` for `FromPhone`, 0 = no limit). A token
//!    bucket per direction. A packet that finds too few tokens waits until the missing ones
//!    have been earned, which is what a slow link does. If that wait would be longer than
//!    `MAX_QUEUE_DELAY` the packet is dropped instead, like a full buffer on a real router, so
//!    TCP slows down by itself and a flood of UDP can't grow a queue without end.
//! 3. Latency (`latency_ms`) plus a random jitter of up to `jitter_ms` either way. This is the
//!    delay of ONE direction: a request and its answer pay it twice.
//! 4. Order. Packets of one direction never overtake each other: a packet that would be
//!    released before an earlier one waits until just after it.
//!
//! How the caller must use the verdict: `Now` means send it at once, `At(t)` means put it in a
//! queue ordered by `t` (equal instants keep their arrival order) and send it when `t` has come.
//! `t` can already be in the past: that is the shaper saying "behind the earlier packets that are
//! still in your queue". For the order to hold, a packet of one direction is only ever `Now` when
//! no earlier one of that direction was released in the last `QUEUE_GRACE` (50 ms), because your
//! timer may not have sent that one yet. Release instants of one direction strictly increase.
//!
//! Changing the conditions of a running phone (`Shaper::set_conditions`) keeps that order state, so
//! the first packet after the change still waits behind the ones the old conditions delayed.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use super::Direction;

/// The longest a packet may wait for bandwidth. Past this the packet is dropped (a full buffer).
pub const MAX_QUEUE_DELAY: Duration = Duration::from_secs(2);

/// A delayed packet may still sit in the caller's queue for a moment after its release instant
/// (the caller's timer has not run yet). For this long after it, later packets of the same
/// direction go through the queue too, so they can't overtake it.
pub const QUEUE_GRACE: Duration = Duration::from_millis(50);

/// Limits for what the shaper accepts, so a typo can't make a packet wait for days.
pub const MAX_LATENCY_MS: u32 = 60_000;
pub const MAX_JITTER_MS: u32 = 60_000;

/// A token bucket always holds at least this much, so one full-size packet can go through at
/// once even on a very slow link.
const MIN_BURST_BYTES: f64 = 3_000.0;
/// ...and this much time worth of the rate, so fast links don't spend their time at the limit.
const BURST_SECONDS: f64 = 0.02;
const BYTES_PER_KBIT: f64 = 125.0; // 1 kbit/s = 1000 bits/s = 125 bytes/s

/// What the user picked for a phone. Zero means "no limit" for the bandwidths.
///
/// In JSON (the `set-conditions` command) the names are camelCase, like the UI's
/// `VpnConditions`: `latencyMs`, `jitterMs`, `downKbps`, `upKbps`, `lossPct`. A missing field is 0.
#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Conditions {
    /// Delay added to every packet, in each direction.
    pub latency_ms: u32,
    /// Each packet's delay moves randomly by up to this much either way.
    pub jitter_ms: u32,
    pub down_kbps: u32,
    pub up_kbps: u32,
    /// 0.0 to 100.0, the chance that a packet is lost (per direction).
    pub loss_pct: f32,
}

impl Conditions {
    /// True when these conditions change nothing, so the caller can skip the shaper.
    pub fn is_off(&self) -> bool {
        self.latency_ms == 0
            && self.jitter_ms == 0
            && self.down_kbps == 0
            && self.up_kbps == 0
            && !(self.loss_pct > 0.0)
    }

    /// The same conditions with every value inside its limits: loss between 0 and 100 (a
    /// number that isn't one counts as 0), latency and jitter at most a minute.
    pub fn sanitized(self) -> Conditions {
        let loss_pct = if self.loss_pct.is_finite() {
            self.loss_pct.clamp(0.0, 100.0)
        } else {
            0.0
        };
        Conditions {
            latency_ms: self.latency_ms.min(MAX_LATENCY_MS),
            jitter_ms: self.jitter_ms.min(MAX_JITTER_MS),
            loss_pct,
            ..self
        }
    }
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
    rng: SplitMix64,
    from_phone: Lane,
    to_phone: Lane,
}

impl Shaper {
    /// Loss and jitter are random, with a seed from the operating system.
    pub fn new(conditions: Conditions) -> Self {
        Self::with_seed(conditions, random_seed())
    }

    /// Like `new`, but the same seed and the same packets always give the same verdicts. For tests.
    pub fn with_seed(conditions: Conditions, seed: u64) -> Self {
        let conditions = conditions.sanitized();
        Shaper {
            conditions,
            rng: SplitMix64::new(seed),
            from_phone: Lane::new(conditions.up_kbps),
            to_phone: Lane::new(conditions.down_kbps),
        }
    }

    /// The conditions in use (inside their limits, see `Conditions::sanitized`).
    pub fn conditions(&self) -> Conditions {
        self.conditions
    }

    /// Switches to other conditions. The bandwidth buckets start over, but the release instants of
    /// the packets already delayed are kept: a packet after the change never overtakes one from
    /// before it, however much faster the new conditions are.
    pub fn set_conditions(&mut self, conditions: Conditions) {
        let conditions = conditions.sanitized();
        self.conditions = conditions;
        self.from_phone = self.from_phone.reconfigured(conditions.up_kbps);
        self.to_phone = self.to_phone.reconfigured(conditions.down_kbps);
    }

    /// True when no packet of this shaper can still be waiting in the caller's queue at `now`
    /// (the same test as the order rule in the module docs).
    pub fn is_idle(&self, now: Instant) -> bool {
        !self.from_phone.is_queued(now) && !self.to_phone.is_queued(now)
    }

    /// Called for every IP packet of the phone, in order. `len` is the packet's size in bytes.
    pub fn admit(&mut self, direction: Direction, len: usize, now: Instant) -> Verdict {
        if self.is_lost() {
            return Verdict::Drop;
        }

        let lane = match direction {
            Direction::FromPhone => &mut self.from_phone,
            Direction::ToPhone => &mut self.to_phone,
        };

        let after_bandwidth = match lane.pay_for_bandwidth(len, now) {
            Some(ready) => ready,
            None => return Verdict::Drop,
        };

        let delay = self.sample_delay();
        let candidate = match after_bandwidth.checked_add(delay) {
            Some(candidate) => candidate,
            None => return Verdict::Drop,
        };

        let lane = match direction {
            Direction::FromPhone => &mut self.from_phone,
            Direction::ToPhone => &mut self.to_phone,
        };
        lane.keep_order(candidate, now)
    }

    fn is_lost(&mut self) -> bool {
        let loss = f64::from(self.conditions.loss_pct);
        if loss <= 0.0 {
            return false;
        }
        if loss >= 100.0 {
            return true;
        }
        self.rng.next_f64() * 100.0 < loss
    }

    /// Latency plus a random amount of jitter (up to the jitter either way, never below zero).
    fn sample_delay(&mut self) -> Duration {
        let latency = f64::from(self.conditions.latency_ms);
        let jitter = f64::from(self.conditions.jitter_ms);
        let ms = if jitter > 0.0 {
            latency + (self.rng.next_f64() * 2.0 - 1.0) * jitter
        } else {
            latency
        };
        Duration::from_secs_f64(ms.max(0.0) / 1000.0)
    }
}

/// One direction of the link: its token bucket and the release time of the last delayed packet.
#[derive(Debug)]
struct Lane {
    /// Bytes per second; `None` = no limit.
    rate: Option<f64>,
    capacity: f64,
    /// Goes below zero while packets are queued: the debt is what the queue still has to send.
    tokens: f64,
    last_refill: Option<Instant>,
    /// When the packet that waits longest in this direction is released.
    last_release: Option<Instant>,
}

impl Lane {
    fn new(kbps: u32) -> Self {
        let rate = (kbps > 0).then(|| f64::from(kbps) * BYTES_PER_KBIT);
        let capacity = rate.map_or(0.0, |rate| (rate * BURST_SECONDS).max(MIN_BURST_BYTES));
        Lane {
            rate,
            capacity,
            tokens: capacity,
            last_refill: None,
            last_release: None,
        }
    }

    /// A lane for another rate that remembers when its last delayed packet is released.
    fn reconfigured(&self, kbps: u32) -> Lane {
        Lane { last_release: self.last_release, ..Lane::new(kbps) }
    }

    /// Does a delayed packet of this lane possibly still sit in the caller's queue?
    fn is_queued(&self, now: Instant) -> bool {
        self.last_release.is_some_and(|last| still_in_queue(last, now))
    }

    /// Takes `len` bytes of tokens and says when the packet gets through the bandwidth limit.
    /// `None` means the queue is too long: the packet is dropped and nothing is taken.
    fn pay_for_bandwidth(&mut self, len: usize, now: Instant) -> Option<Instant> {
        let Some(rate) = self.rate else {
            return Some(now);
        };

        // A clock that steps back is treated as no time passing
        let last_refill = self.last_refill.map_or(now, |last| last.max(now));
        let earned = now.saturating_duration_since(self.last_refill.unwrap_or(now)).as_secs_f64() * rate;
        self.tokens = (self.tokens + earned).min(self.capacity);
        self.last_refill = Some(last_refill);

        let left = self.tokens - len as f64;
        if left >= 0.0 {
            self.tokens = left;
            return Some(now);
        }

        let wait = Duration::from_secs_f64(-left / rate);
        if wait > MAX_QUEUE_DELAY {
            return None;
        }
        self.tokens = left;
        now.checked_add(wait)
    }

    /// Makes sure a packet is not released before an earlier delayed one, and turns the
    /// release instant into a verdict.
    fn keep_order(&mut self, candidate: Instant, now: Instant) -> Verdict {
        let mut release = candidate;
        // Does an earlier packet of this direction wait, or did it only just come due?
        let mut behind_earlier = false;

        if let Some(last) = self.last_release
            && still_in_queue(last, now)
        {
            behind_earlier = true;
            // One nanosecond later keeps the instants strictly increasing, so a queue sorted
            // by instant keeps the order.
            let Some(after_last) = last.checked_add(Duration::from_nanos(1)) else {
                return Verdict::Drop;
            };
            release = release.max(after_last);
        }

        if release <= now && !behind_earlier {
            return Verdict::Now;
        }
        self.last_release = Some(release);
        Verdict::At(release)
    }
}

/// A packet released at `last` may still be in the caller's queue at `now`, up to `QUEUE_GRACE`
/// after its instant.
fn still_in_queue(last: Instant, now: Instant) -> bool {
    last.checked_add(QUEUE_GRACE).is_none_or(|until| until > now)
}

/// The random numbers for loss and jitter: SplitMix64, tiny and good enough here. Not for secrets.
#[derive(Debug, Clone)]
struct SplitMix64(u64);

impl SplitMix64 {
    fn new(seed: u64) -> Self {
        SplitMix64(seed)
    }

    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// A number from 0.0 up to (not including) 1.0.
    fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

fn random_seed() -> u64 {
    let mut bytes = [0u8; 8];
    if getrandom::getrandom(&mut bytes).is_ok() {
        return u64::from_le_bytes(bytes);
    }
    // No system randomness: the clock is unpredictable enough for loss and jitter
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0x5EED, |since| since.as_nanos() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A clock the test moves by hand, so the shaper's delays can be checked exactly.
    struct FakeClock {
        start: Instant,
        offset: Duration,
    }

    impl FakeClock {
        fn new() -> Self {
            FakeClock { start: Instant::now(), offset: Duration::ZERO }
        }

        fn now(&self) -> Instant {
            self.start + self.offset
        }

        fn advance(&mut self, by: Duration) {
            self.offset += by;
        }

        fn advance_ms(&mut self, ms: u64) {
            self.advance(Duration::from_millis(ms));
        }

        /// How long after `now` the packet is sent: zero for `Now`, `None` for a drop.
        fn wait_of(&self, verdict: Verdict) -> Option<Duration> {
            match verdict {
                Verdict::Now => Some(Duration::ZERO),
                Verdict::At(at) => Some(at.saturating_duration_since(self.now())),
                Verdict::Drop => None,
            }
        }

        fn seconds_after_start(&self, at: Instant) -> f64 {
            at.duration_since(self.start).as_secs_f64()
        }
    }

    const SEED: u64 = 0xC0FFEE;

    fn conditions() -> Conditions {
        Conditions::default()
    }

    fn at(verdict: Verdict) -> Instant {
        match verdict {
            Verdict::At(at) => at,
            other => panic!("expected a delayed packet, got {other:?}"),
        }
    }

    /// Checks the packet waits `expected_ms` (a hundredth of a millisecond is close enough:
    /// the delays go through f64 seconds).
    fn assert_wait_ms(clock: &FakeClock, verdict: Verdict, expected_ms: f64) {
        let wait = clock.wait_of(verdict).unwrap_or_else(|| panic!("the packet was dropped"));
        let off_by = (wait.as_secs_f64() * 1000.0 - expected_ms).abs();
        assert!(off_by < 0.01, "waited {wait:?}, expected {expected_ms} ms");
    }

    #[test]
    fn default_conditions_let_everything_through_at_once() {
        let clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(conditions(), SEED);

        for _ in 0..1000 {
            assert_eq!(shaper.admit(Direction::FromPhone, 1500, clock.now()), Verdict::Now);
            assert_eq!(shaper.admit(Direction::ToPhone, 1500, clock.now()), Verdict::Now);
        }
        assert!(conditions().is_off());
    }

    #[test]
    fn latency_delays_each_packet_by_that_much_in_both_directions() {
        let mut clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(Conditions { latency_ms: 200, ..conditions() }, SEED);

        for direction in [Direction::FromPhone, Direction::ToPhone] {
            // Spaced out, so no packet is waiting for another
            clock.advance_ms(1_000);
            let verdict = shaper.admit(direction, 100, clock.now());
            assert_wait_ms(&clock, verdict, 200.0);
        }
    }

    #[test]
    fn jitter_spreads_the_delays_over_the_band() {
        let mut clock = FakeClock::new();
        let mut shaper =
            Shaper::with_seed(Conditions { latency_ms: 100, jitter_ms: 40, ..conditions() }, SEED);

        let mut delays_ms = Vec::new();
        for _ in 0..2000 {
            // A second apart, so no packet is held back by an earlier one
            clock.advance_ms(1_000);
            let verdict = shaper.admit(Direction::ToPhone, 100, clock.now());
            delays_ms.push(clock.wait_of(verdict).expect("not dropped").as_secs_f64() * 1000.0);
        }

        let shortest = delays_ms.iter().cloned().fold(f64::MAX, f64::min);
        let longest = delays_ms.iter().cloned().fold(0.0, f64::max);
        let mean = delays_ms.iter().sum::<f64>() / delays_ms.len() as f64;
        assert!(shortest >= 60.0 - 0.01 && shortest < 65.0, "shortest delay was {shortest} ms");
        assert!(longest <= 140.0 + 0.01 && longest > 135.0, "longest delay was {longest} ms");
        assert!((mean - 100.0).abs() < 3.0, "mean delay was {mean} ms");
    }

    #[test]
    fn packets_never_overtake_each_other_even_with_big_jitter() {
        let mut clock = FakeClock::new();
        let mut shaper =
            Shaper::with_seed(Conditions { latency_ms: 100, jitter_ms: 40, ..conditions() }, SEED);

        let mut last_release: Option<Instant> = None;
        for _ in 0..2000 {
            // 1 ms apart, much closer than the jitter, so packets want to overtake each other
            clock.advance_ms(1);
            let release = at(shaper.admit(Direction::ToPhone, 100, clock.now()));

            let delay = release.duration_since(clock.now());
            // A packet held back for order can wait a little longer than the band, never less
            assert!(delay >= Duration::from_millis(60), "delay {delay:?} is under 100 - 40 ms");
            assert!(
                delay <= Duration::from_millis(140) + Duration::from_micros(10),
                "delay {delay:?} is over 100 + 40 ms"
            );

            if let Some(last) = last_release {
                assert!(release > last, "packets must be released in the order they came in");
            }
            last_release = Some(release);
        }
    }

    #[test]
    fn a_packet_that_could_go_now_waits_for_an_earlier_delayed_one() {
        let mut clock = FakeClock::new();
        let mut shaper =
            Shaper::with_seed(Conditions { latency_ms: 10, jitter_ms: 50, ..conditions() }, SEED);

        // Look for a draw with a long delay followed by one that would be sent at once
        let mut seen_held_back = false;
        for _ in 0..500 {
            clock.advance_ms(1);
            let first = shaper.admit(Direction::FromPhone, 100, clock.now());
            clock.advance(Duration::from_micros(10));
            let second = shaper.admit(Direction::FromPhone, 100, clock.now());

            if let Verdict::At(first_at) = first {
                match second {
                    Verdict::Now => panic!("the second packet would overtake the first"),
                    Verdict::At(second_at) => {
                        assert!(second_at > first_at);
                        seen_held_back = true;
                    }
                    Verdict::Drop => panic!("nothing may be dropped"),
                }
            }
        }
        assert!(seen_held_back);
    }

    #[test]
    fn a_packet_right_after_a_delayed_one_goes_through_the_queue_behind_it() {
        let mut clock = FakeClock::new();
        // 80 kbit/s = 10,000 bytes/s, a 3000-byte bucket
        let mut shaper = Shaper::with_seed(Conditions { up_kbps: 80, ..conditions() }, SEED);

        // Two packets use the bucket, the third waits 150 ms and the fourth 300 ms
        assert_eq!(shaper.admit(Direction::FromPhone, 1500, clock.now()), Verdict::Now);
        assert_eq!(shaper.admit(Direction::FromPhone, 1500, clock.now()), Verdict::Now);
        let third = at(shaper.admit(Direction::FromPhone, 1500, clock.now()));
        let fourth = at(shaper.admit(Direction::FromPhone, 1500, clock.now()));
        assert!(fourth > third);

        // 20 ms after the fourth one came due a small packet could go at once, but the caller may
        // not have sent the fourth yet: the verdict is an instant that is not after now
        clock.advance_ms(320);
        let small = at(shaper.admit(Direction::FromPhone, 10, clock.now()));
        assert!(small > fourth, "it must sort behind the fourth packet");
        assert!(small <= clock.now(), "and it is due at once");

        // The same direction again once the grace is over: straight through
        clock.advance(QUEUE_GRACE + Duration::from_millis(1));
        assert_eq!(shaper.admit(Direction::FromPhone, 10, clock.now()), Verdict::Now);

        // The other direction never had a delayed packet
        assert_eq!(shaper.admit(Direction::ToPhone, 10, clock.now()), Verdict::Now);
    }

    #[test]
    fn new_conditions_keep_a_packet_behind_the_ones_the_old_conditions_delayed() {
        let mut clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(Conditions { latency_ms: 500, ..conditions() }, SEED);
        let before = at(shaper.admit(Direction::ToPhone, 100, clock.now()));
        assert_wait_ms(&clock, Verdict::At(before), 500.0);

        // The phone's conditions change to ones with no delay at all, 10 ms later
        clock.advance_ms(10);
        shaper.set_conditions(conditions());
        assert_eq!(shaper.conditions(), conditions());
        let after = shaper.admit(Direction::ToPhone, 100, clock.now());
        assert!(
            matches!(after, Verdict::At(release) if release > before),
            "the new packet must wait behind the delayed one, got {after:?}"
        );

        // The other direction had nothing delayed
        assert_eq!(shaper.admit(Direction::FromPhone, 100, clock.now()), Verdict::Now);
    }

    #[test]
    fn new_conditions_with_a_shorter_delay_do_not_release_a_packet_before_an_earlier_one() {
        let mut clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(Conditions { latency_ms: 300, up_kbps: 80, ..conditions() }, SEED);
        let first = at(shaper.admit(Direction::FromPhone, 100, clock.now()));

        clock.advance_ms(5);
        shaper.set_conditions(Conditions { latency_ms: 20, up_kbps: 8_000, ..conditions() });
        let second = at(shaper.admit(Direction::FromPhone, 100, clock.now()));
        assert!(second > first, "{second:?} is not after {first:?}");

        // The new rate is in force: a 1500-byte packet fits the new bucket at once
        let third = at(shaper.admit(Direction::FromPhone, 1500, clock.now()));
        assert!(third > second);
        assert!(third.duration_since(second) < Duration::from_millis(1), "the new bandwidth applies");
    }

    #[test]
    fn a_shaper_is_idle_once_its_last_delayed_packet_is_out_of_the_queue() {
        let mut clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(Conditions { latency_ms: 100, ..conditions() }, SEED);
        assert!(shaper.is_idle(clock.now()), "nothing was admitted");

        let release = at(shaper.admit(Direction::ToPhone, 100, clock.now()));
        assert!(!shaper.is_idle(clock.now()));
        // Due, but the caller's timer may not have sent it yet
        clock.advance(release.duration_since(clock.now()) + QUEUE_GRACE / 2);
        assert!(!shaper.is_idle(clock.now()));
        clock.advance(QUEUE_GRACE);
        assert!(shaper.is_idle(clock.now()));
    }

    #[test]
    fn a_queue_sorted_by_instant_gives_every_direction_its_packets_in_order() {
        let mut clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(
            Conditions { latency_ms: 30, jitter_ms: 30, down_kbps: 600, up_kbps: 300, loss_pct: 3.0 },
            SEED,
        );

        // Every packet is numbered; a verdict of Now is the same as an instant of now
        let mut queue: Vec<(Instant, usize, Direction)> = Vec::new();
        let mut arrivals: Vec<(Direction, usize)> = Vec::new();
        for number in 0..4000usize {
            // Irregular gaps, from 0 to 9 ms
            clock.advance(Duration::from_micros(((number * 7919) % 10) as u64 * 1000));
            let direction = if number % 3 == 0 { Direction::FromPhone } else { Direction::ToPhone };
            let len = 60 + (number * 31) % 1400;
            match shaper.admit(direction, len, clock.now()) {
                Verdict::Drop => {}
                Verdict::Now => queue.push((clock.now(), number, direction)),
                Verdict::At(release) => queue.push((release, number, direction)),
            }
            arrivals.push((direction, number));
        }

        queue.sort_by_key(|&(release, number, _)| (release, number));
        for wanted in [Direction::FromPhone, Direction::ToPhone] {
            let sent: Vec<usize> = queue.iter().filter(|entry| entry.2 == wanted).map(|entry| entry.1).collect();
            let mut sorted = sent.clone();
            sorted.sort_unstable();
            assert_eq!(sent, sorted, "{wanted:?} packets left in a different order than they came in");
            assert!(sent.len() > 500);
        }
        assert!(!arrivals.is_empty());
    }

    #[test]
    fn bandwidth_spaces_packets_at_the_configured_rate() {
        let clock = FakeClock::new();
        // 800 kbit/s = 100,000 bytes/s, so a 1000-byte packet needs 10 ms
        let mut shaper = Shaper::with_seed(Conditions { down_kbps: 800, ..conditions() }, SEED);

        // 100 packets of 1000 bytes arrive at the same instant
        let mut releases = Vec::new();
        for _ in 0..100 {
            let verdict = shaper.admit(Direction::ToPhone, 1000, clock.now());
            releases.push(match verdict {
                Verdict::Now => clock.now(),
                Verdict::At(at) => at,
                Verdict::Drop => panic!("a 1 s backlog must not be dropped"),
            });
        }

        // The first three packets fit in the bucket (3000 bytes), the other 97,000 bytes are
        // sent at 100,000 bytes/s: the last one leaves after 0.97 s
        let last = clock.seconds_after_start(*releases.last().unwrap());
        assert!((last - 0.97).abs() < 0.001, "last packet left at {last} s");

        // From then on, one packet every 10 ms
        for pair in releases[10..].windows(2) {
            let gap = pair[1].duration_since(pair[0]).as_secs_f64();
            assert!((gap - 0.010).abs() < 0.0001, "gap {gap} s");
        }
        assert!(releases.windows(2).all(|pair| pair[1] >= pair[0]));
    }

    #[test]
    fn a_steady_sender_gets_the_rate_and_no_more() {
        let mut clock = FakeClock::new();
        // 2 Mbit/s = 250,000 bytes/s; the phone sends 1500-byte packets every 3 ms = 500,000 bytes/s
        let mut shaper = Shaper::with_seed(Conditions { down_kbps: 2000, ..conditions() }, SEED);

        let mut sent_bytes = 0u64;
        let mut delivered_bytes = 0u64;
        let mut last_delivery = clock.now();
        for _ in 0..4000 {
            clock.advance_ms(3);
            sent_bytes += 1500;
            match shaper.admit(Direction::ToPhone, 1500, clock.now()) {
                Verdict::Now => {
                    delivered_bytes += 1500;
                    last_delivery = clock.now();
                }
                Verdict::At(at) => {
                    delivered_bytes += 1500;
                    last_delivery = at;
                }
                Verdict::Drop => {}
            }
        }

        // 12 s of sending; what got through is what the link carries in the time the last
        // delivery took (the queue was at most 2 s long), so the rate is the configured one
        let seconds = clock.seconds_after_start(last_delivery);
        let rate = delivered_bytes as f64 / seconds;
        assert!((rate - 250_000.0).abs() < 8_000.0, "delivered {rate} bytes/s");
        assert!(delivered_bytes < sent_bytes, "half of the packets must have been dropped");
        assert!(delivered_bytes > sent_bytes / 3);
    }

    #[test]
    fn up_and_down_have_their_own_buckets() {
        let clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(
            Conditions { down_kbps: 80, up_kbps: 0, ..conditions() },
            SEED,
        );

        // Fill the down bucket and then some: 10,000 bytes/s, so these queue up
        for _ in 0..10 {
            shaper.admit(Direction::ToPhone, 1500, clock.now());
        }
        assert!(matches!(shaper.admit(Direction::ToPhone, 1500, clock.now()), Verdict::At(_)));

        // The other direction has no limit and is not held up by the first one
        for _ in 0..100 {
            assert_eq!(shaper.admit(Direction::FromPhone, 1500, clock.now()), Verdict::Now);
        }

        // And the other way round
        let mut shaper = Shaper::with_seed(
            Conditions { down_kbps: 0, up_kbps: 80, ..conditions() },
            SEED,
        );
        for _ in 0..10 {
            shaper.admit(Direction::FromPhone, 1500, clock.now());
        }
        assert!(matches!(shaper.admit(Direction::FromPhone, 1500, clock.now()), Verdict::At(_)));
        for _ in 0..100 {
            assert_eq!(shaper.admit(Direction::ToPhone, 1500, clock.now()), Verdict::Now);
        }
    }

    #[test]
    fn an_idle_link_refills_its_bucket_but_only_up_to_the_burst() {
        let mut clock = FakeClock::new();
        // 80 kbit/s = 10,000 bytes/s, so the bucket holds the 3000-byte minimum
        let mut shaper = Shaper::with_seed(Conditions { up_kbps: 80, ..conditions() }, SEED);

        // Empty the bucket, with a queue behind it
        for _ in 0..6 {
            shaper.admit(Direction::FromPhone, 1500, clock.now());
        }

        // An hour of silence earns a full bucket, not an hour's worth of credit
        clock.advance(Duration::from_secs(3600));
        assert_eq!(shaper.admit(Direction::FromPhone, 1500, clock.now()), Verdict::Now);
        assert_eq!(shaper.admit(Direction::FromPhone, 1500, clock.now()), Verdict::Now);
        // 3000 bytes of burst are used up: the third packet waits 150 ms
        let verdict = shaper.admit(Direction::FromPhone, 1500, clock.now());
        assert_wait_ms(&clock, verdict, 150.0);
    }

    #[test]
    fn a_backlog_past_the_queue_limit_is_dropped_and_costs_nothing() {
        let mut clock = FakeClock::new();
        // 80 kbit/s = 10,000 bytes/s: 2 s of queue = 20,000 bytes (plus the 3000-byte bucket)
        let mut shaper = Shaper::with_seed(Conditions { down_kbps: 80, ..conditions() }, SEED);

        let mut queued = 0;
        let mut dropped = 0;
        for _ in 0..30 {
            match shaper.admit(Direction::ToPhone, 1000, clock.now()) {
                Verdict::Drop => dropped += 1,
                _ => queued += 1,
            }
        }
        assert_eq!(queued, 23, "3000 bytes of bucket + 20,000 bytes of queue, in 1000-byte packets");
        assert_eq!(dropped, 7);

        // Dropped packets took no tokens: once the queue drains, everything is accepted again
        clock.advance(Duration::from_secs(3));
        assert_eq!(shaper.admit(Direction::ToPhone, 1000, clock.now()), Verdict::Now);
    }

    #[test]
    fn latency_comes_on_top_of_the_bandwidth_wait() {
        let clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(
            Conditions { latency_ms: 400, down_kbps: 240, ..conditions() },
            SEED,
        );

        // 240 kbit/s = 30,000 bytes/s. Three 1000-byte packets use the bucket,
        // the fourth waits 1000/30000 s for its tokens
        for _ in 0..3 {
            let verdict = shaper.admit(Direction::ToPhone, 1000, clock.now());
            assert_wait_ms(&clock, verdict, 400.0);
        }
        let verdict = shaper.admit(Direction::ToPhone, 1000, clock.now());
        assert_wait_ms(&clock, verdict, 400.0 + 1000.0 / 30.0);
    }

    #[test]
    fn loss_ratio_matches_the_percentage() {
        let mut clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(Conditions { loss_pct: 5.0, ..conditions() }, SEED);

        let total = 50_000;
        let mut dropped = 0;
        for i in 0..total {
            clock.advance_ms(1);
            let direction = if i % 2 == 0 { Direction::FromPhone } else { Direction::ToPhone };
            match shaper.admit(direction, 800, clock.now()) {
                Verdict::Drop => dropped += 1,
                Verdict::Now => {}
                Verdict::At(_) => panic!("only loss is set, nothing may be delayed"),
            }
        }
        let ratio = f64::from(dropped) / f64::from(total);
        assert!((ratio - 0.05).abs() < 0.004, "{dropped} of {total} dropped = {ratio}");
    }

    #[test]
    fn a_small_loss_percentage_works_too() {
        let clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(Conditions { loss_pct: 0.5, ..conditions() }, SEED);

        let total = 100_000;
        let dropped = (0..total)
            .filter(|_| shaper.admit(Direction::ToPhone, 100, clock.now()) == Verdict::Drop)
            .count();
        let ratio = dropped as f64 / f64::from(total);
        assert!((ratio - 0.005).abs() < 0.0015, "ratio {ratio}");
    }

    #[test]
    fn zero_percent_never_drops_and_a_hundred_percent_always_does() {
        let clock = FakeClock::new();

        let mut never = Shaper::with_seed(Conditions { loss_pct: 0.0, ..conditions() }, SEED);
        let mut always = Shaper::with_seed(Conditions { loss_pct: 100.0, ..conditions() }, SEED);
        for _ in 0..5000 {
            assert_eq!(never.admit(Direction::ToPhone, 1500, clock.now()), Verdict::Now);
            assert_eq!(always.admit(Direction::ToPhone, 1500, clock.now()), Verdict::Drop);
            assert_eq!(always.admit(Direction::FromPhone, 40, clock.now()), Verdict::Drop);
        }
    }

    #[test]
    fn the_same_seed_gives_the_same_verdicts() {
        let settings = Conditions {
            latency_ms: 80,
            jitter_ms: 30,
            down_kbps: 1000,
            up_kbps: 500,
            loss_pct: 10.0,
        };
        let run = |seed: u64| {
            let mut clock = FakeClock::new();
            let start = clock.now();
            let mut shaper = Shaper::with_seed(settings, seed);
            (0..2000)
                .map(|i| {
                    clock.advance_ms(2);
                    let direction = if i % 3 == 0 { Direction::FromPhone } else { Direction::ToPhone };
                    match shaper.admit(direction, 1200, clock.now()) {
                        Verdict::Now => Some(Duration::ZERO),
                        Verdict::At(at) => Some(at.duration_since(start)),
                        Verdict::Drop => None,
                    }
                })
                .collect::<Vec<_>>()
        };

        assert_eq!(run(7), run(7));
        assert_ne!(run(7), run(8));
    }

    #[test]
    fn values_outside_their_limits_are_pulled_in() {
        let sanitized = Conditions {
            latency_ms: u32::MAX,
            jitter_ms: u32::MAX,
            loss_pct: 250.0,
            ..conditions()
        }
        .sanitized();
        assert_eq!(sanitized.latency_ms, MAX_LATENCY_MS);
        assert_eq!(sanitized.jitter_ms, MAX_JITTER_MS);
        assert_eq!(sanitized.loss_pct, 100.0);

        assert_eq!(Conditions { loss_pct: -3.0, ..conditions() }.sanitized().loss_pct, 0.0);
        assert_eq!(Conditions { loss_pct: f32::NAN, ..conditions() }.sanitized().loss_pct, 0.0);
        assert_eq!(Conditions { loss_pct: f32::INFINITY, ..conditions() }.sanitized().loss_pct, 0.0);

        // The shaper uses the limited values and does not panic on huge ones
        let clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(
            Conditions { latency_ms: u32::MAX, down_kbps: u32::MAX, ..conditions() },
            SEED,
        );
        assert_eq!(shaper.conditions().latency_ms, MAX_LATENCY_MS);
        let verdict = shaper.admit(Direction::ToPhone, 1500, clock.now());
        assert_wait_ms(&clock, verdict, f64::from(MAX_LATENCY_MS));
    }

    #[test]
    fn a_clock_that_steps_back_does_not_break_the_bucket() {
        let mut clock = FakeClock::new();
        let mut shaper = Shaper::with_seed(Conditions { up_kbps: 80, ..conditions() }, SEED);

        clock.advance_ms(1000);
        let later = clock.now();
        shaper.admit(Direction::FromPhone, 1500, later);

        // The next packet carries an older instant than the previous one
        let earlier = later - Duration::from_millis(500);
        let verdict = shaper.admit(Direction::FromPhone, 1500, earlier);
        assert!(matches!(verdict, Verdict::Now | Verdict::At(_)));
    }

    #[test]
    fn conditions_read_the_camel_case_json_the_ui_sends() {
        let parsed: Conditions = serde_json::from_str(
            r#"{"latencyMs":200,"jitterMs":20,"downKbps":750,"upKbps":250,"lossPct":2.5}"#,
        )
        .unwrap();
        assert_eq!(
            parsed,
            Conditions { latency_ms: 200, jitter_ms: 20, down_kbps: 750, up_kbps: 250, loss_pct: 2.5 }
        );

        // Fields that are left out mean "no limit"
        let partial: Conditions = serde_json::from_str(r#"{"lossPct":100}"#).unwrap();
        assert_eq!(partial, Conditions { loss_pct: 100.0, ..conditions() });

        assert!(serde_json::from_str::<Conditions>(r#"{"latencyMs":-5}"#).is_err());
        assert!(serde_json::from_str::<Conditions>(r#"{"latencyMs":"fast"}"#).is_err());
    }

    #[test]
    fn the_presets_the_ui_offers_behave_as_described() {
        let mut clock = FakeClock::new();

        // 3G: 750 kbit/s down, 250 up, 200 ms
        let mut shaper = Shaper::with_seed(
            Conditions { latency_ms: 200, down_kbps: 750, up_kbps: 250, ..conditions() },
            SEED,
        );
        clock.advance_ms(10);
        let verdict = shaper.admit(Direction::ToPhone, 1000, clock.now());
        assert_wait_ms(&clock, verdict, 200.0);

        // Offline: 100% loss
        let mut offline = Shaper::with_seed(Conditions { loss_pct: 100.0, ..conditions() }, SEED);
        assert_eq!(offline.admit(Direction::FromPhone, 60, clock.now()), Verdict::Drop);
        assert!(!Conditions { loss_pct: 100.0, ..conditions() }.is_off());
    }
}
