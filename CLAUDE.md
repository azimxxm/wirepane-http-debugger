# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Goal and roadmap

@README.md

The README (in Uzbek) is the source of truth for the goal, setup and roadmap: **Wirepane**, a free HTTP debugger for developers, QA and beginners, a Proxyman alternative built on HTTP Toolkit's open-source code and shipped as one `.app` (GitHub `azimxxm/wirepane`, bundle ID `com.wirepane.app`). Update it when the plan changes. Markdown files are tracked in this repo (docs will be written as `.md`), which overrides the global "only README.md is tracked" rule.

## Branding

User-visible text says "Wirepane". That includes the CA: the server creates its own "Wirepane CA" in `wirepane-ca.pem` / `wirepane-ca.key` (`generateHTTPSConfig` in `httptoolkit-server/src/index.ts`). The official app's `ca.pem` / `ca.key` share the same config folder and are never touched. Phones download the certificate from `http://wirepane.cert/certificate`; `wirepane.cert` is not a real domain, the proxy answers it through the built-in rules in `httptoolkit-ui/src/model/rules/rule-creation.ts`. `amiusing.httptoolkit.tech` still works the same way.

These keep the "HTTP Toolkit" name on purpose, don't rename them:

- The `HTTP Toolkit Rules` title in saved rule files (file format), the HTTP Toolkit Android app (its real Play Store name) and links to httptoolkit.com docs.
- Internal identifiers: package names, the `httptoolkit` config and Electron userData dirs (`extraMetadata` in `httptoolkit-desktop/package.json`), `HTK_*` / `HTTPTOOLKIT_*` env vars, `amiusing.httptoolkit.tech`.
- "HTTP Toolkit Pro" texts still inside upstream components: those prompts never render any more (see Architecture), so they stay untouched to keep syncs small.

The logo source is `brand/icon.svg`, and `brand/tray-template.svg` is its one-colour menu bar version. `./brand/build-icons.sh` regenerates every icon and logo file from it (`httptoolkit-desktop/src/icons/*`, `httptoolkit-ui/src/images/logo-icon.svg` and `loading-logo.png`), so change the source and rerun the script instead of editing those files.

## Distribution: no Apple Developer account (yet)

There is no Apple Developer account, so nothing may depend on one. The owner is applying for one; until it arrives:

- Wirepane ships as an **unsigned `.pkg` installer** for Apple Silicon (`arm64`). It holds an ad-hoc signed `Wirepane.app` (`codesign --sign -`), which Apple Silicon needs to run it at all.
- No Developer ID signing and no notarization. No `notarize: true`, `forceCodeSigning`, `CSC_*` identities, provisioning profiles or App Store steps in the default build. The build must work on a Mac with no certificates.
- Gatekeeper blocks a downloaded unsigned `.pkg` on the first open. The user right-clicks → Open, or goes to System Settings → Privacy & Security → **Open Anyway**. The release notes and README say so. A `curl … | sh` install avoids the quarantine flag.
- When the account arrives, signing and notarization are added on top: a Developer ID Application/Installer identity, hardened runtime, notarization. The unsigned path stays as a fallback.
- How it's built: `./scripts/build-pkg.sh` (Commands). `npm run build` in `httptoolkit-desktop` uses `build-setup/wirepane-builder.config.cjs`: `pkg` and `zip` targets for arm64, `identity: '-'` (ad-hoc), `hardenedRuntime: false` (with an ad-hoc signature its library validation stops the app from starting), an unsigned pkg, and any `CSC_*` variables dropped. `ENABLE_SIGNING=true` switches to upstream's signed setup (`electron-builder.config.cjs` and `build` in `package.json`), which is where the Developer ID identity and notarization go later.

## Repo layout

Three upstream HTTP Toolkit projects, imported with `git subtree --squash` (no upstream history):

