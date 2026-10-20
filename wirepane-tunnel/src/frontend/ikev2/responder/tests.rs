//! A software IKEv2 initiator (the "phone") that drives the responder through IKE_SA_INIT,
//! IKE_AUTH, ESP both ways, dead peer detection and Delete, plus the failure paths and garbage.
//! It reuses the crate's key schedule, which is checked separately against independent vectors in
//! `crypto.rs`; the message building here is written independently of the responder's.

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr};
use std::time::{Duration, Instant};

use ring::agreement::{self, ECDH_P256, EphemeralPrivateKey, UnparsedPublicKey, X25519};
use ring::rand::SystemRandom;

use super::*;
use crate::frontend::ikev2::crypto::{self, GcmKey, IkeKeys};
use crate::frontend::ikev2::esp::EspSa;

const PSK: &[u8] = b"a per-device secret of 32 bytes!";
const PHONE_SPI: u32 = 0xC0FFEE01;

struct TestCredentials(HashMap<Vec<u8>, PeerSecret>);

impl Credentials for TestCredentials {
    fn lookup(&self, id_type: u8, id: &[u8]) -> Option<PeerSecret> {
        if id_type != ID_FQDN {
            return None;
        }
        self.0.get(id).cloned()
    }
}

fn new_responder() -> Responder<TestCredentials> {
    let mut peers = HashMap::new();
    peers.insert(
        b"p1.wirepane".to_vec(),
        PeerSecret {
            peer: "p1".to_string(),
            psk: PSK.to_vec(),
            tunnel_ip: Ipv4Addr::new(10, 73, 0, 2),
        },
    );
    Responder::new(
        ResponderConfig {
            server_id: "vpn.wirepane".to_string(),
            dns: Ipv4Addr::new(10, 73, 0, 53),
            max_half_open: 4,
        },
        TestCredentials(peers),
    )
}

fn phone_ike() -> SocketAddr {
    "192.168.1.20:500".parse().expect("address")
}

fn phone_nat_t() -> SocketAddr {
    "192.168.1.20:4500".parse().expect("address")
}

fn transform(kind: u8, id: u16, key_length: Option<u16>) -> Transform {
    Transform {
        kind,
        id,
        key_length,
        unknown_attribute: false,
    }
}

/// The initiator side, holding what it needs between the exchanges. The listener's socket test
/// reuses it.
pub(crate) struct Phone {
    pub(crate) group: u16,
    pub(crate) spi_i: u64,
    pub(crate) spi_r: u64,
    pub(crate) ni: Vec<u8>,
    pub(crate) nr: Vec<u8>,
    pub(crate) private: Option<EphemeralPrivateKey>,
    pub(crate) init_request: Vec<u8>,
    pub(crate) init_response: Vec<u8>,
    pub(crate) keys: Option<IkeKeys>,
    pub(crate) iv: u64,
    pub(crate) message_id: u32,
    pub(crate) identity: Vec<u8>,
    pub(crate) psk: Vec<u8>,
    pub(crate) esp: Option<EspSa>,
    pub(crate) assigned: Option<Ipv4Addr>,
    pub(crate) dns: Option<Ipv4Addr>,
    /// Where the responder saw IKE_SA_INIT come from, for the NAT detection check.
    pub(crate) expected_address: SocketAddr,
    /// The cookie the responder asked for, sent first in the next IKE_SA_INIT.
    pub(crate) cookie: Option<Vec<u8>>,
}

impl Phone {
    pub(crate) fn new(group: u16) -> Phone {
        Phone {
            group,
            spi_i: 0x1122334455667788,
            spi_r: 0,
            ni: vec![0x5a; 32],
            nr: Vec::new(),
            private: None,
            init_request: Vec::new(),
            init_response: Vec::new(),
            keys: None,
            iv: 0,
            message_id: 0,
            identity: b"p1.wirepane".to_vec(),
            psk: PSK.to_vec(),
            esp: None,
            assigned: None,
            dns: None,
            expected_address: phone_ike(),
            cookie: None,
        }
    }

    fn header(&self, exchange: u8, message_id: u32) -> Header {
        Header {
            spi_i: self.spi_i,
            spi_r: self.spi_r,
            next_payload: PL_NONE,
            exchange,
            flags: FLAG_INITIATOR,
            message_id,
            length: 0,
        }
    }

    /// IKE_SA_INIT with one proposal: AES-GCM-256, HMAC-SHA-256, our group (or `offer` instead).
    pub(crate) fn sa_init(&mut self, offer: Option<Vec<Transform>>) -> Vec<u8> {
        let algorithm = if self.group == DH_ECP_256 { &ECDH_P256 } else { &X25519 };
        let private = EphemeralPrivateKey::generate(algorithm, &SystemRandom::new()).expect("key");
        let public = private.compute_public_key().expect("public key");
        let ke = if self.group == DH_ECP_256 {
            public.as_ref()[1..].to_vec()
        } else {
            public.as_ref().to_vec()
        };
        self.private = Some(private);
        let transforms = offer.unwrap_or_else(|| {
            vec![
                transform(TT_ENCR, ENCR_AES_GCM_16, Some(256)),
                transform(TT_PRF, PRF_HMAC_SHA2_256, None),
                transform(TT_DH, self.group, None),
            ]
        });
        let mut chain = ChainBuilder::new();
        if let Some(cookie) = &self.cookie {
            chain.push(PL_NOTIFY, &build_notify(N_COOKIE, cookie));
        }
        chain.push(
            PL_SA,
            &build_sa(&Proposal {
                number: 1,
                protocol: PROTO_IKE,
                spi: Vec::new(),
                transforms,
            }),
        );
        chain.push(PL_KE, &build_ke(self.group, &ke));
        chain.push(PL_NONCE, &self.ni);
        chain.push(PL_NOTIFY, &build_notify(N_NAT_DETECTION_SOURCE_IP, &[0x11; 20]));
        chain.push(PL_NOTIFY, &build_notify(N_NAT_DETECTION_DESTINATION_IP, &[0x22; 20]));
        let message = build_message(self.header(IKE_SA_INIT, 0), chain);
        self.init_request = message.clone();
        message
    }

