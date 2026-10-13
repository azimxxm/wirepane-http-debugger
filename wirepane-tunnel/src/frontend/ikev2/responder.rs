//! The IKEv2 responder, sans-IO: datagrams in, datagrams and decrypted IPv4 packets out. The IO
//! side (UDP 500 and 4500) only moves bytes; every protocol decision is made here, so tests can
//! drive a whole handshake without sockets. See `docs/ikev2.md` for the design.

use std::collections::HashMap;
use std::net::{Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

use smoltcp::wire::{IpProtocol, Ipv4Packet, TcpPacket, UdpPacket};

use super::crypto::{
    GCM_ICV_LEN, GCM_IV_LEN, GcmKey, IkeKeys, child_key_material, dh_agree, dh_supported, gcm_key_bytes,
    ike_key_material, nat_hash, psk_auth, psk_auth_matches, random_bytes, signed_octets,
};
use super::esp::EspSa;
use super::wire::*;

/// A half-open SA (IKE_SA_INIT done, no IKE_AUTH yet) is forgotten after this long.
pub const HALF_OPEN_TIMEOUT: Duration = Duration::from_secs(30);
/// An established SA with no authenticated packet for this long is gone; iOS's dead peer detection
/// runs every 10 minutes at `Medium`.
pub const IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
pub const DEFAULT_MAX_HALF_OPEN: usize = 64;
const MIN_NONCE_LEN: usize = 16;
const MAX_NONCE_LEN: usize = 256;
const OUR_NONCE_LEN: usize = 32;
/// IKE messages on UDP 4500 start with four zero bytes, so they can't be mistaken for ESP (RFC 3948).
const NON_ESP_MARKER: [u8; 4] = [0; 4];
const NAT_KEEPALIVE: [u8; 1] = [0xff];
/// SPIs 1 to 255 are reserved (RFC 4303 §2.1).
const FIRST_ESP_SPI: u32 = 256;

/// Which of the two UDP ports a datagram came in on or goes out of.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Port {
    /// UDP 500, only for IKE_SA_INIT in practice.
    Ike,
    /// UDP 4500: IKE with the non-ESP marker, and ESP.
    NatT,
}

/// What the responder needs to know about one phone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSecret {
    pub peer: String,
    pub psk: Vec<u8>,
    pub tunnel_ip: Ipv4Addr,
}

/// Finds a phone by the identity it sent in IDi.
pub trait Credentials {
    fn lookup(&self, id_type: u8, id: &[u8]) -> Option<PeerSecret>;
}

