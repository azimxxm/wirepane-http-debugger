# Next steps: start here

Last updated 2026-10-13 (afternoon). A new session (or one after /clear or /compact) reads this file first, then `docs/remaining-work.md` (the full list, Uzbek) and the top of `PROJECT_LOG.md`.

**Qisqacha (o'zbekcha):** iPhone sinovidagi UI xatolari tuzatildi, VPN rejimining 1-bosqichi (WireGuard) qurildi va `main`ga push qilindi. Egasining iPhone'i Wirepane'ning o'z VPN'iga ulandi. Endi egasidan ilovalar bo'yicha natija va packaged app sinovi kutilyapti, kod tomonda esa quyidagi ro'yxat qoldi. Release faqat egasi aytganda.

## State

- Branch `feature/rebrand` = `main` = `origin/main` (`57ce4b2e1`). The tree is clean. **No GitHub release exists**; the owner decides when (v1.0.0, macOS arm64 `.pkg` only; Windows and Linux "coming soon").
- Nothing is running. Start the dev instance for checks with `./start.sh --no-window` (UI http://localhost:45458, API :45457, Mockttp admin :45456), in the background.
- Test pkg with VPN mode for the owner: `~/Downloads/Wirepane-1.0.0-vpn-test-mac-arm64.pkg` (built 2026-10-12 from `57ce4b2e1`'s code).
- The sidecar's dev build lives in `wirepane-tunnel/target/release/wirepane-tunnel` (gitignored; `cd wirepane-tunnel && cargo build --release --locked`). The dev server's `wireguard-vpn` interceptor finds it there.
- Plan with the contracts: `docs/plans/2026-10-12-iphone-fixes-and-vpn.md`. VPN research and the real-device results: `docs/research/phone-vpn-mode.md` (section 14). Sidecar contract: `wirepane-tunnel/README.md`.

## Waiting on the owner

1. **App-by-app result over Wirepane's own VPN** (dev): Jett, Road24, TelecomTV, OddiyTV. The iPhone completed a WireGuard handshake with the dev sidecar on 2026-10-12 18:03; what showed up in View wasn't reported yet.
2. **Packaged VPN test:** install the test pkg, Intercept › iPhone or iPad › Capture all apps (VPN) › Start, scan the QR. Check the macOS Local Network prompt (TN3179): it only appears for the packaged app, never for terminal-launched dev runs.
3. **Release:** only when the owner says. Then `gh release create v1.0.0 <pkg> --target main` with mac-only notes (a mac-only notes draft was used before; the template `.github/release-notes.md` still lists every OS).

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