    /// Reads the IKE_SA_INIT answer and derives the IKE SA's keys.
    pub(crate) fn read_sa_init(&mut self, datagram: &[u8]) {
        let header = Header::parse(datagram).expect("response header");
        assert!(header.is_response() && !header.is_from_initiator());
        assert_eq!(header.spi_i, self.spi_i);
        assert_ne!(header.spi_r, 0);
        self.spi_r = header.spi_r;
        let payloads = parse_chain(header.next_payload, &datagram[HEADER_LEN..]).expect("payloads");
        let mut ke = None;
        let mut nat = HashMap::new();
        for payload in &payloads {
            match payload.kind {
                PL_SA => {
                    let proposals = parse_sa(payload.body).expect("SA");
                    assert_eq!(proposals.len(), 1);
                    let ids: Vec<(u8, u16)> = proposals[0].transforms.iter().map(|t| (t.kind, t.id)).collect();
                    assert_eq!(ids, vec![(TT_ENCR, ENCR_AES_GCM_16), (TT_PRF, PRF_HMAC_SHA2_256), (TT_DH, self.group)]);
                }
                PL_KE => ke = Some(parse_ke(payload.body).expect("KE").1.to_vec()),
                PL_NONCE => self.nr = payload.body.to_vec(),
                PL_NOTIFY => {
                    let notify = parse_notify(payload.body).expect("notify");
                    nat.insert(notify.kind, notify.data.to_vec());
                }
                other => panic!("unexpected payload {other}"),
            }
        }
        // The destination hash is real (our address as the responder saw it); the source hash is
        // deliberately wrong, so a real phone switches to UDP encapsulation.
        assert_eq!(
            nat[&N_NAT_DETECTION_DESTINATION_IP],
            crypto::nat_hash(self.spi_i, self.spi_r, self.expected_address.ip(), self.expected_address.port()).to_vec()
        );
        let responder_address: IpAddr = "192.168.1.10".parse().expect("address");
        assert_ne!(
            nat[&N_NAT_DETECTION_SOURCE_IP],
            crypto::nat_hash(self.spi_i, self.spi_r, responder_address, 500).to_vec()
        );

        let ke = ke.expect("KE payload");
        let algorithm = if self.group == DH_ECP_256 { &ECDH_P256 } else { &X25519 };
        let peer = if self.group == DH_ECP_256 { [&[4u8][..], &ke].concat() } else { ke };
        let shared = agreement::agree_ephemeral(
            self.private.take().expect("private key"),
            &UnparsedPublicKey::new(algorithm, &peer),
            |secret| secret.to_vec(),
        )
        .expect("agreement");
        self.keys = crypto::ike_key_material(&self.ni, &self.nr, &shared, self.spi_i, self.spi_r, 32)
            .and_then(|material| material.into_keys());
        assert!(self.keys.is_some());
        self.init_response = datagram.to_vec();
        self.message_id = 1;
    }

    fn keys(&self) -> &IkeKeys {
        self.keys.as_ref().expect("IKE SA keys")
    }

    /// An encrypted request, as sent on UDP 4500 (with the non-ESP marker).
    pub(crate) fn encrypted(&mut self, exchange: u8, chain: ChainBuilder) -> Vec<u8> {
        let header = self.header(exchange, self.message_id);
        let (first, mut plain) = chain.finish();
        // Some padding, to check the responder strips it.
        plain.extend_from_slice(&[0, 0, 0]);
        plain.push(3);
        let sk_len = 4 + 8 + plain.len() + 16;
        let mut message = Vec::new();
        let mut full = header;
        full.next_payload = PL_SK;
        full.length = (HEADER_LEN + sk_len) as u32;
        full.write(&mut message);
        message.push(first);
        message.push(0);
        message.extend_from_slice(&(sk_len as u16).to_be_bytes());
        self.iv += 1;
        let iv = self.iv.to_be_bytes();
        let aad = message.clone();
        self.keys().sk_ei.seal(iv, &aad, &mut plain).expect("seal");
        message.extend_from_slice(&iv);
        message.extend_from_slice(&plain);
        [&[0u8, 0, 0, 0][..], &message].concat()
    }

    /// Decrypts a response from UDP 4500 and returns its payloads (owned).
    pub(crate) fn decrypt(&self, datagram: &[u8], exchange: u8) -> Vec<(u8, Vec<u8>)> {
        assert_eq!(&datagram[..4], &[0, 0, 0, 0], "non-ESP marker");
        let message = &datagram[4..];
        let header = Header::parse(message).expect("header");
        assert!(header.is_response());
        assert_eq!(header.exchange, exchange);
        assert_eq!(header.message_id, self.message_id);
        let payloads = parse_chain(header.next_payload, &message[HEADER_LEN..]).expect("payloads");
        assert_eq!(payloads.len(), 1);
        let sk = payloads[0];
        assert_eq!(sk.kind, PL_SK);
        let aad = &message[..HEADER_LEN + sk.offset + 4];
        let iv: [u8; 8] = sk.body[..8].try_into().expect("iv");
        let mut sealed = sk.body[8..].to_vec();
        let plain = self.keys().sk_er.open(iv, aad, &mut sealed).expect("response decrypts").to_vec();
        let pad = *plain.last().expect("pad length") as usize;
        let inner = &plain[..plain.len() - 1 - pad];
        parse_chain(sk.next, inner)
            .expect("inner payloads")
            .into_iter()
            .map(|p| (p.kind, p.body.to_vec()))
            .collect()
    }

