# Plan: nine network tools on top of VPN mode (2026-10-13)

Written by the lead (main session, Opus 5.5) for the parallel agents. Every agent reads this file first, then `docs/next-steps.md`, `wirepane-tunnel/README.md` and the repo's CLAUDE.md. The owner is away; the decisions below are final unless they break something.

## The rule: TypeScript + Rust

Everything stays TypeScript, except network work below the HTTP layer that Node can't do or does badly. That goes into the Rust sidecar `wirepane-tunnel/`. All nine tools below work on the traffic that VPN mode already brings to the Mac (every app on the phone, Flutter included), so each one is a Rust part in the sidecar plus a TypeScript part in the server and the UI.

## The nine tools (scope for this round)

| #   | Tool                          | MVP this round                                                                                                                                                                                                                                                                          | Owner           | Model, effort      | Time                    |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------ | ----------------------- |
| 0   | **Foundation**                | Command and event channel sidecar ↔ server ↔ UI, hooks in the sidecar core, the Network page shell                                                                                                                                                                                      | `T0-foundation` | Opus 5.5, high     | 45 min                  |
| 1   | **IKEv2, no extra app**       | A second front-end next to WireGuard: IKE_SA_INIT + IKE_AUTH, ESP (AES-GCM) in UDP 4500, config payload (IP, DNS), checked with RFC test vectors and a local client; a `.mobileconfig` (Wirepane CA + VPN) the phone opens in Safari; "Without an app (IKEv2, beta)" on the iPhone page | `T1-ikev2`      | Opus 5.5, xhigh    | 90 min, partial allowed |
| 2   | **Network Conditions**        | Per device: latency, jitter, down/up bandwidth, packet loss; presets (3G, Edge, lossy Wi-Fi, offline); controls on the Network page                                                                                                                                                     | `T2-conditions` | Sonnet 5.5, high   | 45 min                  |
| 3   | **DNS view**                  | Every DNS query per device: name, type, answers, time, blocked/rewritten mark; search and filter                                                                                                                                                                                        | `T3-dns-view`   | Sonnet 5.5, high   | 40 min                  |
| 4   | **DNS spoofing and blocking** | Rules `pattern → block` or `pattern → IPv4` (wildcards like `*.example.com`), saved, applied live                                                                                                                                                                                       | `T4-dns-rules`  | Sonnet 5.5, high   | 45 min                  |
| 5   | **JA4 fingerprints**          | JA4 from every TLS ClientHello in the tunnel (pinned apps too), as a request tag and an event; shown on requests and on failed TLS rows; group by fingerprint                                                                                                                           | `T5-ja4`        | Sonnet 5.5, high   | 45 min                  |
| 6   | **UDP view**                  | UDP flows per device (games, WebRTC, calls): destination, name, packets, bytes, duration, QUIC blocked mark                                                                                                                                                                             | `T6-udp-view`   | Sonnet 5.5, high   | 40 min                  |
| 7   | **HTTP/3 decryption**         | QUIC mode `decrypt`: the sidecar terminates HTTP/3 with a leaf cert from the Wirepane CA and forwards each request as HTTP/1.1 through SOCKS to Mockttp (tag `wirepane-vpn-h3`), so it shows in View like any request; `block` stays the default                                        | `T7-http3`      | Opus 5.5, xhigh    | 90 min, partial allowed |
| 8   | **pcap export**               | Start/stop a capture of the tunnel's IP packets to `.pcapng` (one interface per device), "Show in Finder"                                                                                                                                                                               | `T8-pcap`       | Sonnet 5.5, high   | 40 min                  |
| 9   | **Android VPN**               | "Capture all apps (VPN)" on the Android page with the WireGuard app (Play Store), same QR flow; honest note: since Android 7 most apps don't trust user CAs, so their HTTPS shows as host only unless the existing ADB/root flow installs the CA as a system CA                         | `T9-android`    | Sonnet 5.5, medium | 35 min                  |

Models: Sonnet 5.5 builds the well-specified parts quickly; Opus 5.5 takes the cross-layer foundation and the two protocol/crypto-heavy tools (IKEv2, HTTP/3). Opus 4.8 is used once, as an independent code reviewer in the quality phase: a different model generation misses different things than the one that wrote the code. Haiku isn't used.

