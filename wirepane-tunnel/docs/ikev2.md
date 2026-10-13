# IKEv2 front-end: VPN mode without an extra app

Status (2026-10-13): design, a sans-IO protocol engine, its UDP listener and the wiring into `Tunnel` (`--ikev2 <ip:port>`, `add-peer` with `"kind":"ikev2"`), with tests in `src/frontend/ikev2/`: RFC 4231 and GCM-spec vectors, an independent key-schedule cross-check, a software initiator through the responder, through real loopback sockets, and through the whole `Tunnel` (handshake, DNS over ESP through the core, restart, revocation), plus garbage input. `ikev2::supported()` is `true`. Not yet done: the server's `ikev2-profile` action and `--ikev2` on start (T0's interceptor), and a real iPhone (§10). Plan: `docs/plans/2026-10-13-rust-network-tools.md`, task T1.

WireGuard mode needs the WireGuard app on the phone. iOS has an IKEv2/IPsec client built in, configured by a `.mobileconfig` profile, so a second front-end that speaks IKEv2 lets an iPhone use VPN mode with nothing but Settings. It is a second front-end next to `frontend/wireguard.rs`: it turns ESP into the same plain IPv4 packets, and the shared core treats them exactly like WireGuard's.

```
iPhone (Settings › VPN, IKEv2) --UDP 500: IKE_SA_INIT------------------> wirepane-tunnel (ikev2)
                               --UDP 4500: IKE_AUTH, INFORMATIONAL, ESP-->  | decrypted IPv4 packets
                                                                            v
                                            its own network layer + core, the same hooks as WireGuard
```

## 1. What iOS proposes, and what our profile pins

The IKEv2 dictionary of Apple's `com.apple.vpn.managed` payload has `IKESecurityAssociationParameters` and `ChildSecurityAssociationParameters`, each with `EncryptionAlgorithm` (DES, 3DES, AES-128, AES-256, AES-128-GCM, AES-256-GCM, ChaCha20Poly1305), `IntegrityAlgorithm` (SHA1-96, SHA1-160, SHA2-256, SHA2-384, SHA2-512), `DiffieHellmanGroup` (1, 2, 5, 14 to 21, 31, 32) and `LifeTimeInMinutes` (10 to 1440). Apple's reference gives AES-256 (CBC), SHA2-256 and group 14 as the defaults when the keys are missing; what exactly iOS 26 sends without them has not been captured on a device yet.

We don't depend on the defaults: Wirepane writes the profile, so it pins one proposal and the engine accepts that one (plus a few safe neighbours). When the parameters are set, iOS sends a single proposal built from them.

| Profile key                                      | Value            | On the wire (IANA)                                                    |
| ------------------------------------------------ | ---------------- | --------------------------------------------------------------------- |
| IKE `EncryptionAlgorithm`                        | `AES-256-GCM`    | ENCR_AES_GCM_16 (20), Key Length 256; no INTEG transform (RFC 5282)   |
| IKE `IntegrityAlgorithm`                         | `SHA2-256`       | used as the PRF: PRF_HMAC_SHA2_256 (5)                                |
| IKE `DiffieHellmanGroup`                         | `19`             | 256-bit random ECP group, NIST P-256 (RFC 5903)                       |
| Child `EncryptionAlgorithm`                      | `AES-256-GCM`    | ESP ENCR_AES_GCM_16 (20), 256; ESN: No ESN (0)                        |
| Child `IntegrityAlgorithm`, `DiffieHellmanGroup` | `SHA2-256`, `19` | only used for PFS on rekey; `EnablePFS` stays 0, so rekeys have no KE |
| `LifeTimeInMinutes` (both)                       | `1440`           | iOS rekeys about once a day                                           |

The engine also accepts group 31 (Curve25519, RFC 8031) and AES-128-GCM, so a later profile can switch without a sidecar change. It does not implement CBC + HMAC or MODP groups: nothing we ship asks for them, and every extra transform is code that can be wrong.

Other profile keys we set: `DisableMOBIKE = 1` (no address updates mid-session, so the endpoint only changes through NAT-T, see §4), `DisableRedirect = 1`, `EnablePFS = 0`, `DeadPeerDetectionRate = Medium`, `UseConfigurationAttributeInternalIPSubnet = 0`, `NATKeepAliveOffloadEnable = 1`, `OnDemandEnabled = 0` (the user turns it on in Settings › VPN).

## 2. Authentication: a per-device shared secret, both ways

Choices considered:

