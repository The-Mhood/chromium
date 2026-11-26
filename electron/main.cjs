const { app, BrowserWindow, WebContentsView, ipcMain, session, Menu, screen } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { createProtectionEngine } = require('./protection.cjs');
const { browsingUrl, isAllowedDomain, trustedFilterUrl } = require('./security.cjs');
const { buildShieldScript } = require('./youtube-shield.cjs');

let win;
let engine;
let browsingSession;
let activeId;
let showExternal = false;
let htmlFullscreen = false;
let chromeVisible = true;
let lastActivityAt = Date.now();
let lastCursorPoint = null;
let chromeIdleTimer;
let persistTimer;
let broadcastTimer;
const views = new Map();
const defaults = {
  protection: { enabled: true, network: true, tracking: true, cosmetic: true, popups: true, youtube: true },
  allowlist: [], filters: [], doNotTrack: true, stats: { ads: 0, trackers: 0, popups: 0, threats: 0, events: [] },
};
let state = structuredClone(defaults);
let storePath;

function persist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const temp = `${storePath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state));
    fs.renameSync(temp, storePath);
  }, 1200);
}

function send(channel, payload) { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); }
function recordBlocked(type, url, sourceUrl) {
  const fields = { Ad: 'ads', Tracker: 'trackers', 'Pop-up': 'popups', Threat: 'threats' };
  state.stats[fields[type]]++;
  let domain = 'Unknown website';
  try { domain = new URL(sourceUrl || url).hostname.replace(/^www\./, ''); } catch { /* The tab may be closing. */ }
  let request = url;
  try { const parsed = new URL(url); request = `${parsed.hostname}${parsed.pathname}`; } catch { /* Keep the supplied request. */ }
  state.stats.events.unshift({ id: crypto.randomUUID(), domain, request, type, time: new Date().toISOString() });
  state.stats.events = state.stats.events.slice(0, 1000);
  persist();
  if (!broadcastTimer) broadcastTimer = setTimeout(() => { broadcastTimer = null; send('core:stats-update', state.stats); }, 400);
}

function bounds() {
  if (!win || win.isDestroyed()) return;
  const [width, height] = win.getContentSize();
  for (const [id, view] of views) {
    view.setVisible(showExternal && activeId === id);
    const top = htmlFullscreen || !chromeVisible ? 0 : 96;
    view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) });
  }
}

function setChromeVisible(visible) {
  if (chromeVisible === visible) return;
  chromeVisible = visible;
  send('core:chrome-visibility', visible);
  bounds();
}

function publishTab(id, contents) {
  if (contents.isDestroyed()) return;
  // The blank page used to prepare a new tab is internal and never shown to the user.
  if (!contents.getURL() || contents.getURL() === 'about:blank') return;
  send('core:tab-update', { id, title: contents.getTitle() || new URL(contents.getURL() || 'https://example.com').hostname, url: contents.getURL() });
}

function makeTab(id) {
  const view = new WebContentsView({ webPreferences: { session: browsingSession, contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, navigateOnDragDrop: false } });
  views.set(id, view);
  win.contentView.addChildView(view);
  const contents = view.webContents;
  contents.setWindowOpenHandler(details => {
    try {
      const url = browsingUrl(details.url);
      if (state.protection.enabled && state.protection.popups && !isAllowedDomain(contents.getURL(), state.allowlist) && !['foreground-tab', 'background-tab'].includes(details.disposition)) recordBlocked('Pop-up', url, contents.getURL());
      else send('core:open-tab', { url, title: new URL(url).hostname });
    } catch { /* Never open privileged URLs from a remote page. */ }
    return { action: 'deny' };
  });
  contents.on('will-navigate', (event, url) => { try { browsingUrl(url); } catch { event.preventDefault(); } });
  contents.on('will-redirect', (event, url) => { try { browsingUrl(url); } catch { event.preventDefault(); } });
  contents.on('enter-html-full-screen', () => {
    if (activeId !== id || !win || win.isDestroyed()) return;
    htmlFullscreen = true;
    setChromeVisible(false);
    win.setFullScreen(true);
    send('core:fullscreen-state', true);
    bounds();
  });
  contents.on('leave-html-full-screen', () => {
    if (activeId !== id || !win || win.isDestroyed()) return;
    htmlFullscreen = false;
    win.setFullScreen(false);
    setChromeVisible(true);
    send('core:fullscreen-state', false);
    bounds();
  });
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && !htmlFullscreen) { lastActivityAt = Date.now(); setChromeVisible(true); }
  });
  contents.on('page-title-updated', () => publishTab(id, contents));
  contents.on('did-navigate', () => publishTab(id, contents));
  contents.on('did-navigate-in-page', () => publishTab(id, contents));
  contents.on('did-finish-load', () => { publishTab(id, contents); engine.applyCosmetics(contents).catch(console.warn); });
  const contentsId = contents.id;
  contents.on('destroyed', () => { engine.forget(contentsId); shields.delete(contentsId); });
  syncShield(contents);
  bounds();
  return view;
}

async function refreshCosmetics() {
  await Promise.all([...views.values()].map(view => engine.applyCosmetics(view.webContents).catch(console.warn)));
}

// The YouTube shield strips ad data from video responses, so it has to run before any page script.
// It is registered through the DevTools protocol, which also means only this process supplies its source
// and web pages never gain a preload script or an IPC channel.
const shields = new Map();

// Protocol commands are only answered once a page exists, and a stuck command must never block browsing.
function withTimeout(promise, label, ms = 4000) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function syncShield(contents) {
  const id = contents.id;
  const entry = shields.get(id) || { identifier: null, listening: false, queue: Promise.resolve() };
  shields.set(id, entry);
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
        if (!entry.listening) { entry.listening = true; cdp.on('detach', () => { entry.identifier = null; }); }
        await withTimeout(cdp.sendCommand('Page.enable'), 'Page.enable');
      } catch (error) { console.warn('YouTube shield unavailable:', error.message); return; }
    }
    if (entry.identifier) {
      await withTimeout(cdp.sendCommand('Page.removeScriptToEvaluateOnNewDocument', { identifier: entry.identifier }), 'remove shield').catch(() => {});
      entry.identifier = null;
    }
    if (!state.protection.enabled || !state.protection.youtube) return;
    try {
      const result = await withTimeout(cdp.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: buildShieldScript(state.allowlist) }), 'install shield');
      entry.identifier = result.identifier;
    } catch (error) { console.warn('YouTube shield could not be installed:', error.message); }
  }).catch(error => console.warn('YouTube shield error:', error.message));
  return entry.queue;
}

async function refreshShields() {
  await Promise.all([...views.values()].map(view => syncShield(view.webContents)));
}

function trusted(event) {
  if (!win || event.sender.id !== win.webContents.id || event.senderFrame !== win.webContents.mainFrame) throw new Error('Untrusted IPC sender');
}

function registerIPC() {
  const handle = (channel, callback) => ipcMain.handle(channel, (event, ...args) => { trusted(event); return callback(...args); });
  handle('core:navigate', async (id, input) => {
    if (typeof id !== 'string' || id.length > 100) throw new Error('Invalid tab');
    const url = browsingUrl(input);
    const view = views.get(id) || makeTab(id);
    // Make sure the shield is registered before the first page starts loading.
    await shields.get(view.webContents.id)?.queue;
    if (view.webContents.getURL() !== url && !view.webContents.isLoadingMainFrame()) {
      try { await view.webContents.loadURL(url); }
      catch (error) { if (error.code !== 'ERR_ABORTED' && error.errno !== -3) console.warn('Navigation failed:', error.message); }
    }
  });
  handle('core:focus', (id, external) => { activeId = id; showExternal = external === true; lastActivityAt = Date.now(); setChromeVisible(true); bounds(); });
  handle('core:close', id => { const view = views.get(id); if (view) { win.contentView.removeChildView(view); view.webContents.close(); views.delete(id); } });
  handle('core:tab-action', (id, action) => {
    const contents = views.get(id)?.webContents;
    if (!contents) return;
    if (action === 'back' && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    if (action === 'forward' && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    if (action === 'reload') contents.reload();
  });
  handle('core:protection', async input => {
    for (const key of Object.keys(defaults.protection)) if (typeof input?.[key] === 'boolean') state.protection[key] = input[key];
    persist(); await Promise.all([refreshCosmetics(), refreshShields()]);
  });
  handle('core:allowlist', async input => {
    if (!Array.isArray(input) || input.length > 1000) throw new Error('Invalid allowlist');
    state.allowlist = input.filter(domain => typeof domain === 'string' && /^[a-z0-9.-]+$/i.test(domain) && domain.includes('.')).map(domain => domain.toLowerCase());
    persist(); await Promise.all([refreshCosmetics(), refreshShields()]);
  });
  handle('core:filters', async input => {
    if (!Array.isArray(input) || input.length > 100) throw new Error('Invalid filters');
    state.filters = input.filter(item => item && typeof item.id === 'string' && trustedFilterUrl(item.url)).map(item => ({ id: item.id.slice(0, 100), url: item.url, enabled: item.enabled === true, updated: typeof item.updated === 'string' ? item.updated : '' }));
    persist(); await engine.rebuild(state.filters); await refreshCosmetics();
  });
  handle('core:stats', () => state.stats);
  handle('core:privacy', enabled => { if (typeof enabled === 'boolean') { state.doNotTrack = enabled; persist(); } });
  handle('core:clear-data', () => { state.stats = structuredClone(defaults.stats); persist(); send('core:stats-update', state.stats); });
  ipcMain.on('core:window', (event, action) => {
    trusted(event);
    if (action === 'close') win.close();
    if (action === 'minimize') win.minimize();
    if (action === 'maximize') win.isMaximized() ? win.unmaximize() : win.maximize();
  });
}

function createWindow() {
  win = new BrowserWindow({ width: 1440, height: 1000, minWidth: 850, minHeight: 620, frame: false, show: false, backgroundColor: '#f8f9fb', title: 'ChromiumCore', icon: path.join(__dirname, '../assets/icon.png'), webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } });
  win.webContents.setWindowOpenHandler(details => {
    try { const url = browsingUrl(details.url); send('core:open-tab', { url, title: new URL(url).hostname }); }
    catch { /* Privileged schemes never leave the application renderer. */ }
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.on('resize', bounds);
  win.on('focus', () => { lastActivityAt = Date.now(); if (!htmlFullscreen) setChromeVisible(true); });
  win.on('closed', () => { for (const view of views.values()) if (!view.webContents.isDestroyed()) view.webContents.close(); views.clear(); win = null; });
  win.once('ready-to-show', () => win.show());
  win.webContents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && !htmlFullscreen) { lastActivityAt = Date.now(); setChromeVisible(true); }
  });
  win.loadFile(path.join(__dirname, '../renderer/index.html'));
  clearInterval(chromeIdleTimer);
  chromeIdleTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isFocused() || !showExternal || htmlFullscreen) return;
    const point = screen.getCursorScreenPoint();
    const rect = win.getBounds();
    const inside = point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
    const moved = !lastCursorPoint || point.x !== lastCursorPoint.x || point.y !== lastCursorPoint.y;
    lastCursorPoint = point;
    if (inside && moved) {
      lastActivityAt = Date.now();
      setChromeVisible(true);
    } else if (chromeVisible && Date.now() - lastActivityAt >= 7000) {
      setChromeVisible(false);
    }
  }, 250);
}

app.setName('ChromiumCore');
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  storePath = path.join(app.getPath('userData'), 'workspace.json');
  try { const saved = JSON.parse(fs.readFileSync(storePath, 'utf8')); state = { ...defaults, ...saved, protection: { ...defaults.protection, ...saved.protection }, stats: { ...defaults.stats, ...saved.stats } }; } catch { /* First launch uses the defaults. */ }
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
  engine = createProtectionEngine({ browsingSession, cacheDir: path.join(app.getPath('userData'), 'filters'), getSettings: () => state, recordBlocked });
  if (state.filters.length) engine.rebuild(state.filters).catch(console.warn);
  registerIPC(); createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => {
  clearTimeout(persistTimer); clearTimeout(broadcastTimer); clearInterval(chromeIdleTimer);
  if (storePath) { try { fs.writeFileSync(storePath, JSON.stringify(state)); } catch (error) { console.warn('Could not save workspace:', error.message); } }
});