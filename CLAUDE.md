# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Goal and roadmap

@README.md

The README (in Uzbek) is the source of truth for the goal, setup and roadmap: **Wirepane**, a free HTTP debugger for developers, QA and beginners, a Proxyman alternative built on HTTP Toolkit's open-source code and shipped as one `.app` (GitHub `azimxxm/wirepane`, bundle ID `com.wirepane.app`). Update it when the plan changes. Markdown files are tracked in this repo (docs will be written as `.md`), which overrides the global "only README.md is tracked" rule.

## Branding

User-visible text says "Wirepane". These keep the "HTTP Toolkit" name on purpose, don't rename them:

- "HTTP Toolkit CA" (CA `commonName` in `httptoolkit-server/src/index.ts`, the Firefox `certutil -n` nickname, UI texts naming it): the CA is shared with the official app, and renaming it means reinstalling it on every device.
- The `HTTP Toolkit Rules` title in saved rule files (file format), the HTTP Toolkit Android app (its real Play Store name) and links to httptoolkit.com docs.
- Internal identifiers: package names, the `httptoolkit` config and Electron userData dirs (`extraMetadata` in `httptoolkit-desktop/package.json`), `HTK_*` / `HTTPTOOLKIT_*` env vars, `amiusing.httptoolkit.tech`.
- "HTTP Toolkit Pro" texts still inside upstream components: those prompts never render any more (see Architecture), so they stay untouched to keep syncs small.

The logo source is `brand/icon.svg`. `./brand/build-icons.sh` regenerates every icon and logo file from it (`httptoolkit-desktop/src/icons/*`, `httptoolkit-ui/src/images/logo-icon.svg` and `loading-logo.png`), so change the source and rerun the script instead of editing those files.

## Repo layout

Three upstream HTTP Toolkit projects, imported with `git subtree --squash` (no upstream history):

- `httptoolkit-server/`: Node + TypeScript oclif CLI. Runs the proxy, the interceptors and the API the UI calls.
- `httptoolkit-ui/`: React + MobX app bundled with webpack.
- `httptoolkit-desktop/`: Electron shell that starts the server and loads the UI.
- The proxy engine `mockttp` is an npm dependency, not part of this repo.

`./sync-upstream.sh` runs `git subtree pull --squash` for each folder (needs a clean tree). Every line we change in upstream files can conflict on the next sync, so keep fork changes small and contained, and prefer adding new files over rewriting upstream ones.

## Commands

From the repo root (macOS, Node 24):

- `./setup.sh`: `npm ci` in all three projects. Re-run whenever a `package-lock.json` changes, e.g. after a sync.
- `./start.sh`: runs the whole app from local source, logs go to `logs/`. Server (`npm start`, restarts on change) on :45457 (API) and :45456 (Mockttp admin); UI (`npm run start:web`, webpack-dev-server with hot reload) on :8080; then it compiles the desktop TypeScript and opens Electron with `HTK_DEV=true APP_URL=http://localhost:8080`. Cmd+Q or Ctrl+C stops everything. Extra args go to Electron, e.g. `./start.sh --remote-debugging-port=9222`.

Inside each project folder:

|                    | `httptoolkit-server`                                    | `httptoolkit-ui`                                                                                    | `httptoolkit-desktop`                              |
| ------------------ | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| Type-check / build | `npm run build:src` (tsc → `lib/`)                      | type errors show in `logs/ui.log` (ForkTsChecker); `npm run build` makes the prod bundle in `dist/` | `npm run build:src` (tsc → `build/`)               |
| Tests              | `npm run test:unit`, `npm run test:integration` (Mocha) | `npm run test:unit` (Karma, headless Chrome); `npm run test:unit:dev` for watch mode                | `npm test` (Playwright, only `test/smoke.spec.ts`) |
| One test           | `npx mocha --exit test/unit/send-request.spec.ts`       | Karma always loads every `test/unit/**/*.spec.ts(x)`; narrow it with a temporary `.only`            | —                                                  |

No project has a lint script.

Pitfalls:

- `server:setup` downloads the official server release from GitHub instead of using `../httptoolkit-server`. It runs inside UI `npm start` / `test:integration` and desktop `npm start` / `npm test` / `npm run build`. Use `./start.sh` for local runs.
- UI integration tests also need puppeteer's Chromium, which `setup.sh` skips on purpose (puppeteer 5 has no Apple Silicon build).
- The server rejects requests whose `Origin` isn't in `ALLOWED_ORIGINS` (`httptoolkit-server/src/constants.ts`): any localhost / 127.0.0.x origin in dev, only `https://app.httptoolkit.tech` in prod builds (`HTTPTOOLKIT_SERVER_BINPATH` set). Even health checks need it: `curl -H "Origin: http://localhost:8080" http://127.0.0.1:45457/version`.
- Server `engines` pins Node `v24.19.0`; other 24.x versions work with an `EBADENGINE` warning.
- In the UI, plain `npx tsc --noEmit` fails on DOM vs WebWorker lib conflicts inside `node_modules`. The dev server's ForkTsChecker is the real type check: look for `No issues found.` in `logs/ui.log`.
- Everything runs natively on Apple Silicon without Rosetta. The only x86_64 binary in `node_modules` is node-notifier's `terminal-notifier`, and `httptoolkit-ui/automation/webpack.common.ts` skips it there, because its failed spawn used to kill the UI dev server.
- The global auto-lint hook runs `prettier --write` on every file changed with Edit/Write. `.prettierignore` keeps it off the upstream folders, but only when the hook runs from the repo root. After editing upstream code, check `git diff --stat` for whole-file reformatting, or make those edits with sed/python.

## Architecture

1. Electron (`httptoolkit-desktop/src/index.ts`) creates a random auth token, spawns `httptoolkit-server start` with it (`HTK_SERVER_TOKEN`) and loads `APP_URL` (default: the hosted `https://app.httptoolkit.tech`) with the token in the query string. `src/preload.cts` exposes `window.desktopApi`, which the UI reads in `src/services/desktop-api.ts`. With `HTK_DEV=true` it uses fixed ports 45457/45456 and spawns a stub (`build-setup/skip-server.ts`) instead of the server; `start.sh` runs the real server separately, without a token.
2. The server (`httptoolkit-server/src/index.ts`) starts two listeners. The Mockttp admin server (:45456) is what the UI uses directly to create and drive proxy sessions (`PluggableAdmin.AdminClient` in `httptoolkit-ui/src/model/proxy-store.ts`). The HTK API (:45457, `src/api/`: REST in `rest-api.ts`, GraphQL in `graphql-api.ts`, shared logic in `api-model.ts`) covers what a browser can't do: certificates, interceptors, system state.
3. Interceptors (`httptoolkit-server/src/interceptors/`: browsers, Android via ADB/QR, Docker, Electron apps, Frida, JVM, terminal) launch or reconfigure a target so its traffic goes through the proxy.
4. Config and the CA live in `env-paths('httptoolkit')` (`~/Library/Preferences/httptoolkit` on macOS), shared with the official app. Renaming that directory forces everyone to reinstall the CA on their devices, so a rebrand should change user-visible names only and leave internal ones alone.
5. The `ctl` and `mcp` server commands (`src/commands/`) expose the UI's operations to CLIs and MCP clients through `src/api/ui-operation-bridge.ts`; the desktop app ships `httptoolkit-ctl` / `httptoolkit-mcp` wrappers for them.

UI state lives in MobX stores under `httptoolkit-ui/src/model/` (proxy session, captured events, rules, interception, send, account). Everything is free. `AccountStore` (`model/account/account-store.ts`) is one fixed full-access user with no account servers, so every upstream paid check (`user.isPaidUser()`, `mightBePaidUser`, `NonPaidStepClasses` in `model/rules/rules.ts`) passes, and the server's `src/api/ui-operation-bridge.ts` gives every CLI/MCP caller full access. Login, plan picker, checkout and the settings account card are deleted; keep them out when syncing upstream. Heavy work (body decoding, formatting, OpenAPI building, cert parsing, zip export) runs in a web worker, `src/services/ui-worker.ts`.
