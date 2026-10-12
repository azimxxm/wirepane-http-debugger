# wirepane-tunnel

Wirepane's VPN-mode sidecar. A userspace WireGuard server (no root, no TUN device) that turns a phone's traffic into TCP and UDP flows. Every TCP flow goes to Mockttp's proxy port over SOCKS5, with tags that say which phone it came from, so Mockttp sees the real destination and can decrypt, record and rewrite it. The phone runs the stock WireGuard app; the desktop runs this binary (started by the server's `wireguard-vpn` interceptor).

Plan and decisions: `docs/plans/2026-10-12-iphone-fixes-and-vpn.md`. Research: `docs/research/phone-vpn-mode.md`.

```
phone (WireGuard app) --UDP--> wirepane-tunnel --SOCKS5 0xDA{tags} + CONNECT ip:port--> Mockttp
                               | DNS 10.73.0.53       -> host resolver
                               | UDP/443 (QUIC)       -> dropped (default) or relayed
                               | other UDP            -> host socket, 60 s idle timeout
```

## Build, run, test

```bash
cargo build --release          # target/release/wirepane-tunnel (about 1.1 MiB, see "Size")
cargo test                     # unit tests + end-to-end tests of the real binary (about 2 s after compiling)
cargo build --release --examples && node scripts/e2e-mockttp.js   # against a real Mockttp
```

Cargo 1.95 or newer (edition 2024, same as mitmproxy_rs). Only macOS arm64 has been built and tested so far.

## Size

Release profile: `lto = true`, `codegen-units = 1`, `opt-level = "s"`, `strip = true`.

| Build (macOS arm64)                    | Size                                |
| -------------------------------------- | ----------------------------------- |
| `panic = "unwind"` (what we ship)      | 1,167,088 bytes (1.11 MiB)          |
| `panic = "abort"` (measured, not used) | 951,904 bytes (0.91 MiB)            |

`panic = "abort"` would save about 0.2 MiB but would turn any panic in packet code into a dead sidecar, so it is not used (see "Design").

## CLI

```
wirepane-tunnel --wireguard <ip:port> --state <file> --socks <host:port>
                [--endpoint-host <LAN IPv4 the phone dials>] [--tunnel-net 10.73.0.0/24] [--quic block|relay]
```

| Option            | Meaning                                                                                                                                                                       |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--wireguard`     | UDP address to listen on, e.g. `0.0.0.0:51873`. Port `0` picks a free one (the `ready` event says which). The caller picks the port and the fallbacks (51873, then 51874-51899). |
| `--state`         | State file (see below). Created, with its folder, if missing.                                                                                                                 |
| `--socks`         | Mockttp's proxy port, `host:port`. Can be changed while running with `set-socks`.                                                                                             |
| `--endpoint-host` | Written into the client config as `Endpoint = <host>:<port>`. Default: the bind address, or `127.0.0.1` when it is `0.0.0.0`.                                                 |
| `--tunnel-net`    | Virtual network, `/16` to `/24`. Default `10.73.0.0/24`: server `.1`, DNS `.53`, `wirepane.cert` `.54`, peers from `.2` (skipping `.53` and `.54`).                           |
| `--quic`          | `block` (default) drops UDP/443 and reports it; `relay` forwards it like other UDP.                                                                                           |

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
{"event":"ready","listen":"0.0.0.0:51873","publicKey":"<server public key, base64>"}
{"event":"peer","peer":"p1","endpoint":"192.168.0.199:61234","lastHandshake":1791809205206}
{"event":"dns","peer":"p1","name":"api.example.com","qtype":"A","rcode":"NOERROR","answers":["93.184.216.34"],"ms":12}
{"event":"udp-open","flow":1,"peer":"p1","src":"10.73.0.2:40003","dst":"1.2.3.4:5000","name":null}
{"event":"udp-close","flow":1,"peer":"p1","reason":"idle","packetsUp":1,"packetsDown":1,"bytesUp":13,"bytesDown":13}
{"event":"quic","peer":"p1","dst":"93.184.216.34:443","action":"blocked"}
{"event":"error","message":"..."}
```

