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

const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, screen } = require('electron');
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
const POPUP_STATE_EXPR = '(function () { var s = window.__ccPopupState; if (!s) return null; return { age: s.t ? Date.now() - s.t : 999999999, open: s.lastOpen && Date.now() - s.lastOpen.t < 3000 ? s.lastOpen : null, click: s.lastClick && Date.now() - s.lastClick.t < 3000 ? s.lastClick : null }; })()';

async function readPagePopupState(contents) {
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
    let ageMs = null;
    let open = null;
    let click = null;
    for (const value of reads) {
      if (!value) continue;
      if (typeof value.age === 'number' && (ageMs === null || value.age < ageMs)) ageMs = value.age;
      if (value.open && (!open || value.open.t > open.t)) open = value.open;
      if (value.click && (!click || value.click.t > click.t)) click = value.click;
    }
    if (ageMs === null && !open && !click) return null;
    return { ageMs: ageMs === null ? 999999999 : ageMs, open, click };
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
  const pageState = await readPagePopupState(contents);
  if (contents.isDestroyed()) return;
  const decision = engine.popupPolicy.classifyWindowOpen({
    url,
    sourceUrl,
    disposition,
    tabCount: views.size,
    pageState,
    contentsId: contents.id,
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
  if (!decision.needsCommit) {
    logPopup({ source: safeHost(sourceUrl), url, disposition, frame, decision: 'allow', reason: decision.reason, created: true });
    send('core:open-tab', { url, title: safeHost(url) });
    return;
  }
  logPopup({ source: safeHost(sourceUrl), url, disposition, frame, decision: 'verify', reason: decision.reason, created: false });
  startCommitVerification({ url, sourceUrl });
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

function startCommitVerification({ url, sourceUrl }) {
  if (!win || win.isDestroyed()) return;
  const view = new WebContentsView({ webPreferences: { session: browsingSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false } });
  const contents = view.webContents;
  const record = { url, sourceUrl, view, openedAt: Date.now(), committed: false, settled: false, timer: null };
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
    verifiedPopupOpens.push({ url: outcome.url, sourceUrl: record.sourceUrl, at: Date.now(), watch: outcome.watch === true });
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

// First-navigation inspection for script-opened tabs whose commit
// verification could not finish in time (popunder fallback watch).
const popunderWatches = new Map(); // contents id -> { intendedUrl, sourceUrl, createdAt }

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

function makeTab(id) {
  const view = new WebContentsView({ webPreferences: { session: browsingSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false } });
  views.set(id, view);
  win.contentView.addChildView(view);
  const contents = view.webContents;
  lastBounds = null;

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
        send('core:navigation-blocked', { id, url, type: hit });
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
        send('core:navigation-blocked', { id, url, type: hit });
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
      send('core:load-failed', { id, url: validatedURL });
    }
  });

  // A background tab can't own media fullscreen: the user is looking at a
  // different tab, and maximising the window for a hidden video would be a
  // surprise. The active tab's real isFullscreen() is re-synced on focus.
  contents.on('enter-html-full-screen', () => { if (!contents.isDestroyed() && activeId === id) fsCtl.mediaEnter(id); });
  contents.on('leave-html-full-screen', () => { if (!contents.isDestroyed()) fsCtl.mediaLeave(id); });

  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' || input.type === 'char' || input.type === 'mouseDown' || input.type === 'mouseWheel') {
      fsCtl.activity();
      engine.popupPolicy.observeInput(contents.id, input.type);
    }
    if (input.type === 'keyDown') {
      if (input.key === 'F11') fsCtl.userToggle();
      else if (input.key === 'Escape' && fsCtl.userFullscreen && !fsCtl.mediaActive) fsCtl.setUserFullscreen(false);
    }
  });

  contents.on('page-title-updated', () => publishTab(id, contents));
  contents.on('did-navigate', () => publishTab(id, contents));
  contents.on('did-navigate-in-page', () => publishTab(id, contents));
  contents.on('did-finish-load', () => { publishTab(id, contents); applyLayout(); engine.applyCosmetics(contents).catch(console.warn); });
  contents.on('destroyed', () => {
    engine.forget(contents.id);
    engine.popupPolicy.forget(contents.id);
    syncQueue.delete(contents.id);
    navigationLocks.delete(contents.id);
    lastRequested.delete(contents.id);
    popunderWatches.delete(contents.id);
  });

  syncPageScripts(contents);
  applyLayout();
  return view;
}

// ---------------------------------------------------------------------------
// Document-start scripts via the DevTools protocol: the popup support on every
// page, the YouTube shield where it applies. A stuck command must never block
// browsing, so every step is guarded and the script is simply re-queued.
// ---------------------------------------------------------------------------

const popupSupportSource = (() => {
  try { return fs.readFileSync(path.join(__dirname, '..', 'shared', 'popup-support.js'), 'utf8'); } catch { return ''; }
})();
// Isolated JavaScript world for the popup support script (see shared/popup-support.js).
const POPUP_WORLD = 'cc-popup';
const syncQueue = new Map();

function withTimeout(promise, label, ms = 4000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function syncPageScripts(contents) {
  const id = contents.id;
  const entry = syncQueue.get(id) || { identifier: null, popupIdentifier: null, listening: false, queue: Promise.resolve() };
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
        if (!entry.listening) {
          entry.listening = true;
          cdp.on('detach', () => { entry.identifier = null; entry.popupIdentifier = null; });
        }
        await withTimeout(cdp.sendCommand('Page.enable'), 'Page.enable');
      } catch (error) { console.warn('Page scripts unavailable:', error.message); return; }
    }
    const { protection } = state;
    const wantPopup = protection.enabled && protection.popups && popupSupportSource;
    const wantShield = protection.enabled && protection.youtube;
    if (entry.popupIdentifier) {
      await withTimeout(cdp.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.popupIdentifier }), 'remove popup support').catch(() => {});
      entry.popupIdentifier = null;
    }
    if (entry.identifier) {
      await withTimeout(cdp.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.identifier }), 'remove shield').catch(() => {});
      entry.identifier = null;
    }
    if (wantPopup) {
      try {
        const result = await withTimeout(cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: popupSupportSource, worldName: POPUP_WORLD }), 'install popup support');
        entry.popupIdentifier = result.identifier;
      } catch (error) { console.warn('Popup support could not be installed:', error.message); }
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

function trusted(event) {
  if (!win || event.sender.id !== win.webContents.id || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted IPC sender');
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
      if (pending.watch) popunderWatches.set(view.webContents.id, { intendedUrl: pending.url, sourceUrl: pending.sourceUrl, createdAt: pending.at });
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