pub struct ResponderConfig {
    /// Our identity (IDr, ID_FQDN), the profile's `RemoteIdentifier`.
    pub server_id: String,
    /// INTERNAL_IP4_DNS for every phone.
    pub dns: Ipv4Addr,
    pub max_half_open: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Output {
    /// Send these exact bytes (the non-ESP marker is already included where it belongs).
    Send { via: Port, to: SocketAddr, datagram: Vec<u8> },
    /// A decrypted IPv4 packet from a phone, checked like the WireGuard front-end's.
    Packet { peer: String, packet: Vec<u8> },
    /// A phone finished IKE_AUTH, or its address changed.
    Up { peer: String, endpoint: SocketAddr, tunnel_ip: Ipv4Addr },
    /// A phone's tunnel ended (Delete, timeout, removed, or replaced by a new connection).
    Down { peer: String },
}

struct IkeSa {
    spi_i: u64,
    spi_r: u64,
    ni: Vec<u8>,
    nr: Vec<u8>,
    keys: IkeKeys,
    init_request: Vec<u8>,
    init_response: Vec<u8>,
    /// The Message ID the phone's next request must carry.
    next_message_id: u32,
    /// The answer to the last request, sent again if that request is retransmitted.
    last_response: Option<(u32, Vec<u8>)>,
    endpoint: SocketAddr,
    peer: Option<PeerSecret>,
    /// Our inbound SPIs of its Child SAs: one, or two for a moment while one is rekeyed.
    children: Vec<u32>,
    created: Instant,
    last_seen: Instant,
    iv_counter: u64,
}

struct EspEntry {
    sa: EspSa,
    ike_spi_r: u64,
    peer: String,
    tunnel_ip: Ipv4Addr,
    endpoint: SocketAddr,
}

pub struct Responder<C: Credentials> {
    config: ResponderConfig,
    credentials: C,
    /// Keys the stateless cookies (RFC 7296 §2.6) asked for once half-open SAs pile up.
    cookie_secret: [u8; 32],
    sas: HashMap<u64, IkeSa>,
    /// (the phone's SPI, its address) to our SPI, so a retransmitted IKE_SA_INIT gets the same answer.
    init_index: HashMap<(u64, SocketAddr), u64>,
    esp: HashMap<u32, EspEntry>,
    esp_by_ip: HashMap<Ipv4Addr, u32>,
}

struct IkeChoice {
    proposal: Proposal,
    dh: u16,
    aes_key_bytes: usize,
}

struct EspChoice {
    proposal: Proposal,
    peer_spi: u32,
    aes_key_bytes: usize,
}

/// A transform list holds alternatives per type; this picks the first usable one of a type.
fn first_usable(proposal: &Proposal, kind: u8, usable: impl Fn(&Transform) -> bool) -> Option<Transform> {
    proposal
        .transforms
        .iter()
        .find(|t| t.kind == kind && !t.unknown_attribute && usable(t))
        .copied()
}

/// An AEAD proposal may list no integrity algorithm, or NONE among them (RFC 5282 §8). Returns
/// None when the proposal is unusable, Some(transform to echo) otherwise.
fn integrity_for_aead(proposal: &Proposal) -> Option<Option<Transform>> {
    let offered = proposal.transforms.iter().any(|t| t.kind == TT_INTEG);
    if !offered {
        return Some(None);
    }
    first_usable(proposal, TT_INTEG, |t| t.id == INTEG_NONE).map(Some)
}

fn gcm(transform: &Transform) -> bool {
    transform.id == ENCR_AES_GCM_16 && transform.key_length.and_then(gcm_key_bytes).is_some()
}

/// TSi narrows to the phone's own address; TSr is whatever IPv4 range the phone asked for.
fn narrow_selectors(tunnel_ip: Ipv4Addr, tsi: Option<&[u8]>, tsr: Option<&[u8]>) -> Result<(Ipv4Selector, Ipv4Selector), u16> {
    let their_tsi = parse_ts(tsi.ok_or(N_TS_UNACCEPTABLE)?).map_err(|_| N_INVALID_SYNTAX)?;
    let their_tsr = parse_ts(tsr.ok_or(N_TS_UNACCEPTABLE)?).map_err(|_| N_INVALID_SYNTAX)?;
    let initiator = their_tsi
        .iter()
        .find(|selector| selector.contains(tunnel_ip))
        .ok_or(N_TS_UNACCEPTABLE)?;
    let ours_i = Ipv4Selector {
        start: tunnel_ip,
        end: tunnel_ip,
        ..*initiator
    };
    let ours_r = *their_tsr.first().ok_or(N_TS_UNACCEPTABLE)?;
    Ok((ours_i, ours_r))
}

fn choose_ike_proposal(proposals: &[Proposal]) -> Option<IkeChoice> {
    for proposal in proposals {
        if proposal.protocol != PROTO_IKE || !proposal.spi.is_empty() {
            continue;
        }
        let Some(encr) = first_usable(proposal, TT_ENCR, gcm) else { continue };
        let Some(prf) = first_usable(proposal, TT_PRF, |t| t.id == PRF_HMAC_SHA2_256) else { continue };
        let Some(dh) = first_usable(proposal, TT_DH, |t| dh_supported(t.id)) else { continue };
        let Some(integrity) = integrity_for_aead(proposal) else { continue };
        let Some(aes_key_bytes) = encr.key_length.and_then(gcm_key_bytes) else { continue };
        let mut transforms = vec![encr, prf];
        transforms.extend(integrity);
        transforms.push(dh);
        return Some(IkeChoice {
            proposal: Proposal {
                number: proposal.number,
                protocol: PROTO_IKE,
                spi: Vec::new(),
                transforms,
            },
            dh: dh.id,
            aes_key_bytes,
        });
    }
    None
}

fn choose_esp_proposal(proposals: &[Proposal]) -> Option<EspChoice> {
    for proposal in proposals {
        if proposal.protocol != PROTO_ESP || proposal.spi.len() != 4 {
            continue;
        }
        let Some(encr) = first_usable(proposal, TT_ENCR, gcm) else { continue };
        let Some(integrity) = integrity_for_aead(proposal) else { continue };
        // Extended sequence numbers aren't implemented: "no ESN" has to be on offer (or ESN absent).
        let esn_offered = proposal.transforms.iter().any(|t| t.kind == TT_ESN);
        let esn = first_usable(proposal, TT_ESN, |t| t.id == ESN_NONE);
        if esn_offered && esn.is_none() {
            continue;
        }
        let Some(aes_key_bytes) = encr.key_length.and_then(gcm_key_bytes) else { continue };
        let spi = u32::from_be_bytes([proposal.spi[0], proposal.spi[1], proposal.spi[2], proposal.spi[3]]);
        if spi == 0 {
            continue;
        }
        // A Child SA made in IKE_AUTH never has its own DH (no KE payload there), so DH is left out.
        let mut transforms = vec![encr];
        transforms.extend(integrity);
        transforms.extend(esn);
        return Some(EspChoice {
            proposal: Proposal {
                number: proposal.number,
                protocol: PROTO_ESP,
                spi: Vec::new(),
                transforms,
            },
            peer_spi: spi,
            aes_key_bytes,
        });
    }
    None
}

/// What a cookie covers: Ni | IPi | port | SPIi (RFC 7296 §2.6).
fn cookie_input(nonce: &[u8], from: SocketAddr, spi_i: u64) -> Vec<u8> {
    let mut input = nonce.to_vec();
    match from.ip() {
        std::net::IpAddr::V4(v4) => input.extend_from_slice(&v4.octets()),
        std::net::IpAddr::V6(v6) => input.extend_from_slice(&v6.octets()),
    }
    input.extend_from_slice(&from.port().to_be_bytes());
    input.extend_from_slice(&spi_i.to_be_bytes());
    input
}

/// The cookie for one IKE_SA_INIT: HMAC-SHA-256(secret, Ni | IPi | port | SPIi). Nothing is stored;
/// the retried request carries it back.
fn make_cookie(secret: &[u8], nonce: &[u8], from: SocketAddr, spi_i: u64) -> [u8; 32] {
    super::crypto::prf(secret, &[&cookie_input(nonce, from, spi_i)])
}

fn cookie_matches(secret: &[u8], nonce: &[u8], from: SocketAddr, spi_i: u64, cookie: &[u8]) -> bool {
    // ring's HMAC verification compares in constant time.
    let key = ring::hmac::Key::new(ring::hmac::HMAC_SHA256, secret);
    ring::hmac::verify(&key, &cookie_input(nonce, from, spi_i), cookie).is_ok()
}

fn random_u64() -> Option<u64> {
    let mut bytes = [0u8; 8];
    random_bytes(&mut bytes)?;
    Some(u64::from_be_bytes(bytes))
}

fn random_u32() -> Option<u32> {
    let mut bytes = [0u8; 4];
    random_bytes(&mut bytes)?;
    Some(u32::from_be_bytes(bytes))
}

/// What reaches the network layer must pass the same checks as on the WireGuard side: the
/// phone's own source address, no fragments, TCP/UDP with real ports, or ICMP.
fn accept_inbound(peer_ip: Ipv4Addr, plain: &[u8]) -> Option<Vec<u8>> {
    let packet = Ipv4Packet::new_checked(plain).ok()?;
    if packet.src_addr() != peer_ip {
        log::debug!("ikev2: dropping a packet from {peer_ip} that claims to be from {}", packet.src_addr());
        return None;
    }
    if packet.more_frags() || packet.frag_offset() != 0 {
        return None;
    }
    match packet.next_header() {
        IpProtocol::Tcp => {
            let tcp = TcpPacket::new_checked(packet.payload()).ok()?;
            if tcp.src_port() == 0 || tcp.dst_port() == 0 {
                return None;
            }
        }
        IpProtocol::Udp => {
            let udp = UdpPacket::new_checked(packet.payload()).ok()?;
            if udp.src_port() == 0 || udp.dst_port() == 0 {
                return None;
            }
        }
        IpProtocol::Icmp => {}
        _ => return None,
    }
    let total = usize::from(packet.total_len());
    plain.get(..total).map(<[u8]>::to_vec)
}

/// Decrypts the SK payload of a message. Returns the type of the first inner payload and the inner
/// chain. After IKE_SA_INIT every message we accept has exactly one payload, SK.
fn open_sk(key: &GcmKey, header: &Header, message: &[u8]) -> Option<(u8, Vec<u8>)> {
    let chain = message.get(HEADER_LEN..)?;
    let payloads = parse_chain(header.next_payload, chain).ok()?;
    let [sk] = payloads.as_slice() else { return None };
    if sk.kind != PL_SK {
        return None;
    }
    let aad = message.get(..HEADER_LEN + sk.offset + GENERIC_HEADER_LEN)?;
    if sk.body.len() < GCM_IV_LEN + 1 + GCM_ICV_LEN {
        return None;
    }
    let iv: [u8; GCM_IV_LEN] = sk.body.get(..GCM_IV_LEN)?.try_into().ok()?;
    let mut sealed = sk.body.get(GCM_IV_LEN..)?.to_vec();
    let plain = key.open(iv, aad, &mut sealed)?;
    let pad_len = usize::from(*plain.last()?);
    let inner_len = plain.len().checked_sub(1 + pad_len)?;
    Some((sk.next, plain.get(..inner_len)?.to_vec()))
}

/// Builds a message whose only payload is SK around `chain` (RFC 5282: IV, ciphertext, ICV).
fn seal_sk(key: &GcmKey, iv_counter: &mut u64, mut header: Header, chain: ChainBuilder) -> Option<Vec<u8>> {
    let (first_inner, mut plain) = chain.finish();
    // Pad length 0: GCM needs no block alignment (RFC 5282 §3).
    plain.push(0);
    let sk_len = GENERIC_HEADER_LEN + GCM_IV_LEN + plain.len() + GCM_ICV_LEN;
    let sk_len_field = u16::try_from(sk_len).ok()?;
    header.next_payload = PL_SK;
    header.length = u32::try_from(HEADER_LEN + sk_len).ok()?;
    let mut message = Vec::with_capacity(HEADER_LEN + sk_len);
    header.write(&mut message);
    message.push(first_inner);
    message.push(0);
    message.extend_from_slice(&sk_len_field.to_be_bytes());
    // A counter, so an IV never repeats under one key.
    *iv_counter = iv_counter.checked_add(1)?;
    let iv = iv_counter.to_be_bytes();
    let aad = message.clone();
    key.seal(iv, &aad, &mut plain)?;
    message.extend_from_slice(&iv);
    message.extend_from_slice(&plain);
    Some(message)
}

fn wrap(via: Port, to: SocketAddr, message: &[u8]) -> Output {
    let datagram = match via {
        Port::Ike => message.to_vec(),
        Port::NatT => [&NON_ESP_MARKER[..], message].concat(),
    };
    Output::Send { via, to, datagram }
}

fn response_header(request: &Header, spi_r: u64) -> Header {
    Header {
        spi_i: request.spi_i,
        spi_r,
        next_payload: PL_NONE,
        exchange: request.exchange,
        flags: FLAG_RESPONSE,
        message_id: request.message_id,
        length: 0,
    }
}

impl<C: Credentials> Responder<C> {
    pub fn new(config: ResponderConfig, credentials: C) -> Self {
        let mut cookie_secret = [0u8; 32];
        // Without randomness no key exchange works either, so a zero secret changes nothing.
        let _ = random_bytes(&mut cookie_secret);
        Self {
            config,
            credentials,
            cookie_secret,
            sas: HashMap::new(),
            init_index: HashMap::new(),
            esp: HashMap::new(),
            esp_by_ip: HashMap::new(),
        }
    }

