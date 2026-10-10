# Wirepane design plan

> **Qisqacha (o'zbekcha):** foydalanuvchi app nima uchunligini va hozir nima bo'layotganini unutib qo'ymasligi kerak. Shuning uchun:
>
> 1. App doim o'z holatini ko'rsatadi: recording, proxy manzili, client'lar, request'lar soni.
> 2. Har bir sahifa nima uchunligini bitta jumlada aytadi.
> 3. Intercept → View → Modify → Send yo'li ko'rinib turadi.
> 4. Har bir bo'sh holatda keyingi qadam ko'rsatiladi.
> 5. Ranglar logodan olinadi: navy, teal va sky.
>
> Ish 3 bosqichda bajariladi. To'liq tahlil: [`docs/design/critique-2026-10-10.md`](design/critique-2026-10-10.md).

Source of the findings: the baseline critique of 2026-10-10 (overall grade **D**). Finding IDs below (P0-1 …) refer to it.

## Design anchor

|                         |                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Platform                | Electron, macOS-first (Windows/Linux must not break)                                                                                 |
| App form                | single-window power tool: rail → list → inspector                                                                                    |
| Density                 | compact data (32 px rows), calmer chrome; "Compact rows" toggle later                                                                |
| Anchor                  | **Navy instrument panel**: navy chrome, teal for action and selection, sky for keyboard focus. The app always says what it is doing. |
| Hero / surface / accent | tile gradient `#1B2C4B → #0A1222` / `#FFFFFF` light, `#111B2E` dark / `#0F766E` light, `#2DD4BF` dark                                |
| Fonts                   | DM Sans (real 400/500/600 weights) for UI, DM Mono for data. Saira is dropped.                                                       |
| Motion                  | minimal: 120–150 ms fades and colour transitions, no bounce                                                                          |

## Rules

1. **One colour, one meaning.**
   - Teal means act or selected.
   - Sky means keyboard focus.
   - Navy is app chrome.
   - Green, amber, red and sky info are used only for HTTP outcomes.
2. **Hover is never the same as selection.**
3. **The app always shows its state.** A status bar on every page shows recording, proxy address, clients, request count and active rules.
4. **Page title equals the nav label**, followed by a one-line purpose and the page's actions on the right.
5. **No dead-end empty state.** Each one says what will appear and offers the next action as a button.
6. **Keyboard-first.** Every action has a shortcut, and every shortcut is visible in the menu bar, in tooltips, or in the ⌘K palette. Focus rings stay visible (`:focus-visible`).
7. **At most one solid accent button per view.** The wire gradient appears at most once per screen and never behind text.

## Colour tokens

These are the full tables from the critique: AA-checked, light and dark, with status and method colours. Add them as theme keys in `httptoolkit-ui/src/styles.ts`. Keep the old key names working (map each old key to its new value) so upstream components keep compiling.

| Token (old key)                               | Light                                         | Dark                                          |
| --------------------------------------------- | --------------------------------------------- | --------------------------------------------- |
| canvas (`containerBackground`)                | `#F4F7FB`                                     | `#0B1220`                                     |
| surface (`mainBackground`)                    | `#FFFFFF`                                     | `#111B2E`                                     |
| surfaceRaised (`highlightBackground`)         | `#FFFFFF`                                     | `#18253C`                                     |
| surfaceSunken (`mainLowlightBackground`)      | `#EEF2F7`                                     | `#0D1626`                                     |
| borderSubtle (`containerBorder`)              | `#D5DDE8`                                     | `#22314A`                                     |
| borderControl (`inputBorder`)                 | `#78869B`                                     | `#5F7088`                                     |
| textPrimary (`mainColor`)                     | `#0F1B2D`                                     | `#E6EDF7`                                     |
| textSecondary (`mainLowlightColor`)           | `#475569`                                     | `#A9B6C9`                                     |
| textTertiary (`containerWatermark`)           | `#5E6B7E`                                     | `#94A3B8`                                     |
| accent (`popColor`, `primaryInputBackground`) | `#0F766E`                                     | `#2DD4BF`                                     |
| accentHover                                   | `#115E59`                                     | `#5EEAD4`                                     |
| textOnAccent (`primaryInputColor`)            | `#FFFFFF`                                     | `#042F2E`                                     |
| focusRing                                     | `#0284C7`                                     | `#38BDF8`                                     |
| selectionBackground (focused list)            | `#0F766E` + white text                        | `#0F766E` + white text                        |
| selectionInactive                             | `#E8EDF3` + 3 px `#78869B` bar                | `#22314A` + 3 px `#5F7088` bar                |
| rowHover                                      | `#F1F5F9`                                     | `#16233A`                                     |
| success / warning / error / info              | `#157238` / `#9A4A07` / `#B91C1C` / `#0369A1` | `#4ADE80` / `#FBBF24` / `#FB8585` / `#7DD3FC` |
| modal backdrop (`modalGradient`)              | `radial-gradient(#1B2C4B, #0A1222)` at 0.55   | the same                                      |

Brand gradients:

- `gradientWire`: `linear-gradient(90deg, #2DD4BF, #38BDF8)`. Decoration only.
- `gradientTile`: `linear-gradient(160deg, #1B2C4B, #0A1222)`. Used for the rail and the modal backdrop.

The high-contrast theme keeps its black and white surfaces and takes the dark accent, focus and status values.

## Phases

### Phase 1: foundations (Batch A)

- [ ] **Theme tokens.** `styles.ts` tokens for light, dark and high-contrast. Make `popColor` per-theme and update its 3 direct imports. Retire `#E1421F` and `#2D4CBD`. (P1-1)
- [ ] **Fonts.** Load the real DM Sans 400/500/600/700 and 400-italic weights, plus DM Mono 400/500. Drop Saira. Adopt the desktop type scale: 11 / 12 / 13 / 14 / 16 / 22 px. (P2-1)
- [ ] **Focus rings.** A global `:focus-visible` ring. Change `outline: none` to `:focus:not(:focus-visible)`. (P1-5)
- [ ] **List selection.** Focused and unfocused selection states, row hover, and no synthesized bold. (P1-4)
- [ ] **Status and method colours.** Use theme status and method colours in the list. (P1-3, critique colour section)
- [ ] **Modal backdrop.** The navy backdrop in both themes, and MCP modal copy cleanup. (P1-10)
- [ ] **URL field.** `:user-invalid` instead of `:invalid`, and a labeled "Send ⌘↵" button. (P1-8)
- [ ] **Cards and shadows.** Left-aligned sentence-case card titles. Lighter shadows, with 1 px dividers instead. (P2-2, P2-11)

### Phase 2: orientation shell (Batch B)

- [ ] **Status bar.** A global `StatusBar` (new `components/status-bar.tsx`) showing recording, proxy address, clients, requests and rules. It is the single pause control. (P0-1)
- [ ] **Page header.** A `PageHeader` component (new `components/common/page-header.tsx`) on all 5 pages. `document.title` follows the current page. (P0-3)
- [ ] **Intercept.** Rebuild it as a guided start: a 3-step strip, 4 recommended sources, a manual proxy line, a "More sources" disclosure and a Connected list. (P0-2)
- [ ] **View detail header.** An action header with "Mock response ⌘M", "Resend ⌘R", "Breakpoint" and "More ▾". (P0-4)
- [ ] **Empty states.** For View (0 requests, and nothing selected), Modify (rule templates) and Send (response placeholder). (P1-7)
- [ ] **Client icons.** Proper icons for curl and other CLI clients. (P1-9)
- [ ] **Navy rail.** 64 px wide, active item marked by the gradient bar; "View" gets the `Rows` icon; "MCP" is relabelled "AI". (P2-3)
- [ ] **Intercept cards.** Remove the watermarks. (P2-6)

### Phase 3: desktop conventions (Batch C)

- [ ] **Menu bar.** "Settings… ⌘,", a Go menu (⌘1–4, ⌘K) and a Capture menu (pause ⌘⇧R, clear, copy proxy, import and export HAR). (P1-6)
- [ ] **Command palette.** ⌘K, built on the existing modal. Context-menu accelerators. Cmd+Tab in Send replaced by ⌘⇧] / ⌘⇧[. (P1-6)
- [ ] **Feedback item.** Neutral styling, and the Help menu entry goes to the same repo. (P1-2)
- [ ] **Icons.** One icon set in toolbars (Phosphor). (P2-4)
- [ ] **Request list.** Explained row markers and a Type column; optional Time, Duration and Size columns. (P2-5)
- [ ] **Settings.** Sectioned layout, status first, "Appearance". (P2-7)
- [ ] **Window chrome.** Background matches the theme; `hiddenInset` title bar. (P2-8)
- [ ] **Leftover names.** HAR names `Wirepane_*.har`, the "Wirepane CA" copy and the host pill. (P2-9, P2-10)

### Later

- A density toggle and column customization.
- Window size and position restored on relaunch.
- A first-run onboarding hero.
- Postman collection import (see `docs/research/postman.md`).

## Constraints for the implementation

- **Keep upstream syncs cheap.** Put new UI in new files, and keep edits to upstream files small and surgical. No reformatting: check `git diff --stat` after each change (see CLAUDE.md, Pitfalls).
- **Don't start a second app.** The app runs through `./start.sh` and hot-reloads.
- **Type check:** look for `No issues found.` in `logs/ui.log`.
- **Screenshots:** `node logs/design/capture.cjs logs/design/<name>`, which needs `./start.sh --remote-debugging-port=9222`.

## Verification

After each phase:

1. Capture the same 5 routes in light and dark, plus the extra states listed in the critique's re-verify plan.
2. Run `design-critic` against this plan.
3. Fix the P0s; do at most 2 loops.

Acceptance criteria:

- **No old orange.** No `#E1421F` or indigo anywhere in the UI.
- **Contrast.** Text is at least 4.5:1 and UI parts at least 3:1.
- **Status bar** is visible on every page.
- **Page titles** match the nav labels.
- **Empty states.** Every one has a next-step button.
- **Keyboard.** Every primary action can be done from the keyboard, with its shortcut visible.