    pub(crate) fn auth_request(&mut self) -> Vec<u8> {
        let idi = build_id(ID_FQDN, &self.identity);
        let octets = crypto::signed_octets(&self.init_request, &self.nr, &self.keys().sk_pi, &idi);
        let auth = crypto::psk_auth(&self.psk, &octets);
        let everything = Ipv4Selector {
            protocol: 0,
            start_port: 0,
            end_port: 65535,
            start: Ipv4Addr::UNSPECIFIED,
            end: Ipv4Addr::BROADCAST,
        };
        let mut chain = ChainBuilder::new();
        chain.push(PL_IDI, &idi);
        chain.push(PL_NOTIFY, &build_notify(16384, &[])); // INITIAL_CONTACT
        chain.push(PL_IDR, &build_id(ID_FQDN, b"vpn.wirepane"));
        chain.push(PL_AUTH, &build_auth(AUTH_SHARED_KEY_MIC, &auth));
        chain.push(PL_CP, &build_cp(CFG_REQUEST, &[(INTERNAL_IP4_ADDRESS, vec![]), (INTERNAL_IP4_DNS, vec![])]));
        chain.push(
            PL_SA,
            &build_sa(&Proposal {
                number: 1,
                protocol: PROTO_ESP,
                spi: PHONE_SPI.to_be_bytes().to_vec(),
                transforms: vec![
                    transform(TT_ENCR, ENCR_AES_GCM_16, Some(256)),
                    transform(TT_ESN, ESN_NONE, None),
                ],
            }),
        );
        chain.push(PL_TSI, &build_ts(&[everything]));
        chain.push(PL_TSR, &build_ts(&[everything]));
        self.encrypted(IKE_AUTH, chain)
    }

    /// Checks the IKE_AUTH answer (the responder's AUTH included) and sets up ESP.
    pub(crate) fn read_auth(&mut self, datagram: &[u8]) {
        self.read_auth_for(datagram, Ipv4Addr::new(10, 73, 0, 2));
    }

    /// The same, for a phone that should get `address`.
    pub(crate) fn read_auth_for(&mut self, datagram: &[u8], address: Ipv4Addr) {
        let payloads = self.decrypt(datagram, IKE_AUTH);
        let kinds: Vec<u8> = payloads.iter().map(|(kind, _)| *kind).collect();
        assert_eq!(kinds, vec![PL_IDR, PL_AUTH, PL_CP, PL_SA, PL_TSI, PL_TSR]);
        let idr = &payloads[0].1;
        assert_eq!(parse_id(idr).expect("IDr"), (ID_FQDN, &b"vpn.wirepane"[..]));
        let (method, auth) = parse_auth(&payloads[1].1).expect("AUTH");
        assert_eq!(method, AUTH_SHARED_KEY_MIC);
        let octets = crypto::signed_octets(&self.init_response, &self.ni, &self.keys().sk_pr, idr);
        assert!(crypto::psk_auth_matches(&self.psk, &octets, auth), "the responder's AUTH checks out");

        let cp = &payloads[2].1;
        assert_eq!(cp[0], CFG_REPLY);
        // Attribute 1 (INTERNAL_IP4_ADDRESS) = the address, attribute 3 (INTERNAL_IP4_DNS) = 10.73.0.53.
        let mut expected = vec![0, 1, 0, 4];
        expected.extend_from_slice(&address.octets());
        expected.extend_from_slice(&[0, 3, 0, 4, 10, 73, 0, 53]);
        assert_eq!(&cp[4..], &expected[..]);
        self.assigned = Some(address);
        self.dns = Some(Ipv4Addr::new(10, 73, 0, 53));

        let proposals = parse_sa(&payloads[3].1).expect("SA");
        let spi = &proposals[0].spi;
        let responder_spi = u32::from_be_bytes([spi[0], spi[1], spi[2], spi[3]]);
        assert!(responder_spi >= 256);
        let ids: Vec<(u8, u16)> = proposals[0].transforms.iter().map(|t| (t.kind, t.id)).collect();
        assert_eq!(ids, vec![(TT_ENCR, ENCR_AES_GCM_16), (TT_ESN, ESN_NONE)]);

        let tsi = parse_ts(&payloads[4].1).expect("TSi");
        assert_eq!((tsi[0].start, tsi[0].end), (address, address));
        let tsr = parse_ts(&payloads[5].1).expect("TSr");
        assert_eq!((tsr[0].start, tsr[0].end), (Ipv4Addr::UNSPECIFIED, Ipv4Addr::BROADCAST));

        let (i_to_r, r_to_i) = crypto::child_key_material(&self.keys().sk_d, &self.ni, &self.nr, 32).expect("child keys");
        self.esp = Some(EspSa::new(
            PHONE_SPI,
            responder_spi,
            GcmKey::new(&r_to_i).expect("key"),
            GcmKey::new(&i_to_r).expect("key"),
        ));
        self.message_id += 1;
    }
}

/// A UDP datagram from the phone's tunnel address to 1.1.1.1:53.
pub(crate) fn udp_packet(src: Ipv4Addr, dst: Ipv4Addr) -> Vec<u8> {
    let payload = b"hello through ikev2";
    let total = 20 + 8 + payload.len();
    let mut packet = vec![0x45, 0, 0, total as u8, 0, 1, 0, 0, 64, 17, 0, 0];
    packet.extend_from_slice(&src.octets());
    packet.extend_from_slice(&dst.octets());
    let checksum = {
        let mut sum = 0u32;
        for pair in packet.chunks(2) {
            sum += u32::from(u16::from_be_bytes([pair[0], pair[1]]));
        }
        while sum > 0xffff {
            sum = (sum & 0xffff) + (sum >> 16);
        }
        !(sum as u16)
    };
    packet[10..12].copy_from_slice(&checksum.to_be_bytes());
    packet.extend_from_slice(&40000u16.to_be_bytes());
    packet.extend_from_slice(&53u16.to_be_bytes());
    packet.extend_from_slice(&((8 + payload.len()) as u16).to_be_bytes());
    packet.extend_from_slice(&[0, 0]); // no UDP checksum (allowed for IPv4)
    packet.extend_from_slice(payload);
    packet
}

