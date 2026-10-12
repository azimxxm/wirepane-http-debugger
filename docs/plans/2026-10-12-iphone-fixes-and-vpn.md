# Plan: iPhone-test fixes + VPN mode phase 1 (2026-10-12)

Written by the lead (Opus 5.5) for the parallel agents. Every agent reads this file first. The owner is away; decisions below are final unless they break something.

## Goals

1. Fix what the owner found while testing with their iPhone 13 Pro Max (proxy mode):
   - **F1 body viewer:** binary bodies shown as Text (a 4 MB `video/MP2T` segment from odtv.uz looked like broken Russian) or as a URL-encoded table (Google Analytics protobuf sent as `x-www-form-urlencoded`); the JSON view inserted spaces/newlines inside quoted values of Firebase's non-strict JSON (`{app_id:'1:170852505363:ios:…'}`) and Monaco showed 24 errors.
   - **F2 View columns:** column headers (Method, Status, Type, Source, Host, Path and query) can't sort or filter ("filterlash yo'q").
   - **F3 naming:** status bar "14 clients · io.appmetrica.analytics/5.8.2.0 +13" for one iPhone; the iPhone page's connected card shows an SDK user agent; the Devices panel lists SDKs (FBiOSSDK, AppMetrica, AppleCoreMedia) as apps and road24 twice; the toolbar breadcrumb shows the full URL with its query string.
2. Build **VPN mode phase 1** (WireGuard), proven on the owner's iPhone with mitmproxy's WireGuard mode: Flutter apps (Jett, Road24) and TelecomTV became visible and decrypted (`docs/research/phone-vpn-mode.md` sections 8 and 14). Phase 2 (later, not now) adds iOS's built-in IKEv2 so no extra app is needed.

## Decisions (final)