    pub fn credentials_mut(&mut self) -> &mut C {
        &mut self.credentials
    }

    /// One datagram from a phone.
    pub fn handle_datagram(&mut self, via: Port, data: &[u8], from: SocketAddr, now: Instant) -> Vec<Output> {
        match via {
            Port::Ike => self.handle_ike(via, data, from, now),
            Port::NatT => {
                if data == NAT_KEEPALIVE {
                    return Vec::new();
                }
                match data.get(..4) {
                    Some(marker) if marker == NON_ESP_MARKER => match data.get(4..) {
                        Some(message) => self.handle_ike(via, message, from, now),
                        None => Vec::new(),
                    },
                    Some(_) => self.handle_esp(data, from, now),
                    None => Vec::new(),
                }
            }
        }
    }

    /// Encrypts one IPv4 packet for the phone that owns its destination address. None when no
    /// phone owns it (or its SA can't send any more).
    pub fn encapsulate(&mut self, packet: &[u8]) -> Option<Output> {
        let ip = Ipv4Packet::new_checked(packet).ok()?;
        let spi = *self.esp_by_ip.get(&ip.dst_addr())?;
        let entry = self.esp.get_mut(&spi)?;
        let datagram = entry.sa.seal(packet).ok()?;
        Some(Output::Send {
            via: Port::NatT,
            to: entry.endpoint,
            datagram,
        })
    }

