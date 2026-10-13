//! The IKEv2 message format (RFC 7296 §3): the fixed header, the generic payload chain and the
//! payloads the responder reads or writes.
//!
//! Everything here parses untrusted bytes from the network, so it never indexes blindly: every
//! length is checked first and every parser returns a `Result`.

use std::net::Ipv4Addr;

pub const HEADER_LEN: usize = 28;
pub const GENERIC_HEADER_LEN: usize = 4;
/// Major version 2, minor version 0.
pub const VERSION: u8 = 0x20;
/// A message with more payloads than this is not something iOS sends; it is rejected outright.
const MAX_PAYLOADS: usize = 64;

// Exchange types.
pub const IKE_SA_INIT: u8 = 34;
pub const IKE_AUTH: u8 = 35;
pub const CREATE_CHILD_SA: u8 = 36;
pub const INFORMATIONAL: u8 = 37;

// Header flags.
pub const FLAG_INITIATOR: u8 = 0x08;
pub const FLAG_RESPONSE: u8 = 0x20;

// Payload types.
pub const PL_NONE: u8 = 0;
pub const PL_SA: u8 = 33;
pub const PL_KE: u8 = 34;
pub const PL_IDI: u8 = 35;
pub const PL_IDR: u8 = 36;
pub const PL_CERT: u8 = 37;
pub const PL_CERTREQ: u8 = 38;
pub const PL_AUTH: u8 = 39;
pub const PL_NONCE: u8 = 40;
pub const PL_NOTIFY: u8 = 41;
pub const PL_DELETE: u8 = 42;
pub const PL_VENDOR: u8 = 43;
pub const PL_TSI: u8 = 44;
pub const PL_TSR: u8 = 45;
pub const PL_SK: u8 = 46;
pub const PL_CP: u8 = 47;
pub const PL_EAP: u8 = 48;
/// Encrypted fragment (RFC 7383). We never offer fragmentation, so this is never valid for us.
pub const PL_SKF: u8 = 53;

// Notify message types: errors.
pub const N_UNSUPPORTED_CRITICAL_PAYLOAD: u16 = 1;
pub const N_INVALID_SYNTAX: u16 = 7;
pub const N_NO_PROPOSAL_CHOSEN: u16 = 14;
pub const N_INVALID_KE_PAYLOAD: u16 = 17;
pub const N_AUTHENTICATION_FAILED: u16 = 24;
pub const N_NO_ADDITIONAL_SAS: u16 = 35;
pub const N_INTERNAL_ADDRESS_FAILURE: u16 = 36;
pub const N_TS_UNACCEPTABLE: u16 = 38;
pub const N_CHILD_SA_NOT_FOUND: u16 = 44;
// Notify message types: status.
pub const N_NAT_DETECTION_SOURCE_IP: u16 = 16388;
pub const N_NAT_DETECTION_DESTINATION_IP: u16 = 16389;
pub const N_COOKIE: u16 = 16390;
pub const N_REKEY_SA: u16 = 16393;

// Protocol ids.
pub const PROTO_IKE: u8 = 1;
pub const PROTO_ESP: u8 = 3;

// Transform types and the ids we know.
pub const TT_ENCR: u8 = 1;
pub const TT_PRF: u8 = 2;
pub const TT_INTEG: u8 = 3;
pub const TT_DH: u8 = 4;
pub const TT_ESN: u8 = 5;
pub const ENCR_AES_GCM_16: u16 = 20;
pub const PRF_HMAC_SHA2_256: u16 = 5;
pub const INTEG_NONE: u16 = 0;
pub const DH_NONE: u16 = 0;
pub const DH_ECP_256: u16 = 19;
pub const DH_CURVE25519: u16 = 31;
pub const ESN_NONE: u16 = 0;
/// The Key Length attribute (type 14, always in the short "TV" form).
pub const ATTR_KEY_LENGTH: u16 = 14;
const ATTR_FORMAT_TV: u16 = 0x8000;

// Identification types.
pub const ID_FQDN: u8 = 2;

// Authentication methods.
pub const AUTH_SHARED_KEY_MIC: u8 = 2;

// Configuration payload.
pub const CFG_REQUEST: u8 = 1;
pub const CFG_REPLY: u8 = 2;
pub const INTERNAL_IP4_ADDRESS: u16 = 1;
pub const INTERNAL_IP4_DNS: u16 = 3;

