//! ESP in tunnel mode with AES-GCM (RFC 4303, RFC 4106), carried in UDP 4500 (RFC 3948).
//!
//! Packet: SPI(4) | Sequence(4) | IV(8) | ciphertext | ICV(16). The plaintext is the inner IPv4
//! packet, padding (1, 2, 3, ...), the pad length and the next header (4 = IPv4). AAD = SPI |
//! Sequence (no extended sequence numbers); nonce = salt | IV.

use super::crypto::{GCM_ICV_LEN, GCM_IV_LEN, GcmKey};

const HEADER_LEN: usize = 8;
/// Next header values: IPv4 in tunnel mode, and the "no next header" dummy packet (TFC).
const NEXT_IPV4: u8 = 4;
const NEXT_NONE: u8 = 59;
const REPLAY_WINDOW: u32 = 64;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EspError {
    Truncated,
    WrongSpi,
    Replayed,
    BadIcv,
    BadPadding,
    /// A dummy packet (next header 59): valid, but there is nothing to deliver.
    Dummy,
    /// Not IPv4 (IPv6 isn't carried in v1).
    NotIpv4,
    /// The outbound sequence number would wrap; the SA must not send any more.
    Exhausted,
    Crypto,
}

/// RFC 4303 §3.4.3's sliding window. `top` is the highest sequence number accepted so far.
#[derive(Debug, Default, Clone, Copy)]
struct ReplayWindow {
    top: u32,
    seen: u64,
}

impl ReplayWindow {
    fn is_fresh(&self, sequence: u32) -> bool {
        if sequence == 0 {
            return false;
        }
        if sequence > self.top {
            return true;
        }
        let behind = self.top - sequence;
        behind < REPLAY_WINDOW && self.seen & (1u64 << behind) == 0
    }

    /// Only called after the ICV checked out, so a forged packet can't move the window.
    fn mark(&mut self, sequence: u32) {
        if sequence > self.top {
            let shift = sequence - self.top;
            self.seen = if shift >= REPLAY_WINDOW { 0 } else { self.seen << shift };
            self.seen |= 1;
            self.top = sequence;
        } else {
            self.seen |= 1u64 << (self.top - sequence);
        }
    }
}

/// One Child SA: both directions.
pub struct EspSa {
    /// Our SPI: packets from the phone carry it.
    pub spi_in: u32,
    /// The phone's SPI: our packets carry it.
    pub spi_out: u32,
    key_in: GcmKey,
    key_out: GcmKey,
    sequence_out: u32,
    replay: ReplayWindow,
}

impl EspSa {
    pub fn new(spi_in: u32, spi_out: u32, key_in: GcmKey, key_out: GcmKey) -> Self {
        Self {
            spi_in,
            spi_out,
            key_in,
            key_out,
            sequence_out: 0,
            replay: ReplayWindow::default(),
        }
    }