    /// The phone that owns a tunnel address, and its current address, while its tunnel is up.
    pub fn peer_for(&self, tunnel_ip: Ipv4Addr) -> Option<(String, SocketAddr)> {
        let entry = self.esp.get(self.esp_by_ip.get(&tunnel_ip)?)?;
        Some((entry.peer.clone(), entry.endpoint))
    }

    /// Ends every SA of a phone at once (the peer was removed in Wirepane).
    pub fn remove_peer(&mut self, peer: &str) -> Vec<Output> {
        let spis: Vec<u64> = self
            .sas
            .iter()
            .filter(|(_, sa)| sa.peer.as_ref().is_some_and(|p| p.peer == peer))
            .map(|(spi, _)| *spi)
            .collect();
        spis.into_iter().filter_map(|spi| self.drop_sa(spi)).collect()
    }

    /// Expires half-open SAs and SAs that went silent.
    pub fn tick(&mut self, now: Instant) -> Vec<Output> {
        let expired: Vec<u64> = self
            .sas
            .iter()
            .filter(|(_, sa)| match sa.peer {
                None => now.saturating_duration_since(sa.created) > HALF_OPEN_TIMEOUT,
                Some(_) => now.saturating_duration_since(sa.last_seen) > IDLE_TIMEOUT,
            })
            .map(|(spi, _)| *spi)
            .collect();
        expired.into_iter().filter_map(|spi| self.drop_sa(spi)).collect()
    }

    pub fn sa_count(&self) -> usize {
        self.sas.len()
    }

    /// Removes an IKE SA and its Child SA. Returns a Down event if it had an authenticated phone.
    fn drop_sa(&mut self, spi_r: u64) -> Option<Output> {
        let sa = self.sas.remove(&spi_r)?;
        self.init_index.retain(|_, ours| *ours != spi_r);
        for child in sa.children {
            self.drop_child(child);
        }
        sa.peer.map(|peer| Output::Down { peer: peer.peer })
    }

    fn drop_child(&mut self, spi_in: u32) {
        if let Some(entry) = self.esp.remove(&spi_in)
            && self.esp_by_ip.get(&entry.tunnel_ip) == Some(&spi_in)
        {
            self.esp_by_ip.remove(&entry.tunnel_ip);
        }
    }

    fn handle_ike(&mut self, via: Port, message: &[u8], from: SocketAddr, now: Instant) -> Vec<Output> {
        let Ok(header) = Header::parse(message) else {
            return Vec::new();
        };
        // We never send requests, so everything for us is a request from the phone, which is
        // always the original initiator.
        if header.is_response() || !header.is_from_initiator() {
            return Vec::new();
        }
        match header.exchange {
            IKE_SA_INIT => self.on_sa_init(via, &header, message, from, now),
            IKE_AUTH | INFORMATIONAL | CREATE_CHILD_SA => self.on_encrypted(via, &header, message, from, now),
            _ => Vec::new(),
        }
    }

    fn init_error(via: Port, to: SocketAddr, request: &Header, code: u16, data: &[u8]) -> Vec<Output> {
        let mut chain = ChainBuilder::new();
        chain.push(PL_NOTIFY, &build_notify(code, data));
        // An IKE_SA_INIT that is turned down creates no SA, so our SPI stays zero.
        vec![wrap(via, to, &build_message(response_header(request, 0), chain))]
    }