// Traffic selector types.
pub const TS_IPV4_ADDR_RANGE: u8 = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WireError {
    Truncated,
    BadLength,
    BadVersion,
    TrailingData,
    TooManyPayloads,
    Malformed,
}

impl std::fmt::Display for WireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{self:?}")
    }
}

pub type WireResult<T> = Result<T, WireError>;

fn be16(data: &[u8], at: usize) -> WireResult<u16> {
    let bytes = data.get(at..at + 2).ok_or(WireError::Truncated)?;
    Ok(u16::from_be_bytes([bytes[0], bytes[1]]))
}

fn be32(data: &[u8], at: usize) -> WireResult<u32> {
    let bytes = data.get(at..at + 4).ok_or(WireError::Truncated)?;
    Ok(u32::from_be_bytes([bytes[0], bytes[1], bytes[2], bytes[3]]))
}

fn be64(data: &[u8], at: usize) -> WireResult<u64> {
    let bytes = data.get(at..at + 8).ok_or(WireError::Truncated)?;
    let mut array = [0u8; 8];
    array.copy_from_slice(bytes);
    Ok(u64::from_be_bytes(array))
}

fn byte(data: &[u8], at: usize) -> WireResult<u8> {
    data.get(at).copied().ok_or(WireError::Truncated)
}

/// The fixed IKE header (RFC 7296 §3.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Header {
    pub spi_i: u64,
    pub spi_r: u64,
    pub next_payload: u8,
    pub exchange: u8,
    pub flags: u8,
    pub message_id: u32,
    pub length: u32,
}

impl Header {
    /// Parses the header of a whole message and checks its length field against `message`.
    pub fn parse(message: &[u8]) -> WireResult<Header> {
        if message.len() < HEADER_LEN {
            return Err(WireError::Truncated);
        }
        let version = byte(message, 17)?;
        if version >> 4 != 2 {
            return Err(WireError::BadVersion);
        }
        let header = Header {
            spi_i: be64(message, 0)?,
            spi_r: be64(message, 8)?,
            next_payload: byte(message, 16)?,
            exchange: byte(message, 18)?,
            flags: byte(message, 19)?,
            message_id: be32(message, 20)?,
            length: be32(message, 24)?,
        };
        if header.length as usize != message.len() {
            return Err(WireError::BadLength);
        }
        Ok(header)
    }

    pub fn is_response(&self) -> bool {
        self.flags & FLAG_RESPONSE != 0
    }

    pub fn is_from_initiator(&self) -> bool {
        self.flags & FLAG_INITIATOR != 0
    }

    pub fn write(&self, out: &mut Vec<u8>) {
        out.extend_from_slice(&self.spi_i.to_be_bytes());
        out.extend_from_slice(&self.spi_r.to_be_bytes());
        out.push(self.next_payload);
        out.push(VERSION);
        out.push(self.exchange);
        out.push(self.flags);
        out.extend_from_slice(&self.message_id.to_be_bytes());
        out.extend_from_slice(&self.length.to_be_bytes());
    }
}

/// One payload of a chain, borrowed from the message.
#[derive(Debug, Clone, Copy)]
pub struct RawPayload<'a> {
    pub kind: u8,
    /// The "next payload" field. For SK it names the first payload inside the encryption.
    pub next: u8,
    pub critical: bool,
    pub body: &'a [u8],
    /// Where the payload's generic header starts, counted from the start of the chain.
    pub offset: usize,
}

/// Walks a payload chain that starts with a payload of type `first`. SK (and SKF) must be the last
/// payload: its "next payload" is the first payload inside it, so the walk ends there.
pub fn parse_chain(first: u8, data: &[u8]) -> WireResult<Vec<RawPayload<'_>>> {
    let mut payloads = Vec::new();
    let mut kind = first;
    let mut offset = 0usize;
    while kind != PL_NONE {
        if payloads.len() >= MAX_PAYLOADS {
            return Err(WireError::TooManyPayloads);
        }
        let rest = data.get(offset..).ok_or(WireError::Truncated)?;
        if rest.len() < GENERIC_HEADER_LEN {
            return Err(WireError::Truncated);
        }
        let next = byte(rest, 0)?;
        let critical = byte(rest, 1)? & 0x80 != 0;
        let length = be16(rest, 2)? as usize;
        if length < GENERIC_HEADER_LEN || length > rest.len() {
            return Err(WireError::BadLength);
        }
        let body = rest.get(GENERIC_HEADER_LEN..length).ok_or(WireError::Truncated)?;
        payloads.push(RawPayload {
            kind,
            next,
            critical,
            body,
            offset,
        });
        offset += length;
        if kind == PL_SK || kind == PL_SKF {
            if offset != data.len() {
                return Err(WireError::TrailingData);
            }
            return Ok(payloads);
        }
        kind = next;
    }
    if offset != data.len() {
        return Err(WireError::TrailingData);
    }
    Ok(payloads)
}

