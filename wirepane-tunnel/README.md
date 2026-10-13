# wirepane-tunnel

Wirepane's VPN-mode sidecar. A userspace WireGuard server (no root, no TUN device) that turns a phone's traffic into TCP and UDP flows. Every TCP flow goes to Mockttp's proxy port over SOCKS5, with tags that say which phone it came from, so Mockttp sees the real destination and can decrypt, record and rewrite it. The phone runs the stock WireGuard app; the desktop runs this binary (started by the server's `wireguard-vpn` interceptor).

Plan and decisions: `docs/plans/2026-10-12-iphone-fixes-and-vpn.md`. Research: `docs/research/phone-vpn-mode.md`.

```
phone (WireGuard app) --UDP--> wirepane-tunnel --SOCKS5 0xDA{tags} + CONNECT ip:port--> Mockttp
                               | DNS 10.73.0.53       -> host resolver
                               | UDP/443 (QUIC)       -> ICMP port unreachable (default) or relayed
                               | other UDP            -> host socket, 60 s idle timeout
```

## Build, run, test

```bash
cargo build --release          # target/release/wirepane-tunnel (about 1.1 MiB, see "Size")
cargo test                     # unit tests + end-to-end tests of the real binary (about 21 s after compiling: the timer tests wait for WireGuard's 10 s and 15 s rules)
cargo build --release --examples && node scripts/e2e-mockttp.js   # against a real Mockttp
```

Cargo 1.95 or newer (edition 2024, same as mitmproxy_rs). Only macOS arm64 has been built and tested so far.

## Size

Release profile: `lto = true`, `codegen-units = 1`, `opt-level = "s"`, `strip = true`.

| Build (macOS arm64)                    | Size                                |
| -------------------------------------- | ----------------------------------- |
| `panic = "unwind"` (what we ship)      | 1,200,176 bytes (1.14 MiB)          |
| `panic = "abort"` (measured, not used) | 951,904 bytes (0.91 MiB), measured before the timers, rate limiter, ICMP and stats were added |

`panic = "abort"` would save about 0.2 MiB but would turn any panic in packet code into a dead sidecar, so it is not used (see "Design").

## CLI

```
wirepane-tunnel --wireguard <ip:port> --state <file> --socks <host:port>
                [--endpoint-host <LAN IPv4 the phone dials>] [--tunnel-net 10.73.0.0/24] [--quic block|relay|decrypt]
                [--ca-cert <pem> --ca-key <pem>] [--ikev2 <ip:port>]
```