fn only_send(outputs: Vec<Output>) -> (Port, SocketAddr, Vec<u8>) {
    let sends: Vec<_> = outputs
        .into_iter()
        .filter_map(|output| match output {
            Output::Send { via, to, datagram } => Some((via, to, datagram)),
            _ => None,
        })
        .collect();
    assert_eq!(sends.len(), 1, "exactly one datagram to send");
    sends.into_iter().next().expect("one datagram")
}

/// IKE_SA_INIT on 500, then IKE_AUTH on 4500. Returns the phone, ready for ESP.
fn connect(responder: &mut Responder<TestCredentials>, group: u16, now: Instant) -> Phone {
    let mut phone = Phone::new(group);
    let request = phone.sa_init(None);
    let (via, to, datagram) = only_send(responder.handle_datagram(Port::Ike, &request, phone_ike(), now));
    assert_eq!((via, to), (Port::Ike, phone_ike()));
    phone.read_sa_init(&datagram);

    let auth = phone.auth_request();
    let outputs = responder.handle_datagram(Port::NatT, &auth, phone_nat_t(), now);
    assert!(outputs.contains(&Output::Up {
        peer: "p1".to_string(),
        endpoint: phone_nat_t(),
        tunnel_ip: Ipv4Addr::new(10, 73, 0, 2),
    }));
    let (via, to, datagram) = only_send(outputs);
    assert_eq!((via, to), (Port::NatT, phone_nat_t()));
    phone.read_auth(&datagram);
    phone
}

#[test]
fn full_handshake_and_esp_round_trip_in_both_groups() {
    for group in [DH_ECP_256, DH_CURVE25519] {
        let mut responder = new_responder();
        let now = Instant::now();
        let mut phone = connect(&mut responder, group, now);
        let tunnel_ip = phone.assigned.expect("an address");
        assert_eq!(phone.dns, Some(Ipv4Addr::new(10, 73, 0, 53)));

        // Phone to Mac: the responder hands the exact inner packet to the core.
        let packet = udp_packet(tunnel_ip, Ipv4Addr::new(1, 1, 1, 1));
        let esp = phone.esp.as_mut().expect("ESP").seal(&packet).expect("seal");
        let outputs = responder.handle_datagram(Port::NatT, &esp, phone_nat_t(), now);
        assert_eq!(outputs, vec![Output::Packet { peer: "p1".to_string(), packet: packet.clone() }]);
        // A replayed ESP packet goes nowhere.
        assert!(responder.handle_datagram(Port::NatT, &esp, phone_nat_t(), now).is_empty());

        // Mac to phone.
        let reply = udp_packet(Ipv4Addr::new(1, 1, 1, 1), tunnel_ip);
        let Some(Output::Send { via, to, datagram }) = responder.encapsulate(&reply) else {
            panic!("the responder encrypts for a connected phone");
        };
        assert_eq!((via, to), (Port::NatT, phone_nat_t()));
        assert_eq!(phone.esp.as_mut().expect("ESP").open(&datagram).expect("phone decrypts"), reply);
        assert_eq!(responder.peer_for(tunnel_ip), Some(("p1".to_string(), phone_nat_t())));
        assert!(responder.encapsulate(&udp_packet(Ipv4Addr::new(1, 1, 1, 1), Ipv4Addr::new(10, 73, 0, 9))).is_none());
    }
}

#[test]
fn dead_peer_detection_retransmission_and_delete() {
    let mut responder = new_responder();
    let now = Instant::now();
    let mut phone = connect(&mut responder, DH_ECP_256, now);

    // An empty INFORMATIONAL is a liveness check: an empty answer.
    let dpd = phone.encrypted(INFORMATIONAL, ChainBuilder::new());
    let (_, _, answer) = only_send(responder.handle_datagram(Port::NatT, &dpd, phone_nat_t(), now));
    assert!(phone.decrypt(&answer, INFORMATIONAL).is_empty());
    // The same request again gets the very same answer.
    let (_, _, again) = only_send(responder.handle_datagram(Port::NatT, &dpd, phone_nat_t(), now));
    assert_eq!(again, answer);
    phone.message_id += 1;

    // Deleting the IKE SA ends the tunnel.
    let mut chain = ChainBuilder::new();
    chain.push(PL_DELETE, &build_delete(PROTO_IKE, &[]));
    let delete = phone.encrypted(INFORMATIONAL, chain);
    let outputs = responder.handle_datagram(Port::NatT, &delete, phone_nat_t(), now);
    assert!(outputs.contains(&Output::Down { peer: "p1".to_string() }));
    assert_eq!(responder.sa_count(), 0);
    let packet = udp_packet(Ipv4Addr::new(10, 73, 0, 2), Ipv4Addr::new(1, 1, 1, 1));
    let esp = phone.esp.as_mut().expect("ESP").seal(&packet).expect("seal");
    assert!(responder.handle_datagram(Port::NatT, &esp, phone_nat_t(), now).is_empty());
}

#[test]
fn deleting_the_child_sa_answers_with_our_spi() {
    let mut responder = new_responder();
    let now = Instant::now();
    let mut phone = connect(&mut responder, DH_ECP_256, now);
    let mut chain = ChainBuilder::new();
    chain.push(PL_DELETE, &build_delete(PROTO_ESP, &[PHONE_SPI.to_be_bytes()]));
    let delete = phone.encrypted(INFORMATIONAL, chain);
    let outputs = responder.handle_datagram(Port::NatT, &delete, phone_nat_t(), now);
    assert!(outputs.contains(&Output::Down { peer: "p1".to_string() }));
    let (_, _, answer) = only_send(outputs);
    let payloads = phone.decrypt(&answer, INFORMATIONAL);
    assert_eq!(payloads.len(), 1);
    let (protocol, spis) = parse_delete(&payloads[0].1).expect("delete");
    assert_eq!(protocol, PROTO_ESP);
    let ours = phone.esp.as_ref().expect("ESP").spi_out.to_be_bytes().to_vec();
    assert_eq!(spis, vec![ours]);
    assert!(responder.peer_for(Ipv4Addr::new(10, 73, 0, 2)).is_none());
}

