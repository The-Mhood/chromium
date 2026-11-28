'use strict';

// ---------------------------------------------------------------------------
// ChromiumCore desktop main process.
//
// Architecture after re-engineering:
//   * electron/protection.cjs   — request pipeline (baseline -> cache ->
//                                 fetched filter lists, popups, cosmetics).
//   * electron/popup-blocker.cjs — pure popup / popunder classification
//                                 (user activation, gesture quota, first-
//                                 navigation popunder watch).
//   * electron/fullscreen-state.cjs — pure state machine for browser
//                                 fullscreen, media fullscreen and the
//                                 seven-second chrome auto-hide. This file
//                                 only translates events into inputs and
//                                 effects into Electron calls.
//   * shared/popup-support.js   — document-start script reporting user
//                                 activation into the page.
//   * shared/youtube-shield.js  — YouTube ad-data shield (document start).
// ---------------------------------------------------------------------------

const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, screen, clipboard } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createProtectionEngine } = require('./protection.cjs');
const { FullscreenController } = require('./fullscreen-state.cjs');
const { browsingUrl, isAllowedDomain, trustedFilterUrl } = require('./security.cjs');
const { looksLikeAdCampaignUrl } = require('./ad-signals.cjs');
const { buildShieldScript } = require('./youtube-shield.cjs');
const { committedNavigationVerdict, pickAttribution, sameAnchorHref } = require('./popup-blocker.cjs');

let win;
let engine;
let browsingSession;
let activeId = null;
let showExternal = false;
let lastCursorPoint = null;
let chromeIdleTimer;
let persistTimer;
let broadcastTimer;
let settleTimer = null;
let lastBounds = null;
let measureTimer = null;
let mediaMaximized = false; // true when the window was maximised for media fullscreen
const views = new Map();
// A tab's view is kept hidden until its FIRST document commits: the
// renderer's loading card (host + spinner, no raw URLs) shows instead, so a
// new tab never flashes a blank white document before the page exists.
// `issueHidden` tabs stay hidden even after a commit, so the renderer's
// "blocked" / "couldn't reach" card is the thing on screen.
const firstCommitted = new Set(); // webContents ids with a document
const issueHidden = new Set();    // tab ids with a blocked/failed card showing
// Renderers that stopped responding (a page that LOADED and then froze —
// the field's "didn't respond", an ad-heavy site pinning the main thread)
// or died outright (crash/OOM). Their view is held back via issueHidden and
// the renderer shows a "stopped responding" card with Reload and Close —
// the recovery path that never existed: a frozen tab painted forever, and
// reloads typed into it queued behind the dead JS. Keyed by webContents id;
// the tab id is always in handler scope where this is consulted.
const unresponsiveContents = new Set();
// webContents ids whose renderer we killed ON PURPOSE to recover a frozen
// tab (forcefullyCrashRenderer during reload/navigate). The resulting
// render-process-gone is our recovery action, not a page failure — it must
// not re-raise the card the retry just dismissed.
const suppressProcessGone = new Set();
// Tabs the USER explicitly navigated (address bar, quick link, an admitted
// link click, the home page): their content paints LIVE from the first
// frame, like an ordinary browser — the loading card would blank the page
// on every link. Scripted opens are NOT marked live: they stay hidden until
// their first commit is verified (the round-9 ad-flash protection applies
// exactly where the risk is), and their redirects are still checked by the
// open watches the moment the tab materialises.
const liveTabs = new Set(); // tab ids with live (ungated) content
// Fail-open timers: the gate must never hold a user on the card forever. If
// a document neither commits nor finishes within this window, the view is
// released anyway (worst case: a short white frame instead of a hard hang).
const GATE_FAIL_OPEN_MS = 6000;
const gateForceTimers = new Map(); // tab id -> timer

/** Release a tab's "loading card" gate. Any of these proves the document
 *  exists (commit, finished load, or a parsed title): the view may paint.
 *  The signals are deliberately redundant — a gate that only trusted
 *  did-commit-navigation held users on the card forever on the odd load
 *  where that event did not arrive. */
function releaseGate(contentsId, tabId, signal) {
  if (firstCommitted.has(contentsId)) return;
  firstCommitted.add(contentsId);
  if (tabId && gateForceTimers.has(tabId)) {
    clearTimeout(gateForceTimers.get(tabId));
    gateForceTimers.delete(tabId);
  }
  console.info(`[layout] tab ${tabId ?? '?'} gate released via ${signal}`);
  applyLayout();
}

// A frozen or crashed renderer cannot process a plain reload()/loadURL —
// the request queues behind the dead JS thread and the tab paints its
// frozen frame forever. Kill the process so the caller's navigation spawns
// a FRESH renderer and actually lands. The render-process-gone that follows
// is suppressed (suppressProcessGone): it is our own recovery action, not a
// page failure, and the caller has already dismissed the frozen-state card.
function recoverFrozenRenderer(contents) {
  if (!contents || contents.isDestroyed()) return;
  const frozen = unresponsiveContents.has(contents.id);
  const crashed = contents.isCrashed();
  if (!frozen && !crashed) return; // a healthy renderer needs no recovery
  if (frozen) suppressProcessGone.add(contents.id);
  unresponsiveContents.delete(contents.id);
  if (crashed) return; // already dead; the navigation re-spawns the renderer
  try { contents.forcefullyCrashRenderer(); } catch { /* transitional state */ }
}
const navigationLocks = new Map();
// The URL each tab's main frame is currently trying to reach, so a
// did-fail-load for a sub-resource is never reported as a failed page.
const lastRequested = new Map();
// The last navigation sequence the renderer asked each tab to honour
// (core:navigate, 3rd arg). The renderer bumps its navSeq on every user
// navigation — including a retry of the SAME url after a failed load — while
// a plain tab switch re-focuses without bumping it. Comparing sequences lets
// core:navigate reload an unchanged url (the retry) without reloading a tab
// the user merely switched to.
const lastNavSeq = new Map();
// Verified popup opens awaiting the renderer's tab: when core:navigate
// arrives for that URL, the tab->popup link is recorded (repeat rule) and,
// for opens that timed out during verification, the first-navigation
// popunder watch is armed.
const verifiedPopupOpens = [];
// Allowed script popup -> the tab that opened for it (filled when that tab's
// navigation arrives). Used to close the tab of an earlier popup when the
// same page proves to be a repeat offender.
const popupTabByOpenUrl = new Map();
// Hidden commit inspectors: webContents id -> record. An allowed open is
// navigated here (invisible, zero-size) FIRST; only when its main frame
// commits to a URL that still passes the filter engine is the tab published
// to the renderer. An ad (direct, via redirect, or via a domain jump) is
// destroyed here and the user never sees a chip or a window.
const inspectors = new Map();
const COMMIT_TIMEOUT_MS = 6000;
// A browser context that never commits within this time is handed over as-is
// (slow legitimate sites must not break); its first navigation stays watched.
const defaults = {
  protection: { enabled: true, network: true, tracking: true, cosmetic: true, popups: true, youtube: true },
  allowlist: [], filters: [], doNotTrack: true, stats: { ads: 0, trackers: 0, popups: 0, threats: 0, events: [] },
};
let state = structuredClone(defaults);
let storePath;

