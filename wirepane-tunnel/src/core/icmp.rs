//! ICMP errors the core sends back to a phone through the tunnel.
//!
//! The only one today is "port unreachable" for blocked QUIC: a phone that gets it on a connected
//! UDP socket fails the connection at once and falls back to TCP, instead of waiting for its own
//! timer like it would after a silent drop.

use std::net::{Ipv4Addr, SocketAddrV4};

const IPV4_HEADER_SIZE: usize = 20;
const UDP_HEADER_SIZE: usize = 8;
const ICMP_HEADER_SIZE: usize = 8;
const TTL: u8 = 64;
const PROTOCOL_ICMP: u8 = 1;
const PROTOCOL_UDP: u8 = 17;
/// Type of service "internet control", what routers and hosts put on ICMP errors.
const TOS_INTERNET_CONTROL: u8 = 0xC0;
const ICMP_DESTINATION_UNREACHABLE: u8 = 3;
const CODE_PORT_UNREACHABLE: u8 = 3;

/// The internet checksum (RFC 1071) over several byte strings taken as one.
fn checksum(parts: &[&[u8]]) -> u16 {
    let mut sum: u32 = 0;
    let mut high: Option<u8> = None;
    for &byte in parts.iter().flat_map(|part| part.iter()) {
        match high.take() {
            Some(first) => sum += u32::from(u16::from_be_bytes([first, byte])),
            None => high = Some(byte),
        }
    }
    if let Some(first) = high {
        sum += u32::from(u16::from_be_bytes([first, 0]));
    }
    while sum > 0xFFFF {
        sum = (sum & 0xFFFF) + (sum >> 16);
    }
    !(sum as u16)
}

fn clamp_u16(value: usize) -> u16 {
    u16::try_from(value).unwrap_or(u16::MAX)
}

fn ipv4_header(total_len: usize, protocol: u8, tos: u8, src: Ipv4Addr, dst: Ipv4Addr) -> [u8; IPV4_HEADER_SIZE] {
    let mut header = [0u8; IPV4_HEADER_SIZE];
    header[0] = 0x45; // version 4, 5 words of header
    header[1] = tos;
    header[2..4].copy_from_slice(&clamp_u16(total_len).to_be_bytes());
    // Identification and fragment fields stay zero: nothing here is ever fragmented.
    header[8] = TTL;
    header[9] = protocol;
    header[12..16].copy_from_slice(&src.octets());
    header[16..20].copy_from_slice(&dst.octets());
    let sum = checksum(&[&header]);
    header[10..12].copy_from_slice(&sum.to_be_bytes());
    header
}

/// The UDP header of the datagram the phone sent, checksum included.
fn udp_header(from: SocketAddrV4, to: SocketAddrV4, payload: &[u8]) -> [u8; UDP_HEADER_SIZE] {
    let udp_len = UDP_HEADER_SIZE + payload.len();
    let mut header = [0u8; UDP_HEADER_SIZE];
    header[0..2].copy_from_slice(&from.port().to_be_bytes());
    header[2..4].copy_from_slice(&to.port().to_be_bytes());
    header[4..6].copy_from_slice(&clamp_u16(udp_len).to_be_bytes());
    let mut pseudo = [0u8; 12];
    pseudo[0..4].copy_from_slice(&from.ip().octets());
    pseudo[4..8].copy_from_slice(&to.ip().octets());
    pseudo[9] = PROTOCOL_UDP;
    pseudo[10..12].copy_from_slice(&clamp_u16(udp_len).to_be_bytes());
    let sum = match checksum(&[&pseudo, &header, payload]) {
        0 => 0xFFFF, // zero means "no checksum" in UDP
        sum => sum,
    };
    header[6..8].copy_from_slice(&sum.to_be_bytes());
    header
}

/// A plain IPv4 UDP datagram from `from` to `to`, checksums included: what the QUIC gateway's
/// answers become before the front-end encrypts them for the phone.
pub fn udp_datagram(from: SocketAddrV4, to: SocketAddrV4, payload: &[u8]) -> Vec<u8> {
    let total = IPV4_HEADER_SIZE + UDP_HEADER_SIZE + payload.len();
    let mut packet = Vec::with_capacity(total);
    packet.extend_from_slice(&ipv4_header(total, PROTOCOL_UDP, 0, *from.ip(), *to.ip()));
    packet.extend_from_slice(&udp_header(from, to, payload));
    packet.extend_from_slice(payload);
    packet
}

/// The IPv4 packet a host sends when nothing listens on the UDP port a datagram was addressed to
/// (RFC 792, type 3 code 3). `from` is the phone, `to` the server it tried to reach and `payload`
/// the datagram's data. The error is sent as `to` and quotes the datagram's IPv4 header plus its
/// first 8 bytes (the UDP header), rebuilt from what the core knows, which is all a phone needs to
/// match it to the socket.
pub fn port_unreachable(from: SocketAddrV4, to: SocketAddrV4, payload: &[u8]) -> Vec<u8> {
    let original_len = IPV4_HEADER_SIZE + UDP_HEADER_SIZE + payload.len();
    let mut icmp = Vec::with_capacity(ICMP_HEADER_SIZE + IPV4_HEADER_SIZE + UDP_HEADER_SIZE);
    icmp.extend_from_slice(&[ICMP_DESTINATION_UNREACHABLE, CODE_PORT_UNREACHABLE, 0, 0, 0, 0, 0, 0]);
    icmp.extend_from_slice(&ipv4_header(original_len, PROTOCOL_UDP, 0, *from.ip(), *to.ip()));
    icmp.extend_from_slice(&udp_header(from, to, payload));
    let sum = checksum(&[&icmp]);
    icmp[2..4].copy_from_slice(&sum.to_be_bytes());

    let mut packet = Vec::with_capacity(IPV4_HEADER_SIZE + icmp.len());
    packet.extend_from_slice(&ipv4_header(
        IPV4_HEADER_SIZE + icmp.len(),
        PROTOCOL_ICMP,
        TOS_INTERNET_CONTROL,
        *to.ip(),
        *from.ip(),
    ));
    packet.extend_from_slice(&icmp);
    packet
}