    fn on_sa_init(&mut self, via: Port, header: &Header, message: &[u8], from: SocketAddr, now: Instant) -> Vec<Output> {
        if header.spi_r != 0 || header.message_id != 0 || header.spi_i == 0 {
            return Vec::new();
        }
        if let Some(spi_r) = self.init_index.get(&(header.spi_i, from)) {
            return match self.sas.get(spi_r) {
                Some(sa) if sa.init_request == message => vec![wrap(via, from, &sa.init_response)],
                _ => Vec::new(),
            };
        }
        let Some(chain) = message.get(HEADER_LEN..) else { return Vec::new() };
        let Ok(payloads) = parse_chain(header.next_payload, chain) else {
            return Self::init_error(via, from, header, N_INVALID_SYNTAX, &[]);
        };
        let half_open: Vec<(u64, Instant)> = self
            .sas
            .iter()
            .filter(|(_, sa)| sa.peer.is_none())
            .map(|(spi, sa)| (*spi, sa.created))
            .collect();
        // Under load a phone has to prove it receives at its address before any DH work or
        // state: it repeats IKE_SA_INIT with the cookie we send (RFC 7296 §2.6). A forged source
        // address never sees the cookie.
        if half_open.len() >= (self.config.max_half_open / 2).max(1) {
            let nonce = payloads.iter().find(|p| p.kind == PL_NONCE).map(|p| p.body).unwrap_or(&[]);
            let sent = payloads
                .iter()
                .filter(|p| p.kind == PL_NOTIFY)
                .filter_map(|p| parse_notify(p.body).ok())
                .find(|notify| notify.kind == N_COOKIE)
                .map(|notify| notify.data);
            let valid = sent.is_some_and(|cookie| cookie_matches(&self.cookie_secret, nonce, from, header.spi_i, cookie));
            if !valid {
                let cookie = make_cookie(&self.cookie_secret, nonce, from, header.spi_i);
                return Self::init_error(via, from, header, N_COOKIE, &cookie);
            }
        }
        if half_open.len() >= self.config.max_half_open {
            // The oldest half-open SA makes room. Cookies already stop floods from forged
            // addresses; this keeps a flood from a real one from locking phones out for the 30 s a
            // half-open SA would otherwise hold its slot (a phone sends IKE_AUTH milliseconds later).
            log::debug!("ikev2: too many half-open SAs, dropping the oldest for {from}");
            if let Some((oldest, _)) = half_open.iter().min_by_key(|(_, created)| *created) {
                let _ = self.drop_sa(*oldest);
            }
        }

        let (mut sa_body, mut ke_body, mut nonce) = (None, None, None);
        for payload in &payloads {
            match payload.kind {
                PL_SA => sa_body = Some(payload.body),
                PL_KE => ke_body = Some(payload.body),
                PL_NONCE => nonce = Some(payload.body),
                PL_NOTIFY | PL_VENDOR | PL_CERTREQ => {}
                other if payload.critical => {
                    return Self::init_error(via, from, header, N_UNSUPPORTED_CRITICAL_PAYLOAD, &[other]);
                }
                _ => {}
            }
        }
        let (Some(sa_body), Some(ke_body), Some(nonce)) = (sa_body, ke_body, nonce) else {
            return Self::init_error(via, from, header, N_INVALID_SYNTAX, &[]);
        };
        let Ok(proposals) = parse_sa(sa_body) else {
            return Self::init_error(via, from, header, N_INVALID_SYNTAX, &[]);
        };
        let Some(choice) = choose_ike_proposal(&proposals) else {
            log::info!("ikev2: no acceptable IKE proposal from {from}: {proposals:?}");
            return Self::init_error(via, from, header, N_NO_PROPOSAL_CHOSEN, &[]);
        };
        let Ok((group, ke_data)) = parse_ke(ke_body) else {
            return Self::init_error(via, from, header, N_INVALID_SYNTAX, &[]);
        };
        if group != choice.dh {
            // The phone guessed another group; it retries with the one we name (RFC 7296 §1.2).
            return Self::init_error(via, from, header, N_INVALID_KE_PAYLOAD, &choice.dh.to_be_bytes());
        }
        if !(MIN_NONCE_LEN..=MAX_NONCE_LEN).contains(&nonce.len()) {
            return Self::init_error(via, from, header, N_INVALID_SYNTAX, &[]);
        }
        let Some((our_ke, shared)) = dh_agree(group, ke_data) else {
            log::debug!("ikev2: invalid key exchange value from {from}");
            return Self::init_error(via, from, header, N_INVALID_SYNTAX, &[]);
        };
        let Some(spi_r) = self.new_ike_spi() else { return Vec::new() };
        let mut nr = vec![0u8; OUR_NONCE_LEN];
        let mut fake_source_hash = [0u8; 20];
        if random_bytes(&mut nr).is_none() || random_bytes(&mut fake_source_hash).is_none() {
            return Vec::new();
        }
        let Some(keys) = ike_key_material(nonce, &nr, &shared, header.spi_i, spi_r, choice.aes_key_bytes)
            .and_then(|material| material.into_keys())
        else {
            return Vec::new();
        };

        let mut response = ChainBuilder::new();
        response.push(PL_SA, &build_sa(&choice.proposal));
        response.push(PL_KE, &build_ke(group, &our_ke));
        response.push(PL_NONCE, &nr);
        // A source hash that can't match: the phone then believes we are behind a NAT and puts ESP
        // in UDP 4500, the only way a process without root can receive it (docs/ikev2.md §4).
        response.push(PL_NOTIFY, &build_notify(N_NAT_DETECTION_SOURCE_IP, &fake_source_hash));
        response.push(
            PL_NOTIFY,
            &build_notify(
                N_NAT_DETECTION_DESTINATION_IP,
                &nat_hash(header.spi_i, spi_r, from.ip(), from.port()),
            ),
        );
        let init_response = build_message(response_header(header, spi_r), response);

        self.sas.insert(
            spi_r,
            IkeSa {
                spi_i: header.spi_i,
                spi_r,
                ni: nonce.to_vec(),
                nr,
                keys,
                init_request: message.to_vec(),
                init_response: init_response.clone(),
                next_message_id: 1,
                last_response: None,
                endpoint: from,
                peer: None,
                children: Vec::new(),
                created: now,
                last_seen: now,
                iv_counter: 0,
            },
        );
        self.init_index.insert((header.spi_i, from), spi_r);
        vec![wrap(via, from, &init_response)]
    }

    fn new_ike_spi(&self) -> Option<u64> {
        (0..8).find_map(|_| random_u64().filter(|spi| *spi != 0 && !self.sas.contains_key(spi)))
    }

    fn new_esp_spi(&self) -> Option<u32> {
        (0..8).find_map(|_| random_u32().filter(|spi| *spi >= FIRST_ESP_SPI && !self.esp.contains_key(spi)))
    }

    fn on_encrypted(&mut self, via: Port, header: &Header, message: &[u8], from: SocketAddr, now: Instant) -> Vec<Output> {
        let Some(mut sa) = self.sas.remove(&header.spi_r) else {
            return Vec::new();
        };
        let outputs = self.on_encrypted_for(&mut sa, via, header, message, from, now);
        // A handler that ends the SA clears its peer and child and marks it by spi_r = 0.
        if sa.spi_r != 0 {
            self.sas.insert(header.spi_r, sa);
        } else {
            self.init_index.retain(|_, ours| *ours != header.spi_r);
        }
        outputs
    }