| Option            | Meaning                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--wireguard`     | UDP address to listen on, e.g. `0.0.0.0:51873`. Port `0` picks a free one (the `ready` event says which). The caller picks the port and the fallbacks (51873, then 51874-51899). |
| `--state`         | State file (see below). Created, with its folder, if missing.                                                                                                                 |
| `--socks`         | Mockttp's proxy port, `host:port`. Can be changed while running with `set-socks`.                                                                                             |
| `--endpoint-host` | Written into the client config as `Endpoint = <host>:<port>`. Default: the bind address, or `127.0.0.1` when it is `0.0.0.0`.                                                 |
| `--tunnel-net`    | Virtual network, `/16` to `/24`. Default `10.73.0.0/24`: server `.1`, DNS `.53`, `wirepane.cert` `.54`, peers from `.2` (skipping `.53` and `.54`).                           |
| `--quic`          | `block` (default) answers UDP/443 with an ICMP port unreachable and reports it; `relay` forwards it like other UDP; `decrypt` terminates HTTP/3 and hands each request to Mockttp (needs `--ca-cert`/`--ca-key`; see `docs/http3.md`). Can be changed while running with `set-quic`. |
| `--ca-cert`, `--ca-key` | The Wirepane CA's PEM files, for the leaf certificates QUIC `decrypt` presents to phones. The server passes them (next to the state file) only while the QUIC mode is `decrypt`, and restarts the sidecar when the mode changes to or from it, so the private key isn't handed out while nothing uses it. |
| `--ikev2`         | UDP address for the IKEv2/IPsec front-end (iOS's built-in VPN, no extra app). Only used when the build supports it (`ready` → `capabilities.ikev2`); see `docs/ikev2.md`. |

A hidden `--unsafe-allow-loopback` exists for tests only (see "Security"). Do not pass it from the server.

Exit codes: `0` when stdin reaches EOF (the parent closed it or died, so the sidecar never outlives Wirepane); `1` after a fatal error, always preceded by an `{"event":"error"}` line. Logs go to stderr; `WIREPANE_TUNNEL_LOG=error|warn|info|debug|trace` (default `warn`).

## State file

JSON, mode `0600`, written atomically (temp file + rename) after every change. It holds the server key and every peer, including the phone's private key, so a scanned QR stays valid across restarts and the config can be shown again.

```json
{
  "version": 1,
  "serverPrivateKey": "<base64>",
  "nextPeer": 3,
  "peers": [
    {
      "peer": "p1",
      "name": "iPhone",
      "kind": "wireguard",
      "tunnelIp": "10.73.0.2",
      "privateKey": "<base64>",
      "publicKey": "<base64>"
    }
  ]
}
```

Peer ids (`p1`, `p2`, ...) are never reused. An unreadable file is moved to `<file>.unreadable` and a fresh one is created, so a damaged file cannot block the VPN.

## Commands (stdin, one JSON object per line)

| Command                                         | Answer on stdout                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `{"cmd":"add-peer","name":"iPhone","kind":"wireguard"}` | `{"event":"peer-added","peer":"p1","name":"iPhone","kind":"wireguard","tunnelIp":"10.73.0.2","config":"<wg-quick text>"}`        |
| `{"cmd":"remove-peer","peer":"p1"}`             | `{"event":"peer-removed","peer":"p1"}`; the phone is cut off at once and its open flows end                                       |
| `{"cmd":"list-peers"}`                          | `{"event":"peers","peers":[{"peer":"p1","name":"iPhone","kind":"wireguard","tunnelIp":"10.73.0.2","endpoint":"192.168.0.199:61234","lastHandshake":1791809205206}]}` |
| `{"cmd":"set-socks","addr":"127.0.0.1:9474"}`   | `{"event":"socks-set","addr":"127.0.0.1:9474"}`; new flows use it, open flows keep their connection                              |
| `{"cmd":"stats"}`                               | `{"event":"stats",...}`: running totals since the sidecar started (see "Events")                                                  |
| `{"cmd":"set-conditions","peer":"p1","conditions":{"latencyMs":200,"jitterMs":0,"downKbps":750,"upKbps":250,"lossPct":0}}` | `{"event":"conditions-set","peer":"p1"}`; `"conditions":null` turns them off. Missing fields are 0 (no delay, no limit) |
| `{"cmd":"set-dns-rules","rules":[{"pattern":"*.example.com","action":"block"},{"pattern":"api.test","action":"answer","ipv4":"192.168.0.10"}]}` | `{"event":"dns-rules-set","count":2}`; replaces the whole list; the first matching rule wins |
| `{"cmd":"set-quic","mode":"block"}`               | `{"event":"quic-mode","mode":"block"}` (`block`, `relay` or `decrypt`)                                                 |
| `{"cmd":"capture-start","path":"/…/wirepane.pcapng"}` | `{"event":"capture-started","path":"…"}`: every IP packet of every phone goes to a pcapng file, one interface per phone |
| `{"cmd":"capture-stop"}`                        | `{"event":"capture-stopped","path":"…","packets":1234,"bytes":567890}`                                              |

`name` defaults to `Phone` (control characters removed, 64 characters at most). `kind` defaults to `wireguard`, the only kind for now. `endpoint` and `lastHandshake` are `null` until the phone has connected; `lastHandshake` is a ms epoch. A bad or unknown command, an unknown peer or an invalid address gives `{"event":"error","message":"..."}` and nothing else changes.

The client config in `peer-added` (what the QR code encodes):

```
[Interface]
PrivateKey = <phone private key>
Address = 10.73.0.2/32
DNS = 10.73.0.53