#[test]
fn a_wrong_secret_or_identity_fails_authentication() {
    for (identity, psk) in [(&b"p1.wirepane"[..], &b"not the right secret"[..]), (&b"p9.wirepane"[..], PSK)] {
        let mut responder = new_responder();
        let now = Instant::now();
        let mut phone = Phone::new(DH_ECP_256);
        phone.identity = identity.to_vec();
        phone.psk = psk.to_vec();
        let request = phone.sa_init(None);
        let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &request, phone_ike(), now));
        phone.read_sa_init(&datagram);
        let auth = phone.auth_request();
        let outputs = responder.handle_datagram(Port::NatT, &auth, phone_nat_t(), now);
        assert!(!outputs.iter().any(|o| matches!(o, Output::Up { .. })));
        let (_, _, answer) = only_send(outputs);
        let payloads = phone.decrypt(&answer, IKE_AUTH);
        assert_eq!(payloads.len(), 1);
        assert_eq!(parse_notify(&payloads[0].1).expect("notify").kind, N_AUTHENTICATION_FAILED);
        // The SA is gone, so nothing more is accepted on it.
        assert_eq!(responder.sa_count(), 0);
    }
}

#[test]
fn retransmitted_sa_init_gets_the_same_answer() {
    let mut responder = new_responder();
    let now = Instant::now();
    let mut phone = Phone::new(DH_ECP_256);
    let request = phone.sa_init(None);
    let first = only_send(responder.handle_datagram(Port::Ike, &request, phone_ike(), now));
    let second = only_send(responder.handle_datagram(Port::Ike, &request, phone_ike(), now));
    assert_eq!(first, second);
    assert_eq!(responder.sa_count(), 1);
}

#[test]
fn wrong_group_and_unknown_algorithms_are_refused() {
    let now = Instant::now();
    let notify_of = |datagram: &[u8]| {
        let header = Header::parse(datagram).expect("header");
        assert_eq!(header.spi_r, 0, "a refused IKE_SA_INIT creates no SA");
        let payloads = parse_chain(header.next_payload, &datagram[HEADER_LEN..]).expect("payloads");
        let notify = parse_notify(payloads[0].body).expect("notify");
        (notify.kind, notify.data.to_vec())
    };

    // The phone offers group 19 but sends a Curve25519 key: we ask for group 19.
    let mut responder = new_responder();
    let mut phone = Phone::new(DH_CURVE25519);
    let request = phone.sa_init(Some(vec![
        transform(TT_ENCR, ENCR_AES_GCM_16, Some(256)),
        transform(TT_PRF, PRF_HMAC_SHA2_256, None),
        transform(TT_DH, DH_ECP_256, None),
    ]));
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &request, phone_ike(), now));
    assert_eq!(notify_of(&datagram), (N_INVALID_KE_PAYLOAD, DH_ECP_256.to_be_bytes().to_vec()));
    assert_eq!(responder.sa_count(), 0);

    // AES-CBC with HMAC integrity, or MODP-2048: not offered by our profile, not accepted.
    for offer in [
        vec![
            transform(TT_ENCR, 12, Some(256)),
            transform(TT_PRF, PRF_HMAC_SHA2_256, None),
            transform(TT_INTEG, 12, None),
            transform(TT_DH, DH_ECP_256, None),
        ],
        vec![
            transform(TT_ENCR, ENCR_AES_GCM_16, Some(256)),
            transform(TT_PRF, PRF_HMAC_SHA2_256, None),
            transform(TT_DH, 14, None),
        ],
        vec![
            transform(TT_ENCR, ENCR_AES_GCM_16, Some(192)),
            transform(TT_PRF, PRF_HMAC_SHA2_256, None),
            transform(TT_DH, DH_ECP_256, None),
        ],
    ] {
        let mut responder = new_responder();
        let mut phone = Phone::new(DH_ECP_256);
        let request = phone.sa_init(Some(offer));
        let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &request, phone_ike(), now));
        assert_eq!(notify_of(&datagram).0, N_NO_PROPOSAL_CHOSEN);
    }
}

#[test]
fn half_open_sas_are_capped_and_expire() {
    let mut responder = new_responder();
    let start = Instant::now();
    for i in 0..6u64 {
        let mut phone = Phone::new(DH_ECP_256);
        phone.spi_i = 0x1000 + i;
        let at = start + Duration::from_millis(i);
        // Always answered; above the cap (4 in this test) the oldest half-open SA makes room.
        // From 2 half-open SAs on, a cookie is needed first.
        let datagram = sa_init_with_cookie(&mut responder, &mut phone, phone_ike(), at);
        assert_ne!(Header::parse(&datagram).expect("header").spi_r, 0);
    }
    assert_eq!(responder.sa_count(), 4);
    let now = start;

    // A phone whose IKE_SA_INIT was pushed out gets nothing more; the newest still can go on.
    let mut evicted = Phone::new(DH_ECP_256);
    evicted.spi_i = 0x1000;
    let datagram = sa_init_with_cookie(&mut responder, &mut evicted, "192.168.1.30:500".parse().expect("address"), now);
    assert_ne!(Header::parse(&datagram).expect("header").spi_r, 0, "a new SA, not the evicted one");
    assert!(responder.tick(now + Duration::from_secs(5)).is_empty());
    assert_eq!(responder.sa_count(), 4);
    responder.tick(now + HALF_OPEN_TIMEOUT + Duration::from_secs(1));
    assert_eq!(responder.sa_count(), 0);
}

