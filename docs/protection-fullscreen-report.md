# Protection & Fullscreen Re-engineering — Delivery Report

Branch: `arena/485c78c5-chromium` (base: `main` @ `a6d48d7`)
Date: 2026-11-26

## 1. Root causes

**Ad/redirect protection was a dead system.** The main process created the
adblocker engine with only ~15 hard-coded fallback rules and *never called
`rebuild()` with the actual filter lists* — the list lifecycle (fetch, parse,
cache) existed in the module but was never wired to startup or to the
renderer's filter list. Protection was therefore effectively the fallback
list only; everything else (popups, redirects, cosmetics, threats) depended
on that.

**Popups were blocked, but popunders and unlisted popups were not.** The old
`setWindowOpenHandler` converted `window.open` into a tab and then applied a
plain domain check. Scripted opens with a user gesture, timer popups, popup
chains, and the `window.open(same-url)`-then-`location = ad` popunder pattern
all passed.

**Fullscreen state was scattered.** Browser fullscreen, media fullscreen and
chrome visibility were independent booleans in `main.cjs` with no single
owner: closing the tab that owned a media fullscreen never cleared the state
(stuck in fullscreen), the layout used stale window sizes mid-transition
(views not filling the display), tab switches and window focus produced
inconsistent chrome visibility, and nothing re-synced when the OS dropped
fullscreen (display change, Esc).

**Chrome auto-hide raced the layout.** The 7-second hide was implemented
around CSS opacity while the view geometry was recomputed from a different
source of truth, so hidden chrome left a 96 px seam and reveal triggered
repeated resizes.

## 2. Files changed

| File | Change |
| --- | --- |
| `electron/main.cjs` | Rewired: protection engine at startup, popup/popunder policy around `window.open` and first navigation, `FullscreenController` as the single owner of window/chrome/layout state, CDP document-start scripts (isolated world), 7-second idle tick, display-change handling |
| `electron/protection.cjs` | Rewritten: pure `createProtectionCore` pipeline + Electron adapter; baseline → cache → fetched list lifecycle; per-group sources; no downgrade on failed refresh |
| `electron/popup-blocker.cjs` | New: pure popup/popunder policy (gesture age, per-gesture quota, tab budget, first-navigation watch) |
| `electron/fullscreen-state.cjs` | New: pure state machine for browser fullscreen, media fullscreen, chrome visibility, idle hide |
| `shared/popup-support.js` | New: document-start activation clock, injected in an isolated CDP world (page cannot spoof it) |
| `electron/resources/baseline-ads.txt`, `baseline-trackers.txt` | New: bundled baseline (EasyList/EasyPrivacy-derived domain rules, 46,238 + 47,296 rules) active from first request |
| `electron/preload.cjs` | `getEngineStatus`, `onPopupBlocked`, fullscreen-state payload, `fullscreen` window action |
| `electron/*.test.cjs` | New/rewritten suites: popup-blocker (20), fullscreen-state (23), protection (14), plus a new Electron-stub wiring smoke (8 steps) |
| `scripts/build-baseline-filters.mjs` | New: regenerates the bundled baseline from the audited android-tv blocklists |
| `scripts/prepare-desktop.mjs` | Staged `test` script now runs all five suites |
| `src/types.ts`, `src/store/browser.ts`, `src/App.tsx`, `src/components/Chrome.tsx`, `src/pages/Filters.tsx`, `src/index.css` | Fullscreen state in the store, popup-blocked toast, fullscreen window control, engine status line on the Filters page |
| `docs/protection-fullscreen-report.md` | This report |

## 3. Architecture changes

- **Protection is a pipeline with a pure core.** `createProtectionCore` owns
  three engines (ads / trackers / threats), matching, popup policy and the
  list lifecycle; `createProtectionEngine` wires it to
  `session.webRequest`. Unit tested in plain Node against the same
  `FiltersEngine` the app uses.
- **Lists: baseline → cache → fetched.** Startup parses the bundled baseline
  synchronously (protection active on the *first* request, ~14 ms cold).
  A refresh fetches only enabled, https, non-IP list URLs, writes a
  serialized engine cache (`userData/filters/`, 24 h TTL), and swaps the
  group in only on success. Non-2xx responses, zero-rule lists and network
  failures keep the previous engine — protection never downgrades.
