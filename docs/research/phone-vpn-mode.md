# Phone "VPN mode" (WireGuard): capture every app on iPhone and Android

Research and implementation plan, 2026-10-12. Status: research only, nothing is implemented yet.
Confidence labels: **[verified]** means read in a source during this run. **[local]** means read in this repo or in `node_modules`. **[inference]** means my own reasoning, to be confirmed in the spike. **[unverified]** means not checked in this run.

---

## Qisqa xulosa (o'zbekcha)

- **Tavsiya (Recommendation)**: Wirepane'ga kichik **Rust sidecar** (`wirepane-tunnel`) qo'shiladi. U mitmproxy_rs ichidagi MIT litsenziyali `mitmproxy` crate ustiga quriladi (boringtun + smoltcp). Telefon rasmiy **WireGuard** ilovasidan foydalanadi va konfiguratsiyani QR kod orqali oladi. Mac'da **root kerak emas**.
- **TCP**: har bir TCP oqim Mockttp portiga (9473) **SOCKS5** orqali uzatiladi. Bunda asl manzil (IP:port) va `custom-metadata` teglari birga yuboriladi. Shunda HTTP, TLS va noma'lum protokollar (raw tunnel) Mockttp'ning mavjud mantiqi orqali ko'rinadi. "Transparent" (to'g'ridan-to'g'ri) yo'naltirish yetarli emas: Mockttp manzilsiz noma'lum protokolni yopib qo'yadi.
- **UDP/DNS/QUIC**: Mockttp UDP'ni umuman bilmaydi. Shu sababli bu trafikni sidecar o'zi relay qiladi va metadata'ni (DNS so'rovlari, UDP oqim statistikasi, QUIC SNI) server orqali UI'ga uzatadi. Standart holatda QUIC (UDP/443) bloklanadi, shunda ilovalar TCP/TLS'ga qaytadi va trafikni dekodlash mumkin bo'ladi.
- **Asosiy xavf (Main risk)**: macOS 15+ **Local Network privacy**. LAN'dagi telefonga UDP javob yuborish uchun ruxsat kerak. Terminal'dan ishga tushirilganda bu cheklov ishlamaydi, shuning uchun testda muammo ko'rinmay qolishi mumkin. CA baribir trust qilinishi kerak. Pinning qilingan ilovalar baribir dekodlanmaydi.
- **Hajm (Effort)**: taxminan 4–6 hafta (bitta dasturchi), QUIC SNI'siz MVP 3–4 hafta.
- **Arzon interim yaxshilanishlar**: `unknown-protocol` passthrough'ni yoqish (hozir feature flag ortida va hech qachon yoqilmaydi), pinned hostlar uchun bir bosishda passthrough, iPhone sahifasida qamrov haqida tushuntirish va PAC varianti.

---

## 1. Problem and constraints

- **Today.** The phone points its Wi-Fi HTTP proxy at Wirepane's Mockttp port, which recently moved to 9473 (commit `4d630b632`). Only stacks that honour the system proxy show up. Flutter/Dart, game engines, custom sockets and QUIC bypass it (from the brief).
- **No own iOS NetworkExtension.** There is no Apple Developer account, so Wirepane must "borrow" an existing VPN client. The official WireGuard app is exactly that. mitmproxy's WireGuard mode is the proof that this works without a native companion app [verified]. Source: [mitmproxy Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/).
- **Desktop constraints.** macOS first, then Windows and Linux. Ideally no admin rights. Wirepane is AGPL-3.0-or-later (`httptoolkit-server/package.json`) [local], so MIT, BSD and Apache-2.0 components are fine.

## 2. What Mockttp does with non-CONNECT ("transparent") traffic, and why the sidecar must speak SOCKS5

All of this is read from `httptoolkit-server/node_modules/mockttp` 4.6.3 and `@httptoolkit/httpolyglot` 3.1.0 [local]:

- **Protocol sniffing.** Every accepted socket is classified by its first bytes (`httpolyglot/dist/index.js` lines 9–139):
  - `0x16` is TLS.
  - The HTTP/2 preface is HTTP/2.
  - `0x04` / `0x05` is a SOCKS v4 / v5 hello.
  - An HTTP/1 method is HTTP/1.
  - Anything else goes to the `unknownProtocol` handler.
- **Direct TLS (no CONNECT) works when SNI is present.** The TLS server mints a certificate per SNI via `SNICallback`. Without SNI it falls back to the default cert, `defaultDomain ?? 'localhost'`. Source: `dist/server/http-combo-server.js`, `createComboServer`.
- **Direct HTTP works through the Host header.** `requireHostHeader: false` is set so even garbage requests are handled (same file). This is why HTTP Toolkit's Android VPN can forward TCP "transparently" to the proxy port.
- **Unknown protocols need a destination from a tunnel.** The `passthrough: ['unknown-protocol']` option only passes through traffic "received on a proxy connection (a connection carrying end-destination information, such as SOCKS…)". Otherwise the socket gets `UNKNOWN_PROTOCOL_NO_DESTINATION` and is "closed with a 400 Bad Request". Source: `dist/mockttp.d.ts` passthrough docs and `http-combo-server.js`.
- **The SOCKS server is built in.** It handles SOCKS4/4a/5 and sets the tunnel address. It then re-emits the socket into the same combo server, so TLS, HTTP and unknown-protocol sniffing still apply inside the tunnel (`http-combo-server.js`, `socks-tcp-connect` handler). Its `authMethods` include `custom-metadata` (0xDA). This method lets the client send "2-byte-length-prefixed arbitrary JSON metadata… associated with all requests sent on this connection", and currently only `tags` is used (`dist/server/socks-server.d.ts`). The SOCKS server only emits `socks-tcp-connect`, so there is no UDP ASSOCIATE.
- **Events already exist.** Mockttp emits `raw-passthrough-opened/-data/-closed` and `tls-passthrough-opened` (`dist/mockttp.d.ts` lines 553 and 622–638). The UI already renders them: `httptoolkit-ui/src/model/raw-tunnel.ts`, `components/view/raw-tunnel-row.tsx` and `raw-tunnel-details-pane.tsx`.
- **What Wirepane sets today.**
  - The proxy starts with `socks: true`.
  - `passthrough: ['unknown-protocol']` is set only if `featureFlags.includes('raw-tunnels')` (`httptoolkit-ui/src/model/proxy-store.ts` lines 241–244).
  - `featureFlags` is a hard-coded empty array (`httptoolkit-ui/src/model/account/account-store.ts` line 25).
  - So raw tunnels are never on in Wirepane today [local].

