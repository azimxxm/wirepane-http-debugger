# Send v2 plan

> **Qisqacha (o'zbekcha):** Send'ga fayl, rasm va media yuborish (Form, Multipart, Binary), GraphQL rejimi va WebSocket client qo'shiladi. Uchala tur ham collection'ga saqlanadi va export qilinadi. Umumiy model tayyor (`send-extras.ts`, `send-files.ts`, `build-request.ts`). Ish 4 qismga bo'lingan, har bir qismning o'z fayllari bor.

Source of the task: `docs/remaining-work.md`, section 1.

## What is already in place (the foundation)

All in `httptoolkit-ui/src/model/send/`:

- **`send-extras.ts`.** `RequestInput.extras` (a `SendExtras`) holds:
  - `requestType`: `'http' | 'websocket'`;
  - `bodyMode`: `'raw' | 'form' | 'multipart' | 'binary' | 'graphql'`;
  - `formFields`, `multipartFields`, `binaryFile`, `graphql` and `websocket` (draft message and saved messages).

  `toData()` gives a plain copy and `SendExtras.from()` builds one. It is persisted with the tab (`requestInputSchema`), and copied by `new RequestInput(existing)`.

- **`'raw'`** is upstream's editor with its content type picker (Text, JSON, XML, HTML, CSS, JS). In the other modes the tab's `rawBody` is left alone: switching back to a raw mode brings the old text back.
- **`send-files.ts`.** The file store: the bytes of attached files, in memory and in IndexedDB, keyed by SHA-256. Tabs keep only a `FileRef` (`fileId`, `name`, `size`, `contentType`), because tabs live in localStorage, which only holds a few MB. `MAX_SEND_FILE_SIZE` is 100 MB.
- **`build-request.ts`.** `buildRequestForSend(input)` turns the form, multipart, binary or GraphQL state into the raw request that is sent:
  - the body bytes;
  - Content-Type, when the tab has none (multipart always gets a boundary that matches its body);
  - Content-Length.

  GraphQL over GET puts the query in the URL. It throws `SendBuildError` with a message for the user (a missing file, invalid variables JSON). It runs on every Send, after `{{variables}}` are filled in:
  - `SendStore.prepareRequestInput` is async now;
  - the collections store's `resolveSendRequest` calls it and shows a `SendBuildError` inline under the URL, like a missing variable.

- **Collections plumbing.** `RequestParts.extras` (`request-mapping.ts`) carries the extras through `requestInputToParts` / `partsToRequestInput`, so variable resolution keeps them. Mapping them to and from Bruno items is part D's work.
- **`SendStore` helpers.**
  - `getRequestOptions(url)` gives the connection options Send uses: proxy, upstream CAs, client certificates, ignored HTTPS errors. GraphQL schema fetches and WebSocket connections use it.
  - `prepareRequestInput(sendRequest)` gives the request as it will be sent, with variables filled in and the body built.
  - `resolveTemplates(sendRequest, text)` fills in `{{variables}}` in text sent outside a request, like WebSocket messages. It is a no-op until part D sets it from the collections store.
- **Server.** `/client/send` accepts JSON bodies up to 256 MB (`httptoolkit-server/src/api/api-server.ts`).
- **UI hooks** (stubs, each owned by one part):
  - the body editor (since 2026-10-12 `components/send/body/send-body-panel.tsx`, the Body tab of `components/send/request-editor/`) replaces upstream's body card in `request-pane.tsx`;
  - `components/send/graphql/graphql-body-editor.tsx` (`GraphqlBodyEditor`);
  - `components/send/websocket/websocket-request-pane.tsx` and `websocket-messages-pane.tsx`. `send-page.tsx` shows them instead of the HTTP panes when `extras.requestType === 'websocket'`.

## The four parts

Every part edits only its own files. A small change in a file another part owns is allowed when it can't be avoided: re-read the file first, keep the change minimal, and list it in the report.

### Part A: Form, Multipart and Binary bodies

Owns:

- `components/send/body/*`;
- `model/send/send-files.ts` and `build-request.ts` (fixes only, the API stays);
- new `model/send/body-modes/*` files;
- the unit tests for these.

1. **`SendBodyCard`.** The card header keeps the upstream pieces: expand, format, size pill, title. The size pill shows the file size or the total for structured modes. One mode picker lists: Text, JSON, XML, HTML, CSS, JS, Form, Multipart, Binary, GraphQL.
   - Picking a raw type behaves as before (`requestContentType`).
   - Picking a structured mode sets `extras.bodyMode`, sets Content-Type in the tab's headers (form: `application/x-www-form-urlencoded`; multipart: `multipart/form-data; boundary=<new boundary>`; binary: the file's type or `application/octet-stream`; GraphQL: `application/json`) and removes Content-Length, which is calculated when sending.
   - Picking GraphQL also switches GET to POST.
   - Going back to a raw type puts Content-Length back for a non-empty raw body.
