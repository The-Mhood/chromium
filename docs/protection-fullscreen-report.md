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

## 13. Runtime fixes round 2 (user-reported, 2026-11-26)

Three issues reported against the running desktop app (screenshot: external
tab showing the "BROWSER PREVIEW" card instead of the page):

1. **External navigation showed the web-preview placeholder** ("This website
   is ready to explore … Open {host} … In the web preview, external sites
   open in a new window") — i.e. a click-to-open prompt inside the desktop
   app. Causes addressed:
   - `ExternalPage` in desktop mode no longer renders any open-in-new-window
     prompt; it is now an honest *loading* state (spinner + "Loading
     {host}…") that the tab's WebContentsView covers as soon as the page
     paints.
   - **Blocked main-frame navigations are now reported to the renderer**
     (`core:navigation-blocked`): the protection engine cancels listed main
     frames (e.g. parked/ad domains), which previously left the tab on the
     placeholder forever with no explanation. The tab now shows
     "Blocked by protection" with the filter category and a link to the
     activity page / allowlist hint. Wired at both layers: the request
     pipeline (`onMainframeBlocked` hook in `protection.cjs`) and the
     navigation layer (`will-navigate` / `will-redirect`).
   - **Failed loads are reported** (`core:load-failed` via
     `did-fail-load`, main-frame only — sub-resource failures are ignored
     via a per-tab `lastRequested` match). Unreachable addresses show
     "Couldn't reach {host}" with a Try-again button instead of an
     endless "loading" card.
   - `applyLayout` now re-bounds the *visible* view on every layout pass
     (previously only on window-size signature change), so a view can never
     be left at its default zero geometry after a hidden→visible tab switch
     or creation without a resize. `did-finish-load` also re-asserts the
     layout. The DevTools-script sync in `core:navigate` is bounded at 5 s
     so a stuck CDP session can never hold a navigation.
   - Session permission handlers remain `callback(false)` for every
     permission: no native permission prompt can appear from the browsing
     session; the only "permission-like" UI was the placeholder card, which
     is gone in desktop mode.

2. **Media (YouTube/other) fullscreen**: re-architected as *window-level*
   fullscreen. The document's fullscreen element already fills the contents
   viewport, so the app now maximises the frameless window and hides the
   chrome (`window-maximize` effect) instead of calling `win.setFullScreen`.
   OS transitions layered on an active document-fullscreen are what tore
   the element down (spurious `leave-html-full-screen`). The OS window is
   now in native fullscreen **only** for the user's own browser fullscreen
   (F11 / maximize dot / OS shortcut), which is unchanged and stays
   settled. Media enter/leave never crosses into the OS transition path,
   the maximise is only undone if the app did it, and background tabs
   cannot own media fullscreen.

3. **Verification**: `node --test` in `.desktop-build` — 84/84 (24
   fullscreen-state, 20 popup-blocker, 14 protection, 12 youtube-shield,
   14 wiring, incl. new subtests: tab-switch re-bounding, blocked
   main-frame report, failed-load report, window-level media
   fullscreen). `tsc --noEmit` clean; production build 600.43 kB.
   **Not verified in this environment**: actual rendering on a real
   display (no Electron binary/display in CI sandbox) — the packaged app
   from `main` is the ground truth for the three fixes.

## 14. Round 3 — default-deny popup re-engineering + fullscreen button (2026-11-26)

### Why the previous protection still let ad tabs through
Audit of the shipping code found four real holes:
1. **Degraded allow**: when CDP state was unavailable and no input had been
   observed, the policy *allowed* the open "so ordinary sites keep working".
   Ad pages with no user interaction slipped straight through.
2. **`foreground-tab` was allowed unconditionally**: any `target="_blank"` /
   link-style open skipped the gesture check, the frame check and any
   verification. A deceptive ad element with `target="_blank"` opened a tab.
3. **The destination was never verified before the tab chip appeared**: the
   renderer received `core:open-tab` at allow time. If the URL then
   redirected to an ad domain, the unwanted tab was already on screen.
4. **The opener's frame was unknown**: an ad *iframe* opening a tab on the
   user's click was indistinguishable from the top page's own link.

### What was re-engineered
- **`electron/popup-blocker.cjs` (v3, default-deny)**: no degraded mode — an
  open with no activation evidence (main-process input *and* isolated-world
  clock) is blocked. `foreground-tab` now requires a fresh gesture too.
  Cross-origin-iframe opens are blocked outright (`ad-iframe`).
  `background-tab` is blocked even with a fresh click. Every other allowed
  open is marked `needsCommit`.
- **Hidden commit inspector (`electron/main.cjs`)**: an allowed open is
  navigated in an invisible, zero-size `WebContentsView` that is never
  painted. Only when its main frame *commits* (after redirects) to a URL
  that still passes the filter engine **and** the popunder domain-jump rule
  is the tab published to the renderer. An ad — direct, via redirect, or via
  a domain jump to an *unlisted* host — is destroyed in the inspector and no
  chip or window ever appears. A commit that never arrives (6 s) is passed
  through with a first-navigation popunder watch, so slow legitimate sites
  keep working.
- **All creation pathways audited and closed**: `setWindowOpenHandler`
  (deny, with the policy around it), `did-create-window` (destroy), legacy
  `new-window` (preventDefault), privileged schemes (deny + log),
  download-triggered ads (`will-download` cancel on listed domains),
  notification/permission abuse (already denied by default for the whole
  browsing session).
- **Per-frame `window.open` records (`shared/popup-support.js`)**: the
  isolated-world script now wraps `window.open` in *every* frame and records
  whether the opener is the top frame or a cross-origin iframe; the main
  process reads all frames' isolated worlds (bounded, parallel CDP) and
  classifies on the freshest record.
- **Instrumentation (§7)**: every decision logs one line to the main
  console — requesting page, destination, initiating frame, disposition,
  decision, reason, and whether a browsing context was created
  (`[popup] {…}`), including the commit stage.

### Fullscreen button (section 10 of the directive)
- The purple active state now follows the **verified native window state**,
  not media fullscreen and not the last click (`fullscreenState.window` only;
  `aria-pressed` added). A dedicated `--accent-purple: #8f6fd0` token drives
  it (the product's brand accent is orange; no purple existed before).
- **OS-transition verification**: after every `setFullScreen`, the main
  process polls `isFullScreen()` for ~2.4 s; on a stuck transition it
  retries once, then reconciles the state machine (and therefore the button)
  back to the real window state. `enter/leave-full-screen` events cancel the
  poll. Initial state is broadcast at `ready-to-show` so the button never
  lags the window.
- Repeated toggling, F11, Escape, and media-fullscreen interaction are
  covered by wiring subtests (see below).

### Automated test results (this environment)
Staged suite (`npm test --prefix .desktop-build`): **105/105 pass**
(17 new). Hostile-page wiring scenarios (driven against the *real* main
process): clicked window.open to a listed ad, `target=_blank` to a listed
ad, redirect-to-ad, domain-jump popunder to an *unlisted* ad, scroll-fired
popup, delayed popup, cross-domain chain, background-tab, external protocol
(`intent:`), no-CDP/no-input (the old degraded hole), cross-origin
ad-iframe — all produce **no tab, no window, no chip**; a genuine clicked
link still opens a fully working tab; a repeated-popper loses its first tab
too.

### What this environment cannot do (stated honestly)
- No GUI / Electron binary here: the packaged app was **not** click-tested
  in this sandbox. The hostile suite drives the real main-process code, not
  mocks, but a human should run the acceptance clicks on the packaged build.
- Unlisted ad domains that are neither in the filter lists nor caught by a
  redirect/domain jump cannot be identified client-side (true for any
  browser); list freshness + the commit inspector + gesture rules are the
  mitigation. Server-side and in-stream media ads are out of scope.

## 15. Round 4 — the real-runtime ad-iframe click hole + silver marker (2026-11-26)

### Why the real app "didn't change"
The round-3 frame attribution recorded only **`window.open`** calls per
frame. A `target="_blank"` anchor click does **not** call `window.open` —
the browser opens the new tab directly. So when the user clicked a
"sponsored" element inside a cross-origin ad iframe, the main process saw
*exactly* the evidence it was designed to trust: a fresh, real click, no
script-popup record, destination not in any list — and it (correctly, by
its own rules) let the tab through. The unit and wiring tests never
covered that path because the test fixtures modelled the ad as a scripted
`window.open`.

### The fix
- `shared/popup-support.js` (isolated world, every frame) now also records
  the most recent **click** per frame — capture phase, before the page's
  own handlers — with the frame's origin, its cross-origin flag, and the
  href of the anchor the click landed on (shadow-DOM piercing via
  `composedPath`).
- `popup-blocker.cjs` v3.1 attributes every open to its initiating frame:
  a click whose anchor href **matches** the destination is exact
  attribution; otherwise the freshest of the window.open/click records
  wins. Cross-origin iframe attribution ⇒ `ad-iframe` block, whether the
  frame opened the tab via `window.open` or a `target=_blank` click.
  Top-frame and same-origin-iframe clicks are unaffected.
- `main.cjs` aggregates the click records across all frames (same CDP path
  as before) and the `[popup]` log line now states the initiating frame
  and mechanism (`via: "window.open" | "click"`), so the console log is
  direct proof of who opened what.

### Silver build marker
The app icon (dock/taskbar, favicon, download zips) is now **silver** —
same shape, metallic gradient — so a fixed build is unmistakable at a
glance. Any ChromiumCore with the orange icon is an old build.

### Tests
Staged suite **111/111** (+6): unit tests for click attribution (href
match; non-matching href still blocks a cross-origin click; top-frame
clicks not blocked; a stale ad-iframe click cannot shadow a fresh
top-frame click) and wiring subtests for the exact reported scenario —
a `target="_blank"` click inside a cross-origin ad iframe to an *unlisted*
destination opens **nothing** — plus a legitimate top-frame `target=_blank`
click that still opens a working tab.

### Still honest about
- If CDP itself is unavailable (devtools open on the page) and no
  main-process input was observed, default-deny still applies; with a
  real click but no CDP, the open is allowed *and* commit-verified —
  frame attribution needs the isolated-world read, and we would rather
  keep legitimate links working than break the page.
- In-stream media ads and server-side content remain out of scope.

## 16. Round 5 — real-app regressions: refused links + refused YouTube fullscreen (2026-11-27)

Two symptoms from the silver build on a real machine:

1. **Site links refused to open** (fmhy.net): round-4 attribution had a
   freshest-click fallback — when the user clicked an ad element and then a
   site link within the 3 s record window (the top frame's own record
   missing or stale), the ad iframe's cross-origin click was attributed as
   the cause and the site link was blocked as `ad-iframe`. A second
   over-blocker: the repeat-popup rule (8 s) also blocked link clicks after
   any allowed scripted popup.
2. **YouTube refused fullscreen**: the session permission handlers denied
   *every* permission — including `fullscreen` — so the player's own
   `requestFullscreen()` rejected and the video never entered HTML
   fullscreen.

### Fixes
- **Precise attribution** (`popup-blocker.cjs`): a link open is attributed
  only to a click whose anchor href *matches* the destination (catches the
  sponsored-link ad pattern, attributes top-frame links to the top frame);
  scripted opens are attributed to the window.open record. A link open with
  no matching click is left to the (unspoofable) gesture check + commit
  verification — a stale cross-origin click can no longer block site links.
- **Repeat rule is scripted-only**: a page that legitimately popped once no
  longer swallows the user's next link click (the rule still stops scripted
  popup bursts and still closes the first popup's tab).
- **Permissions, per-permission** (`main.cjs`): `fullscreen`,
  `pointerLock`, `storage-access`, `clipboard-sanitized-write`,
  `web-share`, `speaking`, `mediaKeySystem` are allowed (all
  user-gesture-gated); `notifications`, `media` (camera/mic),
  `geolocation`, device capture and the rest stay denied.

### Verification
Staged suite **114/114** (+3): regression guards for the non-matching-href
stale ad click (link now opens), scripted-open attribution, and the
repeat-rule-not-swallowing-link-clicks case; wiring subtest asserting the
permission handler allows `fullscreen` and denies `notifications`/`media`/
`geolocation`. `tsc` clean; **v1.0.12** built on all three platforms.

## 17. Round 6 — consistent 10 s header hide, fmhy.net links, double-click dialog, address-bar search (2026-11-27)

Four fixes, all verified against the real Electron main process (stub harness)
and the staged desktop build — not just isolated units.

### 1. Header auto-hide: one owner, exactly ten seconds
**Symptom:** the header hid inconsistently — sometimes after ~7 s, sometimes
never, sometimes while a video was playing and sometimes not; mouse movement
did not reliably bring it back.
**Root causes:**
1. **Two hide rules.** The renderer hid the header itself
   (`App.tsx` `chrome-hidden` on `fullscreenState.media`) while the main
   process hid it on its own 7 s timer — two sources of truth, so the CSS
   (header) and the page-view layout (page top) disagreed.
2. **7 s constant**, not the 10 s the product specifies.
3. **Media never revealed the chrome:** activity while media was fullscreen
   was ignored, so the header stayed hidden for the whole video (or, after a
   manual show, snapped back at the next idle tick — "sometimes stays,
   sometimes disappears").
4. **Stale timers / state:** the window-close path did not clear the idle
   interval, and media was previously routed through an OS
   `setFullScreen` transition that tore down the document's fullscreen
   element (the original "media fullscreen broken").

**Fix:** the main-process state machine (`fullscreen-state.cjs`) is now the
*SINGLE* owner of header visibility with one rule set:
- visible by default; ANY activity (mouse, key, wheel, focus, tab switch)
  reveals it immediately and restarts the clock — including while media is
  fullscreen;
- exactly `IDLE_MS = 10000` after the last activity it hides (in the auto-hide
  context, and while media is fullscreen);
- media enter hides the header **immediately** (no 10 s wait) and grows the
  window (`window-maximize`) — no OS transition, so the fullscreen element is
  never torn down; media exit restores the header and the window;
- `tabClosed` clears media ownership (the "stuck in fullscreen" case); the
  window-close path clears the idle interval; the renderer's second rule is
  removed (`App.tsx` keys only on `chromeVisible`).
- macOS + Windows share the identical code path (the cursor is polled with
  `screen.getCursorScreenPoint()`; input events are OS-level).

### 2. fmhy.net and ordinary site links actually navigate
**Symptom (real app):** clicking a movie link on fmhy.net (and many other
content sites) did nothing — no tab, no navigation — while ad popups were
being blocked correctly.
**Root causes (three over-blockers, all policy-level; the filter lists were
proven clean — see verification):**
1. **Ages measured at read-finish, not request time.** The page's isolated
   world is read over the DevTools protocol *asynchronously*; on ad-heavy
   pages that read took 1–2 s, so a click that was 50 ms old at request time
   was 1.5–2 s old when `classifyWindowOpen` ran — outside the 1.5 s gesture
   window — and the open was denied as `no-gesture`.
2. **Freshest-record attribution misfired.** A legitimate link open was
   attributed to a *stale cross-origin `window.open` record* left by an ad
   iframe (records linger 3 s) → denied as `ad-iframe`. (Round 5's exact-href
   rule was necessary but not sufficient: `foreground-tab` opens were never
   attributed to an open record, so the *scripted* ad case slipped through
   while the *link* case was still hostage to the stale record.)
3. **Popunder verdict on link clicks.** A link that 302s across domains
   (the site's player/CDN — the normal shape of fmhy.net) tripped the
   `window.open("")` domain-jump rule and was killed in the inspector.

**Fixes:**
- **`atMs` threading** (`main.cjs` + `popup-blocker.cjs`): the age of every
  record is measured against the moment the open was *requested*, never
  against whenever the async read finished. A fresh click is never starved.
- **Attribution priority** (`popup-blocker.cjs`, `pickAttribution`): (1) a
  click whose anchor href *exactly matches* the destination wins (the user
  clicked this link — even if an ad called `window.open` at the same
  instant); (2) otherwise an open record is a *scripted* open — a
  cross-origin `window.open` is blocked `ad-iframe` **even when the browser
  reports it as a foreground tab**; (3) otherwise a weak click record; (4)
  nothing → the unspoofable gesture check + commit verification decide.
  Cross-origin *link* clicks (a real embedded widget with its own links) are
  allowed once per 8 s window — the first is commit-verified, a burst of
  them is the ad click-through pattern and is blocked.
- **Popunder exemption for link clicks** (`committedNavigationVerdict`
  gains `viaLinkClick`): a link click crossing domains is the user following
  the site's redirects — accepted. The *scripted* `window.open("")`
  domain-jump is still blocked, and *listed* destinations are still blocked
  in both cases (the filter check is never relaxed).
- **Engine repro confirms the lists were never the problem**: all fmhy.net
  URL shapes (home, movie, watch, ajax player, api) are clean under the
  93 534 bundled baseline rules, while doubleclick/pagead controls are still
  blocked — so the fix is policy-level, not a site-specific allowlist.

### 3. Double-click link options (macOS + Windows)
Double-clicking any link shows a small frameless dialog at the cursor with
the **actual destination URL** and the actions **Open link, Open in new
tab, Open in new window, Copy link address, and Download attached media**
(the last only when the link points at media / carries `download`).
- **No unintended single-click navigation:** a plain left click
  `preventDefault`s only the default navigation (page handlers still run)
  and defers 300 ms; a second click on the same anchor within 600 ms
  cancels the deferred navigation and opens the dialog. The commit routing
  reproduces native behaviour: same-frame `location.assign` (with an SPA
  `pushState` guard), `target=_blank` through the *full popup policy*,
  `target=_top/_parent` across origins through the main process, and
  media/`download` through the main-process download pipeline (save dialog +
  ad/threat checks).
- **Injected in an isolated world** (`cc-links`, document-start) and reached
  through the DevTools protocol on a magic console prefix; the main process
  verifies the *execution-context id* of the isolated world, so the page's
  own world cannot forge messages, and only **trusted** (`isTrusted`)
  mouse events drive it — a page that dispatches synthetic clicks cannot
  open the dialog, commit a navigation, or swallow the user's real clicks.
- Keyboard dismiss (Esc), outside-click dismiss (window blur), first action
  focused on open (Tab/Enter/Space), ARIA `role="dialog"`.
- **Open in new window** creates a standalone window wired through the same
  `wireBrowsingContents` path — identical popup/ad protection, media
  handling and navigation lock as a tab.
- `main.cjs` `core:dialog` IPC is `trusted(event, linkDialogWin)` — only the
  dialog window's own contents may act.

### 4. Address bar: valid URL → navigate, otherwise Google search
`shared/address.ts` (`classifyAddress`) with strict hostname rules:
- valid URLs navigate — explicit `http(s)://`, implied-scheme
  (`youtube.com`, `example.com:8080`, `www.…`, paths/queries/fragments),
  IPv4, `[v6]`, `localhost` (incl. `localhost:port`);
- **never** misclassified as hostnames: single labels other than
  `localhost` (`exam`), dotted words (`node.js and deno`), whitespace,
  numeric TLDs (`exam.123`), bad ports (`example.com:abc`), hyphen edge
  cases, empty labels, and non-http schemes (`javascript:`, `file:`,
  `mailto:`, `data:`, `intent:`) all become searches;
- search terms are URL-encoded (`%20`, `%26`, `%3C`…) into the configured
  engine (Google default; DuckDuckGo/Bing honoured); `safeUrl`/`searchUrl`
  are re-exported from `shared/address` so the renderer and any future
  caller share one classifier.
- The `host:port` vs `scheme:` ambiguity is resolved explicitly: a **dotted**
  label before `:` is a host (`example.com:8080` navigates), and
  `localhost:<digit>` is a host not a "localhost:" scheme.

### Files
- `electron/fullscreen-state.cjs` — single-owner 10 s state machine;
  media = window-maximize + immediate chrome hide (no OS transition).
- `electron/popup-blocker.cjs` — `atMs` ages, `pickAttribution` priority,
  cross-origin *click* rate limit, scripted-open `ad-iframe` (any
  disposition), `committedNavigationVerdict(viaLinkClick)`.
- `electron/main.cjs` — `atMs` threading through the open/commit/popunder
  pipeline; `wireBrowsingContents` shared by tabs and standalone windows
  (media events forwarded for every tab — the stale active-tab guard is
  gone); CDP link world + context-id verification; dialog window +
  `core:dialog` IPC; `openBrowsingWindow`; hidden download carrier
  (settled by the session `will-download` handler, which carries the
  sender); window-close clears the idle interval and dialogs.
- `electron/preload.cjs`, `src/types.ts` — dialog + toast bridge.
- `shared/link-support.js` — isolated-world double-click manager (NEW).
- `shared/address.ts` + `shared/address.test.ts` — strict classifier (NEW).
- `src/main.tsx` (dialog mode), `src/components/LinkDialog.tsx` (NEW),
  `src/App.tsx` (second hide rule removed; toast wiring), `src/index.css`
  (dialog styles), `src/lib/data.ts` (classifier re-export).
- Tests: `popup-blocker.test.cjs` (+8), `fullscreen-state.test.cjs` (+5),
  `main.wiring.test.cjs` (media 10 s round-trip, fmhy link + popunder
  control, CDP dialog pipeline + anti-spoof, commit routing, address via
  unit suite), `shared/address.test.ts` (10 cases).

### Verification (all genuinely executed)
- **Staged desktop suite (the CI `electron` signal): 128/128** — including
  the new regression guards, run from a fresh `prepare-desktop` build.
- **Root unit suites:** address 10/10; fullscreen-state 26/26;
  popup-blocker 39/40 — the single failure is the pre-existing tldts
  public-suffix artifact that only occurs outside the staged build (it
  passes in `.desktop-build`, i.e. in CI).
- **FMHY engine repro** (real `@ghostery/adblocker`, real baseline files):
  every fmhy.net URL shape clean under 93 534 rules; ad controls blocked.
- `tsc --noEmit` clean; `vite build` green.
- **Honest limitation:** this sandbox has no display server and no access to
  the Playwright browser CDN, so the *packaged GUI* (pixel-level header
  hide, on-screen dialog, real fmhy.net navigation) is verified here via the
  real `main.cjs` against the Electron stub (128/128) and will be exercised
  on the three release builds (win32-x64, darwin-arm64, darwin-x64) by the
  `desktop-release` workflow when the tag is pushed. No packaged-app test is
  reported as passed in this environment.