- `ready`: once, after the UDP socket is bound. `listen` is the real bound address.
- `peer`: when a handshake completes and when a phone's endpoint changes (roaming between Wi-Fi and mobile data). Only authenticated packets move the endpoint.
- `dns`: one per query. `qtype` is a name (`A`, `AAAA`, `HTTPS`, ..., or `TYPE99`); `rcode` is `NOERROR`, `NXDOMAIN`, `SERVFAIL`, `FORMERR` or `NOTIMP`; `answers` are IPv4 addresses.
- `udp-open` / `udp-close`: only for relayed UDP (not DNS, not blocked QUIC). `name` is the DNS name that phone got for `dst`, or `null`. `reason` is `idle`, `closed`, `error` or `peer-removed`.
- `quic`: once per blocked UDP/443 flow.
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
- **No timers on the server side.** The server never starts handshakes or keepalives; it answers the phone, whose `PersistentKeepalive = 25` keeps the NAT open and starts every rekey.
- **panic = unwind** in release, on purpose: packet handling is wrapped in `catch_unwind`, and every flow is its own tokio task, so one bad packet or flow cannot take the sidecar down. The smoltcp task from mitmproxy_rs has a few `assert!`s we cannot patch.

Layout: `src/lib.rs` (`Tunnel`: peers, state, start/stop), `src/main.rs` (CLI, stdin loop), `src/events.rs`, `src/state.rs`, `src/net.rs`, `src/frontend/`, `src/core/{mod,socks,dns}.rs`; tests in `tests/` (with a boringtun + smoltcp "phone" in `tests/support/wg_client.rs`, also built as `examples/wg_client.rs`); `scripts/e2e-mockttp.js`.

## Behaviour details

- **DNS** (UDP and TCP port 53 on `10.73.0.53`): A queries are resolved on the host with the system resolver (so the phone gets what the Mac would), TTL 30 s, up to 16 addresses. AAAA, HTTPS, SVCB, TXT and everything else get an empty `NOERROR`, so clients fall back to A. Unknown names are `NXDOMAIN`. Names are limited to letters, digits, `-`, `_`, `*` and dots, because they end up in tags. `wirepane.cert` resolves to `10.73.0.54`.
- **QUIC:** UDP/443 is dropped (not rejected with ICMP) and reported once per flow, so apps fall back to TCP/TLS, which Mockttp can decrypt. `--quic relay` forwards it untouched.
- **Other UDP:** one host socket per flow, 60 s idle timeout.
- **IPv6:** the client routes `::/0` so nothing leaks around the tunnel; the sidecar drops all IPv6 and answers AAAA empty.
- **Failed flows:** a TCP flow that can't be served (blocked destination, Mockttp down, SOCKS refused) is closed with a FIN 250 ms after the SYN, so the phone's handshake finishes first and the app sees a clean close at once instead of retrying SYNs until its own timeout.
- **ICMP echo** is answered by the stack so apps that "ping" to check connectivity stay happy.

## Security

- A phone can never reach `127.0.0.0/8`, `0.0.0.0`, multicast, broadcast or the tunnel net itself through the tunnel (TCP and UDP). Otherwise anyone with the QR could talk to the Mac's local services (the server API, the Mockttp admin port). `--unsafe-allow-loopback` lifts this for the tests only.
- A peer may only send from its own tunnel address; other source addresses are dropped.
- Datagrams from unknown keys, unknown session indexes or malformed WireGuard messages are ignored. Fragments, non-TCP/UDP/ICMP protocols and port-0 packets are dropped before they reach the smoltcp task (which stops on a few such inputs).
- Per-device keys; `remove-peer` revokes at once. The state file is `0600`. Handshakes have no rate limit yet.
- Whoever has the QR can use the Mac as a LAN exit node until the peer is removed.

## Limits (v1)

- IPv6 is dropped (IPv6-only hosts are unreachable).
- Only A answers carry records; no PTR/MX/TXT.
- The phone's TCP handshake completes before the SOCKS connection is made (the smoltcp task accepts on SYN). If Mockttp is down, the phone sees a connection that opens and then closes at once.
- QUIC block is a silent drop, so a client may wait for its own fallback timer.
- `--quic relay` does not parse QUIC SNI; there are no `udp-update`/`stats` events yet.
- DNS over TCP is implemented but has no test yet.
- Throughput and long soak runs are not measured (a 1.5 MB download through the debug test client takes about 0.1 s; there is no real-phone number yet). One mutex guards all peers' crypto.
- `Endpoint` is written as `host:port`, so an IPv6 literal would need brackets (IPv4 only for now).
- macOS Local Network privacy (TN3179) for the packaged app is untested; Windows and Linux builds are untested.