2. **Form editor.** A key/value table: enable checkbox, name, value, delete. An empty last row adds a field. Tab and Enter move between cells.
3. **Multipart editor.** The same table, plus a Text/File switch per row:
   - file rows: choose files (`<input type=file multiple>`) and drag & drop files from Finder onto the row or the card;
   - each file shows its name, size and detected type, with a remove button;
   - an optional per-row Content-Type override.
4. **Binary editor.** Choose or drop one file, and see its name, size and type. Show an image preview for images.
5. **Content type detection.** Use the browser's `File.type`, falling back to a small extension map, then `application/octet-stream`.
6. **Size limit.** Files over `MAX_SEND_FILE_SIZE` are refused with an inline message (no `alert()`).
7. **File cleanup.** After the Send store loads, drop stored files that no tab refers to: `sendFileStore.retainOnly(...)` over `extras.fileRefs` of all tabs.
8. **Unit tests** (Karma, `test/unit/model/send/`): `encodeFormBody`, `encodeMultipartBody` (text parts, file parts, names with quotes and non-ASCII), `buildRequestForSend` for every mode (headers, boundary, Content-Length, GraphQL over GET, missing file error).
9. **Optional, if time allows:** "Copy as code snippet" for structured modes. HAR `postData.params` gives `curl -F`. Upstream's snippet code reads `rawBody`.

### Part B: GraphQL mode

Owns:

- `components/send/graphql/*`;
- new `model/send/graphql/*` files;
- their tests.

1. **`GraphqlBodyEditor`.** Two editors: the Query (Monaco, language `graphql`) and the Variables (JSON). It edits `extras.graphql` (`query`, `variables`, `operationName` when the query has several operations).
2. **Schema.**
   - A "Fetch schema" button sends the standard introspection query through the same server path as Send, so proxy, certificates and `{{variables}}` all work. It uses the tab's URL and headers, with variables filled in.
   - Cache the schema per URL in memory. Show the last fetch time and errors inline.
3. **Autocomplete and errors.**
   - Monaco 0.27 is in use. Prefer `graphql-language-service` (`getAutocompleteSuggestions`, `getDiagnostics`, `getHoverInformation`) behind a Monaco completion, hover and marker provider for the `graphql` language over adding `monaco-graphql`, whose versions may not fit Monaco 0.27.
   - The UI has `graphql@15`. Check that the version you add supports it.
   - Without a schema, the editor still works: syntax highlighting, and syntax errors from `graphql`'s `parse`.
4. **Docs panel.** A collapsible schema browser: root types, then type, field, arguments and descriptions, with search. `bruno/packages/bruno-graphql-docs` may be reused if it fits React 18 and our styling; otherwise write a small one.
5. **Acceptance.** `https://countries.trevorblades.com` loads its schema, autocomplete suggests `countries`, `country(code:)` and so on, and the query returns data.
6. **Tests.** Unit tests for the introspection result parsing and the completion mapping.

### Part C: WebSocket client

Owns:

- server: new `httptoolkit-server/src/client/ws-client.ts` and a new API file, plus the 1–2 lines that register it in `api-server.ts`;
- UI: `components/send/websocket/*`, new `model/send/websocket/*` and new `services/websocket-client-api.ts`;
- the tests for these.

1. **Server.** The connection is made by the server, so the proxy settings, upstream CAs, client certificates and ignored HTTPS errors match Send. Reuse `getUpstreamProxyAgent` and Mockttp's TLS option helpers, as `src/client/http-client.ts` does, with the `ws` package (already a dependency). Endpoints, in the same style as `/client/send`:
   - `POST /client/ws/open` takes `{ request: { url, headers, protocols? }, options }`. It answers with an NDJSON stream of events:
     - `{ type: 'ws-open', id, protocol, headers, timestamp }`;
     - `{ type: 'ws-message', data (base64), isBinary, timestamp }` for received messages;
     - `{ type: 'ws-close', code, reason, timestamp }`;
     - `{ type: 'error', error: { code, message }, timestamp }`. A failed upgrade also includes the HTTP status, headers and body, so a 401 or 404 can be shown.

     Closing that HTTP stream closes the socket.

   - `POST /client/ws/:id/send` takes `{ data (base64), isBinary }`.
   - `POST /client/ws/:id/close` takes `{ code?, reason? }`.
   - All sockets close when the server stops.

2. **How a tab becomes WebSocket.**
   - Typing or pasting a `ws://` or `wss://` URL switches `extras.requestType` to `'websocket'`, and an `http(s)://` URL switches it back. A `{{variable}}` origin doesn't switch it.
   - There is also an explicit choice: a "WebSocket" entry next to the HTTP methods, or a type picker.
   - The tab title shows `WS`.
3. **Request pane.**
   - URL with a Connect / Disconnect button (⌘↵).
   - Handshake headers (reuse the headers card). Subprotocols come from `Sec-WebSocket-Protocol`.
   - A message composer with Text / JSON / Binary (base64), a Send button (⌘↵ while connected) and JSON formatting.
   - Saved messages: save the current message with a name, then click to load or send it. They are kept in `extras.websocket.savedMessages`.