/// Builds a payload chain, filling in each payload's "next payload" field as the next one is added.
#[derive(Default)]
pub struct ChainBuilder {
    bytes: Vec<u8>,
    first: u8,
    last_header: Option<usize>,
}

impl ChainBuilder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn push(&mut self, kind: u8, body: &[u8]) {
        match self.last_header {
            Some(at) => self.bytes[at] = kind,
            None => self.first = kind,
        }
        let at = self.bytes.len();
        // Our own payloads are a few hundred bytes at most; the length can't overflow.
        let length = (body.len() + GENERIC_HEADER_LEN).min(u16::MAX as usize) as u16;
        self.bytes.push(PL_NONE);
        self.bytes.push(0);
        self.bytes.extend_from_slice(&length.to_be_bytes());
        self.bytes.extend_from_slice(body);
        self.last_header = Some(at);
    }

    /// The type of the first payload (PL_NONE for an empty chain) and the bytes.
    pub fn finish(self) -> (u8, Vec<u8>) {
        (self.first, self.bytes)
    }
}

/// A whole unencrypted message: header plus chain, with the length field filled in.
pub fn build_message(mut header: Header, chain: ChainBuilder) -> Vec<u8> {
    let (first, body) = chain.finish();
    header.next_payload = first;
    header.length = (HEADER_LEN + body.len()) as u32;
    let mut out = Vec::with_capacity(HEADER_LEN + body.len());
    header.write(&mut out);
    out.extend_from_slice(&body);
    out
}

// --- Security Association payload (RFC 7296 §3.3) ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Transform {
    pub kind: u8,
    pub id: u16,
    pub key_length: Option<u16>,
    /// True when the transform carries an attribute we don't know; such a transform must not be
    /// chosen (RFC 7296 §3.3.6).
    pub unknown_attribute: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Proposal {
    pub number: u8,
    pub protocol: u8,
    pub spi: Vec<u8>,
    pub transforms: Vec<Transform>,
}

pub fn parse_sa(body: &[u8]) -> WireResult<Vec<Proposal>> {
    let mut proposals = Vec::new();
    let mut offset = 0usize;
    loop {
        let rest = body.get(offset..).ok_or(WireError::Truncated)?;
        let last = byte(rest, 0)?;
        let length = be16(rest, 2)? as usize;
        if length < 8 || length > rest.len() {
            return Err(WireError::BadLength);
        }
        let proposal = rest.get(..length).ok_or(WireError::Truncated)?;
        let number = byte(proposal, 4)?;
        let protocol = byte(proposal, 5)?;
        let spi_size = byte(proposal, 6)? as usize;
        let transform_count = byte(proposal, 7)? as usize;
        let spi = proposal.get(8..8 + spi_size).ok_or(WireError::Truncated)?.to_vec();
        let transforms = parse_transforms(proposal.get(8 + spi_size..).ok_or(WireError::Truncated)?)?;
        if transforms.len() != transform_count {
            return Err(WireError::Malformed);
        }
        proposals.push(Proposal {
            number,
            protocol,
            spi,
            transforms,
        });
        offset += length;
        match last {
            0 => break,
            2 => {}
            _ => return Err(WireError::Malformed),
        }
        if proposals.len() > MAX_PAYLOADS {
            return Err(WireError::TooManyPayloads);
        }
    }
    if offset != body.len() {
        return Err(WireError::TrailingData);
    }
    Ok(proposals)
}