- **Popups: policy, not blocklist.** Every `window.open` is classified:
  listed destination → block; link click (`foreground-tab`) → allow;
  script-driven → allowed only with a fresh user activation (≤1500 ms,
  ≤500 ms for `background-tab`), at most one per activation (main-process
  quota, unspoofable). The activation clock comes from a document-start
  script in an **isolated CDP world** the page cannot touch, corroborated
  with main-process input events (min age wins).
- **Popunder watch.** Allowed script-opens are watched on their first
  committed navigation: a jump to a listed ad/threat host or to a different
  registrable domain than a "same-page" open closes the tab and records it.
- **Fullscreen: one owner.** `FullscreenController` (pure, fully unit
  tested) emits three effect types — `window-fullscreen`, `chrome`,
  `layout` — and `main.cjs` only translates them to Electron calls. The
  WebContentsViews are re-laid out from the controller's `viewTop()`
  (`chromeHeight` when chrome is visible, `0` when hidden or media active)
  and from the live window content size.

## 4. Protection techniques covered

- Banner/floating/sticky/overlay/injected/dynamic ads and ad iframes:
  request-level network blocking (scripts, images, iframes, fetch/XHR,
  subframes) + cosmetic hiding (filter-list CSS rules + always-on
  hardening selectors + YouTube player CSS).
- Unwanted new tabs and popups: gesture-based policy (§3), tab budget
  (60), listed-destination blocking even on real gestures.
- Redirects: main-frame and redirect checks on `will-navigate` /
  `will-redirect` against the same engines (JS, meta, click and server
  redirects to listed hosts are stopped at the navigation layer, not only
  at the request layer); popunder first-navigation watch; service-worker
  registration requests flow through the same pipeline.
- Trackers: EasyPrivacy-derived baseline + fetched lists.
- Threats/malvertising: threats group checked first (block type `Threat`),
  feed via the `malware` list category.
- Push abuse: all permission requests are denied at the session level.
- Downloads, auth and ordinary links: untouched (downloads keep their save
  dialog; unlisted destinations always pass; allowlist bypasses everything
  per-site).

## 5. Fullscreen (Objectives B & C)

- **Browser fullscreen (B):** `FullscreenController.userToggle` (F11, the
  title-bar fullscreen control, or `core:window fullscreen`) calls
  `win.setFullScreen(true)`; the window occupies the whole display (the OS
  removes all insets — the app is frameless). Chrome stays available via
  the idle rule (which *does* hide it in browser fullscreen, where it
  belongs to the page). `enter/leave-full-screen` events reconcile: OS-dropped
  media fullscreen is re-asserted; OS-dropped user fullscreen is treated as
  the user exiting (no fight loop); OS-initiated fullscreen is adopted.
- **Media fullscreen (C):** the tab's document enters HTML fullscreen →
  `mediaEnter(tabId)`. The owning tab's view is laid out at `y = 0` with the
  full window content size, and the OS window is fullscreen while the media
  tab is active — so the player fills the **entire display**, not the old
  player rect, aspect preserved by the page. Chrome is forced off for the
  duration (idle rule frozen while media is active). Background tabs' media
  fullscreen is abandoned on tab switch; the focused tab's real
  `isFullscreen()` is the source of truth (`tabFocused` re-sync).
- **Both modes together:** `wantsWindowFullscreen = user || (media &&
  media === active)` — independent booleans, one derived target, no double
  `setFullScreen` calls (effects only fire on change).
- **No stuck state:** `tabClosed` clears ownership (the old stuck case),
  `windowFullscreenChanged` reconciles any divergence, and layout is
  re-applied in a short settling loop after every fullscreen transition and
  on `display-metrics-changed` (monitor plug, rotation, DPI change).
- **Geometry:** view bounds always `{0, viewTop, contentWidth,
  contentHeight - viewTop}`; `viewTop` is the measured header height
  (96 px / 91 px responsive) read from the renderer, so the CSS seam can
  never leave a gap or overlap.

## 6. 7-second chrome hiding (Objective D)

- Idle timer ticks every 250 ms in the main process (cursor movement inside
  the window is detected there, so it works for pages too).
- Chrome hides after exactly 7000 ms **only while** the window is focused
  and an external page (or browser fullscreen) is on screen; activity
  (mouse, wheel, keys — main-window or any page input) reveals it and
  resets the clock. Tab switch and window focus always reveal it.