#[test]
fn established_sas_expire_when_silent_and_on_removal() {
    let mut responder = new_responder();
    let now = Instant::now();
    let _phone = connect(&mut responder, DH_ECP_256, now);
    assert!(responder.tick(now + Duration::from_secs(60)).is_empty());
    assert_eq!(
        responder.tick(now + IDLE_TIMEOUT + Duration::from_secs(1)),
        vec![Output::Down { peer: "p1".to_string() }]
    );

    let _phone = connect(&mut responder, DH_ECP_256, now);
    assert_eq!(responder.remove_peer("p1"), vec![Output::Down { peer: "p1".to_string() }]);
    assert_eq!(responder.sa_count(), 0);
    assert!(responder.peer_for(Ipv4Addr::new(10, 73, 0, 2)).is_none());
}

#[test]
fn a_reconnecting_phone_replaces_its_old_sa() {
    let mut responder = new_responder();
    let now = Instant::now();
    let _old = connect(&mut responder, DH_ECP_256, now);
    let mut new = Phone::new(DH_ECP_256);
    new.spi_i = 0x99;
    let request = new.sa_init(None);
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &request, phone_ike(), now));
    new.read_sa_init(&datagram);
    let auth = new.auth_request();
    let (_, _, answer) = only_send(responder.handle_datagram(Port::NatT, &auth, phone_nat_t(), now));
    new.read_auth(&answer);
    assert_eq!(responder.sa_count(), 1);
    let packet = udp_packet(Ipv4Addr::new(10, 73, 0, 2), Ipv4Addr::new(1, 1, 1, 1));
    let esp = new.esp.as_mut().expect("ESP").seal(&packet).expect("seal");
    assert_eq!(
        responder.handle_datagram(Port::NatT, &esp, phone_nat_t(), now),
        vec![Output::Packet { peer: "p1".to_string(), packet }]
    );
}

#[test]
fn spoofed_inner_source_addresses_are_dropped() {
    let mut responder = new_responder();
    let now = Instant::now();
    let mut phone = connect(&mut responder, DH_ECP_256, now);
    let spoofed = udp_packet(Ipv4Addr::new(10, 73, 0, 3), Ipv4Addr::new(1, 1, 1, 1));
    let esp = phone.esp.as_mut().expect("ESP").seal(&spoofed).expect("seal");
    assert!(responder.handle_datagram(Port::NatT, &esp, phone_nat_t(), now).is_empty());
}

#[test]
fn nat_rebinding_moves_the_endpoint_only_after_a_valid_packet() {
    let mut responder = new_responder();
    let now = Instant::now();
    let mut phone = connect(&mut responder, DH_ECP_256, now);
    let moved: SocketAddr = "192.168.1.20:61000".parse().expect("address");
    let packet = udp_packet(Ipv4Addr::new(10, 73, 0, 2), Ipv4Addr::new(1, 1, 1, 1));
    let mut esp = phone.esp.as_mut().expect("ESP").seal(&packet).expect("seal");
    let last = esp.len() - 1;
    esp[last] ^= 1;
    assert!(responder.handle_datagram(Port::NatT, &esp, moved, now).is_empty());
    assert_eq!(responder.peer_for(Ipv4Addr::new(10, 73, 0, 2)).map(|p| p.1), Some(phone_nat_t()));
    let esp = phone.esp.as_mut().expect("ESP").seal(&packet).expect("seal");
    let outputs = responder.handle_datagram(Port::NatT, &esp, moved, now);
    assert!(outputs.contains(&Output::Up {
        peer: "p1".to_string(),
        endpoint: moved,
        tunnel_ip: Ipv4Addr::new(10, 73, 0, 2),
    }));
    assert_eq!(responder.peer_for(Ipv4Addr::new(10, 73, 0, 2)).map(|p| p.1), Some(moved));
}

/// Truncations and bit flips of real messages, and random bytes on both ports: never a panic,
/// never an authenticated phone.
#[test]
fn garbage_never_panics_or_authenticates() {
    let now = Instant::now();
    let mut responder = new_responder();
    let mut phone = Phone::new(DH_ECP_256);
    let init = phone.sa_init(None);
    for cut in 0..init.len() {
        let _ = responder.handle_datagram(Port::Ike, &init[..cut], phone_ike(), now);
    }
    let mut responder = new_responder();
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &init, phone_ike(), now));
    phone.read_sa_init(&datagram);
    let auth = phone.auth_request();
    for at in 0..auth.len() {
        let mut flipped = auth.clone();
        flipped[at] ^= 0x01;
        let outputs = responder.handle_datagram(Port::NatT, &flipped, phone_nat_t(), now);
        assert!(!outputs.iter().any(|o| matches!(o, Output::Up { .. })), "flip at {at} authenticated");
    }
    for cut in 0..auth.len() {
        let outputs = responder.handle_datagram(Port::NatT, &auth[..cut], phone_nat_t(), now);
        assert!(!outputs.iter().any(|o| matches!(o, Output::Up { .. })));
    }
    // The untouched request still works afterwards: garbage didn't break the SA.
    let outputs = responder.handle_datagram(Port::NatT, &auth, phone_nat_t(), now);
    assert!(outputs.iter().any(|o| matches!(o, Output::Up { .. })));

    let mut state = 0xD1B54A32D192ED03u64;
    for round in 0..4000 {
        let len = (state % 400) as usize;
        let mut random = Vec::with_capacity(len);
        for _ in 0..len {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            random.push(state as u8);
        }
        // Some rounds look like IKE on 4500, some like a valid IKE header.
        if round % 3 == 0 && random.len() > 8 {
            random[..4].copy_from_slice(&[0, 0, 0, 0]);
        }
        if round % 5 == 0 && random.len() >= HEADER_LEN {
            random[17] = VERSION;
            let len = random.len() as u32;
            random[24..28].copy_from_slice(&len.to_be_bytes());
        }
        let _ = responder.handle_datagram(Port::NatT, &random, phone_nat_t(), now);
        let _ = responder.handle_datagram(Port::Ike, &random, phone_ike(), now);
        let _ = responder.encapsulate(&random);
    }
    // Only the one real phone ever came up.
    assert!(responder.sa_count() <= 1 + 4);
}