fn parse_transforms(data: &[u8]) -> WireResult<Vec<Transform>> {
    let mut transforms = Vec::new();
    let mut offset = 0usize;
    while offset < data.len() {
        let rest = data.get(offset..).ok_or(WireError::Truncated)?;
        let last = byte(rest, 0)?;
        let length = be16(rest, 2)? as usize;
        if length < 8 || length > rest.len() {
            return Err(WireError::BadLength);
        }
        let kind = byte(rest, 4)?;
        let id = be16(rest, 6)?;
        let mut key_length = None;
        let mut unknown_attribute = false;
        let mut attributes = rest.get(8..length).ok_or(WireError::Truncated)?;
        while !attributes.is_empty() {
            let attribute_type = be16(attributes, 0)?;
            let value = be16(attributes, 2)?;
            if attribute_type & ATTR_FORMAT_TV != 0 {
                if attribute_type & !ATTR_FORMAT_TV == ATTR_KEY_LENGTH {
                    key_length = Some(value);
                } else {
                    unknown_attribute = true;
                }
                attributes = attributes.get(4..).ok_or(WireError::Truncated)?;
            } else {
                // A long attribute: we know none, so the transform can't be used.
                unknown_attribute = true;
                let skip = 4 + value as usize;
                attributes = attributes.get(skip..).ok_or(WireError::Truncated)?;
            }
        }
        transforms.push(Transform {
            kind,
            id,
            key_length,
            unknown_attribute,
        });
        offset += length;
        if transforms.len() > MAX_PAYLOADS {
            return Err(WireError::TooManyPayloads);
        }
        match last {
            0 => break,
            3 => {}
            _ => return Err(WireError::Malformed),
        }
    }
    if offset != data.len() {
        return Err(WireError::TrailingData);
    }
    Ok(transforms)
}

/// One proposal, as the body of an SA payload.
pub fn build_sa(proposal: &Proposal) -> Vec<u8> {
    let mut transforms = Vec::new();
    for (i, transform) in proposal.transforms.iter().enumerate() {
        let is_last = i + 1 == proposal.transforms.len();
        let mut attributes = Vec::new();
        if let Some(bits) = transform.key_length {
            attributes.extend_from_slice(&(ATTR_FORMAT_TV | ATTR_KEY_LENGTH).to_be_bytes());
            attributes.extend_from_slice(&bits.to_be_bytes());
        }
        transforms.push(if is_last { 0 } else { 3 });
        transforms.push(0);
        transforms.extend_from_slice(&((8 + attributes.len()) as u16).to_be_bytes());
        transforms.push(transform.kind);
        transforms.push(0);
        transforms.extend_from_slice(&transform.id.to_be_bytes());
        transforms.extend_from_slice(&attributes);
    }
    let mut out = Vec::new();
    out.push(0); // the last (only) proposal
    out.push(0);
    out.extend_from_slice(&((8 + proposal.spi.len() + transforms.len()) as u16).to_be_bytes());
    out.push(proposal.number);
    out.push(proposal.protocol);
    out.push(proposal.spi.len() as u8);
    out.push(proposal.transforms.len() as u8);
    out.extend_from_slice(&proposal.spi);
    out.extend_from_slice(&transforms);
    out
}

// --- Key Exchange, Nonce, Notify, ID, AUTH, Delete ---

pub fn parse_ke(body: &[u8]) -> WireResult<(u16, &[u8])> {
    let group = be16(body, 0)?;
    let data = body.get(4..).ok_or(WireError::Truncated)?;
    Ok((group, data))
}

pub fn build_ke(group: u16, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + data.len());
    out.extend_from_slice(&group.to_be_bytes());
    out.extend_from_slice(&[0, 0]);
    out.extend_from_slice(data);
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Notify<'a> {
    pub protocol: u8,
    pub kind: u16,
    pub spi: &'a [u8],
    pub data: &'a [u8],
}

pub fn parse_notify(body: &[u8]) -> WireResult<Notify<'_>> {
    let protocol = byte(body, 0)?;
    let spi_size = byte(body, 1)? as usize;
    let kind = be16(body, 2)?;
    let spi = body.get(4..4 + spi_size).ok_or(WireError::Truncated)?;
    let data = body.get(4 + spi_size..).ok_or(WireError::Truncated)?;
    Ok(Notify {
        protocol,
        kind,
        spi,
        data,
    })
}

pub fn build_notify(kind: u16, data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(4 + data.len());
    out.push(0); // protocol: none (about the IKE SA itself)
    out.push(0); // no SPI
    out.extend_from_slice(&kind.to_be_bytes());
    out.extend_from_slice(data);
    out
}