1. **Server certificate (signed by the Wirepane CA, the Mac's LAN IP in its SAN) + a per-device client certificate.** The profile has to carry a PKCS#12 identity (key + certificate) and its password, the server needs X.509 building and parsing plus RSA/ECDSA signatures, and the server certificate has to be issued again whenever the Mac's LAN IP changes.
2. **Server certificate + EAP (username/password).** iOS supports it, but EAP-MSCHAPv2 needs MD4 and DES, and EAP-TLS is option 1 again.
3. **A per-device pre-shared key, used by both sides (RFC 7296 §2.15, "Shared Key Message Integrity Code").** Chosen.

Why 3: `AuthenticationMethod = SharedSecret` is the IKEv2 dictionary's default and the simplest case iOS has. The profile needs no identity payload, so installing it asks for no password; there is no certificate that expires or has to name the Mac's current IP; and the engine needs no signatures or X.509 at all, only the DH, PRF and AEAD it needs anyway, so the code that parses network input stays small. iOS uses the same method for both directions with `SharedSecret` (a server certificate with a client PSK is not a combination its profile can express).

The known weakness of IKEv2 PSKs is an offline dictionary attack on a weak, human-chosen secret. Ours is 32 random bytes per device (base64 in the profile), so that doesn't apply. Each device has its own identity and secret: removing the device in Wirepane revokes it alone.

- The phone's identity (`LocalIdentifier`, sent as IDi) is `<peer id>.wirepane` (`ID_FQDN`), e.g. `p3.wirepane`. The engine looks the secret up by IDi; an unknown identity gets AUTHENTICATION_FAILED.
- The server's identity (`RemoteIdentifier`, our IDr) is `vpn.wirepane` (`ID_FQDN`). iOS checks that our IDr matches it.
- The secret is derived, not stored: `PSK = HMAC-SHA256(server private key, "wirepane ikev2 psk v1" || peer id)`. The server key already lives in the `0600` state file, peer ids are never reused, and so a removed peer's secret can never come back.
- AUTH comparison is constant-time (`ring::hmac::verify`).

Trade-off, stated plainly: whoever has the profile can act as that phone (like a leaked WireGuard QR) and could also act as the Mac towards that phone. The second needs an active attacker on the same Wi-Fi, who could equally replace the profile during a plain-HTTP download (see §8), so certificates would not buy real protection here. The Wirepane CA's private key is never in the profile, so HTTPS interception still needs the Mac. Option 1 stays the upgrade path if a profile is ever handed out through an untrusted channel.

## 3. Exchanges the responder handles

| Exchange             | Request (from the iPhone)                                                               | Our response                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| IKE_SA_INIT (34)     | HDR, SAi1, KEi, Ni, N(NAT_DETECTION_SOURCE_IP), N(NAT_DETECTION_DESTINATION_IP), others | HDR, SAr1, KEr, Nr, N(NAT_DETECTION_SOURCE_IP), N(NAT_DETECTION_DESTINATION_IP); or N(INVALID_KE_PAYLOAD, group), N(NO_PROPOSAL_CHOSEN) |
| IKE_AUTH (35)        | HDR, SK{IDi, [IDr], AUTH, CP(CFG_REQUEST), SAi2, TSi, TSr, N(...)}                      | HDR, SK{IDr, AUTH, CP(CFG_REPLY), SAr2, TSi, TSr}; or SK{N(AUTHENTICATION_FAILED)}                                                      |
| INFORMATIONAL (37)   | HDR, SK{} (dead peer detection) or SK{D(...)}                                           | HDR, SK{} or SK{D(our SPIs)}; a Delete of the IKE SA tears everything down                                                              |
| CREATE_CHILD_SA (36) | rekey of the Child SA: SK{N(REKEY_SA), SA, Ni, TSi, TSr}, no KE (EnablePFS = 0)            | SK{SA, Nr, TSi, TSr}; the old Child SA keeps decrypting until the phone deletes it. A new extra Child SA, PFS or an IKE SA rekey: N(NO_ADDITIONAL_SAS) / N(NO_PROPOSAL_CHOSEN), and iOS reconnects (at most once a day, see §1) |

- Message IDs: one request window, as RFC 7296 §2.3 allows. A retransmitted request (same Message ID) gets the cached response again; anything else out of order is dropped.
- Unknown notifies that aren't errors (INITIAL_CONTACT, IKEV2_FRAGMENTATION_SUPPORTED, SIGNATURE_HASH_ALGORITHMS, ESP_TFC_PADDING_NOT_SUPPORTED, MOBIKE_SUPPORTED ...) are ignored. We never send IKEV2_FRAGMENTATION_SUPPORTED or MOBIKE_SUPPORTED, so iOS uses neither. PSK messages are small (no certificates), so no IKE fragmentation is needed.
- Unknown payloads with the critical bit set get UNSUPPORTED_CRITICAL_PAYLOAD, as the RFC requires.
- Half-open SAs (IKE_SA_INIT done, no IKE_AUTH) expire after 30 s and are capped (64). From half the cap on, IKE_SA_INIT needs a stateless cookie (RFC 7296 §2.6): the responder answers N(COOKIE) with HMAC-SHA-256(secret, Ni | IP | port | SPIi) and does no DH and keeps no state until the phone repeats the request with it, so a flood from forged addresses costs one HMAC per packet. At the cap the oldest half-open SA makes room.
- Traffic selectors: iOS asks for everything (0.0.0.0/0, ::/0 both ways). We answer TSi = the phone's tunnel address /32 and TSr = 0.0.0.0/0 (IPv4 only, like the WireGuard side: IPv6 is not carried in v1 and our DNS answers AAAA empty).
- Configuration payload: CP(CFG_REPLY) with INTERNAL_IP4_ADDRESS = the peer's tunnel address (from the same allocator and net as WireGuard peers, `10.73.0.0/24`) and INTERNAL_IP4_DNS = `10.73.0.53`. Requests for IPv6 attributes are not answered.

## 4. Ports and NAT traversal

- iOS sends IKE_SA_INIT to UDP 500, then floats to 4500 when it detects a NAT (RFC 7296 §2.23). Its profile has no port setting, so the sidecar must listen on exactly 500 and 4500. macOS lets unprivileged processes bind both (checked on the dev Mac, 2026-10-13); Linux needs `CAP_NET_BIND_SERVICE` or `net.ipv4.ip_unprivileged_port_start`, Windows usually works. The Mac's own IKEv2 client also uses these ports while it is connected to a VPN; then binding fails and the UI says so.
- **ESP must always be UDP-encapsulated**, because a process without root can't receive raw IP protocol 50. On one Wi-Fi there is no NAT, so iOS would send plain ESP. The responder therefore always sends a NAT_DETECTION_SOURCE_IP hash that doesn't match its real address (RFC 7296 §2.23 allows faking it to force encapsulation; strongSwan's `encap = yes` does the same). iOS then believes the server is behind a NAT, moves to 4500 for IKE_AUTH and sends ESP in UDP 4500 (RFC 3948).
- On 4500, IKE messages start with the four-byte non-ESP marker (zeros); ESP packets start with the SPI (never zero); a single `0xFF` byte is a NAT keepalive and is ignored.
- The phone's address: the source of the last authenticated IKE message or ESP packet. A forged datagram can't move it, like on the WireGuard side.

## 5. Key schedule (RFC 7296 §2.14, §2.17; RFC 5282)

- `SKEYSEED = prf(Ni | Nr, g^ir)` with prf = HMAC-SHA-256. `g^ir` is the x coordinate of the P-256 shared point (RFC 5903 §9 as corrected by its errata, 32 bytes) or the X25519 output (RFC 8031).
- `{SK_d | SK_ai | SK_ar | SK_ei | SK_er | SK_pi | SK_pr} = prf+(SKEYSEED, Ni | Nr | SPIi | SPIr)`, where `prf+(K, S) = T1 | T2 | ...`, `T1 = prf(K, S | 0x01)`, `Tn = prf(K, Tn-1 | S | n)`.
- SK_d, SK_pi, SK_pr are 32 bytes (the PRF's output size). With an AEAD, SK_ai and SK_ar are empty and SK_ei / SK_er are the AES key plus a 4-byte salt (36 bytes for AES-256-GCM).
- The first Child SA: `KEYMAT = prf+(SK_d, Ni | Nr)`; first the initiator-to-responder key + salt, then the responder-to-initiator key + salt.
- AUTH (PSK): `AUTH = prf(prf(PSK, "Key Pad for IKEv2"), SignedOctets)`; the phone's SignedOctets are its IKE_SA_INIT request, our Nr and `prf(SK_pi, IDi body)`; ours are our IKE_SA_INIT response, Ni and `prf(SK_pr, IDr body)`.
- The SK payload with AES-GCM (RFC 5282): 8-byte explicit IV, nonce = salt | IV, AAD = from the first byte of the IKE header to the end of the SK payload's generic header, 16-byte ICV. Our IVs are a per-SA counter, so a nonce never repeats under one key.

## 6. ESP (RFC 4303, AES-GCM per RFC 4106)

- `SPI | Sequence | IV(8) | ciphertext(IPv4 packet | padding | pad length | next header = 4) | ICV(16)`; AAD = SPI | Sequence (no extended sequence numbers); nonce = salt | IV. Our padding brings the ciphertext to a multiple of 4 bytes with the RFC's 1, 2, 3, ... pattern; received padding is only checked for its length, since the ICV already covers it and some stacks fill it with random bytes.
- Anti-replay: a 64-packet sliding window, updated only after the ICV checks out. Next header 59 (dummy packets for traffic-flow confidentiality) is dropped quietly.
- Our outbound sequence number never wraps: at 2^32 - 1 the Child SA stops sending (iOS rekeys long before, see §1).
- Inbound packets go through the same checks the WireGuard front-end does before smoltcp sees them (`accept_inbound`): IPv4 only, the source must be the peer's own tunnel address, no fragments, TCP/UDP/ICMP with non-zero ports.

## 7. How decrypted packets reach the core

Exactly like WireGuard's: the front-end hands `NetworkEvent::ReceivePacket` to mitmproxy's smoltcp network layer, which produces `TransportEvent`s for the core, and the core's replies come back as `NetworkCommand::SendPacket`, which the front-end encrypts for the peer that owns the destination address.

How it is wired (`Tunnel::start` in `src/lib.rs`, `start_side` in `listener.rs`): the IKEv2 phones get their own smoltcp network layer and their own `Core`, next to WireGuard's. Connection ids are per network layer and each core sends its commands to its own layer, so the two never mix, and the WireGuard front-end stays untouched. Both cores share the SOCKS address, the events and T0's hooks: DNS rules, the QUIC mode, the capture and network conditions (delay, bandwidth and loss, with the same delay queue as WireGuard). Not shared yet: the flow counters in `stats` (the IKEv2 core has its own `CoreStats`) and HTTP/3 decryption (its gateway injects into the WireGuard front-end, so IKEv2 phones get `block` or `relay`).

- `--ikev2 <ip:port>` is the IKE address; NAT-T is port 4500 when IKE is 500 (what iOS needs), any free port otherwise (tests). The `ready` event says `"ikev2":{"ike":"…","natT":"…"}`, or `null` when IKEv2 is off. A port that can't be bound only turns IKEv2 off (an `error` event), WireGuard keeps working.
- `{"cmd":"add-peer","name":"iPhone","kind":"ikev2"}` uses the same ids and addresses as WireGuard peers and answers `{"event":"peer-added","peer":"p3","name":"iPhone","kind":"ikev2","tunnelIp":"10.73.0.4","config":"","ikev2":{"localId":"p3.wirepane","remoteId":"vpn.wirepane","psk":"<base64>"}}`. The state file stores it with `kind: "ikev2"`; its secret is derived again on every start, and its WireGuard key fields hold a fresh, unused key only so that older builds, which read a key for every peer, still start.
- `remove-peer`, `list-peers` and the per-phone bytes in `stats` work for both kinds (the IKEv2 core's flow counters aren't added to `stats` yet); removal cuts an IKEv2 phone off within 250 ms. IKEv2 has no handshake every two minutes like WireGuard, so an IKEv2 phone's `lastHandshake` is its last authenticated packet, and the UI's freshness check (3 minutes) means the same for both kinds.
- Later, for one shared layer: a packet router for `NetworkCommand::SendPacket` and `InjectedPacket` by destination address, and `CombinedDirectory(wg, ikev2)` (already in `listener.rs`) as the core's directory.

The engine itself (`Responder` in `src/frontend/ikev2/responder.rs`) is sans-IO: `handle_datagram(port, bytes, from, now)` returns datagrams to send, decrypted packets and Up/Down; `encapsulate(packet)` seals a packet for the phone that owns its destination; `tick(now)` expires half-open and dead SAs; `remove_peer(id)` revokes. Its tests drive it with a software initiator written in the test module (`responder/tests.rs`), so no sockets are involved.

`src/frontend/ikev2/listener.rs` is the IO side:

- `start(Ikev2Params { ike, nat_t, peers, events, dns, inbound, outbound }, shutdown)` binds both sockets and runs the responder; `nat_t_address(ike)` gives 4500 for 500 and a free port otherwise (tests).
- `inbound` carries `(peer id, IPv4 packet, phone address)`; `network_event(packet, from, local)` turns one into the `NetworkEvent::ReceivePacket` a network layer takes. `outbound` takes IPv4 packets for IKEv2 phones.
- `start_side(Ikev2SideParams { ike, peers, core, events, socks, hooks }, shutdown)` is what `Tunnel` calls: the listener plus its own network layer and core, and a pump that runs every packet both ways through the hooks (conditions with the delay queue, capture, loss). It returns `Ikev2Side { ike_addr, nat_t_addr, stats }`.
- `Ikev2Peers` holds the phones (`add(id, name, tunnel_ip, profile_secret(server key, id))`, `remove`, `summaries` with bytes up and down); `Ikev2Directory` is the IKEv2 core's `PeerDirectory`, so tags (`wirepane-vpn-peer:<id>`, `wirepane-vpn-endpoint:<ip>`, `wirepane-vpn-name:<dns name>`) work the same; `CombinedDirectory(wg, ikev2)` is for a later shared layer.
- `peer_added_details(server key, id)` (`mod.rs`) is the `ikev2` part of the `peer-added` event; `profile_secret` is the profile's `SharedSecret` text, whose bytes are the IKE PSK.
- A `peer` event (same shape as WireGuard's) goes out when a phone authenticates or moves.

## 8. The profile and how the iPhone gets it

`httptoolkit-server/src/interceptors/wireguard-vpn-ikev2.ts` builds one `.mobileconfig` (XML plist) per device:

- `com.apple.security.root`: the Wirepane CA (public certificate only), so one profile installs both the VPN and the CA. The user still has to turn on full trust in Settings › General › About › Certificate Trust Settings: iOS never does that for a downloaded profile.
- `com.apple.vpn.managed`, `VPNType = IKEv2`: `RemoteAddress` = the Mac's LAN IP, `RemoteIdentifier = vpn.wirepane`, `LocalIdentifier = p3.wirepane`, `AuthenticationMethod = SharedSecret`, `SharedSecret`, the pinned parameters of §1.
- No signature on the profile (we have no signing identity); iOS shows it as "Not Signed", like the certificate profile today.

How the phone gets it, before the VPN exists (`http://wirepane.cert/...` only works through the proxy or the tunnel, so it can't be the first step):

1. **AirDrop** (recommended): "Save profile" in the UI, then AirDrop it to the iPhone. Encrypted, nothing on the network. iOS says "Profile Downloaded"; it then shows up at the top of Settings.
2. **Safari over the LAN**: the server serves the profile once from a short-lived listener on the Mac's LAN address, at `http://<Mac IP>:<random port>/<128-bit random token>.mobileconfig`, shown as a link and a QR code. It answers one successful download and closes after it or after 10 minutes. The download is plain HTTP (the phone can't trust our CA yet), so someone sniffing the same Wi-Fi at that moment could read the secret: on an untrusted network use AirDrop.

The profile holds the device's secret: it must not be logged, cached by the UI, or left on disk.

## 9. Security checklist

- Every parser takes `&[u8]` and returns `Result`/`Option`; lengths are checked before every slice; no `unwrap` or panicking index on network input; garbage-input tests cover truncation at every byte and random bytes.
- Primitives come from `ring` (HMAC-SHA-256, AES-GCM, P-256 and X25519 key agreement, SHA-1 for the NAT detection hashes). Nothing is hand-written. Tags are checked by `ring`'s AEAD open; AUTH and cookies by `ring::hmac::verify` (constant time).
- Half-open SAs are capped, need a cookie under load and expire; established SAs expire after 30 minutes without any authenticated packet (iOS's DPD runs every 10 minutes at `Medium`).
- Answers only go to the address a request came from and are no bigger than it (an IKE_SA_INIT answer is about 250 bytes for iOS's request of about 300, a cookie answer about 60), so the responder is no amplifier. A retransmitted request is only answered again if it still decrypts.

## 10. Real-iPhone checks still to do (the owner's)

0. First the server needs its `ikev2-profile` action and has to start the sidecar with `--ikev2 0.0.0.0:500` (T0's interceptor), and the dev server must run a sidecar built after this change. Then: Intercept › iPhone or iPad › "Without an app (IKEv2, beta)" › Show the steps › Create the profile.
1. Install the profile from AirDrop and from Safari; check iOS shows "Wirepane VPN" with the CA inside.
2. Turn on full trust for the Wirepane CA, then Settings › VPN › Wirepane: connects, the status bar shows "VPN".
3. Safari, an App Store app and a Flutter app show up in View with the `wirepane-vpn` tags.
4. Leave it connected for over 10 minutes with the screen off: DPD keeps it up; switching Wi-Fi off and on reconnects.
5. Note the proposals the iPhone sends (sidecar log at `debug`), to fill in §1's "what iOS 26 sends without the keys".
6. If it doesn't connect, run with `WIREPANE_TUNNEL_LOG=info` and look for "no acceptable IKE proposal", "no acceptable ESP proposal" (the line shows what iOS offered), "wrong secret", "unknown identity" or "stayed on UDP 500".
7. Remove the device in Wirepane: the iPhone's VPN stops passing traffic within a second, and reconnecting fails with an authentication error.