- `httptoolkit-server/`: Node + TypeScript oclif CLI. Runs the proxy, the interceptors and the API the UI calls.
- `httptoolkit-ui/`: React + MobX app bundled with webpack.
- `httptoolkit-desktop/`: Electron shell that starts the server and loads the UI.
- The proxy engine `mockttp` is an npm dependency, not part of this repo.
- `bruno/`: Bruno (MIT, usebruno/bruno), tracked for its packages: `bruno-converters` (Postman/Insomnia/OpenAPI import), `bruno-lang` (`.bru` files), `bruno-js` (scripts/tests runtime), `bruno-cli`. It is not run as an app. Its UI is Redux-based, so Wirepane screens are written in our own React + MobX stack and use Bruno's packages for the logic. Keep its `license.md` notices.
  - The server runs our copy, not the npm releases: `httptoolkit-server/package.json` links `bruno-common`, `bruno-lang`, `bruno-schema`, `bruno-converters` and `bruno-filestore` with `file:../bruno/packages/...`, and those packages load their own dependencies from `bruno/node_modules`.
  - We change Bruno's code on purpose; it doesn't have to match upstream. Fix Bruno bugs there instead of working around them in the server. Mark every edit with a `// wirepane:` comment and keep the diff small, so syncs show our edits clearly. Update Bruno's own tests along with it: `npm run test:ci --workspace=packages/bruno-converters` inside `bruno/`.
  - `scripts/build-bruno.sh` installs what those packages need (`npm ci` with `--workspace` flags, from Bruno's own lockfile) and builds `bruno-common`, `bruno-schema-types`, `bruno-converters` and `bruno-filestore` into `dist/`. `./setup.sh` runs it. It must run again after every Bruno sync, or the server keeps the old build. Re-runs skip what is up to date; `--force` redoes everything.

`./sync-upstream.sh` runs `git subtree pull --squash` for each folder, Bruno included (needs a clean tree). Every line we change in upstream files can conflict on the next sync, so keep fork changes small and contained, and prefer adding new files over rewriting upstream ones.

## Commands

From the repo root (macOS, Node 24):

- `./setup.sh`: builds Bruno's packages (`scripts/build-bruno.sh`), then `npm ci` in all three projects. Re-run whenever a `package-lock.json` changes, e.g. after a sync.
- `./start.sh`: runs the whole app from local source, logs go to `logs/`. Server (`npm start`, restarts on change) on :45457 (API) and :45456 (Mockttp admin); UI (`npm run start:web`, webpack-dev-server with hot reload) on :8080; then it compiles the desktop TypeScript and opens Electron with `HTK_DEV=true APP_URL=http://localhost:8080`. Cmd+Q or Ctrl+C stops everything. Extra args go to Electron, e.g. `./start.sh --remote-debugging-port=9222`.
- `./scripts/build-pkg.sh`: builds the installer from this repo and prints its path, `httptoolkit-desktop/dist/Wirepane-<version>-arm64.pkg` (plus the same app as a `.zip`, and `dist/mac-arm64/Wirepane.app`). In order: `scripts/build-bruno.sh`, `scripts/build-server.sh` (our server release in `build/server/httptoolkit-server`: tsc, oclif manifest, rspack bundle with Bruno inside, then `scripts/assemble-server.cjs` adds Node.js from nodejs.org, checked and cached in `build/cache`, and only the unbundleable `node_modules`; it ends with a test start), the UI (`DISABLE_UPDATES=true npm run build`, no Sentry/PostHog keys), the desktop (`npm run build`). Takes a few minutes; every run rebuilds from the current code.
- `WIREPANE_HIDDEN_WINDOW=1 <Wirepane.app>/Contents/MacOS/Wirepane --remote-debugging-port=9333 --use-mock-keychain`: runs a built app with nothing on screen (no Dock or menu bar icon, no dialogs, window never shown) for checks over CDP. Point `HOME`, `CFFIXED_USER_HOME` (Electron's userData) and `TMPDIR` at a throwaway folder with a short path (the server's CLI socket goes in `TMPDIR` and must fit 104 characters), so the check touches none of your data. `kill -TERM <its pid>` quits it like Cmd+Q, server included.

Inside each project folder:

|                    | `httptoolkit-server`                                    | `httptoolkit-ui`                                                                                    | `httptoolkit-desktop`                              |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Type-check / build | `npm run build:src` (tsc → `lib/`)                      | type errors show in `logs/ui.log` (ForkTsChecker); `npm run build` makes the prod bundle in `dist/` | `npm run build:src` (tsc → `build/`)               |
| Tests              | `npm run test:unit`, `npm run test:integration` (Mocha) | `npm run test:unit` (Karma, headless Chrome); `npm run test:unit:dev` for watch mode                | `npm test` (Playwright, only `test/smoke.spec.ts`) |
| One test           | `npx mocha --exit test/unit/send-request.spec.ts`       | Karma always loads every `test/unit/**/*.spec.ts(x)`; narrow it with a temporary `.only`            | —                                                  |

No project has a lint script.

Pitfalls:

- `server:setup` downloads the official server release from GitHub instead of using `../httptoolkit-server`. It runs inside UI `npm start` / `test:integration` and desktop `npm start` / `npm test`, never in the desktop's `npm run build`, which packages `build/server` from `scripts/build-server.sh`. Use `./start.sh` for local runs.
- UI integration tests also need puppeteer's Chromium, which `setup.sh` skips on purpose (puppeteer 5 has no Apple Silicon build).
- The server rejects requests whose `Origin` isn't in `ALLOWED_ORIGINS` (`httptoolkit-server/src/constants.ts`): any localhost / 127.0.0.x origin in dev, only `wirepane://app` (the bundled UI) in prod builds (`HTTPTOOLKIT_SERVER_BINPATH` set, which our release launcher always does). Even health checks need it: `curl -H "Origin: http://localhost:8080" http://127.0.0.1:45457/version`.
- Server `engines` pins Node `v24.19.0`; other 24.x versions work with an `EBADENGINE` warning.
- In the UI, plain `npx tsc --noEmit` fails on DOM vs WebWorker lib conflicts inside `node_modules`. The dev server's ForkTsChecker is the real type check: look for `No issues found.` in `logs/ui.log`.
- Everything runs natively on Apple Silicon without Rosetta. The only x86_64 binary in `node_modules` is node-notifier's `terminal-notifier`, and `httptoolkit-ui/automation/webpack.common.ts` skips it there, because its failed spawn used to kill the UI dev server.
- The global auto-lint hook runs `prettier --write` on every file changed with Edit/Write. `.prettierignore` keeps it off the upstream folders, but only when the hook runs from the repo root. After editing upstream code, check `git diff --stat` for whole-file reformatting, or make those edits with sed/python.

## Architecture

1. Electron (`httptoolkit-desktop/src/index.ts`) creates a random auth token, spawns `httptoolkit-server start` with it (`HTK_SERVER_TOKEN`) and loads `APP_URL` with the token in the query string. The default is the UI bundled in the app: `src/bundled-ui.ts` serves `Resources/httptoolkit-ui` from the privileged scheme `wirepane://app` (fixed origin, so localStorage/IndexedDB survive restarts; client-side routes fall back to `index.html`). The packaged server is ours from `Resources/httptoolkit-server`, started by our own launcher (`bin/httptoolkit-server`, written by `scripts/assemble-server.cjs`), which never switches to a server downloaded into `~/.local/share`. `src/preload.cts` exposes `window.desktopApi`, which the UI reads in `src/services/desktop-api.ts`. With `HTK_DEV=true` it uses fixed ports 45457/45456 and spawns a stub (`build-setup/skip-server.ts`) instead of the server; `start.sh` runs the real server separately, without a token.
2. The server (`httptoolkit-server/src/index.ts`) starts two listeners. The Mockttp admin server (:45456) is what the UI uses directly to create and drive proxy sessions (`PluggableAdmin.AdminClient` in `httptoolkit-ui/src/model/proxy-store.ts`). The HTK API (:45457, `src/api/`: REST in `rest-api.ts`, GraphQL in `graphql-api.ts`, shared logic in `api-model.ts`) covers what a browser can't do: certificates, interceptors, system state.
3. Interceptors (`httptoolkit-server/src/interceptors/`: browsers, Android via ADB/QR, Docker, Electron apps, Frida, JVM, terminal) launch or reconfigure a target so its traffic goes through the proxy.
4. Config and the CA live in `env-paths('httptoolkit')` (`~/Library/Preferences/httptoolkit` on macOS), shared with the official app. Renaming that directory forces everyone to reinstall the CA on their devices, so a rebrand should change user-visible names only and leave internal ones alone. The exception is oclif's own folders: the server's `oclif.dirname` is `wirepane-server` (`~/.local/share/wirepane-server`, `~/Library/Caches/wirepane-server`), because `~/.local/share/httptoolkit-server/client` holds the official app's downloaded servers. The server has no `@oclif/plugin-update` any more: its init hook ran `update --autoupdate` every 14 days and would fetch the official server from GitHub.
5. The `ctl` and `mcp` server commands (`src/commands/`) expose the UI's operations to CLIs and MCP clients through `src/api/ui-operation-bridge.ts`; the desktop app ships `httptoolkit-ctl` / `httptoolkit-mcp` wrappers for them.

UI state lives in MobX stores under `httptoolkit-ui/src/model/` (proxy session, captured events, rules, interception, send, account). Everything is free. `AccountStore` (`model/account/account-store.ts`) is one fixed full-access user with no account servers, so every upstream paid check (`user.isPaidUser()`, `mightBePaidUser`, `NonPaidStepClasses` in `model/rules/rules.ts`) passes, and the server's `src/api/ui-operation-bridge.ts` gives every CLI/MCP caller full access. Login, plan picker, checkout and the settings account card are deleted; keep them out when syncing upstream. Heavy work (body decoding, formatting, OpenAPI building, cert parsing, zip export) runs in a web worker, `src/services/ui-worker.ts`.