/// The body of an IDi/IDr payload is "ID Type | RESERVED(3) | data". AUTH covers that whole body.
pub fn parse_id(body: &[u8]) -> WireResult<(u8, &[u8])> {
    let id_type = byte(body, 0)?;
    let data = body.get(4..).ok_or(WireError::Truncated)?;
    Ok((id_type, data))
}

pub fn build_id(id_type: u8, data: &[u8]) -> Vec<u8> {
    let mut out = vec![id_type, 0, 0, 0];
    out.extend_from_slice(data);
    out
}

pub fn parse_auth(body: &[u8]) -> WireResult<(u8, &[u8])> {
    let method = byte(body, 0)?;
    let data = body.get(4..).ok_or(WireError::Truncated)?;
    Ok((method, data))
}

pub fn build_auth(method: u8, data: &[u8]) -> Vec<u8> {
    let mut out = vec![method, 0, 0, 0];
    out.extend_from_slice(data);
    out
}

/// A Delete payload: the protocol and the SPIs (8 bytes for IKE, which then lists none; 4 for ESP).
pub fn parse_delete(body: &[u8]) -> WireResult<(u8, Vec<Vec<u8>>)> {
    let protocol = byte(body, 0)?;
    let spi_size = byte(body, 1)? as usize;
    let count = be16(body, 2)? as usize;
    let spis = body.get(4..).ok_or(WireError::Truncated)?;
    if spi_size == 0 {
        return if count == 0 && spis.is_empty() {
            Ok((protocol, Vec::new()))
        } else {
            Err(WireError::Malformed)
        };
    }
    if spis.len() != spi_size * count {
        return Err(WireError::BadLength);
    }
    Ok((protocol, spis.chunks(spi_size).map(<[u8]>::to_vec).collect()))
}

pub fn build_delete(protocol: u8, spis: &[[u8; 4]]) -> Vec<u8> {
    let mut out = vec![protocol, if spis.is_empty() { 0 } else { 4 }];
    out.extend_from_slice(&(spis.len() as u16).to_be_bytes());
    for spi in spis {
        out.extend_from_slice(spi);
    }
    out
}

// --- Traffic selectors (RFC 7296 §3.13) ---

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ipv4Selector {
    pub protocol: u8,
    pub start_port: u16,
    pub end_port: u16,
    pub start: Ipv4Addr,
    pub end: Ipv4Addr,
}

impl Ipv4Selector {
    pub fn contains(&self, ip: Ipv4Addr) -> bool {
        self.start <= ip && ip <= self.end
    }
}

/// The IPv4 selectors of a TS payload. IPv6 and unknown selector types are skipped, not rejected:
/// iOS always asks for both families and we only carry IPv4.
pub fn parse_ts(body: &[u8]) -> WireResult<Vec<Ipv4Selector>> {
    let count = byte(body, 0)? as usize;
    let mut selectors = Vec::new();
    let mut offset = 4usize;
    for _ in 0..count {
        let rest = body.get(offset..).ok_or(WireError::Truncated)?;
        let ts_type = byte(rest, 0)?;
        let length = be16(rest, 2)? as usize;
        if length < 8 || length > rest.len() {
            return Err(WireError::BadLength);
        }
        if ts_type == TS_IPV4_ADDR_RANGE {
            if length != 16 {
                return Err(WireError::BadLength);
            }
            let start = rest.get(8..12).ok_or(WireError::Truncated)?;
            let end = rest.get(12..16).ok_or(WireError::Truncated)?;
            selectors.push(Ipv4Selector {
                protocol: byte(rest, 1)?,
                start_port: be16(rest, 4)?,
                end_port: be16(rest, 6)?,
                start: Ipv4Addr::new(start[0], start[1], start[2], start[3]),
                end: Ipv4Addr::new(end[0], end[1], end[2], end[3]),
            });
        }
        offset += length;
    }
    if offset != body.len() {
        return Err(WireError::TrailingData);
    }
    Ok(selectors)
}

pub fn build_ts(selectors: &[Ipv4Selector]) -> Vec<u8> {
    let mut out = vec![selectors.len() as u8, 0, 0, 0];
    for selector in selectors {
        out.push(TS_IPV4_ADDR_RANGE);
        out.push(selector.protocol);
        out.extend_from_slice(&16u16.to_be_bytes());
        out.extend_from_slice(&selector.start_port.to_be_bytes());
        out.extend_from_slice(&selector.end_port.to_be_bytes());
        out.extend_from_slice(&selector.start.octets());
        out.extend_from_slice(&selector.end.octets());
    }
    out
}