[Peer]
PublicKey = <server public key>
AllowedIPs = 0.0.0.0/0, ::/0
Endpoint = <endpoint-host>:<port>
PersistentKeepalive = 25
```

## Events (stdout, one JSON object per line)

```jsonc
{"event":"ready","listen":"0.0.0.0:51873","publicKey":"<server public key, base64>","capabilities":{"quicDecrypt":true,"ikev2":false}}
{"event":"peer","peer":"p1","endpoint":"192.168.0.199:61234","lastHandshake":1791809205206}
{"event":"dns","peer":"p1","name":"api.example.com","qtype":"A","rcode":"NOERROR","answers":["93.184.216.34"],"ms":12}
{"event":"udp-open","flow":1,"peer":"p1","src":"10.73.0.2:40003","dst":"1.2.3.4:5000","name":null}
{"event":"udp-update","flow":1,"peer":"p1","packetsUp":1,"packetsDown":1,"bytesUp":13,"bytesDown":13}
{"event":"udp-close","flow":1,"peer":"p1","reason":"idle","packetsUp":1,"packetsDown":1,"bytesUp":13,"bytesDown":13}
{"event":"quic","peer":"p1","dst":"93.184.216.34:443","action":"blocked"}
{"event":"tls-hello","peer":"p1","dst":"93.184.216.34:443","sni":"api.example.com","alpn":["h2","http/1.1"],"ja4":"t13d1516h2_8daaf6152771_e5627efa2ab1"}
{"event":"stats","uptimeMs":812345,"peers":[{"peer":"p1","name":"iPhone","tunnelIp":"10.73.0.2","endpoint":"192.168.0.199:61234","lastHandshake":1791809205206,"bytesUp":48213,"bytesDown":902114}],"tcp":{"flowsOpened":41,"flowsActive":3,"bytesUp":30211,"bytesDown":881200},"udp":{"flowsOpened":2,"flowsActive":1,"packetsUp":5,"packetsDown":4,"bytesUp":410,"bytesDown":380},"dns":{"queries":57},"quic":{"blocked":6,"icmpSent":6}}
{"event":"error","message":"..."}
```

- `ready`: once, after the UDP socket is bound. `listen` is the real bound address.
- `peer`: when a handshake completes (one the phone started, or one the server's timers started and the phone answered) and when a phone's endpoint changes (roaming between Wi-Fi and mobile data). Only authenticated packets move the endpoint.
- `dns`: one per query; `"rule":"blocked"` or `"answered"` is added when a DNS rule decided the answer. `qtype` is a name (`A`, `AAAA`, `HTTPS`, ..., or `TYPE99`); `rcode` is `NOERROR`, `NXDOMAIN`, `SERVFAIL`, `FORMERR` or `NOTIMP`; `answers` are IPv4 addresses.
- `udp-open` / `udp-update` / `udp-close`: only for relayed UDP (not DNS, not blocked QUIC). `name` is the DNS name that phone got for `dst`, or `null`. `reason` is `idle`, `closed`, `error` or `peer-removed`. `udp-update` carries the running counts (`Up` = from the phone) and is throttled: at most one a second per flow, and none while the counts have not changed. `udp-close` has the final counts.
- `quic`: once per blocked UDP/443 flow. Every blocked datagram also gets an ICMP port unreachable (at most one per 100 ms per flow), which is counted in `stats` but not reported as an event.
- `tls-hello`: the first bytes of a TCP flow were a TLS ClientHello; its SNI and JA4 also go on that flow's SOCKS connection as the tags `wirepane-vpn-sni:` and `wirepane-vpn-ja4:`.
- `stats`: the answer to `{"cmd":"stats"}`, running totals since start. `peers[]` counts plaintext bytes through each phone's tunnel (`bytesUp` from the phone, `bytesDown` to it). `tcp`, `udp`, `dns` and `quic` count what the core served; `flowsActive` is a gauge, everything else only grows. Fields may be added later, never removed.
- `error`: fatal problems and rejected commands. Not used for ordinary per-flow failures (those are logged at `debug`).

## What Mockttp receives

For each TCP flow the sidecar connects to `--socks` and speaks SOCKS5 with only the custom-metadata method offered:

1. `05 01 DA`; Mockttp answers `05 DA`.
2. A 2-byte big-endian length and `{"tags":[...]}`; Mockttp answers `05 00`.
3. `CONNECT` (`05 01 00 01 <ip4> <port>`) to the destination IP and port the phone dialled, so the exact server is kept. For `wirepane.cert` it is `CONNECT` by host name (`05 01 00 03 ...`), because the proxy answers that name itself.
4. Bytes are piped both ways; a FIN from either side is passed on as a half-close.

Tags:

- `wirepane-vpn`
- `wirepane-vpn-peer:<peerId>`
- `wirepane-vpn-endpoint:<the phone's LAN IP>` (when known)
- `wirepane-vpn-name:<dns name>` (when this phone resolved that IP through the tunnel's DNS in the last 10 minutes)

Mockttp stores them on every request of the connection as `socket-metadata:<tag>` in `request.tags`. The UI needs `socks: { authMethods: ['no-auth', 'custom-metadata'] }`.

Verified output of `scripts/e2e-mockttp.js` (real Mockttp 4.x from `httptoolkit-server/node_modules`, random port, passthrough rule):

```
Mockttp saw: {"method":"GET","url":"http://localhost:64337/e2e-through-wireguard","host":"localhost:64337","tags":["socket-metadata:wirepane-vpn","socket-metadata:wirepane-vpn-peer:p1","socket-metadata:wirepane-vpn-endpoint:127.0.0.1","socket-metadata:wirepane-vpn-name:localhost"]}
```

## Design

- **Built on mitmproxy_rs**, pinned as a git dependency to `v0.12.11`: mitmproxy 12.2.3 requires `mitmproxy-rs>=0.12.6,<0.13`, and 0.12.11 is the newest that satisfies it (the stack the iPhone test of 2026-10-12 ran on). We use its smoltcp network task (`mitmproxy::network::add_network_layer`, `mitmproxy::messages`) as the TCP/IP stack: it accepts a connection to any address and gives us streams. `crates.io/mitmproxy` is only a placeholder.
- **Own WireGuard front-end** (`src/frontend/wireguard.rs`), derived from mitmproxy_rs `packet_sources/wireguard.rs` (MIT, copyright the mitmproxy_rs authors; the notice is in the file header). Upstream fixes the peer list at start-up, routes replies for unknown IPs to "the first peer" and calls `endpoint.unwrap()`; ours adds and removes peers while running, only accepts packets from the tunnel address a peer owns (like AllowedIPs), and drops anything it can't attribute.
- **One module boundary** (`src/frontend/mod.rs`): a front-end produces `TransportEvent`s (new flows) and takes `TransportCommand`s (read, write, drain, close), and implements `PeerDirectory`. The core (`src/core/`: SOCKS, TCP pipe, DNS, UDP, QUIC policy, events) knows nothing else. IKEv2 later is a second front-end.
- **WireGuard timers run on the server too.** One tick every 250 ms (what boringtun's own device does) calls `update_timers` for every peer and sends what it returns, to the phone's last authenticated address: the empty keepalive WireGuard owes a phone that sent data and got nothing back for 10 s, a new handshake when a session went quiet, and the wipe of a session that stayed silent for nine minutes. The server's `Tunn` has no persistent keepalive of its own: the phone's `PersistentKeepalive = 25` keeps its NAT open, and a server keepalive would only make it dial phones that never connected. Upstream mitmproxy_rs never runs these timers.
- **Handshakes go through a rate limiter first.** Before any key is derived, `RateLimiter::verify_packet` checks MAC1 and counts the handshake; above 100 a second (boringtun's own device limit) it answers with a cookie reply instead, and the phone repeats its initiation with the cookie in MAC2, which a client behind a forged source address can't do. So a flood of forged initiations costs a hash each, not a Diffie-Hellman each. The count is reset by the 250 ms tick. Each peer's own `Tunn` gets a limiter that can never be "under load", so the front door is the only place that limits.
- **panic = unwind** in release, on purpose: packet handling is wrapped in `catch_unwind`, and every flow is its own tokio task, so one bad packet or flow cannot take the sidecar down. The smoltcp task from mitmproxy_rs has a few `assert!`s we cannot patch.

Layout: `src/lib.rs` (`Tunnel`: peers, state, start/stop, stats), `src/main.rs` (CLI, stdin loop), `src/events.rs`, `src/state.rs`, `src/net.rs`, `src/frontend/` (`mod.rs`: the boundary, including `InjectedPacket`, how the core hands a raw packet to a phone; `wireguard.rs`: packets, timers, rate limiter), `src/core/{mod,socks,dns,icmp,stats}.rs`; tests in `tests/` (with a boringtun + smoltcp "phone" in `tests/support/wg_client.rs`, also built as `examples/wg_client.rs`, which can send a UDP datagram and show the ICMP errors, or hold the tunnel open and count keepalives); `scripts/e2e-mockttp.js`.

## Behaviour details

- **DNS** (UDP and TCP port 53 on `10.73.0.53`): A queries are resolved on the host with the system resolver (so the phone gets what the Mac would), TTL 30 s, up to 16 addresses. AAAA, HTTPS, SVCB, TXT and everything else get an empty `NOERROR`, so clients fall back to A. Unknown names are `NXDOMAIN`. Names are limited to letters, digits, `-`, `_`, `*` and dots, because they end up in tags. `wirepane.cert` resolves to `10.73.0.54`.
- **QUIC:** UDP/443 is not forwarded. It is reported once per flow (`quic` event) and every datagram is answered, through the tunnel, with an ICMP destination unreachable / port unreachable (type 3, code 3) from the address the phone tried, quoting the datagram's IPv4 header and first 8 bytes, so a connected UDP socket fails at once and the app falls back to TCP/TLS, which Mockttp can decrypt. The quoted header is rebuilt from what the core knows (addresses, ports, length, checksums; TTL 64, no fragmentation). At most one error per 100 ms per flow. `--quic relay` forwards it untouched.
- **Other UDP:** one host socket per flow, 60 s idle timeout, a `udp-update` about once a second while it moves data.
- **IPv6:** the client routes `::/0` so nothing leaks around the tunnel; the sidecar drops all IPv6 and answers AAAA empty.
- **Failed flows:** a TCP flow that can't be served (blocked destination, Mockttp down, SOCKS refused) is closed with a FIN 250 ms after the SYN, so the phone's handshake finishes first and the app sees a clean close at once instead of retrying SYNs until its own timeout.
- **ICMP echo** is answered by the stack so apps that "ping" to check connectivity stay happy.

## Throughput

`throughput_through_the_tunnel` in `tests/tunnel.rs` moves a body each way through the whole pipeline in one process: the test phone (boringtun + smoltcp, so its cost is part of the number), the sidecar binary, the stub SOCKS proxy and a local HTTP server, all on loopback. The download is `GET /stream/<n>` (server to phone), the upload is a `POST` the server counts (phone to server). `WIREPANE_BENCH_MB` sets the size (default 16).

```bash
WIREPANE_BENCH_MB=64 cargo test --release --test tunnel throughput -- --nocapture --test-threads=1
```

Measured 2026-10-13 on the dev Mac (Apple Silicon), three runs of 64 MB each way:

| Build                      | Download (server to phone) | Upload (phone to server) |
| -------------------------- | -------------------------- | ------------------------ |
| release (`--release`)      | 136 to 156 MB/s            | 205 to 220 MB/s          |
| debug (`cargo test`, 16 MB) | about 41 MB/s              | about 21 MB/s            |

That is more than 1 Gbit/s in release, far above what a phone on Wi-Fi sustains, so the sidecar is not the bottleneck for a phone. These are single-flow, single-phone numbers on loopback (no real radio, no Mockttp, no TLS); one mutex guards all peers' crypto, so many busy phones share one core. There is no real-phone number yet. The test only fails below 1 MB/s, to catch a stall or a back-pressure bug.

## Security

- A phone can never reach `127.0.0.0/8`, `0.0.0.0`, multicast, broadcast or the tunnel net itself through the tunnel (TCP and UDP). Otherwise anyone with the QR could talk to the Mac's local services (the server API, the Mockttp admin port). `--unsafe-allow-loopback` lifts this for the tests only.
- A peer may only send from its own tunnel address; other source addresses are dropped.
- Datagrams from unknown keys, unknown session indexes or malformed WireGuard messages are ignored. Fragments, non-TCP/UDP/ICMP protocols and port-0 packets are dropped before they reach the smoltcp task (which stops on a few such inputs).
- Per-device keys; `remove-peer` revokes at once. The state file is `0600`. Handshakes are rate limited with cookie replies (see "Design").
- Whoever has the QR can use the Mac as a LAN exit node until the peer is removed.

## Limits (v1)

- IPv6 is dropped (IPv6-only hosts are unreachable).
- Only A answers carry records; no PTR/MX/TXT.
- The phone's TCP handshake completes before the SOCKS connection is made (the smoltcp task accepts on SYN). If Mockttp is down, the phone sees a connection that opens and then closes at once.
- A QUIC client whose UDP socket is not connected ignores the ICMP error and waits for its own fallback timer, like after a silent drop.
- `--quic relay` does not parse QUIC SNI.
- Long soak runs are not done and there is no real-phone throughput number; see "Throughput" for what is measured. One mutex guards all peers' crypto.
- `Endpoint` is written as `host:port`, so an IPv6 literal would need brackets (IPv4 only for now).
- macOS Local Network privacy (TN3179) for the packaged app is untested; Windows and Linux builds are untested.
