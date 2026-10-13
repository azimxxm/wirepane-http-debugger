//! IKEv2/IPsec front-end (T1): iOS's built-in VPN, so a phone needs no extra app. It decrypts ESP
//! (UDP 4500, NAT-T) into the same plain IP packets the WireGuard front-end produces, and the
//! shared core handles them the same way. The protocol engine stays sans-IO so it can be tested
//! with RFC vectors; `--ikev2 <ip:port>` starts the UDP listener next to WireGuard. Design:
//! `docs/ikev2.md`.
//!
//! - `wire`: message and payload parsing and building (RFC 7296 §3).
//! - `crypto`: the key schedule and the `ring` primitives (HMAC-SHA-256, AES-GCM, P-256, X25519).
//! - `esp`: ESP with AES-GCM (RFC 4303, RFC 4106), replay window.
//! - `responder`: the sans-IO responder: IKE_SA_INIT (with cookies under load), IKE_AUTH (PSK),
//!   CP, traffic selectors, INFORMATIONAL (dead peer detection, Delete), Child SA rekeying,
//!   timeouts.
//! - `listener`: the UDP 500/4500 sockets around the responder, the phones' secrets, the
//!   `PeerDirectory` the core uses for tags, and `start_side`: the IKEv2 phones' own network layer
//!   and core, which `Tunnel` starts for `--ikev2`.

pub mod crypto;
pub mod esp;
pub mod listener;
pub mod responder;
pub mod wire;

/// The server's identity (IDr), the profile's `RemoteIdentifier`.
pub const SERVER_IDENTITY: &str = "vpn.wirepane";
const IDENTITY_SUFFIX: &str = ".wirepane";
const PSK_LABEL: &[u8] = b"wirepane ikev2 psk v1";

/// Whether this build can serve IKEv2: `--ikev2 <ip:port>` starts it (docs/ikev2.md §7). Checked
/// end to end by `listener::tests::the_tunnel_serves_ikev2_phones` with a software initiator.
pub fn supported() -> bool {
    true
}

/// A phone's identity (IDi, the profile's `LocalIdentifier`): `<peer id>.wirepane`.
pub fn phone_identity(peer: &str) -> String {
    format!("{peer}{IDENTITY_SUFFIX}")
}

/// The peer id inside a phone's identity, when it is one of ours.
pub fn peer_from_identity(identity: &[u8]) -> Option<&str> {
    let text = std::str::from_utf8(identity).ok()?;
    let peer = text.strip_suffix(IDENTITY_SUFFIX)?;
    let valid = !peer.is_empty() && peer.len() <= 64 && peer.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_');
    valid.then_some(peer)
}

/// The phone's shared secret: HMAC-SHA-256(server private key, label | peer id). Nothing new is
/// stored, the state file's server key is already private, and peer ids are never reused, so a
/// removed phone's secret can't come back.
pub fn derive_psk(server_private_key: &[u8], peer: &str) -> [u8; 32] {
    crypto::prf(server_private_key, &[PSK_LABEL, peer.as_bytes()])
}

/// The `SharedSecret` string for the phone's profile: the derived secret in base64. iOS keys IKE
/// with the bytes of this string, so the responder's PSK is `profile_secret(..).into_bytes()`,
/// not the raw 32 bytes.
pub fn profile_secret(server_private_key: &[u8], peer: &str) -> String {
    data_encoding::BASE64.encode(&derive_psk(server_private_key, peer))
}

/// The `ikev2` part of a `peer-added` event for an IKEv2 phone: what the server writes into the
/// profile (docs/ikev2.md §7).
pub fn peer_added_details(server_private_key: &[u8], peer: &str) -> serde_json::Value {
    serde_json::json!({
        "localId": phone_identity(peer),
        "remoteId": SERVER_IDENTITY,
        "psk": profile_secret(server_private_key, peer),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identities_round_trip_and_reject_strangers() {
        assert_eq!(phone_identity("p3"), "p3.wirepane");
        assert_eq!(peer_from_identity(b"p3.wirepane"), Some("p3"));
        assert_eq!(peer_from_identity(b".wirepane"), None);
        assert_eq!(peer_from_identity(b"p3.example"), None);
        assert_eq!(peer_from_identity(b"p 3.wirepane"), None);
        assert_eq!(peer_from_identity(&[0xff, 0xfe]), None);
    }

    #[test]
    fn secrets_differ_per_peer_and_per_server() {
        let a = derive_psk(&[1; 32], "p1");
        assert_eq!(a, derive_psk(&[1; 32], "p1"));
        assert_ne!(a, derive_psk(&[1; 32], "p2"));
        assert_ne!(a, derive_psk(&[2; 32], "p1"));
        let text = profile_secret(&[1; 32], "p1");
        assert_eq!(text.len(), 44);
        assert_eq!(data_encoding::BASE64.decode(text.as_bytes()).expect("base64"), a.to_vec());
        assert!(supported());
        let details = peer_added_details(&[1; 32], "p1");
        assert_eq!(details["localId"], "p1.wirepane");
        assert_eq!(details["remoteId"], SERVER_IDENTITY);
        assert_eq!(details["psk"], text);
    }
}