    fn on_encrypted_for(
        &mut self,
        sa: &mut IkeSa,
        via: Port,
        header: &Header,
        message: &[u8],
        from: SocketAddr,
        now: Instant,
    ) -> Vec<Output> {
        if sa.spi_i != header.spi_i {
            return Vec::new();
        }
        // The phone sent the same request again (our answer got lost): same answer, no new work.
        // Only an authenticated copy counts, so a forged one can't make us send anything.
        if let Some((id, response)) = &sa.last_response
            && *id == header.message_id
        {
            if open_sk(&sa.keys.sk_ei, header, message).is_some() {
                return vec![wrap(via, from, response)];
            }
            return Vec::new();
        }
        if header.message_id != sa.next_message_id {
            return Vec::new();
        }
        let authenticated = sa.peer.is_some();
        if (header.exchange == IKE_AUTH) == authenticated {
            // IKE_AUTH happens once, and nothing else may come before it.
            return Vec::new();
        }
        let Some((first, inner)) = open_sk(&sa.keys.sk_ei, header, message) else {
            log::debug!("ikev2: a message from {from} failed to decrypt");
            return Vec::new();
        };
        if header.exchange == IKE_AUTH && via == Port::Ike {
            // The phone didn't switch to UDP 4500, so its ESP would be raw IP protocol 50, which
            // a process without root can't receive (docs/ikev2.md §4).
            log::warn!("ikev2: {from} stayed on UDP 500 for IKE_AUTH; its ESP can't reach us");
        }
        // Only the phone that did IKE_SA_INIT has the keys, so its address can follow this message.
        sa.last_seen = now;
        sa.endpoint = from;
        let reply = match parse_chain(first, &inner) {
            Err(_) => {
                let mut chain = ChainBuilder::new();
                chain.push(PL_NOTIFY, &build_notify(N_INVALID_SYNTAX, &[]));
                Reply { chain, outputs: Vec::new(), end: header.exchange == IKE_AUTH }
            }
            Ok(payloads) => match header.exchange {
                IKE_AUTH => self.on_auth(sa, &payloads, from),
                INFORMATIONAL => self.on_informational(sa, &payloads),
                _ => self.on_create_child(sa, &payloads),
            },
        };

        let Some(response) = seal_sk(&sa.keys.sk_er, &mut sa.iv_counter, response_header(header, sa.spi_r), reply.chain)
        else {
            return Vec::new();
        };
        let mut outputs = vec![wrap(via, from, &response)];
        sa.last_response = Some((header.message_id, response));
        sa.next_message_id = sa.next_message_id.wrapping_add(1);
        outputs.extend(reply.outputs);
        if reply.end {
            for child in std::mem::take(&mut sa.children) {
                self.drop_child(child);
            }
            if let Some(peer) = sa.peer.take() {
                outputs.push(Output::Down { peer: peer.peer });
            }
            sa.spi_r = 0;
        }
        outputs
    }

