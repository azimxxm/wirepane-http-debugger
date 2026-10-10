# Project log

## 2026-10-10

### Done (branch `feature/rebrand`, not pushed)

- **Setup.** `CLAUDE.md` (from `init`, imports README). `.md` files are tracked. Fixed the UI dev-server crash on Apple Silicon without Rosetta.
- **Wirepane brand.** Name, logo (`brand/`, regenerate with `./brand/build-icons.sh`), bundle ID `com.wirepane.app`. GitHub repo renamed to `azimxxm/wirepane`, with description and topics.
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
- **Devices panel in View (in progress, stopped for the shutdown):** the owner wants a Proxyman-style Devices section. With 2–3 phones, View should show which request came from which device; opening a device shows only its requests, then its apps and domains.
  - Done: the model only, in `httptoolkit-ui/src/model/devices/` (store, tracker, names, filters, selection filter). It's committed but not wired in, and has no tests yet.
  - Left: the collapsible Devices panel in View, a device marker in the list, the `device=` / `client-ip=` text filter, "N devices" in the status bar, unit tests, and checking with 3 devices.
  - The full brief is the "Devices panel" task: identify devices by client IP, take the type from the User-Agent (reuse `model/interception/phone-setup.ts`), let users rename them (localStorage), and AND the selection with the filter box.

**Next, in order:** finish the Devices panel → check the menu bar icon → redo the iPhone test with Wirepane CA → design phase 3 (menu bar menus, ⌘K, ⌘,).

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