- The hide/show is a layout event, not CSS-only: views expand to `y = 0`
  when hidden and return below the measured header when shown — no seam,
  and layout effects are emitted only on real changes (no resize spam).
- Never touches chrome while media is active (the player must not be
  covered or interrupted).

## 7. Automated test results (actual, this environment)

Run: `node --test` in the staged desktop workspace
(`scripts/prepare-desktop.mjs --no-install` + `npm test`), Node 22.22.3.

| Suite | Tests | Result |
| --- | --- | --- |
| `electron/popup-blocker.test.cjs` | 20 | pass |
| `electron/fullscreen-state.test.cjs` | 23 | pass |
| `electron/protection.test.cjs` | 14 | pass |
| `electron/youtube-shield.test.cjs` (pre-existing) | 12 | pass |
| `electron/main.wiring.test.cjs` (new: real `main.cjs` against a strict Electron stub — startup, session, engine, IPC, tab geometry, popup block, 7 s idle hide/reveal, fullscreen toggle, persistence) | 8 steps | pass |
| **Total** | **79** | **79 pass / 0 fail** |

Also green: `npx tsc --noEmit` (strict) and `npm run build`
(`dist/index.html` 597.52 kB, single-file).

Notable defects the new suites caught and that were fixed: a `syncQueue`
entry/Promise mix-up in `core:navigate` (navigation could hang), the
`fromLists` dependency on the adblocker project's own CDN, non-2xx list
responses silently downgrading protection, and the popunder watch being
consumed by the app's own initial load.

## 8. Runtime test results (actual)

**None — explicitly not performed in this environment.** This sandbox has
no Electron binary (the 45.5.0 release asset host is outside the allowed
egress), no display/GUI, and no way to download one. Launching the app,
packaging with Forge, and every real-website check below were therefore
**not executed here**, and no result is claimed for them. The CI `electron`
job runs the same 79-test suite; the `desktop-release` workflow will
produce fresh packages from this commit.

## 9. Tests not performed

- GUI launch of the packaged app (no Electron binary/display here).
- Real-site matrix: ad-heavy pages (banner/overlay/sticky), popup and
  popunder farms, redirect chains, YouTube in-stream playback + player
  fullscreen, HTML5 player fullscreen, browser fullscreen, 7 s hiding on a
  real display (including monitor change/rotation).
- `npx playwright test` (browser download host not reachable here).
- Electron Forge `make` / Windows-macOS-Linux package builds and their
  integrity checks.
- Android TV APK build and on-device tests.
- macOS and Windows specific fullscreen behavior (developed and unit-tested
  for the cross-platform path; platform quirks unverified).

## 10. Remaining limitations (known, by design)

- **First-party ads** (served from the page's own domain) and
  **server-side ad insertion** cannot be blocked at the network layer;
  cosmetic rules cover the common cases.
- **YouTube in-stream video ads**: the shield strips the ad schedule and
  skips ads that still start, but it is a best-effort page-side shield, not
  a guarantee.
- Popup blocking of *unlisted* destinations relies on the gesture policy;
  a site that always opens tabs on a genuine click pattern will be allowed
  (mirrors a real browser blocker). When CDP is unavailable the policy
  degrades to allow (log only) rather than break sites.
- Protection coverage is bounded by the list sources (bundled
  EasyList/EasyPrivacy-derived baseline until fetched lists arrive).
- Redirects that hop through multiple *unlisted* intermediate domains are
  only caught at the final listed hop.
- The 7-second idle rule does not hide chrome on internal pages in windowed
  mode (by design — the controls remain reachable).

## 11. Branch and pull request

Branch: `arena/485c78c5-chromium` — pushed to `origin`.
Pull request: see the branch head (created against `main`).

## 12. Final commit and packages

Final commit: `af302a8` (branch head; the SHA of this report's own commit
differs by the report amendment — the branch head is authoritative).
Packages: **not produced in this environment** (no Electron binary). The
`.github/workflows/desktop-release.yml` pipeline builds Windows x64 /
macOS ARM / macOS Intel zips plus the SHA-256 manifest from this commit;
`scripts/package-desktop.mjs` is unchanged and compatible with the new
modules (the baseline `electron/resources/*.txt` are packaged inside the
app directory and read through the asar).