// --- Configuration payload (RFC 7296 §3.15) ---

/// The CFG type and the attribute types it lists (the values of a request are ignored).
pub fn parse_cp(body: &[u8]) -> WireResult<(u8, Vec<u16>)> {
    let cfg_type = byte(body, 0)?;
    let mut attributes = Vec::new();
    let mut rest = body.get(4..).ok_or(WireError::Truncated)?;
    while !rest.is_empty() {
        let attribute_type = be16(rest, 0)? & 0x7fff;
        let length = be16(rest, 2)? as usize;
        rest = rest.get(4 + length..).ok_or(WireError::Truncated)?;
        attributes.push(attribute_type);
        if attributes.len() > MAX_PAYLOADS {
            return Err(WireError::TooManyPayloads);
        }
    }
    Ok((cfg_type, attributes))
}

pub fn build_cp(cfg_type: u8, attributes: &[(u16, Vec<u8>)]) -> Vec<u8> {
    let mut out = vec![cfg_type, 0, 0, 0];
    for (attribute_type, value) in attributes {
        out.extend_from_slice(&(attribute_type & 0x7fff).to_be_bytes());
        out.extend_from_slice(&(value.len() as u16).to_be_bytes());
        out.extend_from_slice(value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_proposal() -> Proposal {
        Proposal {
            number: 1,
            protocol: PROTO_ESP,
            spi: vec![0xde, 0xad, 0xbe, 0xef],
            transforms: vec![
                Transform {
                    kind: TT_ENCR,
                    id: ENCR_AES_GCM_16,
                    key_length: Some(256),
                    unknown_attribute: false,
                },
                Transform {
                    kind: TT_ESN,
                    id: ESN_NONE,
                    key_length: None,
                    unknown_attribute: false,
                },
            ],
        }
    }

    #[test]
    fn header_round_trip() {
        let header = Header {
            spi_i: 0x0102030405060708,
            spi_r: 0x1112131415161718,
            next_payload: PL_NONE,
            exchange: IKE_AUTH,
            flags: FLAG_INITIATOR,
            message_id: 7,
            length: 0,
        };
        let message = build_message(header, ChainBuilder::new());
        assert_eq!(message.len(), HEADER_LEN);
        let parsed = Header::parse(&message).expect("header parses");
        assert_eq!(parsed.spi_i, header.spi_i);
        assert_eq!(parsed.spi_r, header.spi_r);
        assert_eq!(parsed.exchange, IKE_AUTH);
        assert_eq!(parsed.message_id, 7);
        assert_eq!(parsed.length as usize, HEADER_LEN);
        assert!(parsed.is_from_initiator() && !parsed.is_response());
    }

    #[test]
    fn header_rejects_wrong_version_and_length() {
        let mut message = build_message(
            Header {
                spi_i: 1,
                spi_r: 0,
                next_payload: 0,
                exchange: IKE_SA_INIT,
                flags: FLAG_INITIATOR,
                message_id: 0,
                length: 0,
            },
            ChainBuilder::new(),
        );
        let mut longer = message.clone();
        longer.push(0);
        assert_eq!(Header::parse(&longer), Err(WireError::BadLength));
        message[17] = 0x10;
        assert_eq!(Header::parse(&message), Err(WireError::BadVersion));
    }

    #[test]
    fn chain_round_trip_and_sk_ends_the_walk() {
        let mut chain = ChainBuilder::new();
        chain.push(PL_NONCE, &[7; 32]);
        chain.push(PL_NOTIFY, &build_notify(N_NAT_DETECTION_SOURCE_IP, &[1; 20]));
        chain.push(PL_SK, &[9; 40]);
        let (first, bytes) = chain.finish();
        assert_eq!(first, PL_NONCE);
        let payloads = parse_chain(first, &bytes).expect("chain parses");
        assert_eq!(payloads.len(), 3);
        assert_eq!(payloads[0].body, &[7; 32]);
        assert_eq!(payloads[1].kind, PL_NOTIFY);
        let notify = parse_notify(payloads[1].body).expect("notify parses");
        assert_eq!(notify.kind, N_NAT_DETECTION_SOURCE_IP);
        assert_eq!(notify.data, &[1; 20]);
        assert_eq!(payloads[2].kind, PL_SK);
        assert_eq!(payloads[2].offset, 36 + 28);
    }

    #[test]
    fn sa_round_trip() {
        let proposal = sample_proposal();
        let parsed = parse_sa(&build_sa(&proposal)).expect("SA parses");
        assert_eq!(parsed, vec![proposal]);
    }

    #[test]
    fn unknown_attributes_mark_the_transform() {
        let mut body = build_sa(&sample_proposal());
        // Turn the first transform's key length attribute (type 14) into an unknown type 15.
        let position = body
            .windows(2)
            .position(|w| w == (ATTR_FORMAT_TV | ATTR_KEY_LENGTH).to_be_bytes())
            .expect("attribute present");
        body[position + 1] = 0x0f;
        let parsed = parse_sa(&body).expect("SA parses");
        assert!(parsed[0].transforms[0].unknown_attribute);
    }

    #[test]
    fn ts_and_cp_round_trip() {
        let selector = Ipv4Selector {
            protocol: 0,
            start_port: 0,
            end_port: 65535,
            start: Ipv4Addr::new(10, 73, 0, 2),
            end: Ipv4Addr::new(10, 73, 0, 2),
        };
        assert_eq!(parse_ts(&build_ts(&[selector])).expect("TS parses"), vec![selector]);
        let cp = build_cp(CFG_REPLY, &[(INTERNAL_IP4_ADDRESS, vec![10, 73, 0, 2]), (INTERNAL_IP4_DNS, vec![10, 73, 0, 53])]);
        assert_eq!(parse_cp(&cp).expect("CP parses"), (CFG_REPLY, vec![INTERNAL_IP4_ADDRESS, INTERNAL_IP4_DNS]));
    }

    #[test]
    fn delete_round_trip() {
        let body = build_delete(PROTO_ESP, &[[1, 2, 3, 4], [5, 6, 7, 8]]);
        assert_eq!(parse_delete(&body).expect("delete parses"), (PROTO_ESP, vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8]]));
        assert_eq!(parse_delete(&build_delete(PROTO_IKE, &[])).expect("delete parses"), (PROTO_IKE, vec![]));
    }

    /// Every truncation and a sweep of single-byte corruptions must give an error or a value, never
    /// a panic.
    #[test]
    fn garbage_never_panics() {
        let mut chain = ChainBuilder::new();
        chain.push(PL_SA, &build_sa(&sample_proposal()));
        chain.push(PL_KE, &build_ke(DH_ECP_256, &[4; 64]));
        chain.push(PL_TSI, &build_ts(&[Ipv4Selector {
            protocol: 0,
            start_port: 0,
            end_port: 65535,
            start: Ipv4Addr::UNSPECIFIED,
            end: Ipv4Addr::BROADCAST,
        }]));
        chain.push(PL_CP, &build_cp(CFG_REQUEST, &[(INTERNAL_IP4_ADDRESS, vec![])]));
        let (first, bytes) = chain.finish();
        let walk = |data: &[u8]| {
            if let Ok(payloads) = parse_chain(first, data) {
                for payload in payloads {
                    let _ = parse_sa(payload.body);
                    let _ = parse_ke(payload.body);
                    let _ = parse_ts(payload.body);
                    let _ = parse_cp(payload.body);
                    let _ = parse_notify(payload.body);
                    let _ = parse_delete(payload.body);
                    let _ = parse_id(payload.body);
                    let _ = parse_auth(payload.body);
                }
            }
        };
        for cut in 0..bytes.len() {
            walk(&bytes[..cut]);
        }
        for at in 0..bytes.len() {
            for value in [0x00, 0x01, 0x7f, 0x80, 0xff] {
                let mut corrupted = bytes.clone();
                corrupted[at] = value;
                walk(&corrupted);
            }
        }
        let mut state = 0x2545F4914F6CDD1Du64;
        for _ in 0..2000 {
            let len = (state % 200) as usize;
            let mut random = Vec::with_capacity(len);
            for _ in 0..len {
                state ^= state << 13;
                state ^= state >> 7;
                state ^= state << 17;
                random.push(state as u8);
            }
            walk(&random);
            let _ = Header::parse(&random);
            let _ = parse_sa(&random);
            let _ = parse_ts(&random);
        }
    }
}