    fn on_auth(&mut self, sa: &mut IkeSa, payloads: &[RawPayload<'_>], from: SocketAddr) -> Reply {
        let failure = |code: u16| {
            let mut chain = ChainBuilder::new();
            chain.push(PL_NOTIFY, &build_notify(code, &[]));
            Reply { chain, outputs: Vec::new(), end: true }
        };
        let (mut idi, mut idr, mut auth, mut child_sa, mut tsi, mut tsr, mut cp) = (None, None, None, None, None, None, None);
        for payload in payloads {
            match payload.kind {
                PL_IDI => idi = Some(payload.body),
                PL_IDR => idr = Some(payload.body),
                PL_AUTH => auth = Some(payload.body),
                PL_SA => child_sa = Some(payload.body),
                PL_TSI => tsi = Some(payload.body),
                PL_TSR => tsr = Some(payload.body),
                PL_CP => cp = Some(payload.body),
                PL_NOTIFY | PL_VENDOR | PL_CERTREQ => {}
                _ if payload.critical => return failure(N_UNSUPPORTED_CRITICAL_PAYLOAD),
                _ => {}
            }
        }
        // No AUTH means EAP, which we don't offer.
        let (Some(idi), Some(auth)) = (idi, auth) else {
            return failure(N_AUTHENTICATION_FAILED);
        };
        let (Ok((id_type, id_data)), Ok((method, auth_data))) = (parse_id(idi), parse_auth(auth)) else {
            return failure(N_INVALID_SYNTAX);
        };
        if method != AUTH_SHARED_KEY_MIC {
            return failure(N_AUTHENTICATION_FAILED);
        }
        // The phone may name the server it expects; it has to be us. The ID type isn't compared:
        // iOS picks it from the profile's text, and only the identity itself matters.
        if let Some(idr) = idr {
            match parse_id(idr) {
                Ok((_, data)) if data == self.config.server_id.as_bytes() => {}
                _ => return failure(N_AUTHENTICATION_FAILED),
            }
        }
        let Some(secret) = self.credentials.lookup(id_type, id_data) else {
            log::info!("ikev2: unknown identity from {from}");
            return failure(N_AUTHENTICATION_FAILED);
        };
        let octets = signed_octets(&sa.init_request, &sa.nr, &sa.keys.sk_pi, idi);
        if !psk_auth_matches(&secret.psk, &octets, auth_data) {
            log::info!("ikev2: wrong secret for {} from {from}", secret.peer);
            return failure(N_AUTHENTICATION_FAILED);
        }

        // The phone is authenticated. Our IDr and AUTH come first in the answer.
        let our_id = build_id(ID_FQDN, self.config.server_id.as_bytes());
        let our_auth = psk_auth(&secret.psk, &signed_octets(&sa.init_response, &sa.ni, &sa.keys.sk_pr, &our_id));
        let mut chain = ChainBuilder::new();
        chain.push(PL_IDR, &our_id);
        chain.push(PL_AUTH, &build_auth(AUTH_SHARED_KEY_MIC, &our_auth));

        // A phone that connects again replaces its old SAs: one tunnel address, one live SA.
        let mut outputs = Vec::new();
        let stale: Vec<u64> = self
            .sas
            .iter()
            .filter(|(_, other)| other.peer.as_ref().is_some_and(|p| p.peer == secret.peer))
            .map(|(spi, _)| *spi)
            .collect();
        for spi in stale {
            // The replaced SA's Down is left out: the same phone comes Up right below.
            let _ = self.drop_sa(spi);
        }

        match self.make_child(sa, &secret, child_sa, tsi, tsr, cp) {
            Ok(child_payloads) => {
                for (kind, body) in child_payloads {
                    chain.push(kind, &body);
                }
                outputs.push(Output::Up {
                    peer: secret.peer.clone(),
                    endpoint: from,
                    tunnel_ip: secret.tunnel_ip,
                });
            }
            // The IKE SA still stands without a Child SA (RFC 7296 §1.2); iOS gives up on it.
            Err(code) => chain.push(PL_NOTIFY, &build_notify(code, &[])),
        }
        sa.peer = Some(secret);
        Reply { chain, outputs, end: false }
    }

    /// Picks the ESP proposal, narrows the traffic selectors, assigns the address and derives the
    /// Child SA's keys. Returns the payloads for the answer, or the error notify to send instead.
    fn make_child(
        &mut self,
        sa: &mut IkeSa,
        secret: &PeerSecret,
        child_sa: Option<&[u8]>,
        tsi: Option<&[u8]>,
        tsr: Option<&[u8]>,
        cp: Option<&[u8]>,
    ) -> Result<Vec<(u8, Vec<u8>)>, u16> {
        let proposals = parse_sa(child_sa.ok_or(N_NO_PROPOSAL_CHOSEN)?).map_err(|_| N_INVALID_SYNTAX)?;
        let Some(choice) = choose_esp_proposal(&proposals) else {
            // Logged in full: this is what to look at when a new iOS version sends something else.
            log::info!("ikev2: no acceptable ESP proposal from {}: {proposals:?}", secret.peer);
            return Err(N_NO_PROPOSAL_CHOSEN);
        };
        let (ours_i, ours_r) = narrow_selectors(secret.tunnel_ip, tsi, tsr)?;
        let (ni, nr) = (sa.ni.clone(), sa.nr.clone());
        let (_, proposal) = self.install_child(sa, secret, choice, &ni, &nr)?;

        let mut payloads = Vec::new();
        if let Some(cp) = cp
            && matches!(parse_cp(cp), Ok((CFG_REQUEST, _)))
        {
            payloads.push((
                PL_CP,
                build_cp(
                    CFG_REPLY,
                    &[
                        (INTERNAL_IP4_ADDRESS, secret.tunnel_ip.octets().to_vec()),
                        (INTERNAL_IP4_DNS, self.config.dns.octets().to_vec()),
                    ],
                ),
            ));
        }
        payloads.push((PL_SA, build_sa(&proposal)));
        payloads.push((PL_TSI, build_ts(&[ours_i])));
        payloads.push((PL_TSR, build_ts(&[ours_r])));
        Ok(payloads)
    }

    /// Derives a Child SA's keys from these nonces (KEYMAT = prf+(SK_d, Ni | Nr), no new DH),
    /// installs it as the phone's newest one and returns our SPI and the proposal to answer with.
    fn install_child(
        &mut self,
        sa: &mut IkeSa,
        secret: &PeerSecret,
        choice: EspChoice,
        ni: &[u8],
        nr: &[u8],
    ) -> Result<(u32, Proposal), u16> {
        let spi_in = self.new_esp_spi().ok_or(N_NO_ADDITIONAL_SAS)?;
        let (i_to_r, r_to_i) =
            child_key_material(&sa.keys.sk_d, ni, nr, choice.aes_key_bytes).ok_or(N_NO_PROPOSAL_CHOSEN)?;
        let key_in = GcmKey::new(&i_to_r).ok_or(N_NO_PROPOSAL_CHOSEN)?;
        let key_out = GcmKey::new(&r_to_i).ok_or(N_NO_PROPOSAL_CHOSEN)?;
        self.esp.insert(
            spi_in,
            EspEntry {
                sa: EspSa::new(spi_in, choice.peer_spi, key_in, key_out),
                ike_spi_r: sa.spi_r,
                peer: secret.peer.clone(),
                tunnel_ip: secret.tunnel_ip,
                endpoint: sa.endpoint,
            },
        );
        // Outbound packets use the newest Child SA; the old one still decrypts until it's deleted.
        self.esp_by_ip.insert(secret.tunnel_ip, spi_in);
        sa.children.push(spi_in);
        let mut proposal = choice.proposal;
        proposal.spi = spi_in.to_be_bytes().to_vec();
        Ok((spi_in, proposal))
    }

    /// CREATE_CHILD_SA: rekeying the phone's Child SA (RFC 7296 §1.3.3), without PFS (our profile
    /// sets EnablePFS = 0). A new extra Child SA or a rekey of the IKE SA is turned down; iOS then
    /// reconnects, at most once a day with our profile's lifetimes.
    fn on_create_child(&mut self, sa: &mut IkeSa, payloads: &[RawPayload<'_>]) -> Reply {
        let refuse = |code: u16| {
            let mut chain = ChainBuilder::new();
            chain.push(PL_NOTIFY, &build_notify(code, &[]));
            Reply { chain, outputs: Vec::new(), end: false }
        };
        let Some(secret) = sa.peer.clone() else { return refuse(N_NO_ADDITIONAL_SAS) };
        let (mut rekeyed, mut child_sa, mut nonce, mut ke, mut tsi, mut tsr) = (None, None, None, None, None, None);
        for payload in payloads {
            match payload.kind {
                PL_NOTIFY => {
                    if let Ok(notify) = parse_notify(payload.body)
                        && notify.kind == N_REKEY_SA
                        && notify.protocol == PROTO_ESP
                    {
                        rekeyed = Some(notify.spi.to_vec());
                    }
                }
                PL_SA => child_sa = Some(payload.body),
                PL_NONCE => nonce = Some(payload.body),
                PL_KE => ke = Some(payload.body),
                PL_TSI => tsi = Some(payload.body),
                PL_TSR => tsr = Some(payload.body),
                PL_VENDOR => {}
                _ if payload.critical => return refuse(N_UNSUPPORTED_CRITICAL_PAYLOAD),
                _ => {}
            }
        }
        // The SPI in REKEY_SA is the phone's own (inbound) SPI of the Child SA being replaced.
        let Some(rekeyed) = rekeyed else { return refuse(N_NO_ADDITIONAL_SAS) };
        let known = sa.children.iter().any(|child| {
            self.esp.get(child).is_some_and(|entry| entry.sa.spi_out.to_be_bytes().as_slice() == rekeyed.as_slice())
        });
        if !known {
            return refuse(N_CHILD_SA_NOT_FOUND);
        }
        if ke.is_some() {
            return refuse(N_NO_PROPOSAL_CHOSEN);
        }
        let Some(ni) = nonce.filter(|n| (MIN_NONCE_LEN..=MAX_NONCE_LEN).contains(&n.len())) else {
            return refuse(N_INVALID_SYNTAX);
        };
        let Some(proposals) = child_sa.and_then(|body| parse_sa(body).ok()) else {
            return refuse(N_INVALID_SYNTAX);
        };
        let Some(choice) = choose_esp_proposal(&proposals) else {
            log::info!("ikev2: no acceptable ESP proposal to rekey {}: {proposals:?}", secret.peer);
            return refuse(N_NO_PROPOSAL_CHOSEN);
        };
        let (ours_i, ours_r) = match narrow_selectors(secret.tunnel_ip, tsi, tsr) {
            Ok(selectors) => selectors,
            Err(code) => return refuse(code),
        };
        let mut nr = vec![0u8; OUR_NONCE_LEN];
        if random_bytes(&mut nr).is_none() {
            return refuse(N_NO_ADDITIONAL_SAS);
        }
        let (_, proposal) = match self.install_child(sa, &secret, choice, ni, &nr) {
            Ok(installed) => installed,
            Err(code) => return refuse(code),
        };
        let mut chain = ChainBuilder::new();
        chain.push(PL_SA, &build_sa(&proposal));
        chain.push(PL_NONCE, &nr);
        chain.push(PL_TSI, &build_ts(&[ours_i]));
        chain.push(PL_TSR, &build_ts(&[ours_r]));
        Reply { chain, outputs: Vec::new(), end: false }
    }

    fn on_informational(&mut self, sa: &mut IkeSa, payloads: &[RawPayload<'_>]) -> Reply {
        let mut chain = ChainBuilder::new();
        let mut end = false;
        let mut outputs = Vec::new();
        for payload in payloads {
            match payload.kind {
                PL_DELETE => match parse_delete(payload.body) {
                    Ok((PROTO_IKE, _)) => end = true,
                    Ok((PROTO_ESP, spis)) => {
                        // The phone names its own SPIs; the answer names ours (RFC 7296 §1.4.1).
                        let mut ours = Vec::new();
                        for child in sa.children.clone() {
                            let Some(peer_spi) = self.esp.get(&child).map(|entry| entry.sa.spi_out.to_be_bytes()) else {
                                continue;
                            };
                            if spis.iter().any(|spi| spi.as_slice() == peer_spi) {
                                ours.push(child.to_be_bytes());
                                self.drop_child(child);
                                sa.children.retain(|c| *c != child);
                            }
                        }
                        // After a rekey the old Child SA goes and the tunnel stays; only the last
                        // one going ends it.
                        if !ours.is_empty() && sa.children.is_empty()
                            && let Some(peer) = &sa.peer
                        {
                            outputs.push(Output::Down { peer: peer.peer.clone() });
                        }
                        if !ours.is_empty() {
                            chain.push(PL_DELETE, &build_delete(PROTO_ESP, &ours));
                        }
                    }
                    _ => {}
                },
                PL_NOTIFY | PL_VENDOR => {}
                _ if payload.critical => {
                    let mut error = ChainBuilder::new();
                    error.push(PL_NOTIFY, &build_notify(N_UNSUPPORTED_CRITICAL_PAYLOAD, &[payload.kind]));
                    return Reply { chain: error, outputs: Vec::new(), end: false };
                }
                _ => {}
            }
        }
        // An empty request is dead peer detection: the empty answer is all it needs.
        Reply { chain, outputs, end }
    }

    fn handle_esp(&mut self, data: &[u8], from: SocketAddr, now: Instant) -> Vec<Output> {
        let Some(spi) = EspSa::spi_of(data) else { return Vec::new() };
        let Some(entry) = self.esp.get_mut(&spi) else { return Vec::new() };
        let packet = match entry.sa.open(data) {
            Ok(packet) => packet,
            Err(error) => {
                log::trace!("ikev2: dropped an ESP packet from {from}: {error:?}");
                return Vec::new();
            }
        };
        let mut outputs = Vec::new();
        // The phone's address follows authenticated packets only, so a forged one can't move it.
        if entry.endpoint != from {
            entry.endpoint = from;
            outputs.push(Output::Up {
                peer: entry.peer.clone(),
                endpoint: from,
                tunnel_ip: entry.tunnel_ip,
            });
        }
        let (ike_spi, tunnel_ip, peer) = (entry.ike_spi_r, entry.tunnel_ip, entry.peer.clone());
        if let Some(sa) = self.sas.get_mut(&ike_spi) {
            sa.last_seen = now;
            sa.endpoint = from;
        }
        if let Some(packet) = accept_inbound(tunnel_ip, &packet) {
            outputs.push(Output::Packet { peer, packet });
        }
        outputs
    }
}

struct Reply {
    chain: ChainBuilder,
    outputs: Vec<Output>,
    /// The IKE SA ends after this answer is sent.
    end: bool,
}

#[cfg(test)]
pub(crate) mod tests;
