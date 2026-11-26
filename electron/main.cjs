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
const views = new Map();
const navigationLocks = new Map();
const pendingPopupOpens = [];
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
function noticePopupBlocked(url, sourceUrl) {
  const nowMs = Date.now();
  if (nowMs - lastPopupNoticeAt < 5000) return;
  lastPopupNoticeAt = nowMs;
  send('core:popup-blocked', { url, source: safeHost(sourceUrl || url) });
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
  for (const [id, view] of views) {
    view.setVisible(showExternal && activeId === id);
  }
  const signature = `${width}x${viewHeight}@${top}`;
  if (signature !== lastBounds) {
    lastBounds = signature;
    for (const view of views.values()) view.setBounds({ x: 0, y: top, width, height: viewHeight });
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

fsCtl.onEffect(effect => {
  if (!win || win.isDestroyed()) return;
  if (effect.type === 'window-fullscreen' && win.isFullScreen() !== effect.value) {
    win.setFullScreen(effect.value);
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
  win.contentView.removeChildView(view);
  views.delete(id);
  try { contents.close(); } catch { /* already closing */ }
  applyLayout();
}

// The activation clock lives in the isolated "cc-popup" world; the page's own
// world cannot touch it. A failed read degrades to the main-process input
// observation (see popup-blocker.classifyWindowOpen).
async function readPagePopupState(contents) {
  const entry = syncQueue.get(contents.id);
  if (!entry || contents.isDestroyed() || !contents.debugger.isAttached()) return null;
  const cdp = contents.debugger;
  try {
    const tree = await withTimeout(cdp.sendCommand('Page.getFrameTree'), 'frame tree', 1500);
    const frameId = tree.frameTree.frame.id;
    const context = await withTimeout(cdp.sendCommand('Runtime.getIsolatedContext', { frameId, worldName: POPUP_WORLD }), 'popup context', 1500);
    const result = await withTimeout(cdp.sendCommand('Runtime.evaluate', {
      expression: '(function () { var s = window.__ccPopupState; return s ? (s.t ? Date.now() - s.t : 999999999) : null; })()',
      contextId: context.contextId,
      returnByValue: true,
    }), 'popup state', 1500);
    const age = result && result.result ? result.result.value : null;
    return typeof age === 'number' ? { ageMs: age } : null;
  } catch {
    return null;
  }
}

// The app converts every window.open into a managed tab, so the native
// window is always denied here; the allow/block decision happens around it.
async function handleWindowOpen(details, contents) {
  let url;
  try { url = browsingUrl(details.url); } catch { /* privileged schemes never open tabs */ return; }
  if (contents.isDestroyed()) return;
  const sourceUrl = contents.getURL();
  const decision = engine.popupPolicy.classifyWindowOpen({
    url,
    sourceUrl,
    disposition: details.disposition || 'default',
    tabCount: views.size,
    pageState: await readPagePopupState(contents),
    contentsId: contents.id,
  });
  if (!decision.allowed) {
    recordBlocked('Pop-up', url, sourceUrl);
    noticePopupBlocked(url, sourceUrl);
    return;
  }
  if (decision.needsWatch) {
    pendingPopupOpens.push({ url, sourceUrl, at: Date.now() });
    if (pendingPopupOpens.length > 50) pendingPopupOpens.splice(0, pendingPopupOpens.length - 50);
  }
  send('core:open-tab', { url, title: safeHost(url) });
}

// First-navigation inspection for allowed script-opened tabs (popunders).
function checkPopunderNavigation(contents, url, tabId) {
  const verdict = engine.popupPolicy.checkFirstNavigation(contents.id, url);
  if (!verdict.block) return false;
  recordBlocked(verdict.type || 'Pop-up', url, contents.getURL());
  noticePopupBlocked(url, contents.getURL());
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

  contents.on('will-navigate', (event, url) => {
    try { browsingUrl(url); } catch { event.preventDefault(); return; }
    // Navigations we started (address bar, app logic) keep the user's intent;
    // renderer-initiated navigations are checked against the filters.
    if (navigationLockFor(contents, url)) return;
    try {
      if (checkPopunderNavigation(contents, url, id)) { event.preventDefault(); return; }
      const hit = engine.matchMainFrame(url, contents.getURL());
      if (hit && !isAllowedDomain(contents.getURL(), state.allowlist)) {
        event.preventDefault();
        recordBlocked(hit, url, contents.getURL());
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
      }
    } catch (error) { console.warn('Redirect check failed:', error.message); }
  });

  contents.on('enter-html-full-screen', () => { if (!contents.isDestroyed()) fsCtl.mediaEnter(id); });
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
  contents.on('did-finish-load', () => { publishTab(id, contents); engine.applyCosmetics(contents).catch(console.warn); });
  contents.on('destroyed', () => {
    engine.forget(contents.id);
    engine.popupPolicy.forget(contents.id);
    syncQueue.delete(contents.id);
    navigationLocks.delete(contents.id);
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
    // Arm the popunder watch for tabs that a script just opened.
    const pending = pendingPopupOpens.find(item => item.url === url && Date.now() - item.at < 10000);
    if (pending) {
      pendingPopupOpens.splice(pendingPopupOpens.indexOf(pending), 1);
      engine.popupPolicy.registerPopup(view.webContents.id, pending);
    }
    // Make sure the document-start scripts are in place before the page loads.
    const syncEntry = syncQueue.get(view.webContents.id);
    if (syncEntry) await syncEntry.queue.catch(() => {});
    // Let the filter lists finish their initial build (bounded: the bundled
    // baseline is already active, so a slow network never stalls browsing).
    await Promise.race([engine.ready, new Promise(resolve => setTimeout(resolve, 4000))]);
    if (view.webContents.getURL() !== url && !view.webContents.isLoadingMainFrame()) {
      navigationLocks.set(view.webContents.id, { url, at: Date.now() });
      try { await view.webContents.loadURL(url); }
      catch (error) { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) console.warn('Navigation failed:', error.message); }
    }
  });
  handle('core:focus', (id, external) => {
    activeId = id;
    showExternal = external === true;
    const contents = views.get(id)?.webContents;
    const mediaIsFullscreen = !!(contents && !contents.isDestroyed() && contents.isFullscreen());
    fsCtl.tabFocused(id, { mediaIsFullscreen });
    fsCtl.tick({ windowFocused: win?.isFocused() ?? false, showingExternal: showExternal, cursorMoved: false });
    applyLayout();
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
  win.webContents.setWindowOpenHandler(details => {
    try { const url = browsingUrl(details.url); send('core:open-tab', { url, title: new URL(url).hostname }); }
    catch { /* Privileged schemes never leave the application renderer. */ }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' || input.type === 'char' || input.type === 'mouseDown' || input.type === 'mouseWheel') fsCtl.activity();
    if (input.type === 'keyDown') {
      if (input.key === 'F11') fsCtl.userToggle();
      else if (input.key === 'Escape' && fsCtl.userFullscreen && !fsCtl.mediaActive) fsCtl.setUserFullscreen(false);
    }
  });
  win.on('resize', () => { applyLayout(); measureChromeHeight(); });
  win.on('enter-full-screen', () => { fsCtl.windowFullscreenChanged(true); settleLayout(); });
  win.on('leave-full-screen', () => { fsCtl.windowFullscreenChanged(false); settleLayout(); });
  win.on('focus', () => fsCtl.focusWindow());
  win.on('blur', () => fsCtl.blurWindow());
  win.on('closed', () => {
    for (const view of views.values()) if (!view.webContents.isDestroyed()) { try { view.webContents.close(); } catch { /* ignore */ } }
    views.clear();
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
  browsingSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  browsingSession.setPermissionCheckHandler(() => false);
  browsingSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = { ...details.requestHeaders };
    if (state.doNotTrack) requestHeaders.DNT = '1';
    else delete requestHeaders.DNT;
    callback({ requestHeaders });
  });
  browsingSession.on('will-download', (_event, item) => item.setSaveDialogOptions({ title: 'Save your download', defaultPath: path.join(app.getPath('downloads'), path.basename(item.getFilename())) }));
  engine = createProtectionEngine({
    browsingSession,
    cacheDir: path.join(app.getPath('userData'), 'filters'),
    getSettings: () => state,
    recordBlocked,
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
  clearTimeout(persistTimer); clearTimeout(broadcastTimer); clearInterval(chromeIdleTimer); clearInterval(settleTimer);
  if (storePath) { try { fs.writeFileSync(storePath, JSON.stringify(state)); } catch (error) { console.warn('Could not save workspace:', error.message); } }
});