#[cfg(test)]
mod tests {
    use super::*;
    use smoltcp::wire::{Icmpv4Message, Icmpv4Packet, IpProtocol, Ipv4Packet};

    fn sample() -> Vec<u8> {
        let phone = SocketAddrV4::new(Ipv4Addr::new(10, 73, 0, 2), 40123);
        let server = SocketAddrV4::new(Ipv4Addr::new(142, 250, 1, 100), 443);
        port_unreachable(phone, server, &[0xC0, 1, 2, 3, 4, 5, 6])
    }

    #[test]
    fn is_a_valid_icmp_port_unreachable_from_the_server() {
        let bytes = sample();
        let ip = Ipv4Packet::new_checked(&bytes[..]).expect("a well-formed IPv4 packet");
        assert!(ip.verify_checksum(), "the IPv4 header checksum");
        assert_eq!(ip.src_addr(), Ipv4Addr::new(142, 250, 1, 100));
        assert_eq!(ip.dst_addr(), Ipv4Addr::new(10, 73, 0, 2));
        assert_eq!(ip.next_header(), IpProtocol::Icmp);
        assert_eq!(usize::from(ip.total_len()), bytes.len());

        let icmp = Icmpv4Packet::new_checked(ip.payload()).expect("a well-formed ICMP message");
        assert!(icmp.verify_checksum(), "the ICMP checksum");
        assert_eq!(icmp.msg_type(), Icmpv4Message::DstUnreachable);
        assert_eq!(icmp.msg_code(), 3, "code 3 is port unreachable");
    }

    #[test]
    fn quotes_the_original_header_and_eight_bytes() {
        let bytes = sample();
        let ip = Ipv4Packet::new_checked(&bytes[..]).unwrap();
        let icmp = Icmpv4Packet::new_checked(ip.payload()).unwrap();
        let quote = icmp.data();
        assert_eq!(quote.len(), IPV4_HEADER_SIZE + UDP_HEADER_SIZE, "header + 8 bytes");

        // The quoted datagram was too long for the quote, so its length field still says so.
        let original = Ipv4Packet::new_unchecked(quote);
        assert!(original.verify_checksum());
        assert_eq!(original.src_addr(), Ipv4Addr::new(10, 73, 0, 2));
        assert_eq!(original.dst_addr(), Ipv4Addr::new(142, 250, 1, 100));
        assert_eq!(original.next_header(), IpProtocol::Udp);
        assert_eq!(usize::from(original.total_len()), 20 + 8 + 7);

        let udp = &quote[IPV4_HEADER_SIZE..];
        assert_eq!(u16::from_be_bytes([udp[0], udp[1]]), 40123, "source port");
        assert_eq!(u16::from_be_bytes([udp[2], udp[3]]), 443, "destination port");
        assert_eq!(u16::from_be_bytes([udp[4], udp[5]]), 8 + 7, "UDP length");
    }

    #[test]
    fn a_udp_datagram_is_a_valid_ipv4_udp_packet() {
        use smoltcp::wire::{IpAddress, UdpPacket};
        let from = SocketAddrV4::new(Ipv4Addr::new(1, 1, 1, 1), 443);
        let to = SocketAddrV4::new(Ipv4Addr::new(10, 73, 0, 2), 50000);
        let packet = udp_datagram(from, to, b"quic answer");
        let ip = Ipv4Packet::new_checked(&packet[..]).unwrap();
        assert!(ip.verify_checksum());
        assert_eq!(ip.src_addr(), *from.ip());
        assert_eq!(ip.dst_addr(), *to.ip());
        let udp = UdpPacket::new_checked(ip.payload()).unwrap();
        assert_eq!(udp.src_port(), 443);
        assert_eq!(udp.dst_port(), 50000);
        assert_eq!(udp.payload(), b"quic answer");
        assert!(udp.verify_checksum(&IpAddress::Ipv4(*from.ip()), &IpAddress::Ipv4(*to.ip())));
    }

    #[test]
    fn the_quoted_udp_checksum_matches_the_datagram() {
        let phone = SocketAddrV4::new(Ipv4Addr::new(10, 73, 0, 2), 5000);
        let server = SocketAddrV4::new(Ipv4Addr::new(1, 2, 3, 4), 443);
        let payload = b"odd length!";
        let header = udp_header(phone, server, payload);
        // Adding the checksum into the sum over pseudo header, header and payload gives all ones.
        let mut pseudo = [0u8; 12];
        pseudo[0..4].copy_from_slice(&phone.ip().octets());
        pseudo[4..8].copy_from_slice(&server.ip().octets());
        pseudo[9] = PROTOCOL_UDP;
        pseudo[10..12].copy_from_slice(&((8 + payload.len()) as u16).to_be_bytes());
        assert_eq!(checksum(&[&pseudo, &header, payload]), 0);
    }

    #[test]
    fn huge_and_empty_datagrams_do_not_panic() {
        let phone = SocketAddrV4::new(Ipv4Addr::new(10, 73, 0, 2), 1);
        let server = SocketAddrV4::new(Ipv4Addr::new(8, 8, 8, 8), 443);
        assert_eq!(port_unreachable(phone, server, &[]).len(), 20 + 8 + 20 + 8);
        assert_eq!(port_unreachable(phone, server, &vec![7u8; 65_507]).len(), 20 + 8 + 20 + 8);
    }
}
