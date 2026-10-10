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

### In progress

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

### Next, in order

1. Commit the Collections UI and merge B1 (steps above). Then `/compact`.
2. **Send v2:**
   - body modes Form, Multipart (files/images/media) and Binary;
   - GraphQL mode (query, variables, schema autocomplete);
   - WebSocket client.
3. **Connect a phone** screen instead of the upstream docs link:
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
