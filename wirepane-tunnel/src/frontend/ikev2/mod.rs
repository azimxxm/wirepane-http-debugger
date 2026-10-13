//! IKEv2/IPsec front-end (T1): iOS's built-in VPN, so a phone needs no extra app. It decrypts ESP
//! (UDP 4500, NAT-T) into the same plain IP packets the WireGuard front-end produces, and the
//! shared core handles them the same way. The protocol engine stays sans-IO so it can be tested
//! with RFC vectors; T1 wires the UDP listener in behind `--ikev2 <ip:port>` once T0 has added
//! that option.

/// Whether this build can serve IKEv2. Stub: no.
pub fn supported() -> bool {
    false
}