impl Phone {
    /// CREATE_CHILD_SA rekeying the current Child SA (no PFS), with a new phone SPI.
    fn rekey_request(&mut self, new_spi: u32) -> Vec<u8> {
        let old_spi = self.esp.as_ref().expect("ESP").spi_in;
        let everything = Ipv4Selector {
            protocol: 0,
            start_port: 0,
            end_port: 65535,
            start: Ipv4Addr::UNSPECIFIED,
            end: Ipv4Addr::BROADCAST,
        };
        let mut rekey = vec![PROTO_ESP, 4];
        rekey.extend_from_slice(&N_REKEY_SA.to_be_bytes());
        rekey.extend_from_slice(&old_spi.to_be_bytes());
        let mut chain = ChainBuilder::new();
        chain.push(PL_NOTIFY, &rekey);
        chain.push(
            PL_SA,
            &build_sa(&Proposal {
                number: 1,
                protocol: PROTO_ESP,
                spi: new_spi.to_be_bytes().to_vec(),
                transforms: vec![
                    transform(TT_ENCR, ENCR_AES_GCM_16, Some(256)),
                    transform(TT_ESN, ESN_NONE, None),
                ],
            }),
        );
        chain.push(PL_NONCE, &[0x77; 32]);
        chain.push(PL_TSI, &build_ts(&[everything]));
        chain.push(PL_TSR, &build_ts(&[everything]));
        self.encrypted(CREATE_CHILD_SA, chain)
    }

    /// Reads the rekey answer and returns the new Child SA (the old one is left as it was).
    fn read_rekey(&mut self, datagram: &[u8], new_spi: u32) -> EspSa {
        let payloads = self.decrypt(datagram, CREATE_CHILD_SA);
        let kinds: Vec<u8> = payloads.iter().map(|(kind, _)| *kind).collect();
        assert_eq!(kinds, vec![PL_SA, PL_NONCE, PL_TSI, PL_TSR]);
        let proposals = parse_sa(&payloads[0].1).expect("SA");
        let spi = &proposals[0].spi;
        let responder_spi = u32::from_be_bytes([spi[0], spi[1], spi[2], spi[3]]);
        let nr = payloads[1].1.clone();
        let (i_to_r, r_to_i) = crypto::child_key_material(&self.keys().sk_d, &[0x77; 32], &nr, 32).expect("keys");
        self.message_id += 1;
        EspSa::new(new_spi, responder_spi, GcmKey::new(&r_to_i).expect("key"), GcmKey::new(&i_to_r).expect("key"))
    }
}

#[test]
fn rekeying_the_child_sa_keeps_the_tunnel_up() {
    let mut responder = new_responder();
    let now = Instant::now();
    let mut phone = connect(&mut responder, DH_ECP_256, now);
    let new_spi = 0xC0FFEE02;
    let request = phone.rekey_request(new_spi);
    let outputs = responder.handle_datagram(Port::NatT, &request, phone_nat_t(), now);
    let (_, _, answer) = only_send(outputs);
    let mut new_esp = phone.read_rekey(&answer, new_spi);

    // Both Child SAs decrypt until the old one is deleted; replies use the new one.
    let packet = udp_packet(Ipv4Addr::new(10, 73, 0, 2), Ipv4Addr::new(1, 1, 1, 1));
    for esp in [phone.esp.as_mut().expect("old ESP"), &mut new_esp] {
        let sealed = esp.seal(&packet).expect("seal");
        assert_eq!(
            responder.handle_datagram(Port::NatT, &sealed, phone_nat_t(), now),
            vec![Output::Packet { peer: "p1".to_string(), packet: packet.clone() }]
        );
    }
    let reply = udp_packet(Ipv4Addr::new(1, 1, 1, 1), Ipv4Addr::new(10, 73, 0, 2));
    let Some(Output::Send { datagram, .. }) = responder.encapsulate(&reply) else { panic!("encrypts") };
    assert_eq!(new_esp.open(&datagram).expect("new SA decrypts"), reply);

    // The phone deletes the old Child SA: no Down, the new one carries on.
    let old_spi = phone.esp.as_ref().expect("old ESP").spi_in;
    let mut chain = ChainBuilder::new();
    chain.push(PL_DELETE, &build_delete(PROTO_ESP, &[old_spi.to_be_bytes()]));
    let delete = phone.encrypted(INFORMATIONAL, chain);
    let outputs = responder.handle_datagram(Port::NatT, &delete, phone_nat_t(), now);
    assert!(!outputs.iter().any(|o| matches!(o, Output::Down { .. })));
    let sealed = phone.esp.as_mut().expect("old ESP").seal(&packet).expect("seal");
    assert!(responder.handle_datagram(Port::NatT, &sealed, phone_nat_t(), now).is_empty());
    let sealed = new_esp.seal(&packet).expect("seal");
    assert_eq!(responder.handle_datagram(Port::NatT, &sealed, phone_nat_t(), now).len(), 1);
}