4. **Messages pane.**
   - A connection status line: connecting, open (protocol, connected for N s), or closed (code and reason).
   - The message log: direction, time, size and a preview, newest at the bottom with auto-scroll. Clicking a message shows it in full (JSON pretty-printed, binary as hex or base64).
   - Filter by text, and Clear.
   - A failed handshake shows the HTTP status and body.
5. **Session state.** Kept per tab, in memory only, not persisted. Closing a tab or switching it back to HTTP closes its socket.
6. **Acceptance.** `wss://echo.websocket.org` echoes a text message back, and a JSON message. A wrong host shows an inline error.
7. **Tests.**
   - Server unit test (Mocha): open, echo and close against a local `ws` server, and a failed upgrade (401).
   - UI unit test for the session model.

### Part D: Collections, files and export

Owns:

- `httptoolkit-ui/src/model/collections/*` (except the plumbing above, which stays);
- `components/collections/*`;
- `httptoolkit-server/src/collections/*`;
- the `// wirepane:` edits in `bruno/packages/bruno-converters`;
- their tests.

1. **Mapping** (`request-mapping.ts`), item ↔ tab, without loss:
   - `formUrlEncoded` ↔ `form`;
   - `multipartForm` ↔ `multipart`, with text and file fields;
   - `file` ↔ `binary`;
   - `graphql-request` and `body.graphql` ↔ `graphql`;
   - `ws-request` with `body.ws` ↔ `requestType: 'websocket'` and `savedMessages`.

   Today these modes are flattened into a raw body. Opened items show the structured editors instead. Raw modes keep today's mapping.

2. **Dirty tracking** (`tab-snapshots.ts`). Snapshots include the extras, so editing a form field marks the tab as changed.
3. **Variables** (`variables.ts`). `{{variables}}` are filled in inside form values, multipart text values, GraphQL query and variables, and WebSocket messages, and they're counted in the "unset values" checks. File contents are never templated.
4. **Files in collections** (server).
   - Saving a request with file fields uploads each file's bytes (from `sendFileStore`) to a new collections endpoint. They are stored in the collection folder under `files/<name>`, with names deduplicated, and the item gets a relative path (Bruno's multipart `value: [path]`, and `file: [{ filePath, contentType, selected: true }]`).
   - Opening such an item downloads the files into `sendFileStore`.
   - A missing file is a warning on open, not an error.
5. **Export.**
   - The Bruno zip includes `files/`.
   - Postman v2.1: form ↔ `urlencoded`; multipart ↔ `formdata` with `type: 'file'` and `src` set to the file name; binary ↔ `mode: 'file'` (add this case to `bruno-to-postman.js`, marked `// wirepane:`); GraphQL ↔ `mode: 'graphql'`.
   - WebSocket requests have no Postman v2.1 form. Leave them out of the Postman file and say so in the export result.
   - The Share dialog warns when the collection has files ("Postman JSON doesn't carry files; use the Bruno format to include them") and when it has WebSocket requests.
6. **Import.** Postman `formdata` / `urlencoded` / `file` / `graphql`, and Bruno `ws-request`, open in the right mode. The existing converters already produce these modes.
7. **Tests.** Mapping round trips for every mode, export (Postman and Bruno with files), and the share warnings.

## Rules for every part

- **Keep upstream diffs small.** Put new code in new files. Mark upstream edits `// wirepane:` where that helps a future sync. Check `git diff --stat` for whole-file reformatting after editing upstream files (see CLAUDE.md, Pitfalls).
- **No `alert()` or `confirm()`.** Errors show inline.
- **Use the existing UI pieces and theme tokens** (`styles.ts`, `docs/design-plan.md`): teal for actions and selection, sky for focus. Keep the compact density and keyboard access, and show shortcuts in tooltips.
- **Testing UI changes.** Don't click around in the Electron window, because the owner and the other parts use it. Launch your own headless Chrome; its localStorage and IndexedDB are separate:

  ```js
  const { chromium } = require('/Users/codingtech/Documents/GitHub/httptoolkit/httptoolkit-desktop/node_modules/playwright');
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('http://localhost:8080/send'); // wait ~8 s for the app to load
  ```

  Focusing the empty URL field prefills `https://`, so type the rest of the URL after it, or paste a full URL; Playwright's `fill()` doesn't replace it.
- **The app is already running** (`./start.sh --remote-debugging-port=9222`, hot reload; the server restarts on change). Don't start a second one. Screenshots and clicks go through CDP (`logs/design/capture.cjs` and the Playwright `connectOverCDP` helpers in `logs/`).
- **Done means:**
  - `logs/ui.log` ends with `No issues found.`;
  - `cd httptoolkit-ui && npm run test:unit` passes, and so does `cd httptoolkit-server && npm run test:unit` for server changes;
  - the acceptance check was done in the running app, with a screenshot.
- **Don't commit.** Report the changed files, what was verified, and what is left.
