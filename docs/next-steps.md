# Next steps: start here

Last updated 2026-10-13 (evening). A new session (or one after /clear or /compact) reads this file first, then `docs/remaining-work.md` (the full list, Uzbek) and the top of `PROJECT_LOG.md`.

**Qisqacha (o'zbekcha):** iPhone sinovidagi UI xatolari tuzatildi, VPN rejimining 1-bosqichi (WireGuard) qurildi va `main`ga push qilindi. Egasining iPhone'i Wirepane'ning o'z VPN'iga ulandi. Endi egasidan ilovalar bo'yicha natija va packaged app sinovi kutilyapti, kod tomonda esa quyidagi ro'yxat qoldi. Release faqat egasi aytganda.

## Done on 2026-10-13 (evening): Intel Mac build on the v1.1.0 release

- `./scripts/build-release.sh mac-x64` (or `scripts/build-mac-x64.sh`) builds `Wirepane-<VERSION>-mac-x64.pkg` and `.zip`; on Apple Silicon it needs Rosetta 2, which runs the server and VPN helper checks. CI has a `mac-x64` job on `macos-14` with Rosetta (not run yet).
- Both Mac builds now need macOS 13.5 (`minimumSystemVersion`): the bundled Node.js 24 is built for 13.5, so the old "macOS 12" was wrong for both.
- `Wirepane-1.1.0-mac-x64.pkg` is on the v1.1.0 release (`gh release upload`, SHA-256 `bbe15582…`), with the release notes updated. Checked through Rosetta on this Mac (every binary x86_64, signature, installer rules, hidden run with HTTP and HTTPS in View); never on a real Intel Mac. Under Rosetta the UI starts in ~45 s (arm64: 6 s), one startup timeout, then it recovers.

## Done on 2026-10-13: nine network tools on VPN mode (merged into main, not pushed)

Plan: `docs/plans/2026-10-13-rust-network-tools.md`. Three workflows (build 10 agents, quality 4, fix 5) plus one background agent; the lead integrated each result as it came in.

- **Tools** (Phone network page `/network`, linked from the iPhone page and the Devices panel): DNS view, DNS block/answer rules (every port-53 flow, not only the tunnel's resolver), UDP view with the QUIC switch (block / let through / decrypt), JA4 fingerprints (requests, failed TLS rows, grouped tab), Network Conditions per phone (presets 3G, Edge, LTE, lossy Wi-Fi, offline), pcap capture (2 GiB cap, numbered files, Show in Finder), HTTP/3 decryption (sidecar gateway → Mockttp as HTTP/1.1), Android VPN page, and **IKEv2 without an app** (sidecar front-end, one-time `.mobileconfig` link, "Without an app (IKEv2, beta)" on the iPhone page).
- **Security P0 fixed** (pre-existing): the Mockttp admin API now needs the per-run token (header or `/token/<token>` prefix) in packaged builds, and built-in rules close proxied requests to the app's own ports on loopback. Dev runs stay tokenless (CLAUDE.md, Pitfalls).
- **Checks:** sidecar 221 tests and release build (3.2 MB now, QUIC/HTTP3 crates); server 193 unit tests; UI 2155 tests, tsc clean; desktop build and 7 path tests; end to end through the dev server with the test WireGuard client.

### The owner checks on the iPhone (real device)

1. WireGuard VPN (dev, Chrome): http://localhost:45458/intercept/iphone → Capture all apps (VPN) → Start; then **Network tools**: DNS fills as apps run; add `*.example.com` Block and open it in Safari (blocked); Conditions → 3G on the iPhone (pages slow down) → Off; Capture → Start/Stop, Show in Finder, open in Wireshark; UDP tab during a call or a game; TLS tab shows a fingerprint per app.
2. HTTP/3: UDP tab → QUIC: Decrypt (beta), open https://cloudflare-quic.com twice in Safari: the requests show in View tagged `wirepane-vpn-h3`.
3. IKEv2 (no app): iPhone page → Without an app (IKEv2, beta) → Create the profile → QR in Safari or AirDrop → install → Settings › VPN › Wirepane on; traffic in View with `wirepane-vpn` tags; if it fails, `WIREPANE_TUNNEL_LOG=info` lines (`no acceptable IKE/ESP proposal`, `wrong secret`, `unknown identity`, `stayed on UDP 500`).
4. Packaged app (when asked for a test pkg): the macOS Local Network prompt, and the admin token path.

### Left (not done)

- IKEv2: no IKE SA rekey (iOS reconnects about daily), PSK only (no EAP/certificates), no IKE fragmentation, MOBIKE or IPv6, no HTTP/3 decrypt for IKEv2 phones; real-device proposals unverified.
- Mockttp's TLS-failure events carry no SOCKS tags (the UI matches tls-hello events instead); failed TLS panes say "this machine" for VPN phones.
- Delay queue has no per-phone share; dropped-packet count isn't in `stats`; a SIGKILL loses up to 1 s of a capture.
- Devices panel: the Network link only goes to the second line when the panel is wide enough.
- Windows and Linux sidecar builds never ran in CI.

## State

- `main` holds everything and is pushed. **Release v1.1.0** (2026-10-13) is on GitHub with the macOS arm64 and Intel (x64) `.pkg`s; Windows and Linux stay "coming soon" until the owner says.
- Nothing is running. Start the dev instance for checks with `./start.sh --no-window` (UI http://localhost:45458, API :45457, Mockttp admin :45456), in the background.
- Test pkg with VPN mode for the owner: `~/Downloads/Wirepane-1.0.0-vpn-test-mac-arm64.pkg` (built 2026-10-12 from `57ce4b2e1`'s code).
- The sidecar's dev build lives in `wirepane-tunnel/target/release/wirepane-tunnel` (gitignored; `cd wirepane-tunnel && cargo build --release --locked`). The dev server's `wireguard-vpn` interceptor finds it there.
- Plan with the contracts: `docs/plans/2026-10-12-iphone-fixes-and-vpn.md`. VPN research and the real-device results: `docs/research/phone-vpn-mode.md` (section 14). Sidecar contract: `wirepane-tunnel/README.md`.

## Waiting on the owner

1. **App-by-app result over Wirepane's own VPN** (dev): Jett, Road24, TelecomTV, OddiyTV. The iPhone completed a WireGuard handshake with the dev sidecar on 2026-10-12 18:03; what showed up in View wasn't reported yet.
2. **Packaged VPN test:** install the test pkg, Intercept › iPhone or iPad › Capture all apps (VPN) › Start, scan the QR. Check the macOS Local Network prompt (TN3179): it only appears for the packaged app, never for terminal-launched dev runs.
3. **Next release:** only when the owner says. Raise `VERSION`, build `./scripts/build-release.sh mac` and `mac-x64`, check both hidden (the x64 one runs through Rosetta), then `gh release create v<VERSION> <both pkgs> --target main` with notes cut from `.github/release-notes.md` (mac rows only while Windows and Linux are "coming soon").

## How to rerun the VPN checks without a phone

- Server and UI: `./start.sh --no-window`; open http://localhost:45458/view headless; read the proxy port from the status bar.
- `POST /interceptors/wireguard-vpn/activate/<proxyPort>` with `{"action":"add-peer","name":"E2E test"}` (header `Origin: http://localhost:45458`). The REST answer is wrapped: `{ result: { success, metadata } }`; the config is `result.metadata.config`.
- A test client on the same Mac must dial `127.0.0.1:<port>`, not the LAN address: macOS loops the packets back and the reply then comes from 127.0.0.1, which a connected UDP socket drops. Rewrite `Endpoint` in the config. Then: `wirepane-tunnel/target/release/examples/wg_client --config <file> --dns example.com --get <ip>:80 --host example.com --path /` (build it with `cargo build --release --example wg_client`).
- Mockttp shows the sidecar's tags as `socket-metadata:wirepane-vpn…` on each request.
- Clean up after: `remove-peer` for every test peer, then `{"action":"stop"}`. The state file is the real `~/Library/Preferences/httptoolkit/wirepane-vpn.json`.
- The scripts used on 2026-10-12 are in the session scratchpad (`e2e-vpn/e2e.cjs`, `ui-check.cjs`, `pkg-check.cjs`); rewrite them if the scratchpad is gone.

## Left to do (code), by priority

### P0, before the release

- [x] Devices panel: VPN peers show as "(p1)"; map peer ids to their names (the UI's vpn-mode store has them) so it says "iPhone".
- [x] README "Telefon trafigi" and the release notes: describe VPN mode (WireGuard app, QR, turn it off when done, pinned apps stay opaque), the Local Network prompt, Windows Firewall and `ufw` notes. The README's `ipconfig getifaddr en0` is wrong on Macs whose Wi-Fi is `en1`: say "the address the iPhone page shows".
- [x] `./setup.sh` builds the sidecar when `cargo` exists (and says how to get Rust when it doesn't), so VPN mode works in a fresh dev checkout.
- [x] A unit test for the interceptor's `{ action: 'stop' }` (added by the lead in `a7498792d`, untested).
- [x] Publish checklist (`docs/remaining-work.md` section 7): Local Network prompt on first VPN start, the helper adds ~1 MB, Windows/Linux CI not run yet.

### P1, VPN robustness (sidecar)

- [x] WireGuard timers: the server side never calls boringtun's `update_timers`, and its handshake `RateLimiter` is unused. Add both.
- [x] QUIC block answers with ICMP port unreachable instead of a silent drop, so apps fall back to TCP at once.
- [x] A test for DNS over TCP; `udp-update` and `stats` events; throughput numbers.
- [ ] IPv6 (now dropped; AAAA answered empty).
- [ ] Windows and Linux builds of the sidecar in CI.

### P1, UI polish found in the agents' reports

- [x] View column headers: on hover the chevron covers the sort arrow; check the menus in dark theme and at 1280×800; `status=4xx` / `type=` filters aren't offered by the filter box; one value per column (no GET+POST).
- [x] Body viewer: picking Hex by hand on a 4 MB body freezes Monaco for ~1.5 s (truncate); windows-1251 text shows U+FFFD; WebSocket message and Send response views not checked in a browser.
- [x] VPN badge in the View list's device cell (now only in its tooltip).
- [x] iPhone page: remember the chosen mode; a Remove button for old VPN devices; Settings › Proxy doesn't list the default passthrough hosts.

### Next: the nine network tools on VPN mode

Plan with models, time limits, contracts and file ownership: `docs/plans/2026-10-13-rust-network-tools.md` (IKEv2, Network Conditions, DNS view, DNS spoofing and blocking, JA4, UDP view, HTTP/3 decryption, pcap export, Android VPN). Languages: TypeScript + Rust (CLAUDE.md, Architecture).

### Phase 2: IKEv2, no extra app (owner's choice: after WireGuard)

- [ ] Second front-end in `wirepane-tunnel` (`src/frontend/`): IKE_SA_INIT / IKE_AUTH with a server certificate from the Wirepane CA, CHILD_SA (ESP AES-GCM), NAT-T on UDP 4500, config payload (IP, DNS), DPD and rekey.
- [ ] A `.mobileconfig` profile (Wirepane CA + VPN payload) served by Wirepane and opened from Safari, so one profile installs both.
- [ ] About 2–3 weeks. Start with a design doc and a spike against a real iPhone.

### Older items still open

- Raw tunnels: mockttp drops the reply when a client half-closes (`docs/remaining-work.md` 8.5).
- `httptoolkit-ui/src/index.html`'s startup `alert()` still links to httptoolkit.com.
- Design leftovers in `docs/remaining-work.md` section 4; Collections (section 8); Postman and Proxyman features (section 9).

## Rules that matter here (details in memory and CLAUDE.md)

- Nothing on the owner's screen: headless Chrome, `WIREPANE_HIDDEN_WINDOW=1` with CDP for built apps, `./start.sh --no-window`. The owner may start visible things themselves (`! open …`).
- Build a pkg only for an owner-requested test or a release. Never push or release uninvited; "main'ga merge, push" was asked for on 2026-10-12 and done.
- Parallel `/w` workflows with Sonnet agents for batches of independent fixes; give them file ownership and a time limit; integrate and verify as the lead (type check, unit tests, end-to-end).
- Upstream folders: edit with python/sed (the prettier hook), `// wirepane:` markers. zsh doesn't split `$VARS`.