const fsCtl = new FullscreenController({ chromeHeight: 96 });

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const temp = `${storePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state));
    fs.renameSync(temp, storePath);
  }, 1200);
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }

function safeHost(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return 'Unknown website'; }
}

function recordBlocked(type, url, sourceUrl) {
  const fields = { Ad: 'ads', Tracker: 'trackers', 'Pop-up': 'popups', Threat: 'threats' };
  state.stats[fields[type]] += 1;
  let domain = 'Unknown website';
  try { domain = new URL(sourceUrl || url).hostname.replace(/^www\./, ''); } catch { /* The tab may be closing. */ }
  let request = url;
  try { const parsed = new URL(url); request = `${parsed.hostname}${parsed.pathname}`; } catch { /* Keep the supplied request. */ }
  state.stats.events.unshift({ id: crypto.randomUUID(), domain, request, type, time: new Date().toISOString() });
  state.stats.events = state.stats.events.slice(0, 1000);
  persist();
  if (!broadcastTimer) broadcastTimer = setTimeout(() => { broadcastTimer = null; send('core:stats-update', state.stats); }, 400);
}

let lastPopupNoticeAt = 0;
function noticePopupBlocked(url, sourceUrl, reason) {
  const nowMs = Date.now();
  if (nowMs - lastPopupNoticeAt < 5000) return;
  lastPopupNoticeAt = nowMs;
  send('core:popup-blocked', { url, source: safeHost(sourceUrl || url), reason: reason || 'protection' });
}

/** Diagnostic popup log (requirement: proof that blocked attempts never
 *  become visible tabs or windows). One line per decision: the requesting
 *  page, the destination, the initiating frame, the mechanism, the decision,
 *  the reason, and whether a browsing context was actually created. */
function logPopup(entry) {
  try { console.log('[popup]', JSON.stringify({ at: new Date().toISOString(), ...entry })); } catch { /* logging must never throw */ }
}

// ---------------------------------------------------------------------------
// Layout: the WebContentsViews fill the window below the browser header
// (top = chromeHeight) unless the chrome is hidden or media is fullscreen
// (top = 0). The state machine owns *when*; this owns *how*.
// ---------------------------------------------------------------------------

function applyLayout() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  const top = fsCtl.viewTop();
  const viewHeight = Math.max(0, height - top);
  const bounds = { x: 0, y: top, width, height: viewHeight };
  // A window-geometry change re-bounds every view; the view that is actually
  // on screen is re-bounded on *every* layout pass, because a hidden→visible
  // tab switch or a freshly created view must never be left at its default
  // (zero) geometry even though the window size did not change.
  const geometryChanged = `${width}x${viewHeight}@${top}` !== lastBounds;
  if (geometryChanged) lastBounds = `${width}x${viewHeight}@${top}`;
  const activeView = showExternal && views.has(activeId) ? views.get(activeId) : null;
  // Z-order: child views stack in the order they were added, so a view for a
  // later-created tab always paints above earlier ones. Move the view that is
  // actually on screen to the end of the child list — otherwise switching to
  // an older tab can leave the newer tab's view painted over it (the
  // "previous site still showing" freeze).
  const children = win.contentView.children;
  if (activeView && children.length && children[children.length - 1] !== activeView) {
    win.contentView.removeChildView(activeView);
    win.contentView.addChildView(activeView);
  }
  // Hide every other view first, then show the active one last, so there is
  // never a frame where two views are visible at once. The active view is
  // held back (renderer card showing) until its first document commits —
  // or for as long as a blocked/failed card is up (issueHidden).
  for (const [id, view] of views) if (view !== activeView) view.setVisible(false);
  if (activeView) {
    const contents = activeView.webContents;
    const ready = (firstCommitted.has(contents.id) || liveTabs.has(activeId)) && !issueHidden.has(activeId);
    if (!ready && !issueHidden.has(activeId) && !gateForceTimers.has(activeId)) {
      // No blocked/failed card is involved, yet no document signal has
      // arrived: arm the fail-open (see GATE_FAIL_OPEN_MS).
      gateForceTimers.set(activeId, setTimeout(() => {
        gateForceTimers.delete(activeId);
        console.warn(`[layout] tab ${activeId} gate fail-open: no commit/finish/title observed`);
        releaseGate(contents.id, activeId, 'timeout');
      }, GATE_FAIL_OPEN_MS));
    }
    activeView.setBounds(bounds);
    // Note: no isLoading() gate — a commit is the moment the document
    // exists; gating on "load ended" would keep the card up over a healthy
    // page (media/sockets can pin the loading state), the opposite bug.
    activeView.setVisible(ready);
  }
}

// After an OS fullscreen transition the window size changes asynchronously
// (and, on some platforms, in steps). Re-apply the layout a few times so the
// views always end on the final, full-display geometry.
function settleLayout() {
  clearInterval(settleTimer);
  let step = 0;
  applyLayout();
  settleTimer = setInterval(() => {
    if (!win || win.isDestroyed() || ++step >= 8) { clearInterval(settleTimer); return; }
    applyLayout();
  }, 120);
}

function measureChromeHeight() {
  if (!win || win.isDestroyed()) return;
  clearTimeout(measureTimer);
  measureTimer = setTimeout(async () => {
    try {
      const height = await win.webContents.executeJavaScript(
        'Math.round((document.querySelector(".browser-chrome") || document.body).getBoundingClientRect().height)',
        true,
      );
      if (typeof height === 'number' && height > 0) fsCtl.setChromeHeight(height);
    } catch { /* keep the last known height */ }
  }, 250);
}

let lastFullscreenPayload = null;
function syncFullscreenState() {
  const payload = { media: fsCtl.mediaActive, window: fsCtl.wantsWindowFullscreen };
  const key = `${payload.media}|${payload.window}`;
  if (key === lastFullscreenPayload) return;
  lastFullscreenPayload = key;
  send('core:fullscreen-state', payload);
}

// The OS fullscreen transition is asynchronous and can fail silently (a
// display that refuses fullscreen, an interrupted transition). The state
// machine must never drift from the REAL window state — the fullscreen
// button must show purple only when the window is actually full-screen. So
// after every setFullScreen we verify, retry once, and if it still does not
// take, reconcile the state (and therefore the button) back to reality.
let fullscreenVerifyTimer = null;
function verifyWindowFullscreen(expected) {
  clearInterval(fullscreenVerifyTimer);
  let attempts = 0;
  let retried = false;
  fullscreenVerifyTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { clearInterval(fullscreenVerifyTimer); return; }
    const actual = win.isFullScreen();
    if (actual === expected) { clearInterval(fullscreenVerifyTimer); return; }
    if (++attempts < 12) return; // ~2.4 s of grace for the OS animation
    clearInterval(fullscreenVerifyTimer);
    if (!retried) {
      console.warn('[fullscreen] OS transition did not take; retrying once', { expected, actual });
      win.setFullScreen(expected);
      verifyWindowFullscreen(expected);
      return;
    }
    // Still stuck: the window cannot honour the request. Reflect reality so
    // the button, Escape handling and media fullscreen all agree again —
    // EXCEPT a "not fullscreen" report while a document is in media
    // fullscreen: mid-playback that is a transition glitch, and dropping
    // the browser fullscreen while the video plays is the regression the
    // session contract forbids. The state is reconciled for real when the
    // session ends (pause / back / exit), which releases it on purpose.
    console.warn('[fullscreen] transition stuck; reconciling state to actual', { expected, actual, heldForMedia: fsCtl.mediaActive });
    if (!(actual === false && fsCtl.mediaActive)) {
      fsCtl.windowFullscreenChanged(actual);
      if (fsCtl.userFullscreen !== actual) fsCtl.setUserFullscreen(actual);
    }
    syncFullscreenState();
  }, 200);
}

fsCtl.onEffect(effect => {
  if (!win || win.isDestroyed()) return;
  if (effect.type === 'window-fullscreen' && win.isFullScreen() !== effect.value) {
    // Browser (user) fullscreen only — media never comes through here.
    // An intentional exit holds the re-assertion so the mid-session guard
    // does not fight the user out of their own fullscreen.
    if (!effect.value) holdFullscreenReassert();
    win.setFullScreen(effect.value);
    settleLayout();
    verifyWindowFullscreen(effect.value);
  }
  if (effect.type === 'window-maximize') {
    // The media leaving (or being abandoned) un-maximises on purpose —
    // hold the re-assertion through the transition.
    if (!effect.on) holdFullscreenReassert();
    // Window-level media fullscreen: cover the screen with the window
    // itself. No OS transition, so the document's fullscreen element is
    // never torn down by a competing transition (the old failure mode).
    // Only undo the maximise we did — a window the user maximised
    // themselves must survive the media session.
    if (effect.on) {
      mediaMaximized = !win.isMaximized();
      if (!win.isMaximized()) win.maximize();
    } else if (mediaMaximized) {
      mediaMaximized = false;
      if (win.isMaximized() && !win.isFullScreen()) win.unmaximize();
    }
    settleLayout();
  }
  if (effect.type === 'chrome') send('core:chrome-visibility', effect.visible);
  if (effect.type === 'layout' || effect.type === 'chrome') applyLayout();
  syncFullscreenState();
});

// ---------------------------------------------------------------------------
// Keeping the window in fullscreen while a media session is active.
// Field contract (the "mouse activity removes the fullscreen" report): the
// browser stays in fullscreen as long as the media is in fullscreen; mouse
// activity never removes it; and ONLY the media leaving fullscreen (Esc,
// the player's exit control, navigating away, tab close — all of them
// fire leave-html-full-screen) ends the session. Pausing the media is NOT
// an exit: the document's fullscreen element persists while paused, and so
// does the session.
//
// Re-assertion: even with that rule, the window can drop out of its state
// mid-session (a stray restore — taskbar click while the chrome is
// revealed, Win+Down, a resize race). Once a second we check and put it
// back. Intentional releases hold the re-assertion briefly so the exit
// is not fought (see holdFullscreenReassert, called from the effect sink).
// ---------------------------------------------------------------------------
const FULLSCREEN_REASSERT_MS = 1000;
let fullscreenReassertTimer = null;
let fsReassertHoldUntil = 0; // release paths hold re-assertion past their transition

function holdFullscreenReassert(ms = 2500) {
  fsReassertHoldUntil = Date.now() + ms;
}

function armFullscreenReassert() {
  if (fullscreenReassertTimer) return;
  fullscreenReassertTimer = setInterval(() => {
    if (!win || win.isDestroyed()) { disarmFullscreenReassert(); return; }
    const wantsUser = fsCtl.userFullscreen;
    const wantsMediaMax = mediaMaximized && fsCtl.mediaActive;
    if (!wantsUser && !wantsMediaMax) { disarmFullscreenReassert(); return; }
    if (Date.now() < fsReassertHoldUntil) return;
    try {
      if (wantsUser && !win.isFullScreen()) {
        console.warn('[fullscreen] window left OS fullscreen mid-session; re-asserting');
        win.setFullScreen(true);
        settleLayout();
        verifyWindowFullscreen(true);
        return;
      }
      if (wantsMediaMax && !win.isFullScreen() && !win.isMaximized()) {
        console.warn('[fullscreen] window left media-maximize mid-session; re-asserting');
        win.maximize();
      }
    } catch { /* window mid-transition — retry next tick */ }
  }, FULLSCREEN_REASSERT_MS);
}

function disarmFullscreenReassert() {
  if (fullscreenReassertTimer) { clearInterval(fullscreenReassertTimer); fullscreenReassertTimer = null; }
}

// ---------------------------------------------------------------------------
// Tabs (WebContentsViews for external pages)
// ---------------------------------------------------------------------------

function publishTab(id, contents) {
  if (contents.isDestroyed()) return;
  // The blank page used to prepare a new tab is internal and never shown to the user.
  if (!contents.getURL() || contents.getURL() === 'about:blank') return;
  send('core:tab-update', { id, title: contents.getTitle() || safeHost(contents.getURL() || 'https://example.com'), url: contents.getURL() });
}

function destroyTab(id) {
  const view = views.get(id);
  if (!view) return;
  const contents = view.webContents;
  fsCtl.tabClosed(id);
  engine.popupPolicy.forget(contents.id);
  navigationLocks.delete(contents.id);
  lastRequested.delete(contents.id);
  lastNavSeq.delete(id);
  firstCommitted.delete(contents.id);
  liveTabs.delete(id);
  issueHidden.delete(id);
  unresponsiveContents.delete(contents.id);
  suppressProcessGone.delete(contents.id);
  if (gateForceTimers.has(id)) { clearTimeout(gateForceTimers.get(id)); gateForceTimers.delete(id); }
  // A closed tab must not keep a page-script heal timer armed: the retry
  // would re-attach a destroyed renderer (and, in the wiring smoke, clobber
  // the shared CDP listener a later test is counting on).
  const syncEntry = syncQueue.get(contents.id);
  if (syncEntry) {
    if (syncEntry.healTimer) { clearTimeout(syncEntry.healTimer); syncEntry.healTimer = null; }
    syncQueue.delete(contents.id);
  }
  popunderWatches.delete(contents.id);
  immediateOpenWatches.delete(contents.id);
  for (const [openUrl, tabId] of popupTabByOpenUrl) if (tabId === id) popupTabByOpenUrl.delete(openUrl);
  releaseImmediateOpenTab(id); // a closed tab frees its (source, destination) key at once
  win.contentView.removeChildView(view);
  views.delete(id);
  try { contents.close(); } catch { /* already closing */ }
  applyLayout();
}

// The activation clock and the per-frame window.open / click records live in
// the isolated "cc-popup" world: the page's own world cannot read, reset or
// fake them, and their listeners accept isTrusted events only (a page that
// dispatches synthetic input refreshes nothing). An ad *iframe* is
// distinguished from the top page by its records. The PRIMARY evidence is
// the main process's own input observation (before-mouse-event /
// before-input-event on the browser's input pipeline) — it works even when
// this CDP read fails, which is what a real link click relies on now.
// The isolated world reports RAW timestamps (same machine clock as the main
// process). The ages are computed HERE, against the moment the open was
// requested — never against the moment this read finishes. That read is an
// asynchronous DevTools round trip that can take a second or more on
// ad-heavy pages (dozens of frames, like fmhy.net); computing ages against
// "now" is what starved a fresh user click of its 1.5 s gesture window and
// made ordinary links "refuse to click".
const POPUP_STATE_EXPR = '(function () { var s = window.__ccPopupState; if (!s) return null; return { t: s.t || 0, open: s.lastOpen && Date.now() - s.lastOpen.t < 3000 ? s.lastOpen : null, click: s.lastClick && Date.now() - s.lastClick.t < 3000 ? s.lastClick : null }; })()';

/**
 * Read the isolated-world popup state of every frame.
 * `options.partialMs`: when set, the read returns EARLY with whatever frames
 * have settled by the deadline (instead of null) — the link-click routing
 * probe uses this so a congested frame never withholds the top frame's
 * record, and the whole read never holds a click up past the budget.
 */
async function readPagePopupState(contents, atMs, options = {}) {
  const entry = syncQueue.get(contents.id);
  if (!entry || contents.isDestroyed() || !contents.debugger.isAttached()) return null;
  const cdp = contents.debugger;
  const partialMs = options.partialMs;
  try {
    const tree = await withTimeout(cdp.sendCommand('Page.getFrameTree'), 'frame tree', partialMs || 1500);
    const frameIds = [];
    (function walk(node, depth) {
      if (!node || depth > 40 || frameIds.length >= 40) return;
      if (node.frame && node.frame.id) frameIds.push(node.frame.id);
      for (const child of node.childFrames || []) walk(child, depth + 1);
    })(tree.frameTree, 0);
    if (!frameIds.length) return null;
    const settled = [];
    const reads = Promise.all(frameIds.map(async frameId => {
      try {
        const context = await cdp.sendCommand('Runtime.getIsolatedContext', { frameId, worldName: POPUP_WORLD });
        const result = await cdp.sendCommand('Runtime.evaluate', { expression: POPUP_STATE_EXPR, contextId: context.contextId, returnByValue: true });
        const value = (result && result.result && result.result.value) || null;
        if (value) settled.push(value); // frames may settle out of order
      } catch { /* one dead frame never withholds the rest */ }
    }));
    if (partialMs) {
      await Promise.race([reads, new Promise(resolve => setTimeout(resolve, partialMs))]);
    } else {
      await withTimeout(reads, 'popup state', 2500);
    }
    let lastActivityAt = 0;
    let open = null;
    let click = null;
    for (const value of settled) {
      if (!value) continue;
      if (typeof value.t === 'number' && value.t > lastActivityAt) lastActivityAt = value.t;
      if (value.open && (!open || value.open.t > open.t)) open = value.open;
      if (value.click && (!click || value.click.t > click.t)) click = value.click;
    }
    if (!lastActivityAt && !open && !click) return null;
    // Freshness is measured against the OPEN, not the read: a record made
    // more than 3 s before the open is a different event (slight clock
    // tolerance for records written microseconds "after" the request).
    const fresh = record => record && atMs - record.t < 3000 && record.t < atMs + 2000 ? record : null;
    return {
      ageMs: lastActivityAt ? Math.max(0, atMs - lastActivityAt) : 999999999,
      open: fresh(open),
      click: fresh(click),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Immediate link opens (genuine target=_blank / modifier clicks).
//
// A genuine link click is recognised SYNCHRONOUSLY from the browser's input
// pipeline (before-mouse-event): it is fresh (milliseconds old) and
// unspoofable (synthetic element.click() never passes through the
// pipeline). For such opens the tab is published at once — no hidden
// inspector round trip on the critical path — and the destination's
// redirects are checked as they happen (a commit to a listed ad closes the
// tab promptly). Rapid repeat clicks on the same link while the first tab
// is still materialising are DEDUPLICATED (dropped, never queued), so a
// nervous user clicking five times gets one tab, not a burst of five.
//
// The input-pipeline check alone is NOT sufficient, though: an ad script
// can call window.open() INSIDE the user's own click handler, and the
// browser reports that open with the same link-shaped disposition and a
// fresh real click behind it. So the isolated-world records arbitrate:
//   * a real anchor click writes a CLICK record whose href is EXACTLY the
//     destination (target=_blank never calls window.open) -> immediate;
//   * a window.open() call writes an OPEN record (never a matching click)
//     -> the full conservative path (quota, repeat rule, hidden
//     inspector, popunder domain-jump check on the commit);
//   * no records at all (DevTools unavailable) -> the FIRST open of a
//     fresh user activation keeps the immediate path (a page with a dead
//     DevTools session must not feel broken), every further open of that
//     activation is treated as scripted.
// A second fresh click on the same link while the first tab is pending is
// the DOUBLE-CLICK: it closes the first tab and offers the link-options
// dialog (same outcome the in-page 600 ms detection produces, but decided
// in the main process, so it also works for slow trackpad double-taps).
//
// Scripted opens (window.open with any non-link disposition) keep the full
// conservative path: DevTools state read + classification + hidden
// inspector verification before anything is shown. The frame attribution
// on the click path (stale ad-iframe window.open records, sponsored-click
// rate limit) still comes from the isolated-world read — bounded to a
// couple of frames: when DevTools is congested (ad-heavy pages), the open
// is classified on the main-process evidence alone instead of waiting.
// ---------------------------------------------------------------------------

const LINK_DEDUP_MS = 1500;              // repeat clicks on the same destination are dropped within this window
const LINK_PAGESTATE_BUDGET_MS = 150;    // the frame-attribution read on the click path must never hold the click up
const LINK_SECOND_CLICK_MS = 1000;       // a second fresh click this soon after the first is the double-click (matches the in-page window; a manual "double" at TV/trackpad distances is slower than an OS double-click)
const pendingLinkOpens = new Map();      // `${contentsId}\u001f${url}` -> { atMs } of the FIRST request
const pendingImmediateOpens = [];        // { url, sourceUrl, sourceContentsId, sourceTabId, at } — matched when the tab materialises
const immediateOpenWatches = new Map();  // new tab contents id -> { intendedUrl, sourceUrl, createdAt, viaLinkClick }
const immediateTabByOpenUrl = new Map(); // declared url -> { tabId, sourceContentsId, sourceTabId, at } (double-click close)

function linkOpenKey(contentsId, url) { return contentsId + '\u001f' + url; }

function sweepPendingLinkOpens(atMs) {
  for (const [key, entry] of pendingLinkOpens) if (atMs - entry.atMs >= LINK_DEDUP_MS) pendingLinkOpens.delete(key);
}

/** Claim the right to open `url` from `contentsId` right now. Returns false
 *  (duplicate — drop it) when the same request is still pending. */
function claimLinkOpen(contentsId, url, atMs) {
  sweepPendingLinkOpens(atMs);
  const key = linkOpenKey(contentsId, url);
  if (pendingLinkOpens.has(key)) return false;
  pendingLinkOpens.set(key, { atMs });
  return true;
}

function releaseLinkOpen(contentsId, url) { pendingLinkOpens.delete(linkOpenKey(contentsId, url)); }

/** Drop all bookkeeping for a tab that was created for an immediate open
 *  (closed by the user, by a double-click, or by the redirect check). */
function releaseImmediateOpenTab(tabId) {
  for (const [url, info] of immediateTabByOpenUrl) {
    if (info.tabId === tabId) {
      immediateTabByOpenUrl.delete(url);
      releaseLinkOpen(info.sourceContentsId, url);
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Double-click bookkeeping.
//
// The in-page script detects a fast double-click on its own 600 ms window
// and asks for the dialog (t:'dialog'); the main process detects the slower
// kind (second fresh click on the same link while the first tab is pending)
// through the dedup state. Both routes serve the SAME dialog through
// serveLinkDialog, and the cooldown keeps a race between the two routes
// from showing two dialogs or re-opening a tab for the pair.
// ---------------------------------------------------------------------------
const DIALOG_COOLDOWN_MS = 1200;
const dialogCooldowns = new Map(); // `${contentsId}\u001f${url}` -> served-at ms

function linkDialogCoolingDown(contentsId, url) {
  const until = dialogCooldowns.get(contentsId + '\u001f' + url);
  if (until === undefined) return false;
  if (Date.now() >= until) { dialogCooldowns.delete(contentsId + '\u001f' + url); return false; }
  return true;
}

/** Close the just-opened (or still pending) tab for a double-clicked link
 *  and show the link-options dialog at the cursor. Returns false when the
 *  dialog for this link was already served within the cooldown. */
function serveLinkDialog({ url, sourceContentsId, sourceTabId, text, media }) {
  const coolKey = sourceContentsId + '\u001f' + url;
  const nowMs = Date.now();
  if ((dialogCooldowns.get(coolKey) || 0) > nowMs) return false;
  dialogCooldowns.set(coolKey, nowMs + DIALOG_COOLDOWN_MS);
  // A double-click on a link that opens a new tab: the FIRST click already
  // opened the tab (immediate single-click behaviour). The second click is
  // the user choosing the options instead — close the just-opened tab,
  // then show the dialog. (If the first click's tab has not materialised
  // yet, its pending entry is dropped below and the renderer's tab, when
  // navigated, finds no bookkeeping and simply behaves like an ordinary
  // user tab.)
  const pendingIdx = pendingImmediateOpens.findIndex(item => item.url === url && item.sourceTabId === sourceTabId && nowMs - item.at < 5000);
  if (pendingIdx !== -1) pendingImmediateOpens.splice(pendingIdx, 1);
  const info = immediateTabByOpenUrl.get(url);
  if (info && info.sourceTabId === sourceTabId && nowMs - info.at < 5000) {
    immediateTabByOpenUrl.delete(url);
    releaseLinkOpen(info.sourceContentsId, url);
    if (views.has(info.tabId)) {
      destroyTab(info.tabId);
      send('core:tab-closed', { id: info.tabId });
    }
  }
  let point = { x: 0, y: 0 };
  try { point = screen.getCursorScreenPoint(); } catch { /* headless */ }
  openLinkDialog({
    url,
    title: typeof text === 'string' ? text : '',
    media: media === true,
    x: point.x,
    y: point.y,
    sourceTabId,
  });
  return true;
}

async function readPagePopupStateBounded(contents, atMs, budgetMs) {
  const budget = new Promise(resolve => setTimeout(resolve, budgetMs));
  const [pageState] = await Promise.all([readPagePopupState(contents, atMs), budget]);
  return pageState; // null on budget expiry (and on any failure)
}

/** A link-shaped open (Chromium disposition "foreground-tab") admitted to
 *  the immediate path (see handleWindowOpen): decide and publish
 *  synchronously. */
async function handleLinkClickOpen({ url, sourceUrl, disposition, contents, atMs, viaScriptCommit = false, pageState: prePageState }) {
  const contentsId = contents.id;
  const source = safeHost(sourceUrl);
  const sourceTabId = tabIdOfContents(contents);
  const frame = viaScriptCommit ? { via: 'link-commit' } : null;

  // 1) Real-input evidence, checked against the browser's input pipeline —
  //    no DevTools involved. No fresh input means no user click: a scripted
  //    element.click() on a target=_blank anchor arrives exactly like this
  //    (link-shaped disposition, zero pipeline input). Deny PROMPTLY — a
  //    deny must not wait on an asynchronous state read either.
  if (!engine.popupPolicy.freshInput(contentsId, atMs)) {
    logPopup({ source, url, disposition, frame, decision: 'deny', reason: 'no-gesture', created: false });
    recordBlocked('Pop-up', url, sourceUrl);
    noticePopupBlocked(url, sourceUrl, 'no-gesture');
    return;
  }

  // 1b) The dialog for this link was just served by a double-click: the
  //     user's follow-up clicks belong to the dialog, not to new tabs.
  if (linkDialogCoolingDown(contentsId, url)) {
    logPopup({ source, url, disposition, frame, decision: 'deny', reason: 'dialog-cooldown', created: false });
    return;
  }

  // 2) Frame attribution (stale ad-iframe window.open records, sponsored
  //    click rate limit) from the isolated-world read — bounded: on a
  //    congested DevTools session the click is classified on the
  //    main-process evidence alone (listed-destination, tab budget, quota
  //    still apply) instead of waiting for the read to finish. (The routing
  //    probe may have already read it; reuse that result.)
  const pageState = prePageState !== undefined
    ? prePageState
    : await readPagePopupStateBounded(contents, atMs, LINK_PAGESTATE_BUDGET_MS);
  if (contents.isDestroyed()) return;
  const decision = engine.popupPolicy.classifyWindowOpen({
    url,
    sourceUrl,
    disposition,
    tabCount: views.size,
    pageState,
    contentsId,
    atMs,
  });
  const attributed = pickAttribution({ url, pageState });
  const logFrame = attributed ? { isTop: !!attributed.isTop, crossOrigin: !!attributed.crossOrigin, via: attributed.via === 'open' ? 'window.open' : 'click' } : frame;
  if (!decision.allowed) {
    logPopup({ source, url, disposition, frame: logFrame, decision: 'deny', reason: decision.reason, created: false });
    recordBlocked('Pop-up', url, sourceUrl);
    noticePopupBlocked(url, sourceUrl, decision.reason);
    if (decision.earlierUrl) closeEarlierPopupTab(decision.earlierUrl);
    releaseLinkOpen(contentsId, url); // a rejected request frees the key at once
    return;
  }

  // 3) Deduplicate: rapid repeat clicks on the same link while the first
  //    tab is still materialising never queue up — no burst of N tabs when
  //    the user clicks the link five times. A second FRESH click on the
  //    same link IS the double-click: same outcome the in-page 600 ms
  //    detection produces (close the first tab, offer the link-options
  //    dialog), but decided in the main process against the dedup state —
  //    so it also fires for slow trackpad double-taps that miss the in-page
  //    window. Clicks later in the dedup window (not a double-click) are
  //    dropped silently, as before.
  if (!claimLinkOpen(contentsId, url, atMs)) {
    const held = pendingLinkOpens.get(linkOpenKey(contentsId, url));
    if (held && atMs - held.atMs <= LINK_SECOND_CLICK_MS) {
      logPopup({ source, url, disposition, frame: logFrame, decision: 'deny', reason: 'double-click', created: false });
      serveLinkDialog({ url, sourceContentsId: contentsId, sourceTabId, text: '', media: false });
    } else {
      logPopup({ source, url, disposition, frame: logFrame, decision: 'deny', reason: 'dedup-pending', created: false });
    }
    return;
  }

  // 4) Publish NOW: the gesture is verified (real input, milliseconds old)
  //    and the destination passed the filter check above. The tab's own
  //    redirects stay checked as they happen (immediateOpenWatches), so a
  //    redirect-to-ad closes the tab promptly instead of flashing.
  logPopup({ source, url, disposition, frame: logFrame, decision: 'allow', reason: 'link-click', created: true, stage: 'immediate' });
  pendingImmediateOpens.push({ url, sourceUrl, sourceContentsId: contentsId, sourceTabId, at: atMs });
  if (pendingImmediateOpens.length > 50) pendingImmediateOpens.splice(0, pendingImmediateOpens.length - 50);
  send('core:open-tab', { url, title: safeHost(url) });
}

// The app converts every window.open into a managed tab, so the native
// window is always denied here; the allow/block decision happens around it.
// A genuine LINK click is published immediately (see handleLinkClickOpen);
// every other (scripted) open is not shown yet — it is verified in a hidden
// inspector first (startCommitVerification), so an ad — directly, via
// redirect or via a domain jump — can never become a visible tab or window.
async function handleWindowOpen(details, contents) {
  if (contents.isDestroyed()) return;
  // The open was requested NOW. Every age in the policy is measured against
  // this instant — the isolated-world state read below is asynchronous and
  // can take seconds on ad-heavy pages, and must not count against the
  // user's gesture (that is what made fresh link clicks "stale").
  const atMs = Date.now();
  const sourceUrl = contents.getURL();
  const disposition = details.disposition || 'default';
  let url;
  try {
    url = browsingUrl(details.url);
  } catch {
    // Privileged schemes (javascript:, data:, chrome-extension:, intent:,
    // mailto:, ...) never open a browsing context in this browser.
    logPopup({ source: safeHost(sourceUrl), url: details.url, disposition, decision: 'deny', reason: 'scheme', created: false });
    return;
  }
  // A LINK-SHAPED open (Chromium's "foreground-tab") earns the immediate
  // path only on POSITIVE link-click evidence: an isolated-world CLICK
  // record whose href is exactly this destination (a real anchor click —
  // window.open() never writes that). A window.open() call writes an OPEN
  // record instead, and ad scripts can fire it inside the user's own click
  // handler (same disposition, same fresh real input) — those keep the
  // full conservative path below. With no records at all (DevTools down),
  // the FIRST open of a fresh activation keeps the immediate path; every
  // further open of the activation is treated as scripted.
  let treatAsScripted = false;
  let likelyLinkClick = false;
  if (disposition === 'foreground-tab') {
    // Bounded PROBE: whatever frames settle in the budget (the top frame's
    // record is usually first) — a congested frame must not withhold it.
    const probe = await readPagePopupState(contents, atMs, { partialMs: LINK_PAGESTATE_BUDGET_MS });
    if (contents.isDestroyed()) return;
    const attributed = pickAttribution({ url, pageState: probe });
    const hasClickEvidence = !!attributed && attributed.via === 'click' && sameAnchorHref(attributed.href, url);
    const hasOpenRecord = !!(probe && probe.open);
    if (hasClickEvidence || (!hasOpenRecord && engine.popupPolicy.firstGapLinkOpen(contents.id))) {
      engine.popupPolicy.noteLinkOpenUsed(contents.id);
      await handleLinkClickOpen({ url, sourceUrl, disposition, contents, atMs, pageState: probe });
      return;
    }
    // Scripted evidence (a window.open record) or a second+ open of the
    // activation: classify as scripted so the quota, the repeat-popup rule
    // and the hidden verification all apply. `likelyLinkClick` is the
    // no-records gap case with a fresh real gesture: the popunder
    // domain-jump check is then relaxed on the commit (an honest
    // cross-domain redirect of the user's own link must keep working even
    // without DevTools) while the list checks stay fully active.
    treatAsScripted = true;
    likelyLinkClick = !hasOpenRecord && engine.popupPolicy.freshInput(contents.id, atMs);
  }

  // Page state (isolated-world records) is read for EVERY scripted open: it
  // carries the frame attribution (ad-iframe window.open records) and the
  // cross-origin click rate-limit, and corroborates the main-process input
  // observation. Scripted opens are suspect by definition — they pay for
  // the read and the hidden verification, which is what keeps their
  // destinations out of sight until they are clean.
  const pageState = await readPagePopupState(contents, atMs);
  if (contents.isDestroyed()) return;
  const decision = engine.popupPolicy.classifyWindowOpen({
    url,
    sourceUrl,
    disposition,
    tabCount: views.size,
    pageState,
    contentsId: contents.id,
    atMs,
    treatAsScripted,
  });
  // For the log: the frame that actually initiated this open (a window.open
  // record, or — for a target=_blank link click — the click record).
  const attributed = pickAttribution({ url, disposition, pageState });
  const frame = attributed ? { isTop: !!attributed.isTop, crossOrigin: !!attributed.crossOrigin, via: pageState && pageState.open && (attributed === pageState.open) ? 'window.open' : 'click' } : null;
  if (!decision.allowed) {
    logPopup({ source: safeHost(sourceUrl), url, disposition, frame, decision: 'deny', reason: decision.reason, created: false });
    recordBlocked('Pop-up', url, sourceUrl);
    noticePopupBlocked(url, sourceUrl, decision.reason);
    // Repeat offender: the page already had one popup through, so close the
    // tab it got earlier — the user never asked for either.
    if (decision.earlierUrl) closeEarlierPopupTab(decision.earlierUrl);
    return;
  }
  // Only scripted opens reach this far (link-shaped opens were handled
  // above): an allowed one is verified in the hidden inspector first.
  if (!decision.needsCommit) {
    logPopup({ source: safeHost(sourceUrl), url, disposition, frame, decision: 'allow', reason: decision.reason, created: true });
    send('core:open-tab', { url, title: safeHost(url) });
    return;
  }
  logPopup({ source: safeHost(sourceUrl), url, disposition, frame, decision: 'verify', reason: decision.reason, created: false });
  // `likelyLinkClick`: the no-records gap case (fresh gesture, no window.
  // open record) — there the commit verdict relaxes the popunder jump rule
  // so an honest cross-domain redirect of the user's own link still works
  // without DevTools. A definite window.open record (or a plain scripted
  // open) keeps the full jump rule.
  startCommitVerification({ url, sourceUrl, viaLinkClick: likelyLinkClick });
}

// ---------------------------------------------------------------------------
// Commit verification: the "no transient advertising UI" core.
//
// An allowed open is navigated in a hidden, zero-size WebContentsView that
// is never painted (not in the tab list, invisible, negative bounds). When
// its main frame commits — after any redirects — the committed URL is
// checked against the filter engine and the popunder domain-jump rule:
//   - passes  -> the inspector is destroyed and ONLY NOW is the tab
//                published to the renderer (core:open-tab), so a chip for
//                an ad can never even flash;
//   - fails   -> the inspector is destroyed and the attempt is recorded.
//                No tab, no window, no chip, no flash.
// ---------------------------------------------------------------------------

function startCommitVerification({ url, sourceUrl, viaLinkClick = false }) {
  if (!win || win.isDestroyed()) return;
  // Campaign-shaped destinations never even get a hidden load: the URL is
  // already the ad landing, so no redirect chain can be vetted — deny now
  // (saves the 6 s stall and a hidden page load the user never sees).
  if (looksLikeAdCampaignUrl(url)) {
    logPopup({ source: safeHost(sourceUrl), url, disposition: 'verify', decision: 'deny', reason: 'interstitial-ad', created: false, stage: 'commit' });
    recordBlocked('Ad', url, sourceUrl);
    noticePopupBlocked(url, sourceUrl, 'interstitial-ad');
    return;
  }
  const view = new WebContentsView({ webPreferences: { session: browsingSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false } });
  const contents = view.webContents;
  // A SCRIPTED open that passes verification still gets its tab's first
  // redirect chain watched (same fallback as the commit-timeout path): the
  // tab's own first load is re-checked against the same domain-fidelity
  // rule. Link clicks are exempt — their first navigation is the user's
  // choice, not a popup continuation.
  const record = { url, sourceUrl, view, openedAt: Date.now(), committed: false, settled: false, timer: null, viaLinkClick: viaLinkClick === true, armTabWatch: viaLinkClick !== true };
  inspectors.set(contents.id, record);
  view.setVisible(false); // never painted, ever
  view.setBounds({ x: -1, y: -1, width: 0, height: 0 });
  win.contentView.addChildView(view);

  contents.setWindowOpenHandler(details => {
    // An ad that escapes the inspector via its own window.open dies here.
    logPopup({ source: safeHost(url), url: details.url, disposition: details.disposition || 'default', decision: 'deny', reason: 'inspector-escape', created: false });
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, navUrl) => {
    // JS-driven navigation inside the inspector (location.replace & co.).
    try {
      browsingUrl(navUrl);
    } catch {
      event.preventDefault();
      resolveInspector(contents, { block: true, type: 'Threat', reason: 'scheme', url: navUrl });
      return;
    }
    const hit = engine.matchMainFrame(navUrl, sourceUrl);
    if (hit) { event.preventDefault(); resolveInspector(contents, { block: true, type: hit, reason: 'listed-redirect', url: navUrl }); return; }
  });
  contents.on('did-commit-navigation', () => {
    if (record.settled || record.committed) return;
    record.committed = true;
    const finalUrl = contents.getURL();
    const hit = engine.matchMainFrame(finalUrl, sourceUrl);
    const verdict = committedNavigationVerdict({
      intendedUrl: record.url,
      openerUrl: record.sourceUrl,
      finalUrl,
      matchRequest: (u, s, _type, group) => (group === 'threats' ? engine.matchMainFrame(u, s, 'threats') : engine.matchMainFrame(u, s)) !== null,
      nowMs: Date.now(),
      createdAt: record.openedAt,
      viaLinkClick: record.viaLinkClick,
      isInterstitialAd: looksLikeAdCampaignUrl,
    });
    if (hit) resolveInspector(contents, { block: true, type: hit, reason: 'listed-destination', url: finalUrl });
    else if (verdict.block) resolveInspector(contents, { block: true, type: verdict.type, reason: verdict.reason, url: finalUrl });
    else resolveInspector(contents, { block: false, url: finalUrl });
  });
  contents.on('did-fail-load', (_event, code) => {
    if (record.settled) return;
    if (code === -3) {
      // ERR_ABORTED: the request pipeline cancelled the main frame (listed
      // ad host). The engine already recorded it; destroy without another
      // record.
      resolveInspector(contents, { block: true, type: 'Ad', reason: 'listed-destination', url: contents.getURL() || record.url, noRecord: true });
    } else {
      // A genuine load failure (DNS, offline, refused): hand the open over
      // as-is — the tab shows the usual friendly "could not load" state.
      resolveInspector(contents, { block: false, url: record.url });
    }
  });
  contents.on('destroyed', () => {
    if (record.settled) return;
    // Torn down externally (window closed, session reset): settle quietly.
    record.settled = true;
    if (record.timer) clearTimeout(record.timer);
    inspectors.delete(contents.id);
  });

  record.timer = setTimeout(() => {
    if (!inspectors.has(contents.id)) return;
    // Verification never finished (stalled ad server or very slow site):
    // pass it through so ordinary sites keep working; its first navigation
    // stays watched as a popunder fallback.
    resolveInspector(contents, { block: false, url: record.url, reason: 'commit-timeout', watch: true });
  }, COMMIT_TIMEOUT_MS);

  contents.loadURL(url).catch(() => {}); // the did-fail-load path settles it
}

function resolveInspector(contents, outcome) {
  const record = inspectors.get(contents.id);
  if (!record || record.settled) return;
  record.settled = true;
  if (record.timer) clearTimeout(record.timer);
  if (outcome.block) {
    logPopup({ source: safeHost(record.sourceUrl), url: outcome.url || record.url, decision: 'deny', reason: outcome.reason, created: false, stage: 'commit' });
    if (!outcome.noRecord) recordBlocked(outcome.type || 'Pop-up', outcome.url || record.url, record.sourceUrl);
    noticePopupBlocked(outcome.url || record.url, record.sourceUrl, outcome.reason);
  } else {
    logPopup({ source: safeHost(record.sourceUrl), url: outcome.url, decision: 'allow', reason: outcome.reason || 'verified', created: true, stage: 'commit' });
    // The renderer will create the tab for this URL; when its navigation
    // arrives we learn the tab id (repeat rule + optional popunder watch).
    verifiedPopupOpens.push({ url: outcome.url, sourceUrl: record.sourceUrl, at: Date.now(), watch: outcome.watch === true || record.armTabWatch === true, viaLinkClick: record.viaLinkClick });
    if (verifiedPopupOpens.length > 50) verifiedPopupOpens.splice(0, verifiedPopupOpens.length - 50);
    send('core:open-tab', { url: outcome.url, title: safeHost(outcome.url) });
  }
  destroyInspector(contents, record);
}

function destroyInspector(contents, record) {
  try { if (win && !win.isDestroyed() && record && record.view && win.contentView.children.includes(record.view)) win.contentView.removeChildView(record.view); } catch { /* already gone */ }
  try { contents.close(); } catch { /* already closing */ }
  inspectors.delete(contents.id);
}

// Close the tab that a previously-allowed popup created, so a repeat-popup
// block removes both unwanted tabs instead of just the latest one.
function closeEarlierPopupTab(openUrl) {
  const id = popupTabByOpenUrl.get(openUrl);
  if (!id) return;
  popupTabByOpenUrl.delete(openUrl);
  if (!views.has(id)) return;
  destroyTab(id);
  send('core:tab-closed', { id });
}

// First-navigation inspection for tabs whose commit verification could not
// finish in time (popunder fallback watch).
const popunderWatches = new Map(); // contents id -> { intendedUrl, sourceUrl, createdAt, viaLinkClick }

// Both redirect watches (popunder fallback + immediate-link) stay ARMED
// across the whole redirect chain of the first load: a watch that dies on
// its first will-navigate (the intended URL, which by definition passes)
// would leave every later redirect unchecked — a tab that 302s to a listed
// ad would then hang on its "Loading <url>" placeholder forever instead of
// being closed. The watch is removed when the verdict blocks (the tab is
// destroyed anyway), when the load commits (did-commit-navigation, wired at
// arm time), when the tab goes away (destroyTab), or when it expires.
function armedNavigationWatch(watches, contents) {
  const watch = watches.get(contents.id);
  if (!watch) return null;
  if (Date.now() - watch.createdAt > engine.popupPolicy.WATCH_TTL_MS) {
    watches.delete(contents.id);
    return null;
  }
  return watch;
}

function checkPopunderNavigation(contents, url, tabId) {
  const watch = armedNavigationWatch(popunderWatches, contents);
  if (!watch) return false;
  const verdict = committedNavigationVerdict({
    intendedUrl: watch.intendedUrl,
    openerUrl: watch.sourceUrl,
    finalUrl: url,
    matchRequest: (u, s, _type, group) => (group === 'threats' ? engine.matchMainFrame(u, s, 'threats') : engine.matchMainFrame(u, s)) !== null,
    nowMs: Date.now(),
    createdAt: watch.createdAt,
    viaLinkClick: watch.viaLinkClick === true,
    isInterstitialAd: looksLikeAdCampaignUrl,
  });
  if (!verdict.block) return false;
  popunderWatches.delete(contents.id);
  recordBlocked(verdict.type || 'Pop-up', url, contents.getURL());
  noticePopupBlocked(url, contents.getURL(), verdict.reason);
  logPopup({ source: safeHost(watch.sourceUrl), url, decision: 'deny', reason: verdict.reason, created: true, stage: 'first-navigation' });
  setTimeout(() => destroyTab(tabId), 50);
  return true;
}

// Redirect check for IMMEDIATE link tabs: the tab was published at once
// (the click was verified in the input pipeline), so its destination's
// redirects are checked as they happen — a redirect to a listed ad or a
// popunder-style domain jump closes the tab promptly (reject, not queue).
function checkImmediateNavigation(contents, url, tabId) {
  const watch = armedNavigationWatch(immediateOpenWatches, contents);
  if (!watch) return false;
  const verdict = committedNavigationVerdict({
    intendedUrl: watch.intendedUrl,
    openerUrl: watch.sourceUrl,
    finalUrl: url,
    matchRequest: (u, s, _type, group) => (group === 'threats' ? engine.matchMainFrame(u, s, 'threats') : engine.matchMainFrame(u, s)) !== null,
    nowMs: Date.now(),
    createdAt: watch.createdAt,
    viaLinkClick: watch.viaLinkClick === true,
    isInterstitialAd: looksLikeAdCampaignUrl,
  });
  if (!verdict.block) return false;
  immediateOpenWatches.delete(contents.id);
  recordBlocked(verdict.type || 'Pop-up', url, watch.sourceUrl);
  noticePopupBlocked(url, watch.sourceUrl, verdict.reason);
  logPopup({ source: safeHost(watch.sourceUrl), url, decision: 'deny', reason: verdict.reason, created: true, stage: 'first-navigation' });
  setTimeout(() => destroyTab(tabId), 50);
  return true;
}

function navigationLockFor(contents, url) {
  const lock = navigationLocks.get(contents.id);
  if (lock && lock.url === url && Date.now() - lock.at < 10000) return true;
  if (lock && (lock.url !== url || Date.now() - lock.at >= 10000)) navigationLocks.delete(contents.id);
  return false;
}

/**
 * Shared protection wiring for ANY browsing context in the app — the tab
 * views of the main window and the standalone "open in new window" windows.
 * The popup policy, navigation checks, download protection (session level),
 * cosmetics and document-start scripts are identical everywhere, so a link
 * opened in a secondary window gets exactly the same protection as a tab.
 *
 * @param {object} opts
 *   onIssue   report blocked/failed navigations to the main renderer (tabs
 *             have a placeholder to explain them; secondary windows do not)
 *   onMedia   route media fullscreen into the window state machine (only the
 *             main window's tabs drive fsCtl)
 *   onF11     F11 / Escape browser-fullscreen handling (main window tabs)
 *   onLayout  re-apply the main window layout after load (tabs)
 *   onTitle   (title) callback — publish the tab, or set the window title
 */
function wireBrowsingContents(contents, id, opts = {}) {
  const { onIssue = true, onMedia = true, onF11 = true, onLayout = true, onTitle = () => {} } = opts;

  contents.setWindowOpenHandler(details => {
    handleWindowOpen(details, contents).catch(console.warn);
    return { action: 'deny' };
  });
  // Defence in depth: if a browsing context ever materialises through a
  // pathway the handler does not cover (legacy new-window, a race), it is
  // destroyed before it can be shown.
  contents.on('did-create-window', (createdWindow) => {
    logPopup({ source: safeHost(contents.getURL()), url: createdWindow.webContents.getURL(), decision: 'deny', reason: 'did-create-window', created: false });
    try { createdWindow.close(); } catch { /* already gone */ }
  });
  contents.on('new-window', (event) => { event.preventDefault(); });

  // First-document commit ends the "loading card" phase: the view may
  // finally paint. (New tabs load hidden until this — a blank white doc
  // must never flash ahead of the card's own host + spinner.)
  contents.on('did-commit-navigation', () => releaseGate(contents.id, id, 'commit'));
  // A new navigation (retry, unblock-reload, user typing) ends the blocked /
  // failed card: let the document through again (hidden until it commits).
  // The layout must be re-applied HERE: clearing the hold-back without a
  // layout pass leaves the view in whatever visibility it had — the exact
  // "card vanished but the page never comes back" (or never left) defect.
  contents.on('did-start-navigation', () => {
    issueHidden.delete(id);
    if (onLayout) applyLayout();
    // Self-heal the document-start scripts (popup shield, YouTube shield,
    // double-click channel): a no-op fast path on a healthy tab; a re-attach
    // plus reinstall for a tab whose debugger was detached — otherwise one
    // transient attach failure left the tab feature-less for its life.
    if (typeof syncPageScripts === 'function') syncPageScripts(contents);
  });
  contents.on('did-navigate', () => {
    issueHidden.delete(id);
  });

  // ---------------------------------------------------------------- double-click (main side)
  // The isolated link world is the PRIMARY double-click route; this is the
  // fallback for when that world cannot run (repeated attach failure — the
  // very "works in tests, dead in the field" gap). It works from the OS-level
  // mouse events the main process observes anyway, and resolves the anchor
  // under the cursor through CDP (the same capability the popup state reads
  // already use).
  //
  // CRITICAL: this only arms when the in-page world is ABSENT (no
  // linkIdentifier). before-mouse-event fires in the input pipeline BEFORE
  // the click reaches the page, so an always-on fallback would win the race
  // against the in-page route and substitute cursor-coordinate +
  // elementFromPoint guesses for the in-page route's exact trusted-DOM
  // anchor. On a healthy tab the in-page route is strictly better, so stand
  // down; on a degraded tab it is the only route left. serveLinkDialog's
  // cooldown still dedupes any rare overlap.
  //
  // The second press only counts when the page did NOT navigate in between
  // (a same-frame link that already navigated is unrecoverable — the second
  // click sits on a different document); for target=_blank links the source
  // page keeps the anchor, so a real double still resolves.
  let lastMouseDown = null;
  contents.on('before-mouse-event', (_event, input) => {
    try {
      if (!input || input.type !== 'mouseDown' || input.button !== 'left') return;
      const entry = syncQueue.get(contents.id);
      if (entry && entry.linkIdentifier) { lastMouseDown = null; return; } // in-page route owns this tab
      const nowMs = Date.now();
      if (lastMouseDown &&
          nowMs - lastMouseDown.at < LINK_SECOND_CLICK_MS &&
          Math.abs(input.x - lastMouseDown.x) <= 12 && Math.abs(input.y - lastMouseDown.y) <= 12 &&
          contents.getURL() === lastMouseDown.url) {
        lastMouseDown = null;
        resolveDoubleClickedAnchor(contents, input.x, input.y).then(href => {
          // Re-check at resolve time: the world may have self-healed in the
          // meantime, in which case the in-page route is back in charge.
          const current = syncQueue.get(contents.id);
          if (current && current.linkIdentifier) return;
          if (href) serveLinkDialog({ url: href, sourceContentsId: contents.id, sourceTabId: tabIdOfContents(contents) });
        }).catch(() => { /* degraded */ });
      } else {
        lastMouseDown = { x: input.x, y: input.y, at: nowMs, url: contents.getURL() };
      }
    } catch { /* never break input */ }
  });

  // Interstitial fingerprint (rotating ad domains in NO list): a
  // JS/meta/redirect navigation INTO a campaign-shaped URL is the in-tab ad
  // takeover — the movie tab morphing into the "answer 2 quick questions"
  // page. Block it like a listed main frame so the tab explains itself.
  // (Address-bar / app navigations carry the user lock and never reach
  // this: an explicitly typed URL stays the user's choice.)
  const blockInterstitial = (event, url, logLabel) => {
    if (!looksLikeAdCampaignUrl(url)) return false;
    event.preventDefault();
    recordBlocked('Ad', url, contents.getURL());
    logPopup({ source: safeHost(contents.getURL()), url, decision: 'deny', reason: 'interstitial-ad', created: false, stage: logLabel });
    if (onIssue) {
      issueHidden.add(id);
      send('core:navigation-blocked', { id, url, type: 'Ad' });
      // The card must be ON SCREEN: hold the view back now, not at some
      // later, unrelated layout pass.
      if (onLayout) applyLayout();
    }
    return true;
  };

  contents.on('will-navigate', (event, url) => {
    try { browsingUrl(url); } catch { event.preventDefault(); return; }
    // Navigations we started (address bar, app logic) keep the user's intent;
    // renderer-initiated navigations are checked against the filters.
    if (navigationLockFor(contents, url)) return;
    lastRequested.set(contents.id, url);
    try {
      if (checkPopunderNavigation(contents, url, id)) { event.preventDefault(); return; }
      if (checkImmediateNavigation(contents, url, id)) { event.preventDefault(); return; }
      if (blockInterstitial(event, url, 'navigation')) return;
      const hit = engine.matchMainFrame(url, contents.getURL());
      if (hit && !isAllowedDomain(contents.getURL(), state.allowlist)) {
        event.preventDefault();
        recordBlocked(hit, url, contents.getURL());
        if (onIssue) {
          issueHidden.add(id);
          send('core:navigation-blocked', { id, url, type: hit });
          if (onLayout) applyLayout(); // the blocked card must be on screen now
        }
      }
    } catch (error) { console.warn('Navigation check failed:', error.message); }
  });

  contents.on('will-redirect', (event, url) => {
    try { browsingUrl(url); } catch { event.preventDefault(); return; }
    try {
      if (checkPopunderNavigation(contents, url, id)) { event.preventDefault(); return; }
      if (checkImmediateNavigation(contents, url, id)) { event.preventDefault(); return; }
      if (blockInterstitial(event, url, 'redirect')) return;
      const hit = engine.matchMainFrame(url, contents.getURL());
      if (hit && !isAllowedDomain(contents.getURL(), state.allowlist)) {
        event.preventDefault();
        recordBlocked(hit, url, contents.getURL());
        if (onIssue) {
          issueHidden.add(id);
          send('core:navigation-blocked', { id, url, type: hit });
          if (onLayout) applyLayout(); // the blocked card must be on screen now
        }
      }
    } catch (error) { console.warn('Redirect check failed:', error.message); }
  });

  // A page that never loads (DNS, offline, refused) leaves the tab on the
  // placeholder; report main-frame failures so the renderer can explain.
  // Sub-resource failures are ignored (their URL never matches lastRequested).
  contents.on('did-fail-load', (_event, errorCode, _errorDescription, validatedURL) => {
    if (errorCode === -3) return; // ERR_ABORTED: superseded or cancelled, not a failure
    if (validatedURL && lastRequested.get(contents.id) === validatedURL) {
      lastRequested.delete(contents.id);
      if (onIssue) {
        issueHidden.add(id);
        send('core:load-failed', { id, url: validatedURL });
        if (onLayout) applyLayout(); // the failed card must be on screen now
      }
    }
  });

  // A page can LOAD and then freeze: an ad-heavy site pins the renderer's
  // main thread and the tab paints the same frame forever (the field report
  // "it didn't respond" — cinelove.live reached its language dialog, then
  // nothing). Before this the tab had no recovery path at all: the view
  // stayed on screen, a reload queued behind the frozen JS, and the app UI
  // sat behind the opaque view. Surface the same card slot the blocked /
  // failed flow uses: hold the view back (issueHidden) and let the renderer
  // show a "stopped responding" card with Reload and Close.
  contents.on('unresponsive', () => {
    if (!onIssue) return;
    unresponsiveContents.add(contents.id);
    issueHidden.add(id);
    send('core:tab-unresponsive', { id, url: contents.getURL() });
    if (onLayout) applyLayout();
  });
  contents.on('responsive', () => {
    if (!onIssue) return;
    // The page thawed on its own: the view comes back and the card clears.
    if (!unresponsiveContents.delete(contents.id)) return;
    issueHidden.delete(id);
    send('core:tab-responsive', { id });
    if (onLayout) applyLayout();
  });
  contents.on('render-process-gone', (_event, details) => {
    if (!onIssue) return;
    if (suppressProcessGone.delete(contents.id)) {
      // Our own recovery crash (recoverFrozenRenderer): the retry's load is
      // already in flight and its commit clears the state. Not a page fault.
      unresponsiveContents.delete(contents.id);
      return;
    }
    const reason = details && details.reason;
    if (reason === 'clean-exit' || reason === 'killed') return; // expected teardown
    // The renderer is dead: 'responsive' will never come, and the card is
    // the only way back (Reload spawns a fresh renderer for the frame).
    unresponsiveContents.add(contents.id);
    issueHidden.add(id);
    send('core:tab-unresponsive', { id, url: contents.getURL(), crashed: true });
    if (onLayout) applyLayout();
  });

  if (onMedia) {
    // A background tab can't own media fullscreen: the user is looking at a
    // different tab, and maximising the window for a hidden video would be a
    // surprise. The active tab's real isFullscreen() is re-synced on focus.
    // NOTE: the enter event is forwarded for EVERY tab — the state machine
    // itself decides (background tabs are presented when focused). Guarding
    // on activeId here was a real bug: a stale activeId (focus IPC not yet
    // run) left the header visible during a video's fullscreen.
    contents.on('enter-html-full-screen', () => {
      if (contents.isDestroyed()) return;
      fsCtl.mediaEnter(id);
      armFullscreenReassert();
    });
    contents.on('leave-html-full-screen', () => {
      if (contents.isDestroyed()) return;
      const owned = fsCtl.mediaTabId === id;
      fsCtl.mediaLeave(id);
      // The browser fullscreen rides the media session: when the document
      // leaves media fullscreen (Esc, the player's exit control, or
      // navigating away) and the user had also taken the browser fullscreen,
      // release that too — the two enter and exit as one session, so a
      // stuck-fullscreen state cannot re-form. PAUSING the media is not one
      // of these exits: the fullscreen element persists through a pause, so
      // the session does too (the field contract).
      // "owned" matters: a hidden tab's video ending must not release the
      // user's browser fullscreen on the tab they are actually looking at.
      if (owned && fsCtl.userFullscreen) fsCtl.setUserFullscreen(false);
      // Keep the mid-session re-assertion only while a fullscreen session
      // still runs in this window.
      if (fsCtl.userFullscreen) armFullscreenReassert(); else disarmFullscreenReassert();
    });
    contents.on('did-navigate', () => {
      // A committed navigation to a different document tears down any media
      // fullscreen (the leave event usually follows, but it has been lost
      // in the field before) — reconcile the session explicitly on "back".
      if (fsCtl.mediaTabId === id) {
        fsCtl.mediaLeave(id);
        if (fsCtl.userFullscreen) fsCtl.setUserFullscreen(false);
      }
    });
  }

  // Input evidence for the popup policy and the fullscreen activity clock.
  // The two channels are different and both are needed:
  //   * before-mouse-event — fires in the browser's INPUT PIPELINE before a
  //     real mouse event is dispatched to the page. Every genuine click
  //     that can open a link necessarily passes through here, so it is an
  //     unspoofable, CDP-independent record of the gesture. A synthetic
  //     element.click() is generated inside the renderer and never passes
  //     through the browser's input pipeline — it leaves no trace here.
  //     (This is the split that tells a user's link click apart from an
  //     ad's scripted click-through.)
  //   * before-input-event — keyboard ONLY. The engine emits it solely
  //     from the keyboard dispatch path (verified against Electron's
  //     PreHandleKeyboardEvent); its `input.type` is keyDown/keyUp. The
  //     old handler's mouseDown/mouseWheel branches could never fire,
  //     which is why a real mouse click used to leave the main process
  //     blind: its popup evidence then depended on the isolated-world CDP
  //     read alone, and on ad-heavy pages that read fails — the user's
  //     genuine click was denied as "no-gesture" and links "refused to
  //     click".
  contents.on('before-mouse-event', (_event, mouse) => {
    if (onF11) fsCtl.activity(); // ANY mouse activity reveals the chrome (media fullscreen)
    engine.popupPolicy.observeInput(contents.id, mouse.type);
  });
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' || input.type === 'char') {
      if (onF11) fsCtl.activity(); // secondary windows do not drive the main window's chrome
      engine.popupPolicy.observeInput(contents.id, input.type);
    }
    if (onF11 && input.type === 'keyDown') {
      if (input.key === 'F11') fsCtl.userToggle();
      else if (input.key === 'Escape' && fsCtl.userFullscreen && !fsCtl.mediaActive) fsCtl.setUserFullscreen(false);
    }
  });

  contents.on('page-title-updated', () => {
    onTitle(contents.getTitle() || safeHost(contents.getURL() || 'https://example.com'));
    releaseGate(contents.id, id, 'title'); // a parsed title proves the document exists
  });
  contents.on('did-navigate', () => onTitle(contents.getTitle() || safeHost(contents.getURL() || 'https://example.com')));
  contents.on('did-navigate-in-page', () => onTitle(contents.getTitle() || safeHost(contents.getURL() || 'https://example.com')));
  contents.on('did-finish-load', () => {
    onTitle(contents.getTitle() || safeHost(contents.getURL() || 'https://example.com'));
    issueHidden.delete(id); // a finished load has no blocked/failed state
    // A committed document also ends any frozen/crashed state: the retry
    // landed (the card the store dismissed is confirmed stale — clear it).
    if (unresponsiveContents.delete(contents.id)) send('core:tab-responsive', { id });
    releaseGate(contents.id, id, 'finish');
    if (onLayout) applyLayout();
    engine.applyCosmetics(contents).catch(console.warn);
  });
  contents.on('destroyed', () => {
    engine.forget(contents.id);
    engine.popupPolicy.forget(contents.id);
    syncQueue.delete(contents.id);
    navigationLocks.delete(contents.id);
    lastRequested.delete(contents.id);
    popunderWatches.delete(contents.id);
    immediateOpenWatches.delete(contents.id);
    unresponsiveContents.delete(contents.id);
    suppressProcessGone.delete(contents.id);
  });
}

function makeTab(id) {
  const view = new WebContentsView({ webPreferences: { session: browsingSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false } });
  views.set(id, view);
  win.contentView.addChildView(view);
  const contents = view.webContents;
  lastBounds = null;
  wireBrowsingContents(contents, id, { onTitle: () => publishTab(id, contents) });
  syncPageScripts(contents);
  applyLayout();
  return view;
}

// ---------------------------------------------------------------------------
// Double-click link support (shared/link-support.js, isolated world
// "cc-links"). The page script suppresses the default action of a plain link
// click for 300 ms: a second click cancels it and opens the link-options
// dialog (so a double-click never navigates); otherwise it re-performs the
// navigation itself or hands it to the main process, where the FULL popup
// policy still applies (listed destinations, gesture checks, commit
// verification, downloads through the protected session pipeline).
// ---------------------------------------------------------------------------

const downloads = new Map(); // contents id -> { view, timer, settled } (hidden download carriers)
let linkDialogWin = null;

/** The main window's tab id that owns a given webContents, or null. */
function tabIdOfContents(contents) {
  for (const [id, view] of views) if (view.webContents === contents) return id;
  return null;
}

/** User-initiated navigation of a tab's main frame (address bar / dialog
 *  "Open link"). The lock keeps the will-navigate check from re-examining a
 *  navigation the user explicitly chose; the session request pipeline still
 *  protects the load, and a listed main frame surfaces the blocked state. */
function navigateContentsForUser(view, url) {
  const contents = view.webContents;
  if (contents.isDestroyed()) return;
  navigationLocks.set(contents.id, { url, at: Date.now() });
  lastRequested.set(contents.id, url);
  contents.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) console.warn('Navigation failed:', error.message); });
}

/** A "commit" from the page's link script: a real click on a real anchor,
 *  re-performed after the double-click window. `target`:
 *   blank    -> open a tab through the full popup policy (verification)
 *   top      -> navigate the tab's main frame (user-initiated)
 *   download -> download through the protected session pipeline */
async function handleLinkCommit(contents, payload) {
  if (contents.isDestroyed() || !payload || typeof payload !== 'object') return;
  let url;
  try { url = browsingUrl(payload.url); } catch { return; }
  const sourceUrl = contents.getURL();

  if (payload.target === 'download') {
    startHiddenDownload(url, sourceUrl);
    return;
  }
  if (payload.target === 'top') {
    const tabId = tabIdOfContents(contents);
    const view = tabId && views.get(tabId);
    if (view) navigateContentsForUser(view, url);
    return;
  }
  // target: 'blank' — the browser would have opened a new tab here (the
  // script no longer defers plain target=_blank clicks; this remains for
  // robustness and for media/download-shaped edges). Route it through the
  // SAME immediate path a native link open gets: a commit can only come
  // from the isolated link world reacting to a REAL (isTrusted) click, and
  // that click passed through the browser's input pipeline — the main
  // process observed it via before-mouse-event milliseconds ago.
  await handleLinkClickOpen({ url, sourceUrl, disposition: 'foreground-tab', contents, atMs: Date.now(), viaScriptCommit: true });
}

/** A page->main message from the isolated link world (verified by context id). */
function handleLinkMessage(contents, raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (contents.isDestroyed() || !payload || typeof payload !== 'object') return;
  if (payload.t === 'dialog') {
    let url;
    try { url = browsingUrl(payload.url); } catch { return; }
    const sourceTabId = tabIdOfContents(contents);
    // The fast (in-page) double-click route: same serve path as the
    // main-process dedup route — the cooldown dedupes the two.
    serveLinkDialog({
      url,
      sourceContentsId: contents.id,
      sourceTabId,
      text: payload.text,
      media: payload.media,
    });
  } else if (payload.t === 'commit') {
    handleLinkCommit(contents, payload);
  }
}

// ---------------------------------------------------------------------------
// The link-options dialog: a small frameless window that loads the app's own
// renderer in dialog mode (same design language, keyboard + Esc support),
// positioned at the double-click point.
// ---------------------------------------------------------------------------

function closeLinkDialog() {
  if (linkDialogWin && !linkDialogWin.isDestroyed()) {
    try { linkDialogWin.close(); } catch { /* already gone */ }
    // The options were consumed (or dismissed): the next double-click on
    // any link gets a fresh dialog, not the cooldown's silence.
    dialogCooldowns.clear();
  }
  linkDialogWin = null;
}

function openLinkDialog({ url, title, media = false, x, y, sourceTabId }) {
  if (!win || win.isDestroyed()) return;
  closeLinkDialog();
  const width = 340;
  const winBounds = win.getBounds();
  // Position near the double-click, clamped inside the window.
  const dx = Math.min(Math.max(x - winBounds.x - 24, 8), Math.max(8, winBounds.width - width - 8));
  const dy = Math.min(Math.max(y - winBounds.y - 16, 8), Math.max(8, winBounds.height - 300));
  linkDialogWin = new BrowserWindow({
    // `dialog` is not an Electron option; it is our marker (harmless if
    // ignored) used to find the dialog window in tests and window lists.
    dialog: true,
    width,
    height: 348,
    x: winBounds.x + dx,
    y: winBounds.y + dy,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    backgroundColor: '#f8f9fb',
    hasShadow: true,
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  });
  linkDialogWin.setAlwaysOnTop(true, 'screen-saver');
  linkDialogWin.setMenu(null);
  // The window is created hidden (show: false) to avoid a white flash: it
  // becomes visible only once its first frame is ready. Forgetting this
  // show() is the "double-click does nothing" defect — the dialog is built,
  // loads its page, and then simply never appears on screen.
  linkDialogWin.once('ready-to-show', () => {
    if (!linkDialogWin || linkDialogWin.isDestroyed()) return;
    linkDialogWin.show();
    linkDialogWin.focus();
  });
  // Leave on any focus loss: an outside click dismisses the dialog.
  linkDialogWin.on('blur', () => { if (linkDialogWin && !linkDialogWin.isDestroyed()) linkDialogWin.close(); });
  linkDialogWin.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && input.key === 'Escape' && linkDialogWin && !linkDialogWin.isDestroyed()) linkDialogWin.close();
  });
  linkDialogWin.webContents.on('did-finish-load', () => {
    if (!linkDialogWin || linkDialogWin.isDestroyed()) return;
    linkDialogWin.webContents.send('core:dialog-data', { url, title, media: media === true, sourceTabId: sourceTabId || null });
    linkDialogWin.webContents.focus();
  });
  linkDialogWin.on('closed', () => { linkDialogWin = null; });
  linkDialogWin.loadFile(path.join(__dirname, '../renderer/index.html'), { query: { linkDialog: '1' } });
}

/** "Open in new window": a standalone window for the link, sharing the
 *  browsing session and the exact same protection wiring as a tab. */
function openBrowsingWindow(url) {
  const w = new BrowserWindow({
    width: 1080,
    height: 720,
    minWidth: 640,
    minHeight: 480,
    title: safeHost(url),
    backgroundColor: '#ffffff',
    icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: { session: browsingSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false },
  });
  const contents = w.webContents;
  wireBrowsingContents(contents, `win-${contents.id}`, {
    onIssue: false,   // no renderer placeholder in a standalone window
    onMedia: false,   // its own OS window; no main-window state machine
    onF11: false,     // the main window owns F11/Escape fullscreen
    onLayout: false,
    onTitle: title => { if (title) w.setTitle(title); },
  });
  syncPageScripts(contents);
  navigationLocks.set(contents.id, { url, at: Date.now() });
  lastRequested.set(contents.id, url);
  w.once('ready-to-show', () => w.show());
  w.on('closed', () => { /* state cleanup happens on the contents 'destroyed' */ });
  contents.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) console.warn('Navigation failed:', error.message); });
  return w;
}

/** Download a URL through the app's protected pipeline: a hidden, never
 *  painted WebContentsView navigates to it; the session's will-download
 *  handler (ad/threat checks + save dialog) does the rest. The carrier is
 *  destroyed as soon as the download starts, the load fails, or the URL
 *  turns out to be a page. */
function startHiddenDownload(url, sourceUrl) {
  if (!win || win.isDestroyed()) return;
  const view = new WebContentsView({ webPreferences: { session: browsingSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false } });
  const contents = view.webContents;
  const record = { view, settled: false, timer: setTimeout(() => settleDownload(contents, record), 15000) };
  downloads.set(contents.id, record);
  view.setVisible(false); // never painted, ever
  view.setBounds({ x: -1, y: -1, width: 0, height: 0 });
  win.contentView.addChildView(view);
  contents.setWindowOpenHandler(details => {
    logPopup({ source: safeHost(sourceUrl), url: details.url, disposition: details.disposition || 'default', decision: 'deny', reason: 'download-escape', created: false });
    return { action: 'deny' };
  });
  // will-download is a SESSION event; the session handler settles the
  // carrier as soon as the download is handed to the save pipeline (it
  // checks the carrier set). What settles here is load failure...
  contents.on('did-fail-load', (_event, code) => {
    if (code === -3) return; // aborted (listed download cancelled) — the session handler already settled it
    settleDownload(contents, record);
  });
  contents.on('did-navigate', (_event, navUrl) => {
    // It loaded as a page, not a file: nothing to download, settle quietly.
    try { if (!new URL(navUrl).pathname.match(/\.(mp4|webm|ogv|ogg|mov|mkv|m4v|avi|mp3|m4a|aac|flac|wav|opus)$/i)) settleDownload(contents, record); } catch { /* keep waiting */ }
  });
  contents.on('destroyed', () => settleDownload(contents, record));
  contents.loadURL(url).catch(() => settleDownload(contents, record));
}

function settleDownload(contents, record) {
  if (!record || record.settled) return;
  record.settled = true;
  if (record.timer) clearTimeout(record.timer);
  downloads.delete(contents.id);
  try { if (win && !win.isDestroyed() && record.view && win.contentView.children.includes(record.view)) win.contentView.removeChildView(record.view); } catch { /* already gone */ }
  try { contents.close(); } catch { /* already closing */ }
}

// ---------------------------------------------------------------------------
// Document-start scripts via the DevTools protocol: the popup support on every
// page, the link support on every page, the YouTube shield where it applies.
// A stuck command must never block browsing, so every step is guarded and the
// script is simply re-queued.
// ---------------------------------------------------------------------------

const popupSupportSource = (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', 'shared', 'popup-support.js'), 'utf8'); } catch { return ''; }
})();
const linkSupportSource = (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', 'shared', 'link-support.js'), 'utf8'); } catch { return ''; }
})();
// Isolated JavaScript world for the popup support script (see shared/popup-support.js).
const POPUP_WORLD = 'cc-popup';
// Isolated world for the link support (double-click options) script.
const LINK_WORLD = 'cc-links';
// Page -> main channel: the link script console.logs MAGIC + JSON in its
// isolated world; the main process verifies the execution context id, so the
// page's own world can forge none of these messages.
const LINK_MAGIC = '%CC-LINK% ';
const syncQueue = new Map();

function withTimeout(promise, label, ms = 4000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** CDP events for one contents: isolated-world bookkeeping (the link world's
 *  context ids — the page->main channel's anti-spoofing check) and the link
 *  messages themselves. Registered once per attach. */
function handleCdpMessage(contents, entry, method, params) {
  try {
    if (method === 'Runtime.executionContextCreated' && params && params.context && params.context.name === LINK_WORLD) {
      entry.linkContextIds.add(params.context.id);
      return;
    }
    if (method === 'Runtime.executionContextDestroyed') {
      entry.linkContextIds.delete(params.executionContextId);
      return;
    }
    if (method === 'Runtime.consoleAPICalled') {
      const arg = params && params.args && params.args[0];
      if (!arg || arg.type !== 'string' || typeof arg.value !== 'string') return;
      if (!arg.value.startsWith(LINK_MAGIC)) return;
      // Only the isolated link world may use this channel; the page's own
      // console (a different context) cannot forge link messages.
      if (!entry.linkContextIds.has(params.executionContextId)) return;
      handleLinkMessage(contents, arg.value.slice(LINK_MAGIC.length));
    }
  } catch (error) { console.warn('Link message error:', error.message); }
}

/** Attach can fail transiently (DevTools holding the debugger, a restarting
 *  renderer, a first-byte race). One failed attach used to leave the tab
 *  degraded for its whole life — popup shield, YouTube shield and the
 *  double-click channel all gone, silently. Retry with backoff, bounded; a
 *  permanently lost debugger degrades to the pre-feature behaviour without
 *  hammering the log. Per-navigation sync (see did-start-navigation) keeps
 *  trying anyway. */
function schedulePageScriptHeal(contents, entry) {
  if (entry.healTimer) return;
  entry.healAttempts = (entry.healAttempts || 0) + 1;
  if (entry.healAttempts > 10) return;
  const delay = entry.healAttempts <= 3 ? 1000 : 5000;
  entry.healTimer = setTimeout(() => {
    entry.healTimer = null;
    if (!contents.isDestroyed()) syncPageScripts(contents);
  }, delay);
}

/** Re-learn the cc-links isolated world's execution contexts for the
 *  CURRENT document, per frame. The context id is the anti-spoofing key of
 *  the link->main channel; it is normally learned from
 *  executionContextCreated, but after a re-attach that event has already
 *  fired for the existing world — without this explicit resolution the
 *  channel stays closed (every double-click dropped as "untrusted
 *  context") until the next document loads. */
function refreshLinkContexts(contents, entry) {
  (async () => {
    try {
      const cdp = contents.debugger;
      if (!cdp.isAttached() || contents.isDestroyed()) return;
      const tree = await withTimeout(cdp.sendCommand('Page.getFrameTree'), 'frame tree', 1500);
      const frameIds = [];
      (function walk(node, depth) {
        if (!node || depth > 40 || frameIds.length >= 40) return;
        if (node.frame && node.frame.id) frameIds.push(node.frame.id);
        for (const child of node.childFrames || []) walk(child, depth + 1);
      })(tree.frameTree, 0);
      await Promise.all(frameIds.map(async frameId => {
        try {
          const context = await withTimeout(cdp.sendCommand('Runtime.getIsolatedContext', { frameId, worldName: LINK_WORLD }), 'link world', 1500);
          const contextId = context && (context.contextId || context.executionContextId);
          if (contextId) entry.linkContextIds.add(contextId);
        } catch { /* the frame has no link world yet (about:blank, mid-load) */ }
      }));
    } catch { /* degraded: the event path still works for new documents */ }
  })();
}

/** The http(s) anchor under (x, y) in the page (input coordinates are DIP;
 *  the page's CSS pixels differ by the zoom factor), or null. Used by the
 *  main-process double-click fallback (see before-mouse-event in
 *  wireBrowsingContents). */
async function resolveDoubleClickedAnchor(contents, x, y) {
  const entry = syncQueue.get(contents.id);
  if (!entry || !contents.debugger.isAttached() || contents.isDestroyed()) return null;
  const cdp = contents.debugger;
  const zoom = (typeof contents.getZoomFactor === 'function') ? (contents.getZoomFactor() || 1) : 1;
  const expr = "(() => { const px = " + JSON.stringify(Number((x / zoom).toFixed(2))) + ", py = " + JSON.stringify(Number((y / zoom).toFixed(2))) +
    "; let n = document.elementFromPoint(px, py);" +
    " while (n && n.nodeType === 1 && !(n.tagName === 'A' && n.href)) n = n.parentElement;" +
    " if (!n || n.tagName !== 'A' || !n.href) return null;" +
    " const u = new URL(n.href, location.href);" +
    " if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;" +
    " return u.href; })()";
  const result = await withTimeout(cdp.sendCommand('Runtime.evaluate', { expression: expr, returnByValue: true }), 'double-click anchor', 2000);
  const href = result && result.result && result.result.value;
  return typeof href === 'string' && href ? href : null;
}

function syncPageScripts(contents) {
  const id = contents.id;
  const entry = syncQueue.get(id) || { identifier: null, popupIdentifier: null, linkIdentifier: null, listening: false, cdpListening: false, linkContextIds: new Set(), queue: Promise.resolve(), healAttempts: 0, healTimer: null };
  syncQueue.set(id, entry);
  entry.queue = entry.queue.then(async () => {
    if (contents.isDestroyed()) return;
    // A brand-new tab has no page yet, so give it a blank one before talking to it.
    if (!contents.getURL() && !contents.isLoading()) await contents.loadURL('about:blank').catch(() => {});
    if (contents.isDestroyed()) return;
    const cdp = contents.debugger;
    const { protection } = state;
    const wantPopup = protection.enabled && protection.popups && popupSupportSource;
    const wantShield = protection.enabled && protection.youtube;
    const wantLink = !!linkSupportSource; // a UX feature: on regardless of protection
    if (cdp.isAttached()) {
      // Fast path: everything we want is already installed. This is also
      // the self-heal path: called on every navigation (see
      // did-start-navigation), it re-attaches a tab whose debugger was
      // detached (DevTools opened, renderer restarted) instead of leaving
      // the tab feature-less for its whole life.
      const installed = (!wantPopup || entry.popupIdentifier) && (!wantShield || entry.identifier) && (!wantLink || entry.linkIdentifier);
      if (installed) { refreshLinkContexts(contents, entry); return; }
    } else {
      try {
        cdp.attach('1.3');
        entry.healAttempts = 0;
        entry.identifier = null;
        entry.popupIdentifier = null;
        entry.linkIdentifier = null;
        if (!entry.cdpListening) {
          entry.cdpListening = true;
          cdp.on('message', (method, params) => handleCdpMessage(contents, entry, method, params));
          cdp.on('detach', () => {
            entry.identifier = null;
            entry.popupIdentifier = null;
            entry.linkIdentifier = null;
            entry.linkContextIds.clear();
            schedulePageScriptHeal(contents, entry);
          });
        }
        await withTimeout(cdp.sendCommand('Page.enable'), 'Page.enable');
        // Runtime events deliver the link world's console channel and its
        // execution-context bookkeeping.
        await withTimeout(cdp.sendCommand('Runtime.enable'), 'Runtime.enable').catch(() => {});
        // The current document's link world (if the document predates this
        // attach) already exists — resolve its context explicitly.
        refreshLinkContexts(contents, entry);
      } catch (error) {
        console.warn('Page scripts unavailable:', error.message);
        schedulePageScriptHeal(contents, entry);
        return;
      }
    }
    if (entry.popupIdentifier) {
      await withTimeout(cdp.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.popupIdentifier }), 'remove popup support').catch(() => {});
      entry.popupIdentifier = null;
    }
    if (entry.identifier) {
      await withTimeout(cdp.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.identifier }), 'remove shield').catch(() => {});
      entry.identifier = null;
    }
    if (entry.linkIdentifier) {
      await withTimeout(cdp.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.linkIdentifier }), 'remove link support').catch(() => {});
      entry.linkIdentifier = null;
    }
    if (wantPopup) {
      try {
        const result = await withTimeout(cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: popupSupportSource, worldName: POPUP_WORLD }), 'install popup support');
        entry.popupIdentifier = result.identifier;
      } catch (error) { console.warn('Popup support could not be installed:', error.message); }
    }
    if (wantLink) {
      try {
        const result = await withTimeout(cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: linkSupportSource, worldName: LINK_WORLD }), 'install link support');
        entry.linkIdentifier = result.identifier;
      } catch (error) { console.warn('Link support could not be installed:', error.message); }
    }
    if (wantShield) {
      try {
        const result = await withTimeout(cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: buildShieldScript(state.allowlist) }), 'install shield');
        entry.identifier = result.identifier;
      } catch (error) { console.warn('YouTube shield could not be installed:', error.message); }
    }
  }).catch(error => console.warn('Page script error:', error.message));
  return entry.queue;
}

async function refreshPageScripts() {
  await Promise.all([...views.values()].map(view => syncPageScripts(view.webContents)));
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function trusted(event, extraSender = null) {
  if (!win) throw new Error('Untrusted IPC sender');
  // The link-options dialog is a separate window running our own renderer:
  // its sender is verified by id (it never loads untrusted content).
  if (extraSender && !extraSender.isDestroyed() && event.sender.id === extraSender.id) return;
  if (event.sender.id !== win.webContents.id || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}

function registerIPC() {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => { trusted(event); return callback(...args); });
  handle('core:navigate', async (id, input, seq) => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid tab');
    const url = browsingUrl(input);
    // A fresh user navigation (navSeq advanced) reloads even when the url
    // string is unchanged — that is the "Try again" retry after a failed
    // load, the one that used to die silently. A re-focus of an
    // already-loaded tab (no seq, or the same seq) keeps the old guard.
    const freshNav = typeof seq === 'number' && seq > (lastNavSeq.get(id) ?? -1);
    if (typeof seq === 'number') lastNavSeq.set(id, seq);
    // A user navigation SUPERSEDES any earlier blocked/failed/frozen state
    // for this tab: the renderer cleared its card when it issued this
    // navigation, so the main side must release the view immediately —
    // holding it back (issueHidden) is what left the tab on blank space
    // between "the card went away" and "the new document commits".
    issueHidden.delete(id);
    const view = views.get(id) || makeTab(id);
    // User-initiated navigation: the content shows live (no loading card).
    // This covers the address bar, the home page, quick links, and the
    // materialising tab of an admitted link click. The view may have been
    // created hidden by the gate (first document not committed yet) — with
    // a live tab the gate no longer applies, so re-run the layout now.
    liveTabs.add(id);
    applyLayout();
    // Remember which tab a verified popup became (repeat rule: the earlier
    // popup's tab is closed when its page repeats), and arm the popunder
    // fallback watch for tabs whose commit verification timed out.
    const pending = verifiedPopupOpens.find(item => item.url === url && Date.now() - item.at < 10000);
    if (pending) {
      verifiedPopupOpens.splice(verifiedPopupOpens.indexOf(pending), 1);
      if (pending.watch) {
        popunderWatches.set(view.webContents.id, { intendedUrl: pending.url, sourceUrl: pending.sourceUrl, createdAt: pending.at, viaLinkClick: pending.viaLinkClick === true });
        // The watch covers the redirect chain up to the first commit; a
        // clean commit disarms it (a later user navigation is not a popup).
        view.webContents.once('did-commit-navigation', () => popunderWatches.delete(view.webContents.id));
      }
      popupTabByOpenUrl.set(url, id);
    }
    // An IMMEDIATE link open (published at the click, before its tab
    // existed): the tab materialising here is that open. Arm the
    // redirect-to-ad check on its first navigations and remember the tab
    // so a double-click (or a close) can find it.
    const immediate = pendingImmediateOpens.find(item => item.url === url && Date.now() - item.at < 10000);
    if (immediate) {
      pendingImmediateOpens.splice(pendingImmediateOpens.indexOf(immediate), 1);
      immediateOpenWatches.set(view.webContents.id, { intendedUrl: immediate.url, sourceUrl: immediate.sourceUrl, createdAt: immediate.at, viaLinkClick: true });
      // The watch covers the redirect chain up to the first commit; after
      // that the destination is what it is (and listed hosts were already
      // rejected at click time or die in the request pipeline).
      view.webContents.once('did-commit-navigation', () => immediateOpenWatches.delete(view.webContents.id));
      immediateTabByOpenUrl.set(url, { tabId: id, sourceContentsId: immediate.sourceContentsId, sourceTabId: immediate.sourceTabId, at: immediate.at });
    }
    // Make sure the document-start scripts are in place before the page loads.
    // Bounded: a stuck DevTools session must never hold up browsing — the
    // worst case is that this one document misses the document-start scripts
    // (the next navigation gets them).
    const syncEntry = syncQueue.get(view.webContents.id);
    if (syncEntry) await Promise.race([syncEntry.queue.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
    // Let the filter lists finish their initial build (bounded: the bundled
    // baseline is already active, so a slow network never stalls browsing).
    await Promise.race([engine.ready, new Promise(resolve => setTimeout(resolve, 4000))]);
    // A fresh user navigation (freshNav) reloads even when the url string is
    // unchanged — that is the "Try again" retry after a failed load, which
    // used to die here because getURL() already equaled the failed url. A
    // re-focus of an already-loaded tab (no new seq) keeps the old guard so
    // switching tabs never reloads the page.
    const contents = view.webContents;
    if (contents.isDestroyed()) return;
    // Compare against the url the tab is TRYING TO REACH (lastRequested),
    // not the last committed document: while a load is in flight
    // getURL() still reports the old page, and treating that as
    // "already at the target" is what let a freshly typed address be
    // dropped behind a slow in-flight load ("nothing happens"). A typed
    // url that differs from the target always loads — it interrupts the
    // in-flight load (ERR_ABORTED, swallowed below).
    const currentTarget = lastRequested.get(contents.id) || contents.getURL();
    const shouldLoad = freshNav || currentTarget !== url;
    if (shouldLoad) {
      recoverFrozenRenderer(contents); // typing a new address into a frozen tab must not queue behind the dead JS either
      navigationLocks.set(contents.id, { url, at: Date.now() });
      lastRequested.set(contents.id, url);
      try { await contents.loadURL(url); }
      catch (error) { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) console.warn('Navigation failed:', error.message); }
    }
  });
  handle('core:focus', (id, external) => {
    try {
      activeId = id;
      showExternal = external === true;
      const contents = views.get(id)?.webContents;
      const mediaIsFullscreen = !!(contents && !contents.isDestroyed() && contents.isFullscreen());
      // The state machine is best-effort here: a fault in it must NEVER
      // reject this invoke — the renderer used to chain the navigation
      // behind the focus promise, and a rejected focus was the whole
      // "tab never navigates, spinner forever" defect.
      try {
        fsCtl.tabFocused(id, { mediaIsFullscreen });
        fsCtl.tick({ windowFocused: win?.isFocused() ?? false, showingExternal: showExternal, cursorMoved: false });
      } catch (error) { console.warn('Fullscreen state fault during focus:', error.message); }
    } finally {
      // A tab switch must never be lost: even if anything above threw,
      // the right view comes on screen.
      try { applyLayout(); } catch (error) { console.warn('Layout fault during focus:', error.message); }
      // Keyboard focus: the page view takes it only when the chrome UI
      // (address bar, popovers) does not already own it. Unconditional
      // focus() here is what stole typing away from the address bar —
      // every renderer focusTab (tab switch, popover change, navigation)
      // yanked the keyboard back into the page.
      const view = views.get(id);
      if (view && !view.webContents.isDestroyed()) {
        try {
          const chromeOwnsFocus = !!(win && !win.isDestroyed() && win.webContents.isFocused());
          if (!chromeOwnsFocus) view.webContents.focus();
        } catch { /* transitional */ }
      }
    }
  });
  handle('core:close', id => destroyTab(id));
  handle('core:tab-action', (id, action) => {
    const contents = views.get(id)?.webContents;
    if (!contents) return;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === 'reload') {
      issueHidden.delete(id); // a retry dismisses the blocked/failed card (the view stays hidden until the retry commits)
      recoverFrozenRenderer(contents); // the frozen tab's "Reload page": a plain reload() would queue behind the dead JS
      navigationLocks.set(contents.id, { url: contents.getURL(), at: Date.now() });
      lastRequested.set(contents.id, contents.getURL());
      if (contents.isCrashed()) {
        // A crashed renderer does not honour reload() — the request dies
        // with the process and the tab sits on the frozen frame forever.
        // loadURL() spawns the fresh renderer and lands the navigation.
        contents.loadURL(contents.getURL()).catch(error => {
          if (error.code !== 'ERR_ABORTED' && error.errno !== -3) console.warn('Reload failed:', error.message);
        });
      } else {
        contents.reload();
      }
    }
  });
  handle('core:protection', async input => {
    for (const key of Object.keys(defaults.protection)) if (typeof input?.[key] === 'boolean') state.protection[key] = input[key];
    persist();
    await Promise.all([engine.refreshCosmetics([...views.values()]), refreshPageScripts()]);
  });
  handle('core:allowlist', async input => {
    if (!Array.isArray(input) || input.length > 1000) throw new Error('Invalid allowlist');
    state.allowlist = input.filter(domain => typeof domain === 'string' && /^[a-z0-9.-]+$/i.test(domain) && domain.includes('.')).map(domain => domain.toLowerCase());
    persist();
    await Promise.all([engine.refreshCosmetics([...views.values()]), refreshPageScripts()]);
  });
  handle('core:filters', async input => {
    if (!Array.isArray(input) || input.length > 100) throw new Error('Invalid filters');
    state.filters = input.filter(item => item && typeof item.id === 'string' && trustedFilterUrl(item.url)).map(item => ({ id: item.id.slice(0, 100), url: item.url, enabled: item.enabled === true, updated: typeof item.updated === 'string' ? item.updated : '' }));
    persist();
    await engine.rebuild(state.filters);
    await engine.refreshCosmetics([...views.values()]);
  });
  handle('core:stats', () => state.stats);
  handle('core:engine-status', () => engine.status());
  handle('core:privacy', enabled => { if (typeof enabled === 'boolean') { state.doNotTrack = enabled; persist(); } });
  handle('core:clear-data', () => { state.stats = structuredClone(defaults.stats); persist(); send('core:stats-update', state.stats); });
  // The link-options dialog (a separate window running our own renderer).
  ipcMain.handle('core:dialog', (event, action, payload) => {
    if (!linkDialogWin || linkDialogWin.isDestroyed()) return;
    trusted(event, linkDialogWin.webContents);
    const p = payload && typeof payload === 'object' ? payload : {};
    let linkUrl = '';
    try { linkUrl = typeof p.url === 'string' ? browsingUrl(p.url) : ''; } catch { /* not a browsable URL */ }
    if (action === 'close') { closeLinkDialog(); return; }
    if (!linkUrl) return;
    if (action === 'open-link') {
      closeLinkDialog();
      const view = typeof p.sourceTabId === 'string' ? views.get(p.sourceTabId) : null;
      if (view) navigateContentsForUser(view, linkUrl);
      else send('core:open-tab', { url: linkUrl, title: safeHost(linkUrl) }); // the source tab closed meanwhile
      return;
    }
    if (action === 'open-tab') {
      closeLinkDialog();
      send('core:open-tab', { url: linkUrl, title: safeHost(linkUrl) });
      return;
    }
    if (action === 'open-window') {
      closeLinkDialog();
      openBrowsingWindow(linkUrl);
      return;
    }
    if (action === 'copy') {
      try { clipboard.writeText(linkUrl); } catch { /* clipboard unavailable */ }
      closeLinkDialog();
      send('core:toast', { text: 'Link address copied.', tone: 'success' });
      return;
    }
    if (action === 'download') {
      closeLinkDialog();
      startHiddenDownload(linkUrl, '');
      return;
    }
  });
  ipcMain.on('core:window', (event, action) => {
    trusted(event);
    if (action === 'close') win.close();
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
    if (action === 'fullscreen') fsCtl.userToggle();
  });
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 1000, minWidth: 850, minHeight: 620, frame: false, show: false, backgroundColor: '#f8f9fb', title: 'ChromiumCore', icon: path.join(__dirname, '../assets/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  // The application renderer is first-party UI (the New Tab quick links,
  // bookmarks): its opens are user actions on our own surface and are
  // published directly. Privileged schemes still never leave it.
  win.webContents.setWindowOpenHandler(details => {
    try {
      const url = browsingUrl(details.url);
      logPopup({ source: 'app-ui', url, disposition: details.disposition || 'default', decision: 'allow', reason: 'app-ui', created: true });
      send('core:open-tab', { url, title: new URL(url).hostname });
    } catch {
      logPopup({ source: 'app-ui', url: details.url, decision: 'deny', reason: 'scheme', created: false });
    }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('did-create-window', (createdWindow) => {
    logPopup({ source: 'app-ui', url: createdWindow.webContents.getURL(), decision: 'deny', reason: 'did-create-window', created: false });
    try { createdWindow.close(); } catch { /* already gone */ }
  });
  win.webContents.on('new-window', (event) => { event.preventDefault(); });
  // before-input-event is keyboard-only in Electron (see the
  // wireBrowsingContents note); mouse activity arrives via
  // before-mouse-event. Both feed the fullscreen activity clock.
  win.webContents.on('before-mouse-event', () => fsCtl.activity());
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' || input.type === 'char') fsCtl.activity();
    if (input.type === 'keyDown') {
      if (input.key === 'F11') fsCtl.userToggle();
      else if (input.key === 'Escape' && fsCtl.userFullscreen && !fsCtl.mediaActive) fsCtl.setUserFullscreen(false);
    }
  });
  win.on('resize', () => { applyLayout(); measureChromeHeight(); });
  win.on('enter-full-screen', () => { clearInterval(fullscreenVerifyTimer); fsCtl.windowFullscreenChanged(true); settleLayout(); });
  win.on('leave-full-screen', () => {
    clearInterval(fullscreenVerifyTimer);
    fsCtl.windowFullscreenChanged(false);
    // An intentional exit cleared userFullscreen BEFORE this event (the
    // toggle / setUserFullscreen ran first, effect sink drove the OS). If
    // the controller still wants fullscreen, the drop was stray (taskbar
    // click, Win+Down race, OS glitch) — the contract is that the window
    // stays in fullscreen through mouse activity and pauses; only a
    // deliberate exit or the media leaving ends it. Put it back now; the
    // 1 s re-assertion timer is the backstop for later glitches.
    if (win && !win.isDestroyed() && fsCtl.userFullscreen && !win.isFullScreen()) {
      console.warn('[fullscreen] stray OS drop mid-session; re-asserting immediately');
      win.setFullScreen(true);
      verifyWindowFullscreen(true);
    }
    settleLayout();
  });
  win.on('focus', () => fsCtl.focusWindow());
  win.on('blur', () => fsCtl.blurWindow());
  win.on('closed', () => {
    for (const view of views.values()) if (!view.webContents.isDestroyed()) { try { view.webContents.close(); } catch { /* ignore */ } }
    views.clear();
    for (const record of inspectors.values()) { if (record.timer) clearTimeout(record.timer); try { record.view.webContents.close(); } catch { /* ignore */ } }
    inspectors.clear();
    for (const record of downloads.values()) settleDownload(record.view.webContents, record);
    downloads.clear();
    closeLinkDialog();
    // No stale idle ticks for a closed window (the interval must never outlive
    // the window it drives; createWindow clears it again before re-arming).
    clearInterval(chromeIdleTimer);
    clearInterval(fullscreenVerifyTimer);
    fsCtl.activeTabId = null;
    fsCtl.userFullscreen = false;
    fsCtl.mediaTabId = null;
    fsCtl.chromeVisible = true;
    activeId = null;
    showExternal = false;
    win = null;
  });
  win.once('ready-to-show', () => {
    win.show();
    const [width, height] = win.getContentSize();
    fsCtl.resize(width, height);
    applyLayout();
    measureChromeHeight();
    // The renderer starts at {media:false, window:false}; tell it the real
    // state immediately so the fullscreen button never lags the window.
    lastFullscreenPayload = null;
    syncFullscreenState();
  });
  win.webContents.on('did-finish-load', measureChromeHeight);
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  clearInterval(chromeIdleTimer);
  chromeIdleTimer = setInterval(() => {
    if (!win || win.isDestroyed()) return;
    let cursorMoved = false;
    try {
      const point = screen.getCursorScreenPoint();
      const rect = win.getBounds();
      const inside = point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
      if (inside && lastCursorPoint && (point.x !== lastCursorPoint.x || point.y !== lastCursorPoint.y)) cursorMoved = true;
      lastCursorPoint = point;
    } catch {
      lastCursorPoint = null; // headless or display-less environment
    }
    fsCtl.tick({ windowFocused: win.isFocused(), showingExternal: showExternal, cursorMoved });
  }, 250);
}

app.setName('ChromiumCore');
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  storePath = path.join(app.getPath('userData'), 'workspace.json');
  try {
    const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    state = { ...defaults, ...saved, protection: { ...defaults.protection, ...saved.protection }, stats: { ...defaults.stats, ...saved.stats } };
  } catch { /* First launch uses the defaults. */ }
  browsingSession = session.fromPartition('persist:chromiumcore-browsing');
  // Permissions: deny what ads and trackers abuse (notifications, camera /
  // microphone, geolocation, device capture) but ALLOW the benign,
  // user-gesture-gated permissions the web relies on. Denying 'fullscreen'
  // is what broke video players: YouTube's own fullscreen button calls
  // requestFullscreen(), which rejects when the permission is refused.
  const allowedPermissions = new Set([
    'fullscreen',            // video players (YouTube & friends)
    'pointerLock',           // first-person video / map panning
    'storage-access',        // Storage Access API (legit web apps)
    'clipboard-sanitized-write', // copy operations on the web
    'web-share',             // navigator.share (native share sheet)
    'speaking',              // speech synthesis
    'mediaKeySystem',        // EME/DRM so high-quality streams work
  ]);
  browsingSession.setPermissionRequestHandler((_contents, permission, callback) => callback(allowedPermissions.has(permission)));
  browsingSession.setPermissionCheckHandler((_contents, permission) => allowedPermissions.has(permission));
  browsingSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (state.doNotTrack) requestHeaders.DNT = '1';
    else delete requestHeaders.DNT;
    callback({ requestHeaders });
  });
  browsingSession.on('will-download', (event, item) => {
    // A hidden download carrier (the double-click "Download attached media"
    // action) is only a request vehicle: once the download is handed to the
    // save pipeline, tear the carrier down immediately.
    try {
      const sender = event && event.sender;
      if (sender && downloads.has(sender.id)) settleDownload(sender, downloads.get(sender.id));
    } catch { /* never block the download itself */ }
    try {
      const url = item.getURL();
      const hit = engine.matchMainFrame(url, '');
      if (hit) {
        // Adware pattern: an "download" that is actually an ad/threat domain.
        const source = event && event.sender && !event.sender.isDestroyed() ? event.sender.getURL() : '';
        recordBlocked(hit, url, source || url);
        logPopup({ source: source || 'unknown', url, decision: 'deny', reason: 'listed-download', created: false });
        if (typeof item.cancel === 'function') item.cancel(); else event.preventDefault();
        return;
      }
    } catch { /* fall through: a broken check must not eat real downloads */ }
    item.setSaveDialogOptions({ title: 'Save your download', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) });
  });
  engine = createProtectionEngine({
    browsingSession,
    cacheDir: path.join(app.getPath('userData'), 'filters'),
    getSettings: () => state,
    recordBlocked,
    isInterstitialAd: looksLikeAdCampaignUrl,
    onMainframeBlocked: (webContentsId, url, type) => {
      // The page will never load — tell the renderer so the tab shows why
      // instead of sitting on a placeholder that reads like a prompt. The
      // layout pass is what puts the card on screen: without it the old
      // (or blank) page view stays painted over the card.
      for (const [id, view] of views) if (view.webContents.id === webContentsId) { issueHidden.add(id); send('core:navigation-blocked', { id, url, type }); applyLayout(); break; }
      // A commit inspector's main frame was cancelled: the open dies here,
      // before any chip exists — surface it as a blocked popup.
      if (inspectors.has(webContentsId)) noticePopupBlocked(url, inspectors.get(webContentsId).sourceUrl, 'listed-destination');
    },
  });
  // The bundled baseline is already active; this upgrades it to the full
  // fetched lists (or settles to the baseline when none are requested).
  engine.rebuild(state.filters).catch(console.warn);
  registerIPC();
  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  // Display size / orientation / DPI changed (monitor plug, rotation): re-derive
  // the geometry so fullscreen and windowed modes stay on the real display.
  screen.on('display-metrics-changed', () => {
    if (!win || win.isDestroyed()) return;
    lastBounds = null;
    const [width, height] = win.getContentSize();
    fsCtl.resize(width, height);
    settleLayout();
  });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  clearTimeout(persistTimer); clearTimeout(broadcastTimer); clearInterval(chromeIdleTimer); clearInterval(settleTimer); clearInterval(fullscreenVerifyTimer); disarmFullscreenReassert();
  if (storePath) { try { fs.writeFileSync(storePath, JSON.stringify(state)); } catch (error) { console.warn('Could not save workspace:', error.message); } }
});
