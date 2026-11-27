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
const { buildShieldScript } = require('./youtube-shield.cjs');
const { committedNavigationVerdict, pickAttribution } = require('./popup-blocker.cjs');

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
const navigationLocks = new Map();
// The URL each tab's main frame is currently trying to reach, so a
// did-fail-load for a sub-resource is never reported as a failed page.
const lastRequested = new Map();
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
  // never a frame where two views are visible at once.
  for (const [id, view] of views) if (view !== activeView) view.setVisible(false);
  for (const [id, view] of views) {
    if (view !== activeView) continue;
    view.setBounds(bounds);
    view.setVisible(true);
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
    // the button, Escape handling and media fullscreen all agree again.
    console.warn('[fullscreen] transition stuck; reconciling state to actual', { expected, actual });
    fsCtl.windowFullscreenChanged(actual);
    if (fsCtl.userFullscreen !== actual) fsCtl.setUserFullscreen(actual);
    syncFullscreenState();
  }, 200);
}

fsCtl.onEffect(effect => {
  if (!win || win.isDestroyed()) return;
  if (effect.type === 'window-fullscreen' && win.isFullScreen() !== effect.value) {
    // Browser (user) fullscreen only — media never comes through here.
    win.setFullScreen(effect.value);
    settleLayout();
    verifyWindowFullscreen(effect.value);
  }
  if (effect.type === 'window-maximize') {
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
  popunderWatches.delete(contents.id);
  for (const [openUrl, tabId] of popupTabByOpenUrl) if (tabId === id) popupTabByOpenUrl.delete(openUrl);
  win.contentView.removeChildView(view);
  views.delete(id);
  try { contents.close(); } catch { /* already closing */ }
  applyLayout();
}

// The activation clock and the per-frame window.open records live in the
// isolated "cc-popup" world; the page's own world cannot touch them. The
// open is classified as coming from whichever frame recorded the freshest
// window.open call — that is how an ad *iframe* is distinguished from the
// top page. A failed read degrades to the main-process input observation
// (see popup-blocker.classifyWindowOpen), which still requires a real,
// recent gesture.
// The isolated world reports RAW timestamps (same machine clock as the main
// process). The ages are computed HERE, against the moment the open was
// requested — never against the moment this read finishes. That read is an
// asynchronous DevTools round trip that can take a second or more on
// ad-heavy pages (dozens of frames, like fmhy.net); computing ages against
// "now" is what starved a fresh user click of its 1.5 s gesture window and
// made ordinary links "refuse to click".
const POPUP_STATE_EXPR = '(function () { var s = window.__ccPopupState; if (!s) return null; return { t: s.t || 0, open: s.lastOpen && Date.now() - s.lastOpen.t < 3000 ? s.lastOpen : null, click: s.lastClick && Date.now() - s.lastClick.t < 3000 ? s.lastClick : null }; })()';

async function readPagePopupState(contents, atMs) {
  const entry = syncQueue.get(contents.id);
  if (!entry || contents.isDestroyed() || !contents.debugger.isAttached()) return null;
  const cdp = contents.debugger;
  try {
    const tree = await withTimeout(cdp.sendCommand('Page.getFrameTree'), 'frame tree', 1500);
    const frameIds = [];
    (function walk(node, depth) {
      if (!node || depth > 40 || frameIds.length >= 40) return;
      if (node.frame && node.frame.id) frameIds.push(node.frame.id);
      for (const child of node.childFrames || []) walk(child, depth + 1);
    })(tree.frameTree, 0);
    if (!frameIds.length) return null;
    const reads = await withTimeout(Promise.all(frameIds.map(async frameId => {
      try {
        const context = await cdp.sendCommand('Runtime.getIsolatedContext', { frameId, worldName: POPUP_WORLD });
        const result = await cdp.sendCommand('Runtime.evaluate', { expression: POPUP_STATE_EXPR, contextId: context.contextId, returnByValue: true });
        return (result && result.result && result.result.value) || null;
      } catch { return null; }
    })), 'popup state', 2500);
    let lastActivityAt = 0;
    let open = null;
    let click = null;
    for (const value of reads) {
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

// The app converts every window.open into a managed tab, so the native
// window is always denied here; the allow/block decision happens around it.
// An *allowed* open is not shown yet: it is verified in a hidden inspector
// first (startCommitVerification), so an ad — directly, via redirect or via
// a domain jump — can never become a visible tab or window.
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
  const isLinkClick = disposition === 'foreground-tab';
  if (!decision.needsCommit) {
    logPopup({ source: safeHost(sourceUrl), url, disposition, frame, decision: 'allow', reason: decision.reason, created: true });
    send('core:open-tab', { url, title: safeHost(url) });
    return;
  }
  logPopup({ source: safeHost(sourceUrl), url, disposition, frame, decision: 'verify', reason: decision.reason, created: false });
  startCommitVerification({ url, sourceUrl, viaLinkClick: isLinkClick });
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
  const view = new WebContentsView({ webPreferences: { session: browsingSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false } });
  const contents = view.webContents;
  const record = { url, sourceUrl, view, openedAt: Date.now(), committed: false, settled: false, timer: null, viaLinkClick: viaLinkClick === true };
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
    verifiedPopupOpens.push({ url: outcome.url, sourceUrl: record.sourceUrl, at: Date.now(), watch: outcome.watch === true, viaLinkClick: record.viaLinkClick });
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

function checkPopunderNavigation(contents, url, tabId) {
  const watch = popunderWatches.get(contents.id);
  if (!watch) return false;
  popunderWatches.delete(contents.id);
  const verdict = committedNavigationVerdict({
    intendedUrl: watch.intendedUrl,
    openerUrl: watch.sourceUrl,
    finalUrl: url,
    matchRequest: (u, s, _type, group) => (group === 'threats' ? engine.matchMainFrame(u, s, 'threats') : engine.matchMainFrame(u, s)) !== null,
    nowMs: Date.now(),
    createdAt: watch.createdAt,
    viaLinkClick: watch.viaLinkClick === true,
  });
  if (!verdict.block) return false;
  recordBlocked(verdict.type || 'Pop-up', url, contents.getURL());
  noticePopupBlocked(url, contents.getURL(), verdict.reason);
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

  contents.on('will-navigate', (event, url) => {
    try { browsingUrl(url); } catch { event.preventDefault(); return; }
    // Navigations we started (address bar, app logic) keep the user's intent;
    // renderer-initiated navigations are checked against the filters.
    if (navigationLockFor(contents, url)) return;
    lastRequested.set(contents.id, url);
    try {
      if (checkPopunderNavigation(contents, url, id)) { event.preventDefault(); return; }
      const hit = engine.matchMainFrame(url, contents.getURL());
      if (hit && !isAllowedDomain(contents.getURL(), state.allowlist)) {
        event.preventDefault();
        recordBlocked(hit, url, contents.getURL());
        if (onIssue) send('core:navigation-blocked', { id, url, type: hit });
      }
    } catch (error) { console.warn('Navigation check failed:', error.message); }
  });

  contents.on('will-redirect', (event, url) => {
    try { browsingUrl(url); } catch { event.preventDefault(); return; }
    try {
      if (checkPopunderNavigation(contents, url, id)) { event.preventDefault(); return; }
      const hit = engine.matchMainFrame(url, contents.getURL());
      if (hit && !isAllowedDomain(contents.getURL(), state.allowlist)) {
        event.preventDefault();
        recordBlocked(hit, url, contents.getURL());
        if (onIssue) send('core:navigation-blocked', { id, url, type: hit });
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
      if (onIssue) send('core:load-failed', { id, url: validatedURL });
    }
  });

  if (onMedia) {
    // A background tab can't own media fullscreen: the user is looking at a
    // different tab, and maximising the window for a hidden video would be a
    // surprise. The active tab's real isFullscreen() is re-synced on focus.
    // NOTE: the enter event is forwarded for EVERY tab — the state machine
    // itself decides (background tabs are presented when focused). Guarding
    // on activeId here was a real bug: a stale activeId (focus IPC not yet
    // run) left the header visible during a video's fullscreen.
    contents.on('enter-html-full-screen', () => { if (!contents.isDestroyed()) fsCtl.mediaEnter(id); });
    contents.on('leave-html-full-screen', () => { if (!contents.isDestroyed()) fsCtl.mediaLeave(id); });
  }

  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' || input.type === 'char' || input.type === 'mouseDown' || input.type === 'mouseWheel') {
      if (onF11) fsCtl.activity(); // secondary windows do not drive the main window's chrome
      engine.popupPolicy.observeInput(contents.id, input.type);
    }
    if (onF11 && input.type === 'keyDown') {
      if (input.key === 'F11') fsCtl.userToggle();
      else if (input.key === 'Escape' && fsCtl.userFullscreen && !fsCtl.mediaActive) fsCtl.setUserFullscreen(false);
    }
  });

  contents.on('page-title-updated', () => onTitle(contents.getTitle() || safeHost(contents.getURL() || 'https://example.com')));
  contents.on('did-navigate', () => onTitle(contents.getTitle() || safeHost(contents.getURL() || 'https://example.com')));
  contents.on('did-navigate-in-page', () => onTitle(contents.getTitle() || safeHost(contents.getURL() || 'https://example.com')));
  contents.on('did-finish-load', () => {
    onTitle(contents.getTitle() || safeHost(contents.getURL() || 'https://example.com'));
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
function handleLinkCommit(contents, payload) {
  if (contents.isDestroyed() || !payload || typeof payload !== 'object') return;
  let url;
  try { url = browsingUrl(payload.url); } catch { return; }
  const sourceUrl = contents.getURL();
  const isTop = payload.isTop !== false;
  const crossOrigin = payload.crossOrigin === true;

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
  // target: 'blank' — the browser would have opened a new tab here. Route it
  // through the same policy a native open gets: a real click on a real anchor
  // means a fresh gesture (the mouseDown was observed milliseconds ago) and
  // an href-matched click attribution.
  const atMs = Date.now();
  const pageState = {
    ageMs: 999999999, // the main-process input observation is the gesture source here
    open: null,
    click: { t: atMs, isTop: isTop, crossOrigin, frameHost: '', topHost: '', href: url },
  };
  const decision = engine.popupPolicy.classifyWindowOpen({
    url,
    sourceUrl,
    disposition: 'foreground-tab',
    tabCount: views.size,
    pageState,
    contentsId: contents.id,
    atMs,
  });
  if (!decision.allowed) {
    logPopup({ source: safeHost(sourceUrl), url, disposition: 'foreground-tab', frame: { isTop, crossOrigin, via: 'link-commit' }, decision: 'deny', reason: decision.reason, created: false });
    recordBlocked('Pop-up', url, sourceUrl);
    noticePopupBlocked(url, sourceUrl, decision.reason);
    if (decision.earlierUrl) closeEarlierPopupTab(decision.earlierUrl);
    return;
  }
  if (!decision.needsCommit) {
    logPopup({ source: safeHost(sourceUrl), url, disposition: 'foreground-tab', frame: { isTop, crossOrigin, via: 'link-commit' }, decision: 'allow', reason: decision.reason, created: true });
    send('core:open-tab', { url, title: safeHost(url) });
    return;
  }
  logPopup({ source: safeHost(sourceUrl), url, disposition: 'foreground-tab', frame: { isTop, crossOrigin, via: 'link-commit' }, decision: 'verify', reason: decision.reason, created: false });
  startCommitVerification({ url, sourceUrl, viaLinkClick: true });
}

/** A page->main message from the isolated link world (verified by context id). */
function handleLinkMessage(contents, raw) {
  let payload;
  try { payload = JSON.parse(raw); } catch { return; }
  if (contents.isDestroyed() || !payload || typeof payload !== 'object') return;
  if (payload.t === 'dialog') {
    let url;
    try { url = browsingUrl(payload.url); } catch { return; }
    let point = { x: 0, y: 0 };
    try { point = screen.getCursorScreenPoint(); } catch { /* headless */ }
    openLinkDialog({
      url,
      title: typeof payload.text === 'string' ? payload.text : '',
      media: payload.media === true,
      x: point.x,
      y: point.y,
      sourceTabId: tabIdOfContents(contents),
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

function syncPageScripts(contents) {
  const id = contents.id;
  const entry = syncQueue.get(id) || { identifier: null, popupIdentifier: null, linkIdentifier: null, listening: false, cdpListening: false, linkContextIds: new Set(), queue: Promise.resolve() };
  syncQueue.set(id, entry);
  entry.queue = entry.queue.then(async () => {
    if (contents.isDestroyed()) return;
    // A brand-new tab has no page yet, so give it a blank one before talking to it.
    if (!contents.getURL() && !contents.isLoading()) await contents.loadURL('about:blank').catch(() => {});
    if (contents.isDestroyed()) return;
    const cdp = contents.debugger;
    if (!cdp.isAttached()) {
      try {
        cdp.attach('1.3');
        entry.identifier = null;
        entry.popupIdentifier = null;
        entry.linkIdentifier = null;
        if (!entry.cdpListening) {
          entry.cdpListening = true;
          cdp.on('message', (method, params) => handleCdpMessage(contents, entry, method, params));
          cdp.on('detach', () => { entry.identifier = null; entry.popupIdentifier = null; entry.linkIdentifier = null; entry.linkContextIds.clear(); });
        }
        await withTimeout(cdp.sendCommand('Page.enable'), 'Page.enable');
        // Runtime events deliver the link world's console channel and its
        // execution-context bookkeeping.
        await withTimeout(cdp.sendCommand('Runtime.enable'), 'Runtime.enable').catch(() => {});
      } catch (error) { console.warn('Page scripts unavailable:', error.message); return; }
    }
    const { protection } = state;
    const wantPopup = protection.enabled && protection.popups && popupSupportSource;
    const wantShield = protection.enabled && protection.youtube;
    const wantLink = !!linkSupportSource; // a UX feature: on regardless of protection
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
  handle('core:navigate', async (id, input) => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid tab');
    const url = browsingUrl(input);
    const view = views.get(id) || makeTab(id);
    // Remember which tab a verified popup became (repeat rule: the earlier
    // popup's tab is closed when its page repeats), and arm the popunder
    // fallback watch for tabs whose commit verification timed out.
    const pending = verifiedPopupOpens.find(item => item.url === url && Date.now() - item.at < 10000);
    if (pending) {
      verifiedPopupOpens.splice(verifiedPopupOpens.indexOf(pending), 1);
      if (pending.watch) popunderWatches.set(view.webContents.id, { intendedUrl: pending.url, sourceUrl: pending.sourceUrl, createdAt: pending.at, viaLinkClick: pending.viaLinkClick === true });
      popupTabByOpenUrl.set(url, id);
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
    if (view.webContents.getURL() !== url && !view.webContents.isLoadingMainFrame()) {
      navigationLocks.set(view.webContents.id, { url, at: Date.now() });
      lastRequested.set(view.webContents.id, url);
      try { await view.webContents.loadURL(url); }
      catch (error) { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) console.warn('Navigation failed:', error.message); }
    }
  });
  handle('core:focus', (id, external) => {
    try {
      activeId = id;
      showExternal = external === true;
      const contents = views.get(id)?.webContents;
      const mediaIsFullscreen = !!(contents && !contents.isDestroyed() && contents.isFullscreen());
      fsCtl.tabFocused(id, { mediaIsFullscreen });
      fsCtl.tick({ windowFocused: win?.isFocused() ?? false, showingExternal: showExternal, cursorMoved: false });
    } finally {
      // A tab switch must never be lost: even if the state machine throws,
      // the right view comes on screen and takes keyboard focus.
      applyLayout();
      const view = views.get(id);
      if (view && !view.webContents.isDestroyed()) { try { view.webContents.focus(); } catch { /* transitional */ } }
    }
  });
  handle('core:close', id => destroyTab(id));
  handle('core:tab-action', (id, action) => {
    const contents = views.get(id)?.webContents;
    if (!contents) return;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === 'reload') {
      navigationLocks.set(contents.id, { url: contents.getURL(), at: Date.now() });
      contents.reload();
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
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' || input.type === 'char' || input.type === 'mouseDown' || input.type === 'mouseWheel') fsCtl.activity();
    if (input.type === 'keyDown') {
      if (input.key === 'F11') fsCtl.userToggle();
      else if (input.key === 'Escape' && fsCtl.userFullscreen && !fsCtl.mediaActive) fsCtl.setUserFullscreen(false);
    }
  });
  win.on('resize', () => { applyLayout(); measureChromeHeight(); });
  win.on('enter-full-screen', () => { clearInterval(fullscreenVerifyTimer); fsCtl.windowFullscreenChanged(true); settleLayout(); });
  win.on('leave-full-screen', () => { clearInterval(fullscreenVerifyTimer); fsCtl.windowFullscreenChanged(false); settleLayout(); });
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
    onMainframeBlocked: (webContentsId, url, type) => {
      // The page will never load — tell the renderer so the tab shows why
      // instead of sitting on a placeholder that reads like a prompt.
      for (const [id, view] of views) if (view.webContents.id === webContentsId) { send('core:navigation-blocked', { id, url, type }); break; }
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
  clearTimeout(persistTimer); clearTimeout(broadcastTimer); clearInterval(chromeIdleTimer); clearInterval(settleTimer); clearInterval(fullscreenVerifyTimer);
  if (storePath) { try { fs.writeFileSync(storePath, JSON.stringify(state)); } catch (error) { console.warn('Could not save workspace:', error.message); } }
});
