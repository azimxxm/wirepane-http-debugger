# Project log

## 2026-10-13

### VPN mode polish, and the plan for nine network tools

- **Merged into main (local, not pushed):** VPN peer names and a VPN marker on devices; `./setup.sh` builds the helper (start.sh warns when it's missing); a test for stopping VPN mode; the helper's WireGuard timers, handshake limiter, ICMP for blocked QUIC, `stats`/`udp-update`, DNS-over-TCP test and throughput test; View column headers polish (arrow and chevron, multi-pick, `status=4xx`/`type=` in the filter box); body viewer Hex cut for big bodies, legacy charsets, WebSocket/Send checks; iPhone page remembers its mode, lists VPN devices with Remove, Settings › Proxy shows the passthrough hosts; README/release notes/publish checklist for VPN mode.
- **Checks:** UI 1738 tests and tsc clean; server 46 VPN tests; sidecar 24 tests and release build; end to end with a test WireGuard client (DNS + HTTP 200 with tags).
- **Decision:** TypeScript + Rust; Rust only for network work below HTTP (CLAUDE.md). A Rust rewrite of Mockttp/server (~35k lines) was rejected.
- **Next:** the nine tools on VPN mode, plan with models and time limits in `docs/plans/2026-10-13-rust-network-tools.md`, building on `feature/rust-network-tools`.

### Nine network tools on VPN mode (merged into main, not pushed)

- **Built** (W1, 10 agents: Opus 5.5 for the foundation, IKEv2 and HTTP/3, Sonnet 5.5 for the rest): DNS view, DNS rules, UDP view + QUIC switch, JA4, Network Conditions, pcap capture, HTTP/3 decryption, Android VPN, IKEv2 without an app; the `/network` page.
- **Quality** (W2: review on Opus 4.8, security on Opus 5.5, QA and end to end on Sonnet 5.5): 1 P0 (pre-existing: the Mockttp admin API had no token and the proxy forwards absolute-form requests to loopback), 9 P1, ~20 P2.
- **Fixed** (W3, 5 agents, plus the lead): the P0 (admin token in packaged builds, built-in rules closing proxied requests to the app's own ports), DNS rules on every port-53 flow, captures (flush on stop, 2 GiB cap, numbered files, device names), delay queue byte budget, QUIC mode switch ends old flows, HTTP/3 origin-form only, iPhone vs Android peers, JA4 on failed TLS rows, labels, Show in Finder, server validates settings before saving, CA key only for decrypt, stats every 2 s.
- **Checks:** sidecar 221 tests, server 193, UI 2155, desktop build + 7 tests, end to end through the dev server.
- **Next:** the owner's iPhone checks (`docs/next-steps.md`), then push when asked.

## 2026-10-12

### iPhone test fixes and VPN mode phase 1 (WireGuard)

- **Proxy-mode findings (owner's iPhone):** Flutter apps (Jett, Road24) and TelecomTV bypass the Wi-Fi proxy; a mitmproxy WireGuard test showed them all decrypted. Plan with contracts: `docs/plans/2026-10-12-iphone-fixes-and-vpn.md`; results: `docs/research/phone-vpn-mode.md` section 14.
- **UI fixes:** binary bodies open as Summary/Hex/Protobuf instead of Text or URL-encoded; non-strict JSON (Firebase iOS) is shown as sent, without error markers; View column headers sort and filter (chips in the filter bar); status bar, Devices panel, iPhone card and toolbar name devices and real apps (bundle ids, SDK labels, VPN tags).
- **VPN mode:** Rust sidecar `wirepane-tunnel/` (WireGuard → SOCKS5 custom-metadata tags → Mockttp, DNS, QUIC block, UDP relay, 1.1 MB), server interceptor `wireguard-vpn`, iPhone page "Capture all apps (VPN)" with QR and live status, default TLS passthrough for pinned Apple hosts, the helper inside the pkg (`scripts/build-tunnel.sh`, `NSLocalNetworkUsageDescription`).
- **Checks:** UI 1635 tests, tsc clean; server 41 VPN tests; sidecar 14 tests; end to end with a userspace WireGuard client (DNS + HTTP 200 arrived in the UI with the tags); the owner's iPhone completed a handshake with Wirepane's own sidecar (dev); pkg has the signed helper and VPN mode is available in the packaged app (hidden check).
- **Next:** the owner's app-by-app result over Wirepane's VPN, the packaged app's Local Network prompt, then IKEv2 (no extra app).

### v1.0.0 release held back (macOS arm64 .pkg only, when the owner says)

- **Merged:** `feature/rebrand` fast-forwarded into `main` and pushed to `azimxxm/wirepane-http-debugger`.
- **Release:** not made. It was going to hold one file, `Wirepane-1.0.0-mac-arm64.pkg` (the build the owner installed and tested), but the owner stopped it: first fix that some iPhone apps' requests don't show in View, then release when the owner says. The empty draft it left was deleted.
- **Windows and Linux:** "coming soon" until the owner says. The first CI run (`38241881241`) built mac fine; the Windows and Linux builds were cancelled before they finished, so they have never completed in CI yet.

### Pre-release fixes (a58bfce..67e523a, not pushed)

- **Toolbar:** one 52 px window toolbar with breadcrumbs ("View › GET /todos/1", ⌘[ back) and the "Search or run a command ⌘K" field; the rail starts below it.
- **Raw tunnels on:** `FEATURE_FLAGS = ['raw-tunnels']` in `account-store.ts`. Non-HTTP TCP goes through and shows in View under its device; Frida apps use SOCKS. Open: mockttp drops the reply when a client half-closes (`docs/remaining-work.md` 8.5).
- **Own dialogs:** `alert()`/`confirm()` replaced by `messageDialog()`/`confirmDialog()` (`model/ui/dialogs.ts`, `DialogHost`), View's Clear and pinned deletes included. Only the startup alert in `index.html` stays.
- **iPhone page:** step 3 says Safari (Chrome shows an empty page), the QR caption warns about the default browser, an AirDrop "Save certificate (.crt)" button.
- **Ports:** proxy 9473–9999 (was 8000), dev UI 45458 (was 8080).
- **Checks:** UI 1514 unit tests, `tsc -p test/unit` clean, dev type check clean, dev UI loads headless on 45458 with the proxy on 9473.
- **Next:** new test pkg for the owner; after "done": push, Actions → Release, check the draft, publish.

### Release 1.0.0 prepared: macOS, Windows, Linux (not pushed, no CI run yet)

- **Version:** root `VERSION` = `1.0.0` for file names, the tag, the macOS About panel and Settings > Status. The internal app/server version stays `1.27.2`.
- **Builds:** `./scripts/build-release.sh <mac|win|linux>` (mac: `./scripts/build-pkg.sh`). The server release is per target (`build/server/<target>`), with its `node_modules` installed by Node 24.19.0's own npm (`scripts/stage-server-deps.cjs`), so `tls-impersonate` is in. UI specs are brotli-compressed (`scripts/assemble-ui.cjs`, 387 → 28 MB). App 911 → 525 MB, pkg 197 MiB.
- **Workflow:** `.github/workflows/release.yml` (dispatch or `v*` tag): macos-14, windows-2022, ubuntu-22.04, then a draft release with 7 files + `SHA256SUMS.txt`. Linted with actionlint (wasm) and action-validator.
- **Names:** Electron userData/logs/lock are `Wirepane` (shared with dev, accepted), socket `wirepane-ctl.sock`, Linux executable `wirepane`, menu "About/Hide/Quit Wirepane".
- **Bug fixed:** collections didn't open in the packaged app ("n.grammar is not a function"): rspack bundled ohm-js's ESM build. `rspack.config.js` now resolves `../bruno` like Node; `build-server.sh` reads a collection and imports a Postman one in every release check.
- **Checks:** codesign (adhoc) OK, pkg unsigned, hidden launch (UI, proxy, View, specs, userData, socket, ctl, Status card, SIGTERM) and a collections smoke all passed. Server 96, UI 1469 tests pass, desktop build OK.
- **Next:** the owner tests the pkg and says "done" → push → Actions → Release → Run workflow → check the draft → Publish.

### Own installable app (no Apple Developer account)

- **`./scripts/build-pkg.sh`** builds `httptoolkit-desktop/dist/Wirepane-1.27.2-arm64.pkg` (~210 MB, plus a `.zip`) from this repo: Bruno, our server release (`scripts/build-server.sh` + `scripts/assemble-server.cjs` → `build/server/`), the UI (`DISABLE_UPDATES=true`), the desktop (`npm run build` → `build-setup/wirepane-builder.config.cjs`).
- **App:** ad-hoc signed (`identity: '-'`, no hardened runtime), unsigned pkg, no notarization, no `CSC_*`. `ENABLE_SIGNING=true` keeps upstream's signed path for later.
- **UI** is bundled and served from `wirepane://app` (`httptoolkit-desktop/src/bundled-ui.ts`); the release server only accepts that origin.
- **No self-updates:** `@oclif/plugin-update` removed (its init hook had tried `update --autoupdate` on 2026-10-10), oclif `dirname` is `wirepane-server`, our launcher never runs a server from `~/.local/share/*/client`.
- **Checks:** `codesign --verify --deep --strict` OK; hidden launch (`WIREPANE_HIDDEN_WINDOW=1`) loaded the UI, proxied a request into View, kept localStorage/IndexedDB across a restart, quit cleanly; `.pkg` installed into `~/Applications` without a password (removed again). Server, UI unit tests pass.
- **Next:** the owner installs the pkg on a clean user (Gatekeeper flow). Notes in `docs/remaining-work.md` section 7.

## 2026-10-10

### Done (branch `feature/rebrand`, not pushed)

- **Setup.** `CLAUDE.md` (from `init`, imports README). `.md` files are tracked. Fixed the UI dev-server crash on Apple Silicon without Rosetta.
- **Wirepane brand.** Name, logo (`brand/`, regenerate with `./brand/build-icons.sh`), bundle ID `com.wirepane.app`. GitHub repo renamed to `azimxxm/wirepane-http-debugger`, with description and topics.
- **Free.** Every Pro feature is free: no account, login or checkout.
- **Docs.** Design critique and plan (`docs/design-plan.md`, `docs/design/critique-2026-10-10.md`), Postman research (`docs/research/postman.md`), collections plan (`docs/collections-plan.md`).
- **Redesign phase 1:**
  - logo-aligned theme tokens, real fonts;
  - visible focus rings and AA status colours.
- **Redesign phase 2:**
  - status bar and page headers;
  - guided Intercept (recommended sources, reasons for unavailable ones);
  - View detail actions, Modify templates, empty states, navy rail.
- **Bruno subtree** in `bruno/`, tracked by `sync-upstream.sh`.
- **Collections C1 (server).** `httptoolkit-server/src/collections/`:
  - import: Postman, Insomnia, OpenAPI, WSDL, HAR, Bruno;
  - export: Postman v2.1 or Bruno zip, with secret redaction;
  - REST endpoints `/collections*`.

### Done later the same day
- Collections UI committed (`c5aa852`), including the fix for `{{var}}` URLs and the alert loop.
- B1 merged (`4820cb2`): the server runs Bruno from `bruno/packages/*`, built by `scripts/build-bruno.sh` (run by `./setup.sh`). Server tests 65/65, UI tests 1068.

### Was in progress (now done)

- **Collections UI (C2–C4).** Uncommitted in `httptoolkit-ui`:
  - Collections panel in Send;
  - Docs, environments and `{{vars}}`;
  - Save from View, Share, Import.
  - Owner found 2 bugs:
    1. `{{baseUrl}}` URLs were blocked by the native `type=url` validation ("Please enter a URL.").
    2. The fix then showed an `alert()` that looped forever.

    The agent is fixing both. Rule: no `alert()`, show the error inline, validate only on Send.

- **B1 (done, not merged).** The server uses our own `bruno/packages/*` (`scripts/build-bruno.sh`, `file:` deps), and 3 converter bugs are fixed in Bruno's source (`// wirepane:`).
  - Commit `79db50b` on branch `worktree-agent-a8cb887ff544861c2`, worktree `.claude/worktrees/agent-a8cb887ff544861c2`.
  - Merge it AFTER the Collections UI is committed: `git cherry-pick 79db50b`, then `scripts/build-bruno.sh`, then `cd httptoolkit-server && npm ci`, then `npm run test:unit`. After that, remove the worktree and branch.

### Send v2, phones and privacy (later the same day)

- **Send v2** (plan: `docs/send-v2-plan.md`), built by 4 parallel agents on a shared foundation (`model/send/send-extras.ts`, `send-files.ts`, `build-request.ts`):
  - Form, Multipart (files, images, media, drag & drop) and Binary bodies; files kept in IndexedDB; `/client/send` takes up to 256 MB.
  - GraphQL mode: schema introspection through the server, autocomplete, hover, validation, docs panel (`graphql-language-service@5.7.0`).
  - WebSocket client: the server opens the connection (`/client/ws/*`), composer, saved messages, message log.
  - Collections: every mode saved to Bruno items, files in the collection's `files/` folder and in the Bruno zip; Postman export gets file bodies and warns about WebSocket requests.
  - Re-verified together after merging: UI tests 1251, server tests 91, all four acceptance scripts pass (httpbin multipart, countries GraphQL, wss echo, collections save/export).
- **Connect a phone:** in-app iPhone and Android screens (IP, port, certificate QR, live connected status). The proxy port now stays the same across reloads (get-port's lock and leaked dev sessions were the cause).
- **Privacy:** no built-in HTTP Toolkit Sentry DSN in the server or desktop app; the server ignores self-update requests (it used to fetch the official server from HTTP Toolkit's GitHub).
- **Fixed:** pasting a full URL into the empty Send URL field gave `https://https://...`.
- **Seen once, not reproduced:** "Startup failed: Syntax compatibility error" in the owner's window while agents were editing and installing packages; a monitor saw no repeat over 32 reloads.

### Evening, before the Mac was shut down

- **Wirepane CA:** the server now creates its own "Wirepane CA" (`wirepane-ca.pem`); the official app's `ca.pem` is untouched. Phones get it at `http://wirepane.cert/certificate` (answered by the proxy). The owner's iPhone still has the old "HTTP Toolkit CA": remove it, install Wirepane CA, turn on full trust, check `https://wirepane.cert`. The app's proxy port was 8040.
- **Dock:** `start.sh` brands the dev Electron.app as Wirepane (`scripts/brand-dev-electron.sh`). Verified: macOS shows "Wirepane" with our icon.
- **Menu bar icon:** added (`httptoolkit-desktop/src/menu-bar-icon.ts`), not yet seen running: it appears on the next `./start.sh`. Check it shows and its menu works.
- **Devices panel in View (done 2026-10-12):** a Proxyman-style Devices section on the left of View (`httptoolkit-ui/src/components/devices/`, model in `src/model/devices/`).
  - Devices are told apart by client IP. Loopback & Send-page requests are "This Mac"; this Mac's own LAN IP is its own device on purpose (simulators, `curl --interface` tests). Type & Android model come from the User-Agent; names are kept in localStorage by IP.
  - Rows: All devices, This Mac, each device (icon, name, IP, count, a dot when active in the last minute). A device opens to its apps & busiest domains. Clicking or arrow keys filter the list, ANDed with the filter box. F2 renames in place; right-click has Rename, Show only this device, Forget name, Copy IP address. It collapses and resizes like the Collections panel (shared parts in `components/common/side-panel.tsx`).
  - The list gets a Device column when several devices have traffic. New text filters `device=`, `client-ip=`, `app=` (also for MCP/CLI `events list`). "N devices" in the status bar. HAR export follows the selection.
  - Checked in headless Chrome, light & dark, with 3 devices: this Mac, an "iPhone" from the LAN IP, and an injected Pixel 8.

**Next, in order:** check the menu bar icon → redo the iPhone test with Wirepane CA → design phase 3 (menu bar menus, ⌘K, ⌘,).

### 2026-10-12

- **Devices panel** in View (`15d7517`): one row per device by client IP, with its apps and domains; `device=`, `client-ip=`, `app=` filters.
- **Unsigned `.pkg`** (`84177fc`), built from our own server and UI (`./scripts/build-pkg.sh`). New rule: build it only when the owner says "done, publish". The release-only follow-ups are on the publish checklist (`docs/remaining-work.md` §7).
- **No-screen rule:** the dev app runs as `./start.sh --no-window`; UI checks run in headless Chrome or a hidden Electron (`WIREPANE_HIDDEN_WINDOW=1`).
- **Redesign phase 3 done** (`7105308`): command palette, Go and Capture menus, list Type and optional columns, sectioned Settings, Phosphor icons, hidden-inset title bar. Also fixed the dark-mode Apple icon and the `code` key redaction (`8069552`).
- Tests: UI 1398, server 96, desktop build OK.

- **Re-critique** (`6e51d13`): D → B+, no P0s. Fixed its P1s and the main P2s (`5b22903`), and added Send's Params · Headers · Body · Docs tabs (`b3d8945`). Tests: UI 1468.

**Next for v1:** iPhone test with the owner (§5) → the owner says "publish" → publish checklist (§7). The smaller design leftovers (§4) can wait for v1.1.

> The full list of remaining work, with details and acceptance criteria, is in `docs/remaining-work.md`.

### Next, in order

1. (done) Commit the Collections UI and merge B1.
2. (done) **Send v2:**
   - body modes Form, Multipart (files/images/media) and Binary;
   - GraphQL mode (query, variables, schema autocomplete);
   - WebSocket client.
3. (done) **Connect a phone** screen instead of the upstream docs link:
   - IP and port shown big, QR for `http://amiusing.httptoolkit.tech/certificate`;
   - steps and a live "iPhone connected" status;
   - a stable port (dev reloads leave old proxy sessions behind and move the port).
4. **Redesign phase 3:**
   - menu bar (Settings ⌘,, Go, Capture), ⌘K palette;
   - list Type column, Settings layout;
   - HAR names, host pill.
5. **iPhone test with the owner.**
   - Mac IP is `192.168.0.156` and the cert URL is `http://amiusing.httptoolkit.tech/certificate`.
   - The CA shows as "HTTP Toolkit CA".
   - Remind the owner to turn the iPhone proxy off afterwards.

### Facts worth remembering

- **Running the app:** `./start.sh --remote-debugging-port=9222` lets agents screenshot it through CDP (helpers in `logs/`, gitignored).
- **Interceptors:**
  - Only Chrome and Safari are installed on this Mac.
  - Docker Desktop is installed but not running.
  - No adb or frida.
  - These have no server implementation and are hidden: `fresh-safari`, `ios-device`, `network-device`, `virtualbox-machine`, `system-proxy`, `existing-arc`.
- **Release:** shipping without an Apple Developer certificate means an ad-hoc signed arm64 app. A browser-downloaded `.app` or `.pkg` triggers Gatekeeper ("Open Anyway"); a `curl … | sh` install does not.
