# HTTP/3 decryption (QUIC mode `decrypt`)

Tool T7 of `docs/plans/2026-10-13-rust-network-tools.md`. Code: `src/features/quic.rs` and `src/features/quic/`. The core's side (`src/core/quic.rs`, T0) feeds it.

With `--quic decrypt` (or `{"cmd":"set-quic","mode":"decrypt"}`) and the Wirepane CA given with `--ca-cert`/`--ca-key`, the sidecar answers a phone's HTTP/3 itself instead of blocking it. Each request is replayed to Mockttp as HTTP/1.1 over TLS, so it shows in View like any other request, tagged `wirepane-vpn-h3`. `block` stays the default.

```
phone --QUIC (UDP/443)--> core: QuicDriver --datagrams--> QuicGateway (quinn + h3, leaf from the Wirepane CA)
                                                              |
       per request: SOCKS5 0xDA {tags} + CONNECT <server ip>:443 -> TLS (SNI, trusts only the Wirepane CA) -> HTTP/1.1 -> Mockttp
```

## Contract (sans-IO, kept from the stub)

| Item                                                       | What it does                                                                                                                                                                                      |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QuicGateway::new(ca_cert_pem, ca_key_pem, socks, events)` | Reads the CA (PKCS#8 PEM key, RSA or ECDSA; the Wirepane CA is RSA 2048 from Mockttp's `generateCACertificate`) and mints one leaf to prove it can sign. Errors here turn decrypt off (`lib.rs`). |
| `on_datagram(peer, src, dst, payload, now)`                | Queues the phone's datagram for quinn and returns what is already waiting for phones.                                                                                                             |
| `poll(now)`                                                | Returns every datagram quinn sent since the last call.                                                                                                                                            |
| `next_timeout()`                                           | `now` when datagrams wait; `now + 2 ms` while a connection is open or a datagram came in during the last 2 s; `None` when idle.                                                                   |
| `notifier()` (added)                                       | A `tokio::sync::Notify` rung whenever a datagram for a phone is queued. Optional: a caller that waits on it next to `next_timeout` sends answers without the 2 ms poll.                           |
| `decrypt_supported()`                                      | `true`: the round trips below pass.                                                                                                                                                               |

`OutDatagram` is `(from, to, payload)`: `from` is the server address the phone dialled (IP and port), `to` the phone's tunnel address.

## Design

- **quinn on a virtual socket** (`quic/socket.rs`). quinn accepts any `AsyncUdpSocket`. Ours takes datagrams from `on_datagram` (each tagged with the destination IP as `RecvMeta::dst_ip`) and queues what quinn sends. quinn answers a connection from the local IP it was reached on (`Transmit::src_ip`), so one endpoint serves every server address the phone dials; the port comes from a small (phone address, server IP) → port map, 443 in practice. QUIC routes by connection ID, so one phone socket talking to several servers works too.
- **Why polling.** quinn and h3 run as tokio tasks on the core's runtime, so answers come out asynchronously, not as the return value of `on_datagram`. The core's `QuicDriver::run` sleeps until `next_timeout()`; while anything is going on that is every 2 ms, which collects the answers (an idle phone with an open connection costs about 500 empty polls a second, until the 30 s idle timeout). quinn keeps its own loss-detection and idle timers. The endpoint is created on the first datagram, on the runtime that delivers it; dropping the gateway closes it.
- **Certificates** (`quic/certs.rs`). One leaf per server name, from the ClientHello's SNI, or the dialled IP when there is none: ECDSA P-256 (one key shared by every leaf, like Mockttp's), signed by the CA with SHA-256 (rcgen), SAN = the name, EKU serverAuth, random 16-byte serial (rcgen's default serial is a hash of the key, the same for every leaf, which browsers reject), the CA's key id as authority key id, valid from a day ago for 365 days (under Apple's 825-day rule). Cached, 1024 names, then the cache starts over. TLS 1.3 only, ALPN `h3`, no 0-RTT (replayed early data would reach Mockttp twice).
- **Replay to Mockttp** (`quic/forward.rs`). For each request, on its own task:
  1. SOCKS5 custom-metadata to the live `--socks` address (`core::socks`, same as TCP flows) with the tags `wirepane-vpn`, `wirepane-vpn-peer:<peer>`, `wirepane-vpn-h3`, `wirepane-vpn-sni:<sni>`, then `CONNECT <server ip>:<port>`, the address the phone dialled.
  2. TLS with the phone's SNI (or the `:authority` host), ALPN `http/1.1`, trusting only the Wirepane CA: Mockttp presents a certificate from it for the host, and nothing else may answer in its place.
  3. HTTP/1.1: `METHOD :path`, `host: :authority`, the other headers in order, minus hop-by-hop ones (`connection`, `keep-alive`, `proxy-connection`, `transfer-encoding`, `upgrade`, `te`); split `cookie` fields joined with `; `. A body with `content-length` is sent as it is, with one `content-length` (the first value, which the body must match exactly); one without is sent `chunked`; a request whose stream ends after its headers has none (`POST`/`PUT`/`PATCH` then get `content-length: 0`).
  4. The answer: interim `1xx` skipped, hop-by-hop headers (and those named in `Connection`) dropped, body by `content-length`, `chunked` (trailers dropped) or until close; none for `HEAD`, `204`, `304`. Bodies stream both ways in pieces of at most 32 KiB; an early answer (a `413` before the upload ends) stops the upload.
  5. Errors: before the response head, a `502` (or `503` when the request slots are full) with a short text; after it, the stream is reset (`H3_INTERNAL_ERROR`) so the phone knows the body is cut.
- **Hosts Mockttp passes through** (its TLS passthrough rules, e.g. the default Apple hosts). Mockttp then tunnels the TLS to the real server, whose certificate isn't from the Wirepane CA, so the replay can't work. The gateway rejects that request with `H3_REQUEST_REJECTED` (safe to retry), closes the connection, and refuses QUIC handshakes for that name for 10 minutes; the phone falls back to TCP, which Mockttp passes through as configured.
- **One Mockttp connection per request**, not pooled. Mockttp keeps it open after the answer; the gateway closes it.
- **Events.** The core reports each decrypted UDP/443 flow (`{"event":"quic","action":"decrypted"}`); the gateway adds none. A gateway that can't start reports an `error` event once.

## Limits (bounded memory and concurrency)

| What                                     | Limit                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------- |
| Datagrams waiting for quinn / for phones | 4096 / 8192 (dropped beyond, which QUIC treats as loss)                               |
| QUIC connections, all phones             | 128 (new ones refused)                                                                |
| Requests per connection (streams)        | 64; unidirectional streams 16                                                         |
| Requests forwarded at once, all phones   | 128; a request waits 10 s for a slot, then `503`                                      |
| Flow-control windows                     | 256 KiB per stream, 1 MiB per connection (receive), 1 MiB send                        |
| Datagram size                            | 1200 bytes, no path MTU probing (fits any tunnel MTU)                                 |
| Idle connection                          | closed after 30 s (or less if the phone asks)                                         |
| Timeouts                                 | handshake 10 s, SOCKS 10 s, TLS to Mockttp 10 s, response head 120 s, body idle 120 s |
| Request header section / response head   | 64 KiB / 64 KiB and 256 headers                                                       |
| Cached leaf certificates                 | 1024 names                                                                            |

Not supported (yet): trailers either way (gRPC over HTTP/3), extended CONNECT (WebSockets over HTTP/3, WebTransport, MASQUE): `CONNECT` gets a `502`, server push, QUIC datagrams, 0-RTT, pooling Mockttp connections. A pinned app refuses the leaf and falls back to TCP, as it does today with block.

## Tests

```bash
cargo test --locked features::quic       # unit and round-trip tests (about 0.3 s after compiling)
cargo test --locked --test http3 -- --nocapture   # the real binary, over WireGuard
```

- `quic/tests.rs`: an HTTP/3 client (quinn + h3) on a real loopback UDP socket; a loop that drives the gateway like `QuicDriver` (`on_datagram` as if the phone 10.73.0.2 sent to 93.184.216.34:443, `poll` at `next_timeout`), checking every answer comes from the dialled server address; a stand-in for Mockttp (SOCKS5 0xDA, TLS with a leaf from the same CA, HTTP/1.1). Covered: GET (tags, CONNECT target, SNI, head, joined cookies, hop headers removed), a second request on the connection with a 300 KB body, POST streaming 50 KB both ways (chunked upload, `100 Continue` skipped, chunked answer with trailers), `content-length: 0` for an empty POST, a sized PUT sent as it is, answers ended by close, `204` and `HEAD` (length kept, no body), Mockttp down (`502`), a phone that doesn't trust the CA (no connection, nothing replayed), a passed-through host (rejected, then refused at the handshake), garbage datagrams (empty, short, noise, unknown version, junk after valid headers) followed by a working connection, polling that stops about 2 s after the phone closes, the queue bounds, the leaf cache and chain.
- `tests/http3.rs`: the sidecar binary with `--quic decrypt --ca-cert --ca-key`; a test phone of its own (boringtun + quinn on a WireGuard socket) dials 93.184.216.34:443; the request reaches the stand-in with the tags, and a 4 MB download runs on the same connection: about 19 MB/s in a debug build, 64 MB/s in release (`CARGO_TARGET_DIR=<elsewhere> cargo test --release --test http3 -- --nocapture`), one run each on the dev Mac, on loopback, with the test phone's own WireGuard and QUIC work counted in. With the 2 ms poll a request after the handshake took 2 ms (release) to 9 ms (debug).
- Against a real Mockttp (httptoolkit-server's copy), ignored by default:

  ```bash
  dir=$(mktemp -d); node scripts/mockttp-h3.cjs "$dir" &   # prints READY <port>; makes a CA like the Wirepane one
  WIREPANE_H3_MOCKTTP=127.0.0.1:$(cat "$dir/port") WIREPANE_H3_TEST_CA="$dir" \
    cargo test --locked features::quic -- --include-ignored
  # with the internet: a real HTTP/3 site through the binary and Mockttp's passthrough rule
  WIREPANE_H3_MOCKTTP=127.0.0.1:$(cat "$dir/port") WIREPANE_H3_TEST_CA="$dir" WIREPANE_H3_SITE=cloudflare-quic.com \
    cargo test --locked --test http3 -- --include-ignored --nocapture
  kill %1
  ```

  Verified 2026-10-13: Mockttp logged `GET https://example.test/hello`, HTTP/1.1, tags `socket-metadata:wirepane-vpn`, `…-peer:p1`, `…-h3`, `…-sni:example.test`, and the POST; the leaf from its RSA CA chains (`signs_with_an_rsa_ca_like_the_wirepane_one`). The real site: `cloudflare-quic.com (104.18.27.14:443): 200 OK with 125961 body bytes in 363 ms; server "cloudflare", alt-svc h3=":443"`, and Mockttp logged `GET https://cloudflare-quic.com/` over HTTP/1.1 with the four tags.

Not tested here: a real iPhone or Android phone (Safari, Chrome, apps), which needs the owner; macOS arm64 only.