**Consequence for the design.** If the sidecar pipes raw TCP straight into port 9473 (the Android-app style), you get HTTP and TLS-with-SNI and nothing else. If each TCP flow instead opens a **SOCKS5 connection to Mockttp** with the original `dst IP:port` (plus `custom-metadata` tags), Mockttp knows the real destination. Then unknown protocols become raw tunnels, and every event carries VPN/device tags.

## 3. mitmproxy WireGuard mode (question 1)

### End to end [verified]

- `mitmweb --mode wireguard` "starts a WireGuard VPN server". The device imports the config "provided by mitmproxy" into a "standard WireGuard client application", and then "mitmproxy will transparently intercept their traffic". "No additional routing configuration is required." The default is `51820/udp`, overridable with `--mode wireguard@51821`. Keys live in `~/.mitmproxy/wireguard.conf` and are generated if missing. "No administrative privileges are necessary in this mode." WireGuard and local modes "also support UDP-based protocols". Source: [Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/).
- The web UI shows "configuration file and QR code". Clients import the file or scan the QR code. The 2022 config "will only route IPv4 traffic". The demo phone was Android, and the mode "allows you to only proxy specific apps on Android". The mitmproxy CA "has been preinstalled for this demo", so CA trust is still a separate step. Source: [A more user-friendly transparent mode, based on WireGuard](https://mitmproxy.org/posts/wireguard-mode) (Fabio Valentini, 2022-10-28).
- Known caveats:
  - IPv6 is limited. Generated configs contain no IPv6, and adding `::/0` gives "partial IPv6 support".
  - The mitmproxy host cannot proxy its own traffic through the tunnel.
  - The auto-detected `Endpoint` IP sometimes needs a manual override.
  - Source: [Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/).

### How packets become TCP streams [verified]

- The blog post describes the stack. It is Rust, built on tokio, **boringtun** (WireGuard) and **smoltcp** (userspace TCP/IP), with PyO3 bindings. The stack must "parse incoming IP packets, construct outgoing IP packets, handle TCP connections, and process UDP datagrams". The resulting `TcpStream` is a drop-in for asyncio streams. Source: [blog](https://mitmproxy.org/posts/wireguard-mode).
- Today this code lives in [mitmproxy_rs](https://github.com/mitmproxy/mitmproxy_rs). The root crate `mitmproxy` 0.13.0-dev has license **MIT**. It depends on `boringtun = 0.7.1` (default features off), `smoltcp = 0.13.1`, `tokio 1.47.1`, `hickory-resolver 0.26.1` and `internet-packet 0.2.4`, uses edition 2024 and MSRV 1.95. The workspace also has a `wireguard-test-client` crate. Source: [Cargo.toml](https://raw.githubusercontent.com/mitmproxy/mitmproxy_rs/main/Cargo.toml).
- `src/packet_sources/wireguard.rs` works like this. Source: [wireguard.rs](https://raw.githubusercontent.com/mitmproxy/mitmproxy_rs/main/src/packet_sources/wireguard.rs).
  - `WireGuardConf { listen_addr, private_key, peer_public_keys }` implements `PacketSourceConf::build(transport_events_tx, transport_commands_rx, shutdown)`.
  - There is one boringtun `Tunn` per peer, with a 25 s keepalive.
  - Decrypted IPv4/IPv6 packets are validated with smoltcp. They are sent as `NetworkEvent::ReceivePacket { packet, tunnel_info: TunnelInfo::WireGuard { src_addr, dst_addr } }` into a shared network layer (`add_network_layer`), which produces `TransportEvent`s for the consumer.
  - Replies are routed to a peer by **`peers_by_ip`**, so every phone needs its own tunnel IP.
  - The outbound path calls `endpoint.unwrap()`. It panics if a peer has never sent a datagram.
- The original destination is simply the destination address of the decrypted IP packet. Transparent proxying requires the packet to be "still addressed to the target server" ([Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/)), and a WireGuard tunnel preserves that by construction [inference]. I did not read `messages.rs`, so the exact `TransportEvent` variants are [unverified].
- How WireGuard mode handles DNS and QUIC internally is [unverified]. The docs only say "UDP-based protocols" are supported and that mitmproxy has a separate DNS mode.

### Reuse as a sidecar

- **License.** MIT allows reuse inside AGPL Wirepane with the notice kept [verified license, inference on compatibility].
- **Option A, recommended.** Write a small Rust binary that depends on the `mitmproxy` crate. Pin it to a git tag, because publication on crates.io is [unverified]. The binary consumes `TransportEvent`s and bridges each TCP connection to a SOCKS5 socket. This is the same job the PyO3 layer does for Python.
- **Option B.** Vendor `packet_sources/wireguard.rs`, `network/` and `messages` with the MIT header, if the crate's platform deps (`tun`, `windows`, Linux eBPF members) make the build heavy [inference].
- **N-API.** I did not find or search for an npm/N-API binding in this run [unverified]. A sidecar is preferable anyway [inference]:
  - Wirepane uses Electron ^39.2.7 (`httptoolkit-desktop/package.json`), and a sidecar avoids rebuilding a native module for each Electron ABI.
  - A crash in packet code cannot take down the server.
  - The headless server can run the same binary.

## 4. Alternatives for Node/Electron (question 2)

| Option                                                                     | What runs where                                                 | Root/admin                                                                                                                                                                             | License                                                                          | Maintenance                                                                     | Fit for Wirepane                                                                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **mitmproxy `mitmproxy` crate** (boringtun 0.7.1 + smoltcp 0.13.1 + tokio) | Rust sidecar on the desktop; phone runs the stock WireGuard app | No: "no administrative privileges are necessary" [verified]                                                                                                                            | MIT [verified]                                                                   | Active: 0.13.0-dev, edition 2024 [verified]. MSRV 1.95 means a recent toolchain | **Best.** It already turns WireGuard into per-connection transport events with src/dst                                                                                                                                                                                                    |
| boringtun + smoltcp, DIY                                                   | Rust sidecar                                                    | No [inference]                                                                                                                                                                         | boringtun BSD-3, smoltcp 0BSD [unverified]                                       | boringtun 0.7.1 is current enough for mitmproxy [verified]                      | Re-implements what option A already has                                                                                                                                                                                                                                                   |
| [onetun](https://docs.rs/onetun)                                           | Rust, boringtun + smoltcp                                       | No                                                                                                                                                                                     | [unverified]                                                                     | [unverified]                                                                    | Wrong direction: it forwards local ports _into_ a WireGuard network [verified]. Reference code only                                                                                                                                                                                       |
| wireguard-go + gVisor netstack (wiretap style)                             | Go sidecar                                                      | No. [wiretap](https://github.com/sandialabs/wiretap) is "a transparent, VPN-like proxy server that tunnels traffic via WireGuard and requires no special privileges to run" [verified] | wireguard-go MIT, gVisor Apache-2.0 [unverified]; wiretap's license not captured | wiretap has 1.1k stars [verified]                                               | Viable plan B. wiretap shows the pattern: a userspace stack answers for the destination, the server "creates a new connection to the true destination", unreachable TCP gets RST and unreachable UDP gets ICMP [verified]. More glue code than A and probably a bigger binary [inference] |
| [xjasonlyu/tun2socks](https://github.com/xjasonlyu/tun2socks)              | Go; TUN device to SOCKS/HTTP proxy                              | Creating a TUN device needs admin on macOS/Windows [inference]                                                                                                                         | **MIT** [verified]                                                               | 5.5k stars, Linux/macOS/Windows/FreeBSD/OpenBSD, gVisor stack [verified]        | Not a WireGuard server. Its gVisor-to-SOCKS5 core matches Mockttp's SOCKS input, but you would still have to join it to wireguard-go yourself                                                                                                                                             |
| eycorsican/go-tun2socks                                                    | —                                                               | —                                                                                                                                                                                      | [unverified]                                                                     | [unverified]                                                                    | Not evaluated                                                                                                                                                                                                                                                                             |
| Tailscale libraries (`tsnet`, `wgengine/netstack`)                         | —                                                               | —                                                                                                                                                                                      | [unverified]                                                                     | [unverified]                                                                    | Not evaluated in this run                                                                                                                                                                                                                                                                 |

Rejected without deep research: bundling mitmproxy itself (Python runtime plus a second MITM engine next to Mockttp) [inference].

Binary sizes were **not measured**. Measuring them is part of the spike.

## 5. The phone side (question 3)

### User steps (iOS and Android are identical)

1. Install the official **WireGuard** app. The App Store / Play availability and price were not re-checked in this run [unverified]. mitmproxy just says "standard WireGuard client applications" ([Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/)).
2. In the app, choose "Create from QR code" and scan the QR shown by Wirepane. mitmproxy uses the same import-file-or-scan-QR flow ([blog](https://mitmproxy.org/posts/wireguard-mode)).
3. The config that Wirepane generates looks like this (values are a proposal):

   ```ini
   [Interface]
   PrivateKey = <per-device key generated by Wirepane>
   Address    = 10.73.0.2/32          # unique per device (peers_by_ip routing)
   DNS        = 10.73.0.53            # virtual resolver inside the sidecar
   [Peer]
   PublicKey  = <Wirepane server key>
   AllowedIPs = 0.0.0.0/0, ::/0       # 0.0.0.0/0 = "route all IPv4 traffic through the tunnel"
   Endpoint   = 192.168.1.10:51873    # Mac's LAN IP + Wirepane's UDP port
   ```

   The meaning of `0.0.0.0/0` and the `::/0` behaviour are from [Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/). The address plan, the port and `::/0` with AAAA filtering are design choices (see §8).

4. Installing and trusting the CA is **still required** for HTTPS decryption. The VPN only delivers bytes. mitmproxy's demo had its CA "preinstalled" ([blog](https://mitmproxy.org/posts/wireguard-mode)). Wirepane's existing certificate steps 3–5 (`connect-iphone-page.tsx`) stay as they are.
5. On Android, the WireGuard app can limit the tunnel to chosen apps ([blog](https://mitmproxy.org/posts/wireguard-mode)). The CA-trust limits on Android are the same as today's flows [unverified].

### What breaks or degrades

- **Pinned apps and apps that ignore user CAs.** Their traffic is now _seen_, but as TLS failures. With passthrough it shows up as TLS tunnels with SNI, not decrypted [local: Mockttp TLS passthrough/failure events].
- **Wirepane off or Mac asleep while the tunnel is on.** The phone loses connectivity. AllowedIPs `0.0.0.0/0` means everything goes to the Mac [inference]. The UI needs a loud "turn the VPN off when done" card, like the existing proxy one.
- **Captive portals.** The phone must already be on the Wi-Fi to reach the Mac endpoint. After that, portal checks egress via the Mac, which is already online [inference, untested].
- **iCloud Private Relay.** I found no authoritative Apple statement on how it behaves with a third-party VPN in this run [unverified]. Secondary coverage says Private Relay can be paused per network ([switchingtomac](https://www.switchingtomac.com/icloud-private-relay-vs-vpn-iphone-mac-setup/), [Computerworld](https://www.computerworld.com/article/3645848/how-apples-icloud-private-relay-supports-enterprise-vpn.html)). Recommend pausing it during capture and testing.
- **VPN-detecting apps** (some banking, streaming and anti-cheat software) may refuse to run or behave differently [unverified, general knowledge].
- **Existing VPN on the phone.** A corporate or personal VPN competes with the WireGuard tunnel. Proxyman has a whole article on that scenario ([Proxyman: company VPN](https://proxyman.com/posts/capture-https-ios-app-with-company-vpn)); its details were not read [unverified].
- **"All traffic" is not literally all.** Some OS-level traffic may bypass VPN tunnels on iOS [unverified in this run]. Document this honestly in the UI.

## 6. Showing non-HTTP traffic usefully (question 4)

- **Raw TCP.** Use the existing `RawTunnel` rows: destination, packets and hex [local]. With SOCKS, these become available for every non-HTTP TCP flow.
- **UDP flows.** These need a **new event type**, because Mockttp has no UDP [local]. Each row carries:
  - The 5-tuple, plus a name from the DNS map.
  - Packets and bytes in each direction, and duration.
  - Previews of the first datagrams.
  - A protocol hint: QUIC, or heuristics for STUN/DTLS/game traffic [inference].
- **DNS.** Also a new event type: query name, type, rcode, answers, latency. These rows are hidden by default behind a filter chip, because DNS is chatty. They also feed the IP-to-name map that labels raw TCP/UDP rows [inference]. mitmproxy treats DNS as a first-class mode ([Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/)).
- **QUIC SNI is readable without any keys.** Source: [RFC 9001](https://www.rfc-editor.org/rfc/rfc9001.html) [verified].
  - Initial packets use AEAD_AES_128_GCM with keys derived from the client's Destination Connection ID, via HKDF-SHA256 and salt `0x38762cf7f55934b34d179ae6a4c80cadccbb7f0a`. The labels are `client in`, then `quic key` / `quic iv` / `quic hp`.
  - Header protection is an AES-ECB mask over a 16-byte sample.
  - The RFC says "it is trivial to determine the keys used for Initial packets" (§5).
  - **The ClientHello can span several Initial packets** (§4.3). The parser must reassemble CRYPTO frames by offset before parsing the TLS ClientHello for SNI and ALPN.
  - This gives a "QUIC → `www.example.com` (h3), blocked or allowed" row. It is roughly 2–3 days of work in the sidecar using RustCrypto primitives [inference].
- **How others present this.**
  - mitmproxy supports UDP-based protocols in WireGuard/local modes and has DNS flows/mode ([Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/)). The exact UI was not checked.
  - Proxyman's iOS app and macOS app are HTTP/HTTPS-centric ([Proxyman for iOS](https://docs.proxyman.com/proxyman-ios)). I found no UDP view [unverified].
  - HTTP Toolkit/Wirepane shows HTTP, TLS failures, TLS passthrough and raw tunnels [local].

## 7. Other routes, for comparison (question 5)

| Route                                | How                                                                                                                                                                                            | Needs                                                                                                                                                                           | Sees                                                             | Verdict                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **rvictl RVI** (macOS)               | USB, then `rvictl -s <UDID>` creates `rvi0`, then `sudo tcpdump -i rvi0 -w trace.pcap`. The RVI "represents the entire networking stack of the iOS device". `tcpdump -k` shows packet metadata | Mac, USB, **sudo** for tcpdump ("necessary in order to record packets"). The article only mentions Xcode for finding the UDID; in practice rvictl comes with Xcode [unverified] | Packets only; TLS payloads stay encrypted [inference]            | A good _metadata_ complement (optional pcap import), not a replacement. Source: [Apple: Recording a packet trace](https://developer.apple.com/documentation/network/recording-a-packet-trace)                       |
| **Proxyman for iOS**                 | On-device VPN plus a local MITM, no Mac needed. Premium features need a macOS licence                                                                                                          | Their own signed NetworkExtension app                                                                                                                                           | HTTP/HTTPS                                                       | We cannot copy it without an Apple Developer account. Sources: [Proxyman for iOS](https://docs.proxyman.com/proxyman-ios), [VPN & certificate](https://docs.proxyman.com/proxyman-ios/vpn-and-proxyman-certificate) |
| **Proxyman Atlantis**                | A library compiled into _your own_ app, which sends traffic to the Mac app                                                                                                                     | App source code                                                                                                                                                                 | That app's HTTP(S)                                               | Useless for third-party apps and games. Source: [Atlantis for iOS](https://docs.proxyman.com/atlantis/atlantis-for-ios)                                                                                             |
| **Charles**                          | Desktop proxy, plus a paid iOS app                                                                                                                                                             | —                                                                                                                                                                               | —                                                                | Not verified in this run                                                                                                                                                                                            |
| **Own NetworkExtension app**         | `NEPacketTunnelProvider`                                                                                                                                                                       | Paid Apple Developer account                                                                                                                                                    | Everything                                                       | Blocked by constraint                                                                                                                                                                                               |
| **WireGuard app + Wirepane sidecar** | Borrowed NetworkExtension (this plan)                                                                                                                                                          | Free app on the phone, no root on the desktop                                                                                                                                   | All TCP decrypted where the CA is trusted; UDP/DNS/QUIC metadata | **Recommended**                                                                                                                                                                                                     |

## 8. Recommended architecture

```
 iPhone / Android                         Desktop (Wirepane)
 +---------------------+  UDP :51873 (LAN)  +-------------------------------------------------+
 | WireGuard app       | =================> | wirepane-tunnel  (Rust sidecar, no root)        |
 | AllowedIPs 0/0,::/0 |                    |  boringtun -> smoltcp   (mitmproxy crate, MIT)  |
 | DNS 10.73.0.53      |                    |  TCP flow  -> SOCKS5 0xDA{tags} -> 127.0.0.1:9473 ---+
 +---------------------+                    |  UDP :53 @10.73.0.53 -> host resolver + log     |  |
                                            |  UDP :443 (QUIC) -> block (default) | relay+SNI |  |
                                            |  other UDP -> NAT relay + per-flow stats        |  |
                                            |  JSON lines (stdout) / commands (stdin)         |  |
                                            +-----------------------|-------------------------+  |
                                                                    v                            v
                                         httptoolkit-server: wireguard interceptor     Mockttp (existing)
                                         keys, QR, lifecycle, VPN event relay  ---->   HTTP/TLS/raw tunnels
                                                         \_________ UI (ws) ________/   -> UI (as today)
```

### 8.1 Sidecar `wirepane-tunnel` (new Rust crate in the repo)

- **CLI sketch:**

  ```
  wirepane-tunnel --listen 192.168.1.10:51873 --state <configPath>/wireguard.json
                  --socks 127.0.0.1:<proxyPort> --dns-ip 10.73.0.53 --quic block|relay
  ```

- **TCP.** For each new connection, connect to Mockttp. Do the SOCKS5 handshake offering only `custom-metadata`. Send JSON along these lines:

  ```json
  {
    "tags": [
      "wirepane-vpn",
      "wirepane-vpn-peer:iphone-1",
      "wirepane-vpn-endpoint:192.168.1.23",
      "wirepane-vpn-name:api.example.com"
    ]
  }
  ```

  Then send `CONNECT <dst IP>:<port>` and pipe the bytes both ways.
  - Use the **IP** for CONNECT, so the exact server is preserved (game servers). Carry the DNS name in a tag for display [inference].
  - The metadata mechanism and its tag semantics are in `mockttp/dist/server/socks-server.d.ts` [local].

- **DNS.**
  - Answer UDP and TCP port 53 on the virtual IP by resolving on the host (`hickory-resolver` is already a dependency of the mitmproxy crate, per [Cargo.toml](https://raw.githubusercontent.com/mitmproxy/mitmproxy_rs/main/Cargo.toml)).
  - Emit a `dns` event per query and keep an IP-to-name map with TTLs.
  - Special case: `wirepane.cert` resolves to a virtual IP, and the sidecar forwards those connections via SOCKS _hostname_ `wirepane.cert`. That keeps the existing certificate and check pages working (`httptoolkit-ui/src/model/interception/phone-setup.ts` lines 11–12 serve `http://wirepane.cert/certificate` through the proxy) [local + inference].
  - DNS sent to hard-coded resolvers (`8.8.8.8:53`) is relayed and parsed. DoH/DoT travel as TCP through Mockttp.
- **UDP.** Keep a flow table keyed by 5-tuple, with one host socket per flow and a ~60 s idle timeout. Emit `udp-open/-update/-close` with byte and packet counts and the first N datagram previews [inference].
- **QUIC policy.**
  - `block` (default): reject UDP/443 with ICMP unreachable, or drop it, so clients fall back to TCP/TLS, which Mockttp can decrypt. The fallback behaviour must be confirmed per client in the spike [inference]. wiretap shows that ICMP-unreachable replies are feasible from a userspace stack ([wiretap](https://github.com/sandialabs/wiretap)).
  - `relay`: pass the traffic through and emit QUIC SNI/ALPN parsed per RFC 9001 (§6). Real HTTP/3 interception is out of scope, because Mockttp has no HTTP/3.
- **IPv6.** Route `::/0` so that IPv6 cannot bypass the tunnel. In v1, either handle IPv6 (smoltcp-validated IPv6 packets already flow through `wireguard.rs`), or answer AAAA with NODATA and reset IPv6 TCP so apps use IPv4 [inference]. mitmproxy calls its own IPv6 support "limited" ([Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/)). Wirepane's Android VPN path is IPv4-only too (`android-adb-interceptor.ts` line 114 comment) [local].
- **IPC events (sketch):**

  ```
  ready{listen, publicKey}
  peer{peer, endpoint, lastHandshake}
  dns{peer, name, qtype, rcode, answers, ms}
  udp-open{flow, peer, src, dst, name, hint}
  udp-update{flow, pkts/bytes up/down}
  quic{flow, sni, alpn, action}
  udp-close{flow, reason}
  stats{}
  error{}
  ```

- **Hardening.**
  - Bind only to the chosen LAN interface.
  - Use one key and one tunnel IP per device. This is required anyway, because replies are routed by `peers_by_ip` ([wireguard.rs](https://raw.githubusercontent.com/mitmproxy/mitmproxy_rs/main/src/packet_sources/wireguard.rs)).
  - Patch or guard the `endpoint.unwrap()` panic path.
  - Exit when stdin closes, so the sidecar cannot outlive Wirepane.

### 8.2 Server (`httptoolkit-server`)

- **New interceptor** `src/interceptors/wireguard-vpn.ts` implementing the existing interface (`getMetadata`, `isActive(proxyPort)`, `activate(proxyPort, options)`, `deactivate`, `deactivateAll`; see `src/interceptors/index.ts` lines 37–48) [local].
  - `activate` spawns the sidecar with `--socks 127.0.0.1:<proxyPort>`, using the patterns in `src/util/process-management.ts`.
  - It returns `{ wgConfig, endpoint, peerId }` for the QR.
  - If the proxy port changes, it restarts the sidecar. The QR is unaffected, because the UDP port is separate and persisted.
- **Keys and peers.** Store them in `configPath` next to `wirepane-ca.key` / `wirepane-ca.pem` (`src/index.ts` lines 34–38), file mode 0600. Pick a persisted UDP port outside the default `51820`, so it does not clash with a real WireGuard installation, with a fallback if the port is taken [inference].
- **VPN events to the UI.** Relay them over the existing WebSocket/GraphQL APIs (`src/api/ws-client-api.ts`, `graphql-api.ts`), batched every ~250 ms [local + inference].

### 8.3 Mockttp options (`httptoolkit-ui/src/model/proxy-store.ts`)

- Change `socks: true` to `socks: { authMethods: ['no-auth', 'custom-metadata'] }`.
- Set `passthrough: ['unknown-protocol']` **always**, not behind the dead `raw-tunnels` flag [local].

### 8.4 UI

- **Setup.** `components/intercept/phone/connect-iphone-page.tsx` and `connect-android-page.tsx` get a mode switch: "Wi-Fi proxy" or "Capture all apps (VPN)". The QR is rendered with the already-installed `qrcode.react` (used in `phone-setup-parts.tsx`). The page shows live handshake status [local].
- **Devices panel.** Today, devices are keyed by `remoteIpAddress`, and loopback maps to "this machine" (`model/devices/device-model.ts`, `getEventAddress` / `getDeviceKey`) [local]. Every sidecar connection arrives from 127.0.0.1, so **without tags the iPhone would appear as "this machine"**. Prefer the `wirepane-vpn-endpoint:<phone LAN IP>` tag. That merges the phone's proxy-mode and VPN-mode traffic into one device and adds a "VPN" badge and status.
- **View.**
  - HTTP(S) exchanges appear as today, with a VPN tag.
  - TLS failures get a "pass this host through" action.
  - Raw TCP tunnels use the existing rows.
  - New `UdpFlow` and `DnsQuery` event models (next to `model/raw-tunnel.ts`), with rows, detail panes and filters.
  - QUIC appears as a UDP flow with its SNI.
- **Volume control.** In VPN mode the phone's whole traffic lands in the UI. Add per-host "pass through without recording" and cap stored raw-tunnel data per tunnel [inference].

### 8.5 Packaging

- Add per-architecture sidecar binaries via `config.extraResources` (`httptoolkit-desktop/build-setup/wirepane-builder.config.cjs` line 56): macOS arm64/x64, Windows x64, Linux x64/arm64.
- Add **`NSLocalNetworkUsageDescription`** to the app's Info.plist. It is currently absent from the builder config [local], and it is needed per TN3179 (see Risks).
- Sign the helper together with the app.

## 9. User flow

1. **Intercept → iPhone** (or Android) → tab **"Capture all apps (VPN)"** → **Start**. The server activates the interceptor, and the status line reads "Listening on 192.168.1.10:51873/udp".
   - On macOS 15+, the first start may trigger the Local Network prompt. Explain why before it appears.
2. **Step 1:** Install WireGuard (App Store / Play).
3. **Step 2:** In WireGuard, tap **+**, then **Create from QR code**, then scan, and name the tunnel "Wirepane".
4. **Step 3:** Turn the tunnel on. Wirepane flips to "iPhone connected (last handshake 2 s ago)".
5. **Step 4:** If the CA is not installed yet, open `http://wirepane.cert/certificate`, which works through the tunnel thanks to the DNS special case. Install the profile and enable full trust (existing steps).
6. **Step 5:** Open the check page. Traffic from every app, game and DNS lookup now appears under that device.
7. **Remove the Wi-Fi proxy** if it was set, because double routing is confusing. **When done, turn the tunnel off.** If Wirepane quits, the phone has no internet; this warning card is mandatory.
8. **Optional settings:**
   - QUIC: block or let through.
   - IPv6 policy.
   - Per-host passthrough.
   - Re-issue or revoke device keys.
   - "Mac IP changed, rescan QR" detection.

## 10. Effort estimate (one developer who knows the codebase; rough)

| Phase                  | Scope                                                                                                                                                                                                      | Estimate |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| 0. Spike               | Minimal sidecar on the mitmproxy crate (WireGuard + TCP→SOCKS5→Mockttp); test with a real iPhone and Android; measure binary size and throughput; check the Local Network prompt **from the packaged app** | 2–3 days |
| 1. Sidecar MVP         | Peers/keys, tags, DNS responder + name map + `wirepane.cert`, UDP relay + stats, QUIC block, IPv6 policy, JSON IPC, tests with `wireguard-test-client`                                                     | 6–8 days |
| 2. Server              | Interceptor, key store, QR config, port persistence, lifecycle, event relay, Mockttp options                                                                                                               | 3–4 days |
| 3. UI                  | Setup tabs + QR + status, device attribution via tags, UDP/DNS models, rows, panes, filters, volume controls                                                                                               | 6–8 days |
| 4. Packaging           | Cross-compile matrix, extraResources, signing, Info.plist, firewall notes, docs                                                                                                                            | 3–5 days |
| 5. QUIC SNI (optional) | Initial decryption, CRYPTO reassembly, ClientHello parse                                                                                                                                                   | 2–3 days |
| **Total**              | MVP without QUIC SNI ≈ 3–4 weeks; full v1 ≈ 4–6 weeks                                                                                                                                                      |          |

## 11. Risks and mitigations

| Risk                                                                                                         | Severity        | Notes / mitigation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------ | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **macOS Local Network privacy**                                                                              | High            | TN3179 says "UDP unicast send" to a local address requires access, while receiving UDP and accepting incoming TCP do not. That is why proxy mode never needed it. When an app spawns a helper, "macOS considers the app to be the responsible code". The system "may deny the operation immediately, before the user has responded". **Tools run from Terminal are exempt, so dev runs hide the problem.** Add `NSLocalNetworkUsageDescription`, pre-explain the prompt, and rely on WireGuard's handshake retries after the user grants access [inference]. On macOS 15.5+, `AllowedWiFiLocalNetworkAddresses` is an admin workaround. Source: [TN3179](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy) |
| Ad-hoc signed builds lose the TCC grant on every update                                                      | Medium          | The permission may be re-asked after updates if the code identity changes [inference]. Test across two builds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Pinned apps and apps that ignore user CAs                                                                    | High (inherent) | Visible as TLS failures or tunnels, not decrypted. One-click passthrough keeps them working                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| QUIC fallback assumption                                                                                     | Medium          | Verify per client (Safari/URLSession, Chrome, Flutter, game engines). Keep `relay` mode as the escape hatch                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| IPv6 leaks or breakage                                                                                       | Medium          | Route `::/0`, filter AAAA in v1                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Volume and memory (whole-phone traffic in the UI)                                                            | Medium          | Passthrough-without-recording lists, raw data caps, batching                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Firewall prompts for a new executable (macOS Application Firewall, Windows Defender) and Linux ufw/firewalld | Medium          | [inference] Document it, detect "no handshake within 15 s", show troubleshooting                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| mitmproxy crate API churn (0.x, edition 2024, MSRV 1.95)                                                     | Medium          | Pin a tag, or vendor the modules (MIT). Upgrades are deliberate                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Security: the Mac becomes a LAN exit node for anyone who has the QR                                          | Medium          | Per-device keys, revoke, LAN-only bind, stop with Wirepane, show peers                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| VPN-detecting apps, Private Relay, existing VPNs on the phone                                                | Medium          | [unverified] Document; offer proxy mode as the alternative                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Mac IP changes (DHCP) invalidate the QR endpoint                                                             | Low             | Detect and offer "rescan"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `endpoint.unwrap()` panic in upstream code                                                                   | Low             | Patch or guard ([wireguard.rs](https://raw.githubusercontent.com/mitmproxy/mitmproxy_rs/main/src/packet_sources/wireguard.rs))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 12. Cheaper interim improvements for proxy mode

1. **Turn raw tunnels on.** Set `passthrough: ['unknown-protocol']` unconditionally (`proxy-store.ts` lines 241–244), since the `raw-tunnels` flag can never be true (`account-store.ts` line 25). Non-HTTP traffic sent via CONNECT/SOCKS then shows as raw tunnels instead of 400s. Roughly one line plus tests [local].
2. **One-click "pass this host through"** on TLS-failure rows, using Mockttp's TLS passthrough options (`http-combo-server.js`, `analyzeAndMaybePassThroughTls`). Pinned apps then keep working while the user debugs other apps [local].
3. **Honest coverage text** on the iPhone page: "the Wi-Fi proxy covers apps that use iOS's system proxy; games, Flutter apps and custom sockets need VPN mode".
4. **PAC option** (Configure Proxy → Automatic with `PROXY host:port; DIRECT`), so the phone degrades gracefully when Wirepane is down. iOS behaviour when the PAC URL itself is unreachable is [unverified].
5. Optional **pcap import** (rvictl + tcpdump) for connection metadata on macOS ([Apple](https://developer.apple.com/documentation/network/recording-a-packet-trace)).

## 13. Not verified in this run (to check before or during the spike)

- Exact `TransportEvent`/`TransportCommand` variants (`mitmproxy_rs/src/messages.rs`) and the TCP read/write API.
- How mitmproxy's WireGuard mode handles DNS and QUIC internally.
- Whether the `mitmproxy` crate is published on crates.io, and which of its features can drop the platform dependencies.
- Licenses of boringtun, smoltcp, wireguard-go, gVisor and wiretap.
- Tailscale libraries; go-tun2socks; sing-box-style WireGuard inbounds; whether any npm/N-API WireGuard binding exists.
- Official WireGuard app store pages (price, QR import wording, iOS "add VPN configuration" prompt).
- iCloud Private Relay with a third-party VPN; iOS traffic that bypasses VPNs; VPN detection by apps; behaviour of Charles' iOS app.
- USB packet capture without root via the `pcapd` service (pymobiledevice3 / go-ios), which may also attribute packets to processes.
- Binary sizes and throughput of the sidecar (measure in the spike).

## 14. Real-device test (2026-10-12)

The owner's iPhone 13 Pro Max (iOS 26.6.1) with the official WireGuard app, against mitmproxy 12.2.3's WireGuard mode on the Mac (`uvx --from mitmproxy mitmdump --mode wireguard`, run from the terminal, using the Wirepane CA so no new certificate was needed). Same apps as the proxy-mode capture a few minutes earlier:

| App | Wi-Fi proxy mode | WireGuard (VPN) mode |
| --- | --- | --- |
| Jett (Flutter, `uz.multibroker.jett.mobile`) | only its native SDKs (Firebase, Sentry, Facebook, Amplitude) and 2 WebView requests | `api.jett.uz` 44 requests decrypted (UA `iPhone iOS 26.6.1 random_uuid: …`), plus `chart.jett.uz` |
| Road24 (Flutter, `uz.kashapp.road24`) | only Firebase, Google and Sentry | 29 API requests decrypted: `api.road24.uz` (users/me, cars, fines, parking, token refresh with UA `Dart/3.10 (dart:io)`), `gw.road24.uz`, `core.yordam24.uz` |
| TelecomTV (`TelecomTV/…`, `lifestream:iphone`) | nothing | `uztel.server-api.lfstrm.tv` 94 requests and its images, decrypted |
| OddiyTV | the video stream (AppleCoreMedia) and AppMetrica only | its API host `app.api.odtv.uz` refuses the certificate during the handshake: pinned, host visible only |
| Apple push, `wps.apple.com` | — | refuse the certificate (pinned): VPN mode must pass these through untouched, or push notifications stop while it's on |

So the core assumption holds on a real device: once the traffic arrives through the tunnel, Flutter apps on iOS trust the user-installed, fully trusted Wirepane CA, and only pinned hosts stay opaque. No UDP flows and no raw TCP flows were seen in this short run; DNS went through the tunnel's resolver (108 queries). The Local Network question (TN3179) is still open for the packaged app, because a terminal-launched process is exempt.

## Sources

1. [mitmproxy: Proxy Modes](https://docs.mitmproxy.org/stable/concepts/modes/): WireGuard, local and transparent mode facts (port, keys, no admin, UDP support, IPv6 limits).
2. [mitmproxy blog: A more user-friendly transparent mode, based on WireGuard](https://mitmproxy.org/posts/wireguard-mode): architecture (tokio/boringtun/smoltcp/PyO3), QR in mitmweb, Android per-app, CA preinstalled.
3. [mitmproxy_rs Cargo.toml](https://raw.githubusercontent.com/mitmproxy/mitmproxy_rs/main/Cargo.toml): MIT license, dependency versions, workspace members.
4. [mitmproxy_rs src/packet_sources/wireguard.rs](https://raw.githubusercontent.com/mitmproxy/mitmproxy_rs/main/src/packet_sources/wireguard.rs): reusable API, peer routing, panic path.
5. [sandialabs/wiretap](https://github.com/sandialabs/wiretap): proof of the no-privilege Go/WireGuard/userspace-stack pattern.
6. [xjasonlyu/tun2socks](https://github.com/xjasonlyu/tun2socks): MIT, gVisor, TUN-based.
7. [onetun on docs.rs](https://docs.rs/onetun): boringtun + smoltcp in the reverse direction.
8. [RFC 9001](https://www.rfc-editor.org/rfc/rfc9001.html): QUIC Initial keys, header protection, multi-packet ClientHello.
9. [Apple TN3179: Understanding local network privacy](https://developer.apple.com/documentation/technotes/tn3179-understanding-local-network-privacy): UDP-send gating, responsible code, exemptions.
10. [Apple: Recording a packet trace](https://developer.apple.com/documentation/network/recording-a-packet-trace): rvictl/RVI.
11. [Proxyman for iOS](https://docs.proxyman.com/proxyman-ios), [VPN & certificate](https://docs.proxyman.com/proxyman-ios/vpn-and-proxyman-certificate), [Atlantis for iOS](https://docs.proxyman.com/atlantis/atlantis-for-ios), [company-VPN post](https://proxyman.com/posts/capture-https-ios-app-with-company-vpn): Proxyman's approaches.
12. Secondary, Private Relay: [switchingtomac](https://www.switchingtomac.com/icloud-private-relay-vs-vpn-iphone-mac-setup/), [Computerworld](https://www.computerworld.com/article/3645848/how-apples-icloud-private-relay-supports-enterprise-vpn.html).
13. Local code: `httptoolkit-server/node_modules/mockttp` 4.6.3 (`dist/server/http-combo-server.js`, `socks-server.d.ts`, `mockttp.d.ts`), `@httptoolkit/httpolyglot` 3.1.0, `httptoolkit-ui/src/model/proxy-store.ts`, `model/account/account-store.ts`, `model/devices/device-model.ts`, `model/raw-tunnel.ts`, `components/intercept/phone/*`, `httptoolkit-server/src/interceptors/index.ts`, `httptoolkit-desktop/build-setup/wirepane-builder.config.cjs`.