#[test]
fn rekeying_the_ike_sa_keeps_the_tunnel_and_child_sas() {
    let mut responder = new_responder();
    let now = Instant::now();
    let mut phone = connect(&mut responder, DH_ECP_256, now);

    // Send a packet through the Child SA first to verify it works
    let packet = udp_packet(Ipv4Addr::new(10, 73, 0, 2), Ipv4Addr::new(1, 1, 1, 1));
    let sealed = phone.esp.as_mut().expect("ESP").seal(&packet).expect("seal");
    assert_eq!(
        responder.handle_datagram(Port::NatT, &sealed, phone_nat_t(), now),
        vec![Output::Packet { peer: "p1".to_string(), packet: packet.clone() }]
    );

    // Rekey the IKE SA (RFC 7296 §1.3.2)
    let new_spi_i: u64 = 0xA1A2_A3A4_A5A6_A7A8;
    let private = EphemeralPrivateKey::generate(&ECDH_P256, &SystemRandom::new()).expect("key");
    let public = private.compute_public_key().expect("public key");
    let ke_data = public.as_ref()[1..].to_vec();

    let mut chain = ChainBuilder::new();
    chain.push(
        PL_SA,
        &build_sa(&Proposal {
            number: 1,
            protocol: PROTO_IKE,
            spi: new_spi_i.to_be_bytes().to_vec(),
            transforms: vec![
                transform(TT_ENCR, ENCR_AES_GCM_16, Some(256)),
                transform(TT_PRF, PRF_HMAC_SHA2_256, None),
                transform(TT_DH, DH_ECP_256, None),
            ],
        }),
    );
    chain.push(PL_KE, &build_ke(DH_ECP_256, &ke_data));
    chain.push(PL_NONCE, &phone.ni);
    let request = phone.encrypted(CREATE_CHILD_SA, chain);

    let (_, _, answer) = only_send(responder.handle_datagram(Port::NatT, &request, phone_nat_t(), now));
    let payloads = phone.decrypt(&answer, CREATE_CHILD_SA);

    // The answer must have SA, KE, and Nonce payloads
    assert_eq!(payloads.len(), 3);
    assert_eq!(payloads[0].0, PL_SA);
    assert_eq!(payloads[1].0, PL_KE);
    assert_eq!(payloads[2].0, PL_NONCE);

    // Verify Child SA traffic still flows without interruption
    let sealed = phone.esp.as_mut().expect("ESP").seal(&packet).expect("seal");
    assert_eq!(
        responder.handle_datagram(Port::NatT, &sealed, phone_nat_t(), now),
        vec![Output::Packet { peer: "p1".to_string(), packet: packet.clone() }]
    );
}

#[test]
fn rekeying_an_unknown_child_sa_is_refused() {
    let mut responder = new_responder();
    let now = Instant::now();
    let mut phone = connect(&mut responder, DH_ECP_256, now);
    phone.esp.as_mut().expect("ESP").spi_in = 0x1234_5678;
    let request = phone.rekey_request(0xC0FFEE03);
    let (_, _, answer) = only_send(responder.handle_datagram(Port::NatT, &request, phone_nat_t(), now));
    let payloads = phone.decrypt(&answer, CREATE_CHILD_SA);
    assert_eq!(parse_notify(&payloads[0].1).expect("notify").kind, N_CHILD_SA_NOT_FOUND);
}

#[test]
fn under_load_ike_sa_init_needs_a_cookie() {
    // The cap is 4 in these tests, so from 2 half-open SAs on a cookie is needed.
    let mut responder = new_responder();
    let now = Instant::now();
    for i in 0..2u64 {
        let mut phone = Phone::new(DH_ECP_256);
        phone.spi_i = 0x2000 + i;
        let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &phone.sa_init(None), phone_ike(), now));
        assert_ne!(Header::parse(&datagram).expect("header").spi_r, 0);
    }
    let cookie_of = |datagram: &[u8]| {
        let header = Header::parse(datagram).expect("header");
        assert_eq!(header.spi_r, 0, "a cookie request creates no SA");
        let payloads = parse_chain(header.next_payload, &datagram[HEADER_LEN..]).expect("payloads");
        let notify = parse_notify(payloads[0].body).expect("notify");
        assert_eq!(notify.kind, N_COOKIE);
        notify.data.to_vec()
    };

    let mut phone = Phone::new(DH_ECP_256);
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &phone.sa_init(None), phone_ike(), now));
    let cookie = cookie_of(&datagram);
    assert_eq!(responder.sa_count(), 2);

    // The cookie from another address, or a changed one, doesn't count.
    phone.cookie = Some(cookie.clone());
    let other: SocketAddr = "192.168.1.99:500".parse().expect("address");
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &phone.sa_init(None), other, now));
    cookie_of(&datagram);
    let mut wrong = cookie.clone();
    wrong[0] ^= 1;
    phone.cookie = Some(wrong);
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &phone.sa_init(None), phone_ike(), now));
    cookie_of(&datagram);

    // With the right cookie the whole connection goes through, AUTH included (it covers the
    // IKE_SA_INIT that carried the cookie).
    phone.cookie = Some(cookie);
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &phone.sa_init(None), phone_ike(), now));
    phone.read_sa_init(&datagram);
    let auth = phone.auth_request();
    let outputs = responder.handle_datagram(Port::NatT, &auth, phone_nat_t(), now);
    assert!(outputs.iter().any(|o| matches!(o, Output::Up { .. })));
    let (_, _, answer) = only_send(outputs);
    phone.read_auth(&answer);
}

/// IKE_SA_INIT, repeated with the cookie when the responder asks for one. Returns the answer.
fn sa_init_with_cookie(responder: &mut Responder<TestCredentials>, phone: &mut Phone, from: SocketAddr, now: Instant) -> Vec<u8> {
    phone.cookie = None;
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &phone.sa_init(None), from, now));
    let header = Header::parse(&datagram).expect("header");
    if header.spi_r != 0 {
        return datagram;
    }
    let payloads = parse_chain(header.next_payload, &datagram[HEADER_LEN..]).expect("payloads");
    let notify = parse_notify(payloads[0].body).expect("notify");
    assert_eq!(notify.kind, N_COOKIE);
    phone.cookie = Some(notify.data.to_vec());
    let (_, _, datagram) = only_send(responder.handle_datagram(Port::Ike, &phone.sa_init(None), from, now));
    datagram
}