## Workflows (≤10 agents each, sequential)

1. **W1 Build** (10 agents, all in parallel): T0 to T9. The lead writes the contract stubs below before launching, so nobody waits for T0: feature agents implement their own modules and UI tabs against the stubs, T0 wires the hooks and the channel.
2. **W2 Quality** (4 agents, read-only, parallel): code review (Opus 4.8, max), security audit of the sidecar's exposure, IKEv2, HTTP/3 and DNS (Opus 5.5, max), headless QA screenshots of every new screen in light and dark (Sonnet 5.5, high), end-to-end run of all tools through a test WireGuard client (Sonnet 5.5, high). 25 min.
3. **W3 Fix** (≤5 agents, Sonnet 5.5, high): one per group of confirmed findings. 30 min.
4. The lead integrates, runs every check, commits per tool, merges into main, writes the report. Real-iPhone checks (IKEv2 profile, HTTP/3 apps, conditions) go to the owner as a short list.

## Contracts

### Sidecar: Rust modules (stubs written by the lead in `wirepane-tunnel/src/features/`)

Each tool owns its module file and keeps these signatures (it may add private items and tests):

- `conditions.rs` (T2): `Conditions { latency_ms, jitter_ms, down_kbps, up_kbps, loss_pct }`, `Shaper::new(Conditions)`, `Shaper::admit(&mut self, Direction, len, now) -> Verdict` (`Now`, `At(Instant)`, `Drop`).
- `dns_rules.rs` (T4): `DnsRule { pattern, action }`, `DnsAction::{Block, Answer(Ipv4Addr)}`, `DnsRules::new(Vec<DnsRule>) -> Result<Self, String>`, `DnsRules::decide(&self, name) -> Option<&DnsAction>`.
- `capture.rs` (T8): `PcapWriter::create(path)`, `write_packet(&mut self, peer, Direction, ip_packet, SystemTime)`, `finish(self) -> CaptureSummary { packets, bytes }`.
- `fingerprint.rs` (T5): `TlsHello { sni, alpn, ja4 }`, `parse_client_hello(first_bytes) -> Option<TlsHello>`.
- `quic.rs` (T7) and `src/frontend/ikev2/` (T1): free-form inside, behind the hooks T0 adds.

### Sidecar: commands and events (T0 wires them; tools fill the logic)

- stdin: `{"cmd":"set-conditions","peer":"p1","conditions":{…}|null}` → `{"event":"conditions-set","peer":"p1"}`; `{"cmd":"set-dns-rules","rules":[{"pattern":"*.example.com","action":"block"},{"pattern":"api.test","action":"answer","ipv4":"192.168.0.10"}]}` → `{"event":"dns-rules-set","count":2}`; `{"cmd":"set-quic","mode":"block"|"relay"|"decrypt"}` → `{"event":"quic-mode","mode":"…"}`; `{"cmd":"capture-start","path":"…"}` → `{"event":"capture-started","path":"…"}`; `{"cmd":"capture-stop"}` → `{"event":"capture-stopped","path","packets","bytes"}`.
- stdout events relayed to the UI: `dns` (+ `"rule":"blocked"|"answered"` when a rule fired), `udp-open`, `udp-update`, `udp-close`, `quic`, `tls-hello` `{peer, dst, sni, alpn, ja4}`, `stats`.
- Hooks in the core (T0): every IP packet both ways → shaper (when the peer has conditions) and capture (when capturing); every DNS question → `DnsRules::decide` before resolving; the first client bytes of every TCP flow are read (≤300 ms, then go on without) → `parse_client_hello` → a `tls-hello` event and the tags `wirepane-vpn-sni:<sni>`, `wirepane-vpn-ja4:<ja4>` on the SOCKS connection; UDP/443 → `quic` per the mode; options `--ca-cert <pem> --ca-key <pem>` (for T7's leaf certs) and `--ikev2 <ip:port>` (for T1's front-end).

### Server: `wireguard-vpn` interceptor (T0)