- Sidecar `wirepane-tunnel` (Rust, new folder `wirepane-tunnel/`), built on **mitmproxy_rs** as a git dependency pinned to the release tag that mitmproxy 12.2.3 uses (the stack the iPhone test ran on). The crates.io `mitmproxy` crate is only a placeholder. If mitmproxy_rs can't be used as a library quickly, fall back to boringtun 0.7 + smoltcp. The front-end (WireGuard now, IKEv2 later) is a separate module behind one boundary; the core (TCP→SOCKS, DNS, QUIC block, UDP relay, events) is shared.
- Every TCP flow goes to Mockttp's proxy port over SOCKS5 with the **custom-metadata** method (0xDA: 2-byte length-prefixed JSON `{"tags":[...]}`, server answers `05 00`), then CONNECT to the original destination IP:port. Mockttp attaches the tags to every request on that connection.
- Tags: `wirepane-vpn`, `wirepane-vpn-peer:<peerId>`, `wirepane-vpn-endpoint:<phone LAN IP>`, `wirepane-vpn-name:<dns name>` (when known).
- The UI's Mockttp options change `socks: true` → `socks: { authMethods: ['no-auth', 'custom-metadata'] }` (`httptoolkit-ui/src/model/proxy-store.ts`, the `socks: true` line).
- UDP port **51873** (not 51820), persisted; fall back to 51874–51899 if taken. Tunnel net `10.73.0.0/24`: server 10.73.0.1, DNS 10.73.0.53, peers from 10.73.0.2.
- QUIC (UDP/443) blocked by default. IPv6: client routes `::/0`, sidecar answers AAAA with no records and drops IPv6 TCP in v1.
- Pinned system hosts are passed through untouched by default, so the phone keeps working with VPN on: `*.push.apple.com`, `*.icloud.com`, `*.apple.com` push/location (`wps.apple.com`, `iphone-ld.apple.com`), plus anything the user marks. (Implemented on the Mockttp side as TLS passthrough hostnames, by the UI agent.)
- iPhone only for phase 1 in the UI (Android already has HTTP Toolkit's VPN app).

## Contracts

### Sidecar CLI and JSON lines (owner: S1)

```
wirepane-tunnel --wireguard <ip:port> --state <file> --socks <host:port>
                [--endpoint-host <LAN IPv4 the phone dials>] [--tunnel-net 10.73.0.0/24] [--quic block|relay]
```

- `--state`: JSON file (mode 0600) with the server key and peers; created if missing; peers survive restarts, so a scanned QR stays valid.
- stdin, one JSON object per line:
  - `{"cmd":"add-peer","name":"iPhone","kind":"wireguard"}` → stdout `{"event":"peer-added","peer":"p1","name":"iPhone","kind":"wireguard","tunnelIp":"10.73.0.2","config":"<wg-quick text>"}`
  - `{"cmd":"remove-peer","peer":"p1"}` → `{"event":"peer-removed","peer":"p1"}`
  - `{"cmd":"list-peers"}` → `{"event":"peers","peers":[{"peer","name","kind","tunnelIp","endpoint","lastHandshake"}]}`
  - `{"cmd":"set-socks","addr":"127.0.0.1:9474"}` → `{"event":"socks-set","addr":"127.0.0.1:9474"}`
  - stdin EOF → exit 0.
- stdout events: `{"event":"ready","listen":"0.0.0.0:51873","publicKey":"…"}`, `{"event":"peer","peer":"p1","endpoint":"192.168.0.199:61234","lastHandshake":<ms epoch>}`, `{"event":"dns","peer","name","qtype","rcode","answers","ms"}`, `{"event":"udp-open"|"udp-close", …}`, `{"event":"quic","peer","dst","action":"blocked"}`, `{"event":"error","message":"…"}`. Logs on stderr.
- Client config: `[Interface] PrivateKey, Address 10.73.0.N/32, DNS 10.73.0.53` / `[Peer] PublicKey, AllowedIPs 0.0.0.0/0, ::/0, Endpoint <endpoint-host>:<port>, PersistentKeepalive 25`.
- `wirepane.cert` resolves to a virtual IP; its TCP flows go to SOCKS by hostname `wirepane.cert` (the proxy answers that name itself).

### Server interceptor `wireguard-vpn` (owner: S2)

- New `httptoolkit-server/src/interceptors/wireguard-vpn.ts`, registered in `src/interceptors/index.ts` like the others.
- Binary: `process.env.WIREPANE_TUNNEL_BINPATH`, else the dev build `<repo>/wirepane-tunnel/target/release/wirepane-tunnel` (then `debug`). Missing binary → `available: false`, never a crash.
- State file: `<configPath>/wirepane-vpn.json`. Endpoint host: the machine's LAN IPv4 (the address the iPhone page already shows).
- `activate(proxyPort, options)`:
  - `{ action: 'start' }` → sidecar running with `--socks 127.0.0.1:<proxyPort>` (restart or `set-socks` if the port changed). Returns the metadata below.
  - `{ action: 'add-peer', name }` → starts if needed, returns `{ peer, name, tunnelIp, config }`.
  - `{ action: 'remove-peer', peer }` → `{ removed: true }`.
- `deactivate(proxyPort)` / `deactivateAll()` → stop the sidecar (state kept). The sidecar dies with the server (stdin pipe).
- `getMetadata('detailed')` → `{ available, running, listen, endpointHost, peers: [{ peer, name, tunnelIp, endpoint, lastHandshake }], error? }`.
- The UI calls these through the existing `activateInterceptor('wireguard-vpn', proxyPort, options)` and `getDetailedInterceptorMetadata('wireguard-vpn')` in `httptoolkit-ui/src/services/server-api.ts`.

### Device attribution (owner: F3)

- An event whose tags include `wirepane-vpn-endpoint:<ip>` belongs to the device at `<ip>` (not "This Mac", although the connection comes from 127.0.0.1), with a "VPN" marker; `wirepane-vpn-peer:<id>` identifies the WireGuard peer.

### Packaging (owner: S4)

- `scripts/build-tunnel.sh <target>` (`darwin-arm64`, `win32-x64`, `linux-x64`) → `build/tunnel/<target>/wirepane-tunnel[.exe]` (`cargo build --release --target <triple>`; `cargo-zigbuild` / `cargo-xwin` exist on this Mac for cross builds; the mac target is native).
- `scripts/build-release.sh` runs it; `httptoolkit-desktop/build-setup/wirepane-builder.config.cjs` ships it via `extraResources` to `Resources/wirepane-tunnel/`; mac `Info.plist` gets `NSLocalNetworkUsageDescription`; the desktop sets `WIREPANE_TUNNEL_BINPATH` for the server it spawns; `.github/workflows/release.yml` gets the Rust step (rustup is preinstalled on GitHub runners).

## File ownership (don't edit outside yours)

| Agent           | Owns                                                                                                                                                                                                                                                             |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1 body-viewer  | `httptoolkit-ui/src/model/events/{content-types,body-formatting}.ts`, `src/services/ui-worker-formatters.ts`, `src/util/json.ts`, `src/components/editor/*`, body cards under `src/components/view/http/`                                                        |
| F2 view-columns | `src/components/view/view-event-list.tsx` + new files beside it, additions in `src/model/filters/`                                                                                                                                                               |
| F3 naming       | `src/components/status-bar.tsx`, `src/model/devices/*`, `src/components/devices/*`, `src/components/intercept/phone/phone-setup-parts.tsx`, `src/model/interception/phone-setup.ts`, `src/components/app-toolbar.tsx`, `src/components/view/open-event-title.ts` |
| S1 sidecar      | `wirepane-tunnel/**`, one `.gitignore` line                                                                                                                                                                                                                      |
| S2 server       | `httptoolkit-server/src/interceptors/wireguard-vpn.ts` (+ helpers beside it), one registration line in `src/interceptors/index.ts`, its tests. Works in its own git worktree (edits in the main tree restart the shared dev server)                              |
| S3 ui-vpn       | `src/components/intercept/phone/connect-iphone-page.tsx`, new `src/components/intercept/phone/vpn-*.tsx`, new `src/model/interception/vpn-mode.ts`, the `socks:` line and TLS passthrough defaults in `src/model/proxy-store.ts`                                 |
| S4 packaging    | `scripts/build-tunnel.sh` (new), `scripts/build-release.sh`, `httptoolkit-desktop/build-setup/wirepane-builder.config.cjs`, the server env in `httptoolkit-desktop/src/index.ts`, `.github/workflows/release.yml`                                                |

Partial work from the stopped run is already in the tree (uncommitted): F1 in `content-viewer.tsx`, `monaco.ts`, `body-formatting.ts`, `content-types.ts`, `ui-worker-formatters.ts`, `util/json.ts`, new `binary-body-summary.tsx`, `relaxed-json-language.ts`; F3 in `model/devices/*`, new `app-groups.ts`, `app-identity.ts`. Review it, keep what's right, finish it. Scratch notes and screenshots: `scratchpad/w-fixes2/`.

## Verification

- UI: headless Chrome only, against the running dev instance (UI http://localhost:45458, API :45457, admin :45456). The owner's own Wirepane (CDP 9333, proxy 9473) must not be touched.
- Type check `logs/ui.log` → "No issues found."; `(cd httptoolkit-ui && npx tsc -p test/unit --noEmit)`; `npm run test:unit` in the UI and the server; `cargo test` for the sidecar.
- The lead integrates, runs everything together, builds the pkg and asks the owner for the iPhone test.