    /// The SPI of an ESP packet, or None when it is too short to be one.
    pub fn spi_of(packet: &[u8]) -> Option<u32> {
        let bytes = packet.get(..4)?;
        Some(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
    }

    /// Checks and decrypts one ESP packet from the phone; returns the inner IPv4 packet.
    pub fn open(&mut self, packet: &[u8]) -> Result<Vec<u8>, EspError> {
        if packet.len() < HEADER_LEN + GCM_IV_LEN + 2 + GCM_ICV_LEN {
            return Err(EspError::Truncated);
        }
        if Self::spi_of(packet) != Some(self.spi_in) {
            return Err(EspError::WrongSpi);
        }
        let sequence_bytes = packet.get(4..8).ok_or(EspError::Truncated)?;
        let sequence = u32::from_be_bytes([sequence_bytes[0], sequence_bytes[1], sequence_bytes[2], sequence_bytes[3]]);
        // A cheap check first; the window only moves once the ICV is known to be good.
        if !self.replay.is_fresh(sequence) {
            return Err(EspError::Replayed);
        }
        let aad = packet.get(..HEADER_LEN).ok_or(EspError::Truncated)?;
        let iv: [u8; GCM_IV_LEN] = packet
            .get(HEADER_LEN..HEADER_LEN + GCM_IV_LEN)
            .and_then(|iv| iv.try_into().ok())
            .ok_or(EspError::Truncated)?;
        let mut body = packet.get(HEADER_LEN + GCM_IV_LEN..).ok_or(EspError::Truncated)?.to_vec();
        let plaintext = self.key_in.open(iv, aad, &mut body).ok_or(EspError::BadIcv)?;
        self.replay.mark(sequence);

        let len = plaintext.len();
        if len < 2 {
            return Err(EspError::BadPadding);
        }
        let next_header = plaintext[len - 1];
        let pad_len = plaintext[len - 2] as usize;
        if pad_len + 2 > len {
            return Err(EspError::BadPadding);
        }
        let payload_len = len - 2 - pad_len;
        // The padding's content isn't checked: the ICV already covers it, and a sender that fills
        // it with something other than RFC 4303's 1, 2, 3, ... (some stacks use random bytes) must
        // not lose its tunnel over it. We send the default pattern ourselves.
        match next_header {
            NEXT_IPV4 => Ok(plaintext[..payload_len].to_vec()),
            NEXT_NONE => Err(EspError::Dummy),
            _ => Err(EspError::NotIpv4),
        }
    }

    /// Encrypts one IPv4 packet for the phone.
    pub fn seal(&mut self, ip_packet: &[u8]) -> Result<Vec<u8>, EspError> {
        let sequence = self.sequence_out.checked_add(1).ok_or(EspError::Exhausted)?;
        if sequence == u32::MAX {
            return Err(EspError::Exhausted);
        }
        self.sequence_out = sequence;
        // The IV only has to be unique under this key; the sequence number never repeats.
        let iv = u64::from(sequence).to_be_bytes();

        let mut header = Vec::with_capacity(HEADER_LEN);
        header.extend_from_slice(&self.spi_out.to_be_bytes());
        header.extend_from_slice(&sequence.to_be_bytes());

        let pad_len = (4 - (ip_packet.len() + 2) % 4) % 4;
        let mut body = Vec::with_capacity(ip_packet.len() + pad_len + 2 + GCM_ICV_LEN);
        body.extend_from_slice(ip_packet);
        body.extend((1..=pad_len).map(|i| i as u8));
        body.push(pad_len as u8);
        body.push(NEXT_IPV4);
        self.key_out.seal(iv, &header, &mut body).ok_or(EspError::Crypto)?;

        let mut packet = header;
        packet.extend_from_slice(&iv);
        packet.extend_from_slice(&body);
        Ok(packet)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pair() -> (EspSa, EspSa) {
        let a_to_b = [1u8; 36];
        let b_to_a = [2u8; 36];
        let responder = EspSa::new(
            0x1000,
            0x2000,
            GcmKey::new(&a_to_b).expect("key"),
            GcmKey::new(&b_to_a).expect("key"),
        );
        let phone = EspSa::new(
            0x2000,
            0x1000,
            GcmKey::new(&b_to_a).expect("key"),
            GcmKey::new(&a_to_b).expect("key"),
        );
        (responder, phone)
    }

    #[test]
    fn round_trip_with_every_padding_length() {
        let (mut responder, mut phone) = pair();
        for len in 20..40 {
            let packet: Vec<u8> = (0..len).map(|i| i as u8).collect();
            let sealed = phone.seal(&packet).expect("seals");
            // The ciphertext is a multiple of four bytes (RFC 4303 §2.4).
            assert_eq!((sealed.len() - 8 - 8 - 16) % 4, 0);
            assert_eq!(responder.open(&sealed).expect("opens"), packet);
            let back = responder.seal(&packet).expect("seals");
            assert_eq!(phone.open(&back).expect("opens"), packet);
        }
    }

    #[test]
    fn replays_and_tampering_are_dropped() {
        let (mut responder, mut phone) = pair();
        let first = phone.seal(&[0x45; 20]).expect("seals");
        let second = phone.seal(&[0x45; 20]).expect("seals");
        assert!(responder.open(&second).is_ok());
        // Out of order but inside the window: fine once; again: a replay.
        assert!(responder.open(&first).is_ok());
        assert_eq!(responder.open(&first), Err(EspError::Replayed));

        let mut tampered = phone.seal(&[0x45; 20]).expect("seals");
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert_eq!(responder.open(&tampered), Err(EspError::BadIcv));
        // A forged packet with a high sequence number must not move the window.
        let mut forged = phone.seal(&[0x45; 20]).expect("seals");
        forged[4..8].copy_from_slice(&1000u32.to_be_bytes());
        assert_eq!(responder.open(&forged), Err(EspError::BadIcv));
        let next = phone.seal(&[0x45; 20]).expect("seals");
        assert!(responder.open(&next).is_ok());
    }

    #[test]
    fn far_behind_the_window_is_a_replay() {
        let (mut responder, mut phone) = pair();
        let old = phone.seal(&[0x45; 20]).expect("seals");
        for _ in 0..70 {
            let packet = phone.seal(&[0x45; 20]).expect("seals");
            responder.open(&packet).expect("opens");
        }
        assert_eq!(responder.open(&old), Err(EspError::Replayed));
    }

    #[test]
    fn wrong_spi_and_short_packets() {
        let (mut responder, mut phone) = pair();
        let mut packet = phone.seal(&[0x45; 20]).expect("seals");
        packet[0] = 9;
        assert_eq!(responder.open(&packet), Err(EspError::WrongSpi));
        for len in 0..34 {
            assert!(responder.open(&vec![0u8; len]).is_err());
        }
    }

    #[test]
    fn sequence_never_wraps() {
        let (_, mut phone) = pair();
        phone.sequence_out = u32::MAX - 2;
        assert!(phone.seal(&[0x45; 20]).is_ok());
        assert_eq!(phone.seal(&[0x45; 20]), Err(EspError::Exhausted));
    }

    #[test]
    fn garbage_never_panics() {
        let (mut responder, _) = pair();
        let mut state = 0x9E3779B97F4A7C15u64;
        for round in 0..3000 {
            let len = (state % 120) as usize;
            let mut packet = Vec::with_capacity(len);
            for _ in 0..len {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                packet.push(state as u8);
            }
            if round % 2 == 0 && packet.len() >= 4 {
                packet[..4].copy_from_slice(&0x1000u32.to_be_bytes());
            }
            assert!(responder.open(&packet).is_err());
        }
    }
}