- `activate(port, { action: 'configure', settings })`: `settings` is a patch of `{ conditions: { [peer]: Conditions | null }, dnsRules: DnsRule[], quic: 'block'|'relay'|'decrypt' }`, saved to `<configPath>/wirepane-vpn-settings.json`, sent to the sidecar now and after every restart.
- `activate(port, { action: 'capture-start' })` → `{ path }` (in `<configPath>/captures/wirepane-<timestamp>.pcapng`); `{ action: 'capture-stop' }` → `{ path, packets, bytes }`.
- Events: a ring buffer of the last 5000 relayed sidecar events with a sequence number; `GET /interceptors/wireguard-vpn/metadata/events-<since>` (the existing sub-metadata route) → `{ seq, events }`.
- The detailed metadata gains `settings` and `capture` (running or not, path).
- The sidecar is started with `--ca-cert`/`--ca-key` pointing at the Wirepane CA files (`generateHTTPSConfig`'s paths) and, when T1 is on, `--ikev2`.

### UI (stubs written by the lead)

- `httptoolkit-ui/src/model/interception/vpn-network.ts`: a MobX store `VpnNetworkStore` with `dnsQueries`, `udpFlows`, `tlsHellos`, `stats` (bounded lists, per peer), `settings`, `capture`, and `configure(patch)`, `startCapture()`, `stopCapture()`. T0 implements the polling (every 1 s while the VPN runs) and the actions; tools read from it.
- `httptoolkit-ui/src/components/network/network-page.tsx`: route `/network`, title "Phone network", tabs DNS · UDP · TLS · Conditions · Capture, each tab a component in its own file (`dns-tab.tsx` T3+T4, `udp-tab.tsx` T6, `tls-tab.tsx` T5, `conditions-tab.tsx` T2, `capture-tab.tsx` T8). T0 adds the route and links from the iPhone page's VPN section and the Devices panel's VPN devices.

## File ownership

| Agent | Owns                                                                                                                                                                                                                                                              |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T0    | `wirepane-tunnel/src/{main.rs,lib.rs,events.rs,core/**,frontend/mod.rs,frontend/wireguard.rs}`, `features/mod.rs`; `httptoolkit-server/src/interceptors/wireguard-vpn*.ts` and its tests; `vpn-network.ts`; `network-page.tsx`; the route in `app.tsx`; the links |
| T1    | `wirepane-tunnel/src/frontend/ikev2/**`; a new `httptoolkit-server/src/interceptors/wireguard-vpn-ikev2.ts` (profile building); the iPhone page's IKEv2 option (`vpn-ikev2*.tsx`, a small hook in `vpn-mode-choice.tsx`)                                          |
| T2    | `features/conditions.rs`; `conditions-tab.tsx`                                                                                                                                                                                                                    |
| T3    | `dns-tab.tsx` (the list)                                                                                                                                                                                                                                          |
| T4    | `features/dns_rules.rs`; `dns-rules-editor.tsx` (used by `dns-tab.tsx`)                                                                                                                                                                                           |
| T5    | `features/fingerprint.rs`; `tls-tab.tsx`; showing JA4 on request details and failed TLS rows (small hooks, `// wirepane:`)                                                                                                                                        |
| T6    | `udp-tab.tsx`                                                                                                                                                                                                                                                     |
| T7    | `features/quic.rs` (+ `features/quic/**`)                                                                                                                                                                                                                         |
| T8    | `features/capture.rs`; `capture-tab.tsx`                                                                                                                                                                                                                          |
| T9    | `httptoolkit-ui/src/components/intercept/phone/connect-android-page.tsx` (and new `android-vpn-*.tsx`)                                                                                                                                                            |

Cargo.toml dependencies: each tool may add the crates it needs; `Cargo.toml` and `Cargo.lock` are shared, so add with `cargo add` and never remove others' entries.

## Verification

- `cargo test --locked` in `wirepane-tunnel`, `npx mocha --exit test/unit/wireguard-vpn*.spec.ts` in the server, the UI's type check and `npm run test:unit`.
- End to end through the dev server with the test WireGuard client (`docs/next-steps.md`, "How to rerun the VPN checks without a phone"); headless screenshots of every tab, light and dark.
- Real-device checks are the owner's: IKEv2 profile install and connect, HTTP/3 apps (Safari, Chrome, Instagram), conditions felt in an app.
