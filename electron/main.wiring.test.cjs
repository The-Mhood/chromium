'use strict';

// ---------------------------------------------------------------------------
// Electron-less wiring smoke test.
//
// Loads the REAL electron/main.cjs against a strict stub of the Electron API
// and drives the app's startup flow (session setup, protection engine, IPC
// registration, window creation, tab creation, popup blocking, the seven-
// second chrome auto-hide, fullscreen toggling, quit persistence). This is
// not a replacement for running the packaged app — it catches integration
// regressions (wrong API names, broken event flow, geometry mistakes) in
// environments where the Electron binary is unavailable (like CI).
//
// The stub is deliberately strict: any Electron member the main process uses
// that the stub does not model throws, so wiring drift fails this test.
//
// The steps run as SUBTESTS: top-level tests in a file execute concurrently,
// and these steps are strictly ordered against each other.
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const Module = require('node:module');

// ---------------------------------------------------------------------------
// Strict Electron stub
// ---------------------------------------------------------------------------

const calls = {
  ipcHandles: new Map(),
  ipcOn: new Map(),
  sends: [],
  onBeforeRequest: null,
  permissions: null,
  clipboard: [],
  willDownload: null,
  downloadOpts: [],
  downloadCancelled: 0,
};

// Controllable CDP view of the page's isolated worlds. Off by default:
// most hostile scenarios test the degraded path (no CDP, no page report),
// which is exactly where the real app used to fail.
//   attachEnabled  attach() succeeds (document-start scripts install)
//   stateValue     the Runtime.evaluate result in the cc-popup world
//   delayMs        artificial latency on evaluate (the ad-heavy-page case)
//   worldContexts  context ids reported for each isolated world
const cdpStub = { pageStateEnabled: false, stateValue: null, attachEnabled: false, delayMs: 0, injectedScripts: [] };
cdpStub.worldContexts = new Map(); // worldName -> nextContextId
// CDP 'message' listeners are PER CONTENTS (each webContents registers its
// own in syncPageScripts). The map keeps them all; the bare variable is the
// LAST-registered one, so emitCdp(method, params) without a target keeps
// working for single-tab scenarios.
cdpStub.messageListeners = new Map(); // webContents -> fn
let cdpMessageListener = null;
const emitCdp = (method, params, targetWc = null) => {
  const fn = targetWc ? cdpStub.messageListeners.get(targetWc) : cdpMessageListener;
  if (fn) fn(method, params);
};
let nextPopupContext = 100;

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromiumcore-wiring-'));

function makeWebContents(id) {
  const listeners = new Map();
  let debuggerAttached = false;
  const wc = {
    id,
    mainFrame: { id },
    __url: '',
    __openHandler: null,
    isDestroyed: () => false,
    getURL: () => wc.__url,
    getTitle: () => { try { return new URL(wc.__url).hostname; } catch { return ''; } },
    isLoading: () => false,
    isLoadingMainFrame: () => false,
    isFullscreen: () => false,
    loadFile: () => Promise.resolve(),
    loadURL: url => { wc.__url = url; return Promise.resolve(); },
    executeJavaScript: async () => 96,
    insertCSS: async () => `css-${id}-${Math.random().toString(36).slice(2)}`,
    removeInsertedCSS: async () => {},
    close: () => {},
    focus: () => {},
    send: (channel, payload) => calls.sends.push({ id, channel, payload }),
    setWindowOpenHandler: fn => { wc.__openHandler = fn; },
    on: (event, fn) => { listeners.set(event, [...(listeners.get(event) || []), fn]); },
    once: (event, fn) => {
      const wrapper = (...args) => {
        const fns = listeners.get(event) || [];
        const idx = fns.indexOf(wrapper);
        if (idx >= 0) fns.splice(idx, 1);
        fn(...args);
      };
      listeners.set(event, [...(listeners.get(event) || []), wrapper]);
    },
    emit: (event, ...args) => { for (const fn of [...(listeners.get(event) || [])] || []) fn(...args); },
    debugger: {
      // attach() throws by default (the document-start script path stays
      // degraded — the real app's failure mode); scenarios that need the
      // isolated worlds flip cdpStub.attachEnabled. The evaluate side feeds
      // realistic raw-timestamp state ({ t, open, click }) and can be made
      // slow (cdpStub.delayMs) to model ad-heavy pages.
      isAttached: () => debuggerAttached,
      attach: () => {
        if (!cdpStub.attachEnabled && !cdpStub.pageStateEnabled) throw new Error('CDP unavailable in wiring smoke (degraded path)');
        debuggerAttached = true;
      },
      on: (event, fn) => { if (event === 'message') { cdpStub.messageListeners.set(wc, fn); cdpMessageListener = fn; } },
      sendCommand: (method, params) => {
        if (!cdpStub.attachEnabled && !cdpStub.pageStateEnabled) return Promise.reject(new Error('no CDP'));
        const later = promise => (cdpStub.delayMs > 0 ? new Promise(resolve => setTimeout(() => resolve(promise), cdpStub.delayMs)) : Promise.resolve(promise));
        if (method === 'Page.enable' || method === 'Runtime.enable') return Promise.resolve({});
        if (method === 'Page.addScriptToEvaluateOnNewDocument') { cdpStub.injectedScripts.push(params); return Promise.resolve({ identifier: `script-${Math.random().toString(36).slice(2)}` }); }
        if (method === 'Page.removeScriptToEvaluateOnNewDocument') return Promise.resolve({});
        if (method === 'Page.getFrameTree') return Promise.resolve({ frameTree: { frame: { id: 'frame-0' }, childFrames: [] } });
        if (method === 'Runtime.getIsolatedContext') {
          const world = (params && params.worldName) || 'cc-popup';
          let next = cdpStub.worldContexts.get(world);
          if (next === undefined) { next = world === 'cc-links' ? 4000 : nextPopupContext += 1; cdpStub.worldContexts.set(world, next); }
          return Promise.resolve({ contextId: next });
        }
        if (method === 'Runtime.evaluate') return later({ result: { value: cdpStub.stateValue } });
        return Promise.reject(new Error('no CDP: ' + method));
      },
    },
    navigationHistory: {
      canGoBack: () => false,
      goBack: () => {},
      canGoForward: () => false,
      goForward: () => {},
      reload: () => {},
    },
  };
  return wc;
}

let extraWindowWc = 500;
class BrowserWindowStub {
  static windows = [];
  constructor(options = {}) {
    // The FIRST window (the app shell) keeps webContents id 1 — the rest of
    // the suite's fakeEvent() depends on it. Later windows (the link dialog,
    // "open in new window") get unique ids.
    this.__wcId = BrowserWindowStub.windows.length === 0 ? 1 : ++extraWindowWc;
    this.webContents = makeWebContents(this.__wcId);
    this.__options = options;
    this.__dialog = !!(options && options.dialog === true);
    this.__listeners = new Map();
    this.__once = new Map();
    this.__fullscreen = false;
    this.__maximized = false;
    this.__destroyed = false;
    this.contentView = {
      __views: [],
      get children() { return this.__views; },
      // Arrows here capture the BrowserWindowStub instance as `this`, not the
      // contentView object, so reach the view list through this.contentView.
      addChildView: view => this.contentView.__views.push(view),
      removeChildView: view => { const i = this.contentView.__views.indexOf(view); if (i >= 0) this.contentView.__views.splice(i, 1); },
    };
    BrowserWindowStub.windows.push(this);
  }
  on(event, fn) { this.__listeners.set(event, [...(this.__listeners.get(event) || []), fn]); }
  once(event, fn) { this.__once.set(event, fn); }
  emit(event, ...args) {
    for (const fn of this.__listeners.get(event) || []) fn(...args);
    const onceFn = this.__once.get(event);
    if (onceFn) { this.__once.delete(event); onceFn(...args); }
  }
  show() { this.__shown = true; }
  focus() {}
  // A closed window leaves BrowserWindow.getAllWindows(), as in real
  // Electron — destroyed dialogs/windows must not leak into later counts.
  close() {
    this.__destroyed = true;
    const i = BrowserWindowStub.windows.indexOf(this);
    if (i >= 0) BrowserWindowStub.windows.splice(i, 1);
    this.emit('closed');
  }
  isDestroyed() { return this.__destroyed; }
  getContentSize() { return [1440, 1000]; }
  setFullScreen(value) { this.__fullscreen = value; }
  isFullScreen() { return this.__fullscreen; }
  getBounds() { return { x: 0, y: 0, width: 1440, height: 1000 }; }
  isFocused() { return true; }
  minimize() {}
  maximize() { this.__maximized = true; }
  isMaximized() { return this.__maximized; }
  unmaximize() { this.__maximized = false; }
  setAlwaysOnTop() {}
  setMenu() {}
  setTitle() {}
  // A real BrowserWindow fires did-finish-load on its webContents after
  // loadFile, then ready-to-show on the window. The loaded file URL (with
  // its query string) becomes the contents' URL, as in a real window.
  loadFile(file, options = {}) {
    const query = options.query ? '?' + Object.entries(options.query).map(([k, v]) => `${k}=${v}`).join('&') : '';
    this.webContents.__url = 'file://' + file + query;
    this.webContents.emit('did-finish-load');
    this.emit('ready-to-show');
  }
}
BrowserWindowStub.getAllWindows = () => BrowserWindowStub.windows;

let webContentsId = 100;
class WebContentsViewStub {
  constructor(_options) {
    this.webContents = makeWebContents(++webContentsId);
    this.__bounds = null;
    this.__visible = false;
  }
  setBounds(bounds) { this.__bounds = bounds; }
  setVisible(visible) { this.__visible = visible; }
}

const appListeners = new Map();
let appReady;
const appStub = {
  setName() {},
  on: (event, fn) => appListeners.set(event, [...(appListeners.get(event) || []), fn]),
  getPath: name => (name === 'userData' ? userDataDir : path.join(userDataDir, name)),
  whenReady: () => new Promise(resolve => { appReady = resolve; }),
};

const electronStub = {
  app: appStub,
  BrowserWindow: BrowserWindowStub,
  WebContentsView: WebContentsViewStub,
  Menu: { setApplicationMenu() {} },
  screen: {
    on: () => {},
    getCursorScreenPoint: () => ({ x: 100, y: 100 }),
  },
  ipcMain: {
    handle: (channel, fn) => calls.ipcHandles.set(channel, fn),
    on: (channel, fn) => calls.ipcOn.set(channel, fn),
  },
  session: {
    fromPartition: () => ({
      setPermissionRequestHandler: fn => { calls.permissions = fn; },
      setPermissionCheckHandler: () => {},
      webRequest: {
        onBeforeSendHeaders: () => {},
        onBeforeRequest: (_filter, fn) => { calls.onBeforeRequest = fn; },
      },
      on: (event, fn) => { if (event === 'will-download') calls.willDownload = fn; },
    }),
  },
  clipboard: {
    writeText: text => { calls.clipboard.push(text); },
  },
};

// ---------------------------------------------------------------------------
// Load the real main process against the stub
// ---------------------------------------------------------------------------

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub;
  // The real ElectronBlocker requires electron at load time; the pure
  // FiltersEngine has the identical API (see protection.test.cjs).
  if (request === '@ghostery/adblocker-electron') {
    return { ElectronBlocker: require('@ghostery/adblocker').FiltersEngine };
  }
  return originalLoad.apply(this, arguments);
};

require('./main.cjs');

const winStub = () => BrowserWindowStub.windows[0];
const fakeEvent = () => { const w = winStub(); return { sender: { id: 1 }, senderFrame: w.webContents.mainFrame }; };
const channels = ['core:navigate', 'core:focus', 'core:close', 'core:tab-action', 'core:protection', 'core:allowlist', 'core:filters', 'core:stats', 'core:engine-status', 'core:privacy', 'core:clear-data'];

test('main process wiring (Electron stub)', async t => {
  // View identity by tab. Layout keeps the active view as the LAST child of
  // the window's contentView (z-order fix), so positional children lookups
  // are not stable once a second tab exists — always use these references.
  let tab1View = null;
  let tab2View = null;
  await t.test('startup wires the session, engine and all IPC channels', async () => {
    appReady();
    await new Promise(resolve => setTimeout(resolve, 50)); // let the ready callback run
    assert.ok(winStub(), 'the window was created');

    for (const channel of channels) assert.ok(calls.ipcHandles.has(channel), `ipcMain.handle(${channel})`);
    assert.ok(calls.ipcOn.has('core:window'), 'ipcMain.on(core:window)');

    // The request pipeline is registered on the browsing session.
    assert.equal(typeof calls.onBeforeRequest, 'function', 'webRequest.onBeforeRequest registered');

    // The engine becomes ready with the bundled baseline (or the fetched
    // lists when this machine can reach the list servers — both acceptable).
    let status;
    for (let i = 0; i < 150; i += 1) {
      status = await calls.ipcHandles.get('core:engine-status')(fakeEvent());
      if (status.ready) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.equal(status.ready, true, 'engine reports ready');
    assert.ok(status.totalRules > 1000, `a substantial rule set is active: ${status.totalRules}`);

    // A listed ad request is cancelled through the real pipeline.
    const decision = {};
    calls.onBeforeRequest({ url: 'https://pagead2.googlesyndication.com/x.js', resourceType: 'script', webContentsId: 101, referrer: 'https://example.com/' }, d => { Object.assign(decision, d); });
    assert.equal(decision.cancel, true, 'listed ad request cancelled');

    // An unlisted request passes untouched.
    const pass = {};
    calls.onBeforeRequest({ url: 'https://example.com/ok.js', resourceType: 'script', webContentsId: 101, referrer: 'https://example.com/' }, d => { Object.assign(pass, d); });
    assert.equal(pass.cancel, undefined, 'unlisted request untouched');
  });

  await t.test('focus and navigation create a view below the chrome with the right geometry', async () => {
    await calls.ipcHandles.get('core:focus')(fakeEvent(), 'tab-1', true);
    await calls.ipcHandles.get('core:navigate')(fakeEvent(), 'tab-1', 'https://example.com/');
    assert.equal(winStub().contentView.__views.length, 1, 'one WebContentsView for the tab');
    const view = winStub().contentView.__views[0];
    tab1View = view;
    assert.deepEqual(view.__bounds, { x: 0, y: 96, width: 1440, height: 904 },
      'the view fills the window below the 96px chrome');
    assert.equal(view.webContents.__url, 'https://example.com/', 'the page was loaded');
  });

  await t.test('a listed popup destination is blocked before any tab is created', async () => {
    const view = winStub().contentView.__views[0];
    const before = calls.sends.filter(s => s.channel === 'core:popup-blocked').length;
    view.webContents.__openHandler({ url: 'https://popcash.net/landing', disposition: 'default' });
    await new Promise(resolve => setTimeout(resolve, 300)); // handleWindowOpen is async
    assert.equal(winStub().contentView.__views.length, 1, 'no second tab was created');
    const notices = calls.sends.filter(s => s.channel === 'core:popup-blocked');
    assert.equal(notices.length, before + 1, 'the renderer was told a popup was blocked');
    assert.equal(notices.at(-1).payload.source, 'example.com');
  });

  await t.test('an unlisted destination without any input is blocked (default deny)', async () => {
    const view = winStub().contentView.__views[0];
    // No CDP in this smoke and no input event was observed on this page.
    // The old "degraded mode" allowed such opens and watched them after the
    // fact; that is how ad tabs slipped through. Default deny: a page the
    // user never touched gets no browsing context. (With a real click, the
    // open is verified in a hidden inspector — see the hostile suite below.)
    const viewsBefore = winStub().contentView.__views.length;
    view.webContents.__openHandler({ url: 'https://docs.example.com/new', disposition: 'default' });
    await new Promise(resolve => setTimeout(resolve, 300));
    const opens = calls.sends.filter(s => s.channel === 'core:open-tab');
    assert.ok(!opens.some(s => s.payload.url === 'https://docs.example.com/new'), 'no unobserved open is published');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'nothing was created');
  });

  await t.test('switching tabs re-bounds the visible view even without a window resize', async () => {
    await calls.ipcHandles.get('core:focus')(fakeEvent(), 'tab-2', true);
    await calls.ipcHandles.get('core:navigate')(fakeEvent(), 'tab-2', 'https://second.example.com/');
    const [first, second] = winStub().contentView.__views;
    tab2View = second;
    assert.equal(first.__visible, false, 'the previous tab view is hidden');
    assert.equal(second.__visible, true, 'the switched-to tab view is visible');
    assert.deepEqual(second.__bounds, { x: 0, y: 96, width: 1440, height: 904 },
      'the switched-to view is fully laid out even though the window size never changed');
    // Switch back: the first view must be on screen with the right geometry.
    await calls.ipcHandles.get('core:focus')(fakeEvent(), 'tab-1', true);
    assert.equal(first.__visible, true, 'the restored tab view is visible');
    assert.deepEqual(first.__bounds, { x: 0, y: 96, width: 1440, height: 904 },
      'the restored view is re-bounded on every layout pass');
    // Z-order: the view on screen must be the topmost child of the window —
    // otherwise the (hidden) sibling added later would still paint over it.
    const kids = winStub().contentView.children;
    assert.equal(kids[kids.length - 1], first, 'the visible view is the topmost child');
    assert.equal(second.__visible, false, 'the other view is hidden');
  });

  await t.test('a blocked main-frame navigation tells the renderer (no silent placeholder)', async () => {
    const view = tab1View; // tab-1's view, however the z-order is arranged
    const before = calls.sends.filter(s => s.channel === 'core:navigation-blocked').length;
    // The request pipeline cancels a listed main frame — exactly what leaves
    // a tab on its placeholder. The renderer must be told why.
    calls.onBeforeRequest({ url: 'https://pagead2.googlesyndication.com/', resourceType: 'mainFrame', webContentsId: view.webContents.id, referrer: 'https://example.com/' }, () => {});
    const blocked = calls.sends.filter(s => s.channel === 'core:navigation-blocked');
    assert.equal(blocked.length, before + 1, 'core:navigation-blocked was sent');
    assert.equal(blocked.at(-1).payload.id, 'tab-1');
    assert.equal(blocked.at(-1).payload.url, 'https://pagead2.googlesyndication.com/');
    assert.equal(typeof blocked.at(-1).payload.type, 'string');
  });

  await t.test('a failed load is reported so the placeholder can explain itself', async () => {
    const view = tab1View; // tab-1's view, however the z-order is arranged
    // Point the tab at a fresh URL so lastRequested matches the failure.
    await calls.ipcHandles.get('core:navigate')(fakeEvent(), 'tab-1', 'https://fail.example.com/');
    const before = calls.sends.filter(s => s.channel === 'core:load-failed').length;
    view.webContents.emit('did-fail-load', {}, -105, 'net::ERR_NAME_NOT_RESOLVED', 'https://fail.example.com/');
    const failed = calls.sends.filter(s => s.channel === 'core:load-failed');
    assert.equal(failed.length, before + 1, 'core:load-failed was sent for the main frame');
    assert.equal(failed.at(-1).payload.id, 'tab-1');
    assert.equal(failed.at(-1).payload.url, 'https://fail.example.com/');
    // A sub-resource failure must NOT be reported as a failed page.
    view.webContents.emit('did-fail-load', {}, -105, 'net::ERR_NAME_NOT_RESOLVED', 'https://fail.example.com/ad.js');
    assert.equal(calls.sends.filter(s => s.channel === 'core:load-failed').length, before + 1, 'sub-resource failures are ignored');
  });

  await t.test('the chrome hides after ten idle seconds and reveals on activity', async () => {
    const view = tab1View; // tab-1 is the active tab, so its view gets laid out
    const hiddenBefore = calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === false).length;

    // The idle timer ticks every 250 ms with a static cursor; the last
    // activity was at startup, so the chrome must hide within ~10.3 s.
    await new Promise(resolve => setTimeout(resolve, 10600));
    const hiddenAfter = calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === false).length;
    assert.ok(hiddenAfter > hiddenBefore, 'the chrome was hidden after ten idle seconds');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(view.__bounds, { x: 0, y: 0, width: 1440, height: 1000 },
      'the page view expanded to the full window while the chrome is hidden');

    // A mouse event reveals the chrome and restores the layout (real
    // Electron delivers mouse input on before-mouse-event).
    const visibleBefore = calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === true).length;
    winStub().webContents.emit('before-mouse-event', {}, { type: 'mouseDown' });
    await new Promise(resolve => setTimeout(resolve, 400));
    const visibleAfter = calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === true).length;
    assert.ok(visibleAfter > visibleBefore, 'activity revealed the chrome');
    assert.deepEqual(view.__bounds, { x: 0, y: 96, width: 1440, height: 904 },
      'the layout returned below the chrome');
  });

  await t.test('closing a tab removes its view and state', async () => {
    await calls.ipcHandles.get('core:close')(fakeEvent(), 'tab-1');
    await calls.ipcHandles.get('core:close')(fakeEvent(), 'tab-2');
    assert.equal(winStub().contentView.__views.length, 0, 'the view was removed from the window');
  });

  await t.test('media fullscreen is window-level: maximise/restore, never an OS transition', async () => {
    // Fresh tab: the media events only take effect for the active tab.
    await calls.ipcHandles.get('core:focus')(fakeEvent(), 'tab-3', true);
    await calls.ipcHandles.get('core:navigate')(fakeEvent(), 'tab-3', 'https://youtube.example.com/');
    const view = winStub().contentView.__views[0];

    view.webContents.emit('enter-html-full-screen');
    assert.equal(winStub().__fullscreen, false, 'media never triggers an OS fullscreen transition');
    assert.equal(winStub().__maximized, true, 'the window was maximised for the player');
    assert.equal(view.__visible, true);
    assert.deepEqual(view.__bounds, { x: 0, y: 0, width: 1440, height: 1000 },
      'the player view covers the full window');
    const state = calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1);
    assert.deepEqual(state.payload, { media: true, window: false },
      'the renderer sees media fullscreen without window fullscreen');

    view.webContents.emit('leave-html-full-screen');
    assert.equal(winStub().__maximized, false, 'the window size was restored');
    assert.equal(winStub().__fullscreen, false);
    assert.deepEqual(view.__bounds, { x: 0, y: 96, width: 1440, height: 904 },
      'the layout returned below the chrome');

    await calls.ipcHandles.get('core:close')(fakeEvent(), 'tab-3');
  });

  // Shared helpers for the hostile-page scenarios below. The layout keeps
  // the ACTIVE tab view as the last child (z-order), so views are identified
  // by exclusion — the inspector is the one view the test did not create.
  // A REAL mouse click, delivered the way Electron delivers it: the
  // browser's input pipeline fires before-mouse-event for mouse input.
  // (before-input-event is keyboard-only in Electron — its input.type is
  // keyDown/keyUp, verified against the engine source; a mouseDown emitted
  // there would be ignored by the main process, exactly as in reality.)
  const clickOn = wc => wc.emit('before-mouse-event', {}, { type: 'mouseDown' });
  const settle = () => new Promise(resolve => setTimeout(resolve, 300)); // handleWindowOpen is async
  const openPublished = url => calls.sends.some(s => s.channel === 'core:open-tab' && s.payload.url === url);
  const freshTab = async (tabId, url) => {
    await calls.ipcHandles.get('core:focus')(fakeEvent(), tabId, true);
    await calls.ipcHandles.get('core:navigate')(fakeEvent(), tabId, url);
    const view = winStub().contentView.__views.at(-1); // makeTab just added it
    return { view, known: new Set([view]) };
  };
  const findInspector = known => winStub().contentView.__views.find(v => !known.has(v));
  const closeTabs = async (...ids) => { for (const id of ids) await calls.ipcHandles.get('core:close')(fakeEvent(), id); };

  // The vivarium-style burst: a page that fires one popup per click. The
  // first popup is verified in the hidden inspector (the user did click);
  // the second is a repeat offender and takes the first tab down with it.
  await t.test('a page firing repeated popups loses its first tab too', async () => {
    const { view: source, known } = await freshTab('tab-9', 'https://burst-source.example.com/');
    const beforeViews = winStub().contentView.__views.length;
    // First script popup, right after a real click.
    clickOn(source.webContents);
    source.webContents.__openHandler({ url: 'https://first-popup.example.com/', disposition: 'default' });
    await settle();
    assert.ok(!openPublished('https://first-popup.example.com/'), 'no chip before the destination is verified');
    assert.equal(winStub().contentView.__views.length, beforeViews + 1, 'a hidden inspector appeared');
    const inspector = findInspector(known);
    assert.ok(inspector, 'the extra view is the inspector');
    assert.equal(inspector.__visible, false, 'the inspector is never visible');
    // The inspector commits to the URL it was given (no redirect): pass.
    inspector.webContents.emit('did-commit-navigation');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(openPublished('https://first-popup.example.com/'), 'the verified popup tab was published');
    assert.equal(winStub().contentView.__views.length, beforeViews, 'the inspector was destroyed');
    // The renderer opens that tab; the main process learns the tab->popup link.
    const popup = await freshTab('tab-p1', 'https://first-popup.example.com/');
    known.add(popup.view);
    assert.equal(winStub().contentView.__views.length, beforeViews + 1, 'the popup tab has a view');
    // The page fires a second popup shortly after (fresh click, new tab).
    clickOn(source.webContents);
    source.webContents.__openHandler({ url: 'https://second-popup.example.com/', disposition: 'default' });
    await settle();
    assert.ok(!openPublished('https://second-popup.example.com/'), 'the second popup tab was not created');
    assert.equal(findInspector(known), undefined, 'no inspector for the blocked open');
    const closed = calls.sends.filter(s => s.channel === 'core:tab-closed');
    assert.equal(closed.length, 1, 'the renderer was told the first popup tab was closed');
    assert.equal(closed.at(-1).payload.id, 'tab-p1');
    assert.equal(winStub().contentView.__views.length, beforeViews, 'only the source tab remains');
    await closeTabs('tab-9');
  });

  // -----------------------------------------------------------------------
  // Hostile-page regression suite: the exact failure modes reported in the
  // field, driven against the real main process. "No advertising tab" means:
  // no core:open-tab is ever published for it AND no visible view is created.
  // -----------------------------------------------------------------------

  await t.test('hostile: a clicked window.open to a listed ad domain opens nothing', async () => {
    const { view: page, known } = await freshTab('h-1', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    clickOn(page.webContents); // a real click on the deceptive icon
    page.webContents.__openHandler({ url: 'https://pagead2.googlesyndication.com/pagead/landing', disposition: 'default' });
    await settle();
    assert.ok(!openPublished('https://pagead2.googlesyndication.com/pagead/landing'), 'no ad tab was published');
    assert.equal(findInspector(known), undefined, 'no view (tab or inspector) was created');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'view count unchanged');
    await closeTabs('h-1');
  });

  await t.test('hostile: a target=_blank link to a listed ad domain opens nothing', async () => {
    const { view: page, known } = await freshTab('h-2', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    clickOn(page.webContents);
    page.webContents.__openHandler({ url: 'https://pagead2.googlesyndication.com/clk', disposition: 'foreground-tab' });
    await settle();
    assert.ok(!openPublished('https://pagead2.googlesyndication.com/clk'), 'no ad tab was published');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'no view was created');
    await closeTabs('h-2');
  });

  await t.test('hostile: a popup that redirects to an ad domain dies in the inspector', async () => {
    const { view: page, known } = await freshTab('h-3', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    clickOn(page.webContents);
    // The first URL looks innocent; the server 302s to the ad network.
    page.webContents.__openHandler({ url: 'https://offers.example.com/claim', disposition: 'default' });
    await settle();
    const inspector = findInspector(known);
    assert.ok(inspector, 'an inspector appeared');
    assert.equal(winStub().contentView.__views.length, viewsBefore + 1, 'exactly one extra view');
    assert.equal(inspector.__visible, false, 'the inspector is invisible');
    // The redirect lands on a listed ad host.
    inspector.webContents.__url = 'https://pagead2.googlesyndication.com/redirect/land';
    inspector.webContents.emit('did-commit-navigation');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(!openPublished('https://offers.example.com/claim'), 'no chip for the ad, not even briefly');
    assert.ok(!openPublished('https://pagead2.googlesyndication.com/redirect/land'), 'no chip for the ad destination');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'the inspector was destroyed');
    await closeTabs('h-3');
  });

  await t.test('hostile: a popup that jumps domains (popunder scheme) dies in the inspector', async () => {
    const { view: page, known } = await freshTab('h-4', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    clickOn(page.webContents);
    // window.open('') style: starts on the opener's own domain...
    page.webContents.__openHandler({ url: 'https://victim.example.com/', disposition: 'default' });
    await settle();
    const inspector = findInspector(known);
    assert.ok(inspector, 'an inspector appeared');
    // ...then the script points it at an unlisted ad domain on a DIFFERENT
    // registrable domain (a blocklist alone cannot name this one — the
    // domain-jump rule must catch it).
    inspector.webContents.__url = 'https://jump-elsewhere.test/ad?ref=victim';
    inspector.webContents.emit('did-commit-navigation');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(!openPublished('https://jump-elsewhere.test/ad?ref=victim'), 'the domain jump was blocked');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'the inspector was destroyed');
    await closeTabs('h-4');
  });

  await t.test('hostile: scrolling while popup scripts run opens nothing', async () => {
    const { view: page, known } = await freshTab('h-5', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    page.webContents.emit('before-mouse-event', {}, { type: 'mouseWheel' }); // scroll, not a click (never grants activation)
    page.webContents.__openHandler({ url: 'https://scroll-popup.example.com/', disposition: 'default' });
    await settle();
    assert.ok(!openPublished('https://scroll-popup.example.com/'), 'scroll-firing popups are blocked');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'nothing was created');
    await closeTabs('h-5');
  });

  await t.test('hostile: a delayed popup (long after the click) opens nothing', async () => {
    const { view: page, known } = await freshTab('h-6', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    clickOn(page.webContents);
    await new Promise(resolve => setTimeout(resolve, 1700)); // the timer fires 1.7 s later
    page.webContents.__openHandler({ url: 'https://delayed-popup.example.com/', disposition: 'default' });
    await settle();
    assert.ok(!openPublished('https://delayed-popup.example.com/'), 'the stale gesture did not count');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'nothing was created');
    await closeTabs('h-6');
  });

  await t.test('hostile: a cross-domain popup chain stops after the first hop', async () => {
    const { view: source, known } = await freshTab('h-7', 'https://chain-source.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    // Hop 1: the user clicks; the first popup verifies and opens.
    clickOn(source.webContents);
    source.webContents.__openHandler({ url: 'https://chain-hop.example.com/', disposition: 'default' });
    await settle();
    const inspector = findInspector(known);
    assert.ok(inspector, 'an inspector appeared for the first hop');
    inspector.webContents.emit('did-commit-navigation');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(openPublished('https://chain-hop.example.com/'), 'the first hop opened');
    const hop = await freshTab('tab-h7', 'https://chain-hop.example.com/');
    known.add(hop.view);
    // Hop 2: the hop page fires its own popup. The user never interacted
    // with the hop page — no gesture, no CDP report — so it dies.
    hop.view.webContents.__openHandler({ url: 'https://chain-hop2.example.com/', disposition: 'default' });
    await settle();
    assert.ok(!openPublished('https://chain-hop2.example.com/'), 'the chain was cut at the second hop');
    assert.equal(winStub().contentView.__views.length, viewsBefore + 1, 'only source + first hop exist');
    await closeTabs('h-7', 'tab-h7');
  });

  await t.test('hostile: a hidden background window is never created', async () => {
    const { view: page, known } = await freshTab('h-8', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    clickOn(page.webContents); // even a fresh click
    page.webContents.__openHandler({ url: 'https://background-ad.example.com/', disposition: 'background-tab' });
    await settle();
    assert.ok(!openPublished('https://background-ad.example.com/'), 'background opens are blocked outright');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'no context was created');
    await closeTabs('h-8');
  });

  await t.test('hostile: an external-protocol ad attempt opens nothing', async () => {
    const { view: page, known } = await freshTab('h-9', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    clickOn(page.webContents);
    page.webContents.__openHandler({ url: 'intent://install?item=ad#Intent;action=ad;end', disposition: 'default' });
    await settle();
    assert.ok(!openPublished('intent://install?item=ad#Intent;action=ad;end'), 'privileged schemes never open a context');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'nothing was created');
    await closeTabs('h-9');
  });

  await t.test('hostile: without CDP and without any input, an open is blocked (no degraded mode)', async () => {
    const { view: page, known } = await freshTab('h-10', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    // No click, no scroll, no CDP read: the old "degraded allow" let this
    // straight through. It must not.
    page.webContents.__openHandler({ url: 'https://silent-popup.example.com/', disposition: 'default' });
    await settle();
    assert.ok(!openPublished('https://silent-popup.example.com/'), 'unobserved opens are denied by default');
    assert.equal(winStub().contentView.__views.length, viewsBefore, 'nothing was created');
    await closeTabs('h-10');
  });

  await t.test('hostile: a scripted open from a cross-origin ad iframe is blocked even on a fresh click', async () => {
    // CDP must be available before the tab is created: syncPageScripts
    // attaches DevTools (and installs the isolated worlds) at document start.
    cdpStub.pageStateEnabled = true;
    try {
      const { view: page, known } = await freshTab('h-11', 'https://victim.example.com/');
      const viewsBefore = winStub().contentView.__views.length;
      // The ad iframe's SCRIPT called window.open. The isolated world reports
      // the raw timestamp; main measures its age against the request time.
      cdpStub.stateValue = { open: { t: Date.now(), isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'victim.example.com' } };
      clickOn(page.webContents);
      page.webContents.__openHandler({ url: 'https://ad-landing.example.com/', disposition: 'foreground-tab' });
      await settle();
      assert.ok(!openPublished('https://ad-landing.example.com/'), 'the scripted ad-iframe open was blocked');
      assert.equal(winStub().contentView.__views.length, viewsBefore, 'nothing was created');
      await closeTabs('h-11');
    } finally {
      cdpStub.pageStateEnabled = false;
      cdpStub.stateValue = null;
    }
  });

  await t.test('hostile: a synthetic element.click() on a target=_blank anchor opens nothing (click-to-ad defence)', async () => {
    // CDP on, so the page records ARE readable — and empty: the page
    // fired element.click(), which is isTrusted=false, so the isolated
    // world's clock and click recorder (isTrusted-only) wrote nothing.
    // And no real mouse event passed through the browser's input pipeline
    // (no before-mouse-event), so the main process saw nothing either.
    // Chromium still reports the open as "foreground-tab" (the disposition
    // comes from the target attribute, not isTrusted) — the evidence rules
    // are what catch it.
    cdpStub.pageStateEnabled = true;
    try {
      const { view: page, known } = await freshTab('h-15', 'https://victim.example.com/');
      const viewsBefore = winStub().contentView.__views.length;
      cdpStub.stateValue = null; // no isTrusted input was ever recorded
      // NO clickOn — a synthetic click leaves no before-mouse-event.
      page.webContents.__openHandler({ url: 'https://sponsored-landing.example.org/clickpay', disposition: 'foreground-tab' });
      await settle();
      assert.ok(!openPublished('https://sponsored-landing.example.org/clickpay'), 'the click-to-ad open was blocked');
      assert.equal(winStub().contentView.__views.length, viewsBefore, 'nothing was created');
      // The SAME destination with a real click works (the user's link is
      // not what we are stopping) — and opens at once, not after a
      // verification round trip.
      clickOn(page.webContents);
      page.webContents.__openHandler({ url: 'https://sponsored-landing.example.org/clickpay', disposition: 'foreground-tab' });
      await settle();
      assert.ok(!findInspector(known), 'the real-click open does not wait on an inspector');
      assert.ok(openPublished('https://sponsored-landing.example.org/clickpay'), 'the real-click open was published at once');
      await closeTabs('h-15');
    } finally {
      cdpStub.pageStateEnabled = false;
      cdpStub.stateValue = null;
    }
  });

  await t.test('the injected link script is wired correctly (non-passive click listener, isTrusted-only records)', async () => {
    // Source-level regression guards for the two "green tests, dead
    // reality" defects: a passive click listener's preventDefault() is a
    // no-op (the double-click dialog could never win), and unguarded
    // page-world records let a page refresh its own "user was here"
    // clock with synthetic events.
    cdpStub.pageStateEnabled = true;
    try {
      await freshTab('src-1', 'https://victim.example.com/');
      const started = Date.now();
      while (cdpStub.injectedScripts.length < 2 && Date.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 25));
      const linkScript = cdpStub.injectedScripts.find(s => s.worldName === 'cc-links');
      const popupScript = cdpStub.injectedScripts.find(s => s.worldName === 'cc-popup');
      assert.ok(linkScript && linkScript.source, 'the link-support script was injected into its isolated world');
      assert.ok(popupScript && popupScript.source, 'the popup-support script was injected into its isolated world');
      assert.ok(linkScript.source.includes('passive: false'), 'the click listener is non-passive so preventDefault() actually suppresses the navigation');
      assert.ok(popupScript.source.includes('event.isTrusted'), 'the popup-support records only accept isTrusted (real) input');
      await closeTabs('src-1');
    } finally {
      cdpStub.pageStateEnabled = false;
    }
  });

  await t.test('cross-origin iframe link clicks: the first opens at once, the second is blocked', async () => {
    cdpStub.pageStateEnabled = true;
    try {
      const { view: page, known } = await freshTab('h-13', 'https://victim.example.com/');
      // The user clicks a target=_blank link in a cross-origin iframe. No
      // window.open is ever called — the browser opens the tab directly and
      // the only record of who initiated it is the click record (cross-origin
      // frame, href = the destination). First such click-open: allowed and
      // published IMMEDIATELY (the click is real; the destination's own
      // redirects stay checked as they happen)...
      cdpStub.stateValue = {
        open: null,
        click: { t: Date.now(), isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'victim.example.com', href: 'https://sponsored-offers.example.org/deal' },
      };
      clickOn(page.webContents);
      page.webContents.__openHandler({ url: 'https://sponsored-offers.example.org/deal', disposition: 'foreground-tab' });
      await settle();
      assert.ok(!findInspector(known), 'a real link click no longer waits on a hidden inspector');
      assert.ok(openPublished('https://sponsored-offers.example.org/deal'), 'the first cross-origin link click was published at once');
      // An ad unit firing a SECOND cross-origin click-through within the
      // repeat window (same tab!) is blocked outright — the rate limit still
      // catches the click-to-paywall pattern a window.open-only check misses.
      cdpStub.stateValue = {
        open: null,
        click: { t: Date.now(), isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'victim.example.com', href: 'https://sponsored-offers.example.org/deal-3' },
      };
      clickOn(page.webContents);
      page.webContents.__openHandler({ url: 'https://sponsored-offers.example.org/deal-3', disposition: 'foreground-tab' });
      await settle();
      assert.ok(!findInspector(known), 'the second cross-origin click was blocked (nothing created)');
      assert.ok(!openPublished('https://sponsored-offers.example.org/deal-3'), 'no chip for the repeat');
    } finally {
      await closeTabs('h-13');
      cdpStub.pageStateEnabled = false;
      cdpStub.stateValue = null;
    }
  });

  await t.test('legitimate: a top-frame target=_blank click is not misattributed to an ad iframe', async () => {
    cdpStub.pageStateEnabled = true;
    try {
      const { view: page, known } = await freshTab('h-14', 'https://victim.example.com/');
      // Same page, but the user clicked the page's OWN target=_blank link in
      // the top document: the click record is top-frame / same-origin and its
      // href is the destination. The attribution rule must not treat this as
      // an ad-iframe open — even though an ad iframe's stale window.open
      // record from 2 s earlier is still in the page state (the real fmhy
      // situation).
      cdpStub.stateValue = {
        open: { t: Date.now() - 2000, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'victim.example.com' },
        click: { t: Date.now(), isTop: true, crossOrigin: false, frameHost: 'victim.example.com', topHost: 'victim.example.com', href: 'https://docs.example.com/guide' },
      };
      clickOn(page.webContents);
      page.webContents.__openHandler({ url: 'https://docs.example.com/guide', disposition: 'foreground-tab' });
      await settle();
      assert.ok(!findInspector(known), 'a top-frame link click is not held in an inspector');
      assert.ok(openPublished('https://docs.example.com/guide'), 'the legitimate top-frame link was published at once');
    } finally {
      await closeTabs('h-14');
      cdpStub.pageStateEnabled = false;
      cdpStub.stateValue = null;
    }
  });

  await t.test('legitimate: a clicked link to an honest site opens a working tab immediately', async () => {
    const { view: page, known } = await freshTab('h-12', 'https://victim.example.com/');
    const viewsBefore = winStub().contentView.__views.length;
    clickOn(page.webContents);
    page.webContents.__openHandler({ url: 'https://docs.example.com/guide', disposition: 'foreground-tab' });
    await settle();
    // The tab chip is published AT THE CLICK — no hidden inspector, no
    // verification round trip, no DevTools state read on the critical path.
    assert.ok(!findInspector(known), 'a real link click does not wait on verification');
    assert.ok(openPublished('https://docs.example.com/guide'), 'the legitimate link was published at once');
    // The renderer opens it; the tab is a real, visible, navigated tab.
    const tab = await freshTab('tab-h12', 'https://docs.example.com/guide');
    known.add(tab.view);
    assert.equal(winStub().contentView.__views.length, viewsBefore + 1, 'exactly one new view');
    assert.equal(tab.view.__visible, true, 'the tab view is on screen');
    assert.equal(tab.view.webContents.__url, 'https://docs.example.com/guide', 'the page was loaded');
    assert.deepEqual(tab.view.__bounds, { x: 0, y: 96, width: 1440, height: 904 }, 'the tab is laid out below the chrome');
    await closeTabs('h-12', 'tab-h12');
    await calls.ipcHandles.get('core:close')(fakeEvent(), 'tab-h12');
  });

  await t.test('media fullscreen: the header hides immediately, reveals on activity, re-hides after ten idle seconds', async () => {
    const { view, known } = await freshTab('m-1', 'https://video.example.com/');
    const hiddenSends = () => calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === false).length;
    const visibleSends = () => calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === true).length;
    try {
    const h0 = hiddenSends();
    view.webContents.emit('enter-html-full-screen');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(hiddenSends() > h0, 'the header hid IMMEDIATELY, not after the inactivity timeout');
    assert.equal(winStub().__maximized, true, 'media maximises the window for a stable transition');
    assert.deepEqual(calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1).payload, { media: true, window: false });

    const v0 = visibleSends();
    view.webContents.emit('before-mouse-event', {}, { type: 'mouseDown' });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(visibleSends() > v0, 'mouse movement revealed the header over the player');

    const h1 = hiddenSends();
    await new Promise(resolve => setTimeout(resolve, 10600));
    assert.ok(hiddenSends() > h1, 'ten idle seconds re-hid the header while media was fullscreen');

    const v1 = visibleSends();
    view.webContents.emit('leave-html-full-screen');
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.ok(visibleSends() > v1, 'media exit restored the header');
    assert.equal(winStub().__maximized, false, 'the window unmaximised with the media');
    assert.equal(winStub().__fullscreen, false, 'no OS fullscreen transition leaked in or out');
    assert.deepEqual(calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1).payload, { media: false, window: false });
    assert.ok(known.has(view), 'the tab view survived the whole cycle');
    } finally {
      await closeTabs('m-1');
    }
  });

  await t.test('site links (the fmhy.net failure): a fresh click opens at once, no DevTools needed', async () => {
    // No CDP at all — the exact degraded path the packaged app was on.
    // The click is admitted SYNCHRONOUSLY from the browser's input pipeline
    // (before-mouse-event): no DevTools state read on the critical path, so
    // an ad-heavy page's congested DevTools session can neither delay nor
    // deny the user's real click.
    cdpStub.pageStateEnabled = false;
    cdpStub.attachEnabled = false;
    try {
      const { view: page, known } = await freshTab('fmhy-1', 'https://fmhy.net/');
      clickOn(page.webContents);
      page.webContents.__openHandler({ url: 'https://fmhy.net/movie/watch-123', disposition: 'foreground-tab' });
      await settle();
      assert.ok(!findInspector(known), 'the fresh link click is not held in an inspector');
      assert.ok(openPublished('https://fmhy.net/movie/watch-123'), 'the fresh link click was published at once (no CDP)');
      // The renderer materialises the tab. The site's 302 hops to its
      // player/CDN domain — for a link click that is the user following the
      // site's own redirects, and the redirect stays checked as it happens
      // (a listed ad would close the tab; an honest CDN does not).
      const tab = await freshTab('fmhy-tab-1', 'https://fmhy.net/movie/watch-123');
      tab.view.webContents.emit('will-redirect', {}, 'https://player-cdn.example.net/embed/123');
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(known.has(tab.view) || winStub().contentView.__views.includes(tab.view), 'the honest cross-domain redirect kept the tab');
    } finally {
      await closeTabs('fmhy-1', 'fmhy-tab-1');
    }
  });

  await t.test('dedup: five rapid clicks on the same new-tab link open exactly ONE tab (dropped, never queued)', async () => {
    const { view: page } = await freshTab('dd-1', 'https://victim.example.com/');
    const url = 'https://docs.example.com/same-link';
    const opens = () => calls.sends.filter(s => s.channel === 'core:open-tab' && s.payload.url === url).length;
    const before = opens();
    // Five rapid clicks: each click is REAL (fresh pipeline evidence every
    // time), so the burst can only be stopped by dedup, not by evidence.
    for (let i = 0; i < 5; i += 1) {
      clickOn(page.webContents);
      page.webContents.__openHandler({ url, disposition: 'foreground-tab' });
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    await settle();
    assert.equal(opens(), before + 1, 'exactly one tab was published for five clicks — nothing accumulated');
    // The pending window has expired: a later deliberate click opens again
    // (the user's link is not permanently stuck).
    await new Promise(resolve => setTimeout(resolve, 1600));
    clickOn(page.webContents);
    page.webContents.__openHandler({ url, disposition: 'foreground-tab' });
    await settle();
    assert.equal(opens(), before + 2, 'after the dedup window a new click opens a new tab');
    await closeTabs('dd-1');
  });

  await t.test('an immediate link tab whose destination redirects to a listed ad is closed promptly', async () => {
    const { view: page } = await freshTab('rt-1', 'https://victim.example.com/');
    const url = 'https://redirector.example.com/gate';
    clickOn(page.webContents);
    page.webContents.__openHandler({ url, disposition: 'foreground-tab' });
    await settle();
    assert.ok(openPublished(url), 'the click opened the tab (the declared destination itself is not listed)');
    // The renderer materialises the tab; the redirect check is armed.
    const tab = await freshTab('rt-tab', url);
    // The destination 302s to a listed ad network — checked as it happens,
    // and the tab is rejected (closed) promptly, not "allowed and closed later".
    tab.view.webContents.emit('will-redirect', {}, 'https://pagead2.googlesyndication.com/landing');
    await new Promise(resolve => setTimeout(resolve, 150));
    assert.ok(!winStub().contentView.__views.includes(tab.view), 'the redirect-to-ad closed the tab');
    assert.ok(calls.sends.some(s => s.channel === 'core:popup-blocked'), 'the block was reported');
    await closeTabs('rt-1', 'rt-tab');
  });

  await t.test('double-click on a new-tab link: the first click tab closes and the dialog opens', async () => {
    cdpStub.pageStateEnabled = true;
    cdpStub.attachEnabled = true;
    try {
      const { view: page } = await freshTab('db-1', 'https://site.test/page');
      // Wait for syncPageScripts to attach CDP and register the message listener.
      const started = Date.now();
      while (!cdpMessageListener && Date.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 25));
      const linkContextId = 4000;
      emitCdp('Runtime.executionContextCreated', { context: { id: linkContextId, name: 'cc-links' } });
      const url = 'https://site.test/article';
      // Click 1: the browser opens the tab natively; main publishes it at once.
      clickOn(page.webContents);
      page.webContents.__openHandler({ url, disposition: 'foreground-tab' });
      await settle();
      assert.ok(openPublished(url), 'the single click opened the tab');
      // The renderer materialises the tab (what the real renderer does on core:open-tab).
      const tab = await freshTab('db-tab', url);
      assert.ok(winStub().contentView.__views.includes(tab.view), 'the first click tab exists');
      // Click 2 within the double window: the isolated script emits the
      // dialog message — from the PAGE's own world (targeted: each
      // webContents has its own CDP message listener).
      emitCdp('Runtime.consoleAPICalled', { type: 'log', executionContextId: linkContextId, args: [{ type: 'string', value: '%CC-LINK% ' + JSON.stringify({ t: 'dialog', url, text: 'Article', media: false, isTop: true, crossOrigin: false }) }] }, page.webContents);
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.ok(!winStub().contentView.__views.includes(tab.view), 'the double-click closed the first click tab');
      assert.ok(calls.sends.some(s => s.channel === 'core:tab-closed' && s.payload.id === 'db-tab'), 'the renderer was told the tab closed');
      const dialogsNow = BrowserWindowStub.windows.filter(w => w.__dialog);
      assert.equal(dialogsNow.length, 1, 'the link-options dialog opened');
      assert.equal(dialogsNow.at(-1).__shown, true, 'the dialog is shown');
      // "Open in new tab" from the dialog re-opens the link (the key was
      // released when the tab closed) — the double-click did not eat the
      // user's intent, it offered it as a choice.
      const dialogEvent = { sender: dialogsNow.at(-1).webContents, senderFrame: dialogsNow.at(-1).webContents.mainFrame };
      const opensBefore = calls.sends.filter(s => s.channel === 'core:open-tab' && s.payload.url === url).length;
      await calls.ipcHandles.get('core:dialog')(dialogEvent, 'open-tab', { url, sourceTabId: 'db-1' });
      await settle();
      assert.equal(calls.sends.filter(s => s.channel === 'core:open-tab' && s.payload.url === url).length, opensBefore + 1, 'the dialog action re-opened the link');
    } finally {
      await closeTabs('db-1', 'db-tab');
      for (const w of BrowserWindowStub.windows.filter(w => w.__dialog)) if (!w.__destroyed) w.close();
      cdpStub.pageStateEnabled = false;
      cdpStub.attachEnabled = false;
    }
  });

  await t.test('a scripted popup that redirects across domains is STILL blocked (the popunder rule keeps working)', async () => {
    cdpStub.pageStateEnabled = false;
    cdpStub.attachEnabled = false;
    try {
      const { view: page, known } = await freshTab('fu-1', 'https://victim.example.com/');
      clickOn(page.webContents);
      // A click exists (gesture) but the OPEN is scripted window.open (no
      // matching click record): viaLinkClick stays false.
      page.webContents.__openHandler({ url: 'https://victim.example.com/empty', disposition: 'default' });
      await settle();
      const inspector = findInspector(known);
      assert.ok(inspector, 'the scripted open is verified');
      inspector.webContents.__url = 'https://totally-different-domain.example.net/capture';
      inspector.webContents.emit('did-commit-navigation');
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.ok(!openPublished('https://victim.example.com/empty'), 'the cross-domain scripted open was not published');
      assert.ok(calls.sends.some(s => s.channel === 'core:popup-blocked'), 'the block was logged');
    } finally {
      await closeTabs('fu-1');
    }
  });

  await t.test('double-click pipeline: the isolated link world opens the options dialog', async () => {
    cdpStub.pageStateEnabled = true;
    cdpStub.attachEnabled = true;
    try {
      const { view: page, known } = await freshTab('l-1', 'https://site.test/page');
      // Wait for syncPageScripts to attach CDP and register the message
      // listener (attach happens asynchronously in the sync queue).
      const started = Date.now();
      while (!cdpMessageListener && Date.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 25));
      assert.ok(cdpMessageListener, 'CDP is attached and listening');
      // The isolated "cc-links" world gets its own execution context.
      const linkContextId = 4000;
      emitCdp('Runtime.executionContextCreated', { context: { id: linkContextId, name: 'cc-links' } });
      // A double-clicked anchor reports through the magic console channel.
      const link = { t: 'dialog', url: 'https://site.test/destination?x=1', text: 'The long article title', media: false, isTop: true, crossOrigin: false, target: 'blank' };
      emitCdp('Runtime.consoleAPICalled', { type: 'log', executionContextId: linkContextId, args: [{ type: 'string', value: '%CC-LINK% ' + JSON.stringify(link) }] });
      await new Promise(resolve => setTimeout(resolve, 100));
      const dialogsNow = BrowserWindowStub.windows.filter(w => w.__dialog);
      assert.equal(dialogsNow.length, 1, 'exactly one link-options window was created');
      const dlg = dialogsNow[0];
      assert.equal(dlg.webContents.__url, 'file://' + path.join(__dirname, '../renderer/index.html') + '?linkDialog=1', 'the dialog loads the renderer in dialog mode');
      assert.equal(dlg.__shown, true, 'the dialog window is actually SHOWN (ready-to-show -> show()); a hidden dialog is the "double-click does nothing" defect');
      const dataSend = calls.sends.find(s => s.channel === 'core:dialog-data' && s.payload && s.payload.url === link.url);
      assert.ok(dataSend, 'the dialog received the link data');
      assert.equal(dataSend.payload.sourceTabId, 'l-1', 'the source tab is known for "Open link"');

      // Anti-spoof: the same magic message from the MAIN world (a different
      // context id) must be ignored.
      emitCdp('Runtime.consoleAPICalled', { type: 'log', executionContextId: 12345, args: [{ type: 'string', value: '%CC-LINK% ' + JSON.stringify(link) }] });
      await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(BrowserWindowStub.windows.filter(w => w.__dialog).length, 1, 'a forged main-world message opened nothing');

      // "Copy link address" goes through the trusted dialog IPC.
      const dialogEvent = { sender: dlg.webContents, senderFrame: dlg.webContents.mainFrame };
      await calls.ipcHandles.get('core:dialog')(dialogEvent, 'copy', { url: link.url, sourceTabId: 'l-1' });
      assert.deepEqual(calls.clipboard.at(-1), 'https://site.test/destination?x=1', 'the address was copied');
      assert.equal(dlg.__destroyed, true, 'the dialog closed after the action');

      // "Open in new window" creates a protected standalone window.
      emitCdp('Runtime.consoleAPICalled', { type: 'log', executionContextId: linkContextId, args: [{ type: 'string', value: '%CC-LINK% ' + JSON.stringify(link) }] });
      await new Promise(resolve => setTimeout(resolve, 100));
      const dlg2 = BrowserWindowStub.windows.filter(w => w.__dialog).at(-1);
      assert.ok(dlg2, 'a second dialog for the next double-click');
      const dialogEvent2 = { sender: dlg2.webContents, senderFrame: dlg2.webContents.mainFrame };
      await calls.ipcHandles.get('core:dialog')(dialogEvent2, 'open-window', { url: link.url, sourceTabId: 'l-1' });
      const standalone = BrowserWindowStub.windows.find(w => !w.__dialog && w !== winStub());
      assert.ok(standalone, 'a standalone browsing window was created');
      assert.equal(standalone.webContents.__url, 'https://site.test/destination?x=1', 'it navigated to the link');
      assert.ok(standalone.webContents.__openHandler, 'it has the popup policy wired (identical protection)');
      standalone.close();
    } finally {
      await closeTabs('l-1');
      cdpStub.pageStateEnabled = false;
      cdpStub.attachEnabled = false;
    }
  });

  await t.test('double-click "commit" routing: blank goes through the popup policy, top navigates, download goes to the hidden carrier', async () => {
    cdpStub.pageStateEnabled = true;
    cdpStub.attachEnabled = true;
    try {
      const { view: page, known } = await freshTab('l-2', 'https://site.test/page');
      const started = Date.now();
      while (!cdpMessageListener && Date.now() - started < 2000) await new Promise(resolve => setTimeout(resolve, 25));
      const linkContextId = 4000;
      emitCdp('Runtime.executionContextCreated', { context: { id: linkContextId, name: 'cc-links' } });
      const commit = over => emitCdp('Runtime.consoleAPICalled', { type: 'log', executionContextId: linkContextId, args: [{ type: 'string', value: '%CC-LINK% ' + JSON.stringify(over) }] });

      // target=_blank with NO recent input (a page script "double-clicked"
      // the anchor): the open is denied — no real input passed through the
      // browser's input pipeline, so the commit carries no evidence.
      commit({ t: 'commit', url: 'https://site.test/blank-no-gesture', text: 'x', media: false, isTop: true, crossOrigin: false, target: 'blank' });
      await settle();
      assert.ok(!openPublished('https://site.test/blank-no-gesture'), 'a blank commit without real input is blocked');

      // With a real click, the blank commit is published at once (the same
      // immediate path a native target=_blank open gets).
      clickOn(page.webContents);
      commit({ t: 'commit', url: 'https://site.test/blank-ok', text: 'x', media: false, isTop: true, crossOrigin: false, target: 'blank' });
      await settle();
      assert.ok(!findInspector(known), 'the clicked blank commit does not wait on verification');
      assert.ok(openPublished('https://site.test/blank-ok'), 'the clicked blank commit was published at once');

      // A same-document commit navigates the TAB (no new window at all).
      const urlBefore = page.webContents.__url;
      commit({ t: 'commit', url: 'https://site.test/in-place', text: 'x', media: false, isTop: true, crossOrigin: false, target: 'top' });
      await settle();
      assert.notEqual(page.webContents.__url, urlBefore, 'the tab navigated in place');
      assert.equal(page.webContents.__url, 'https://site.test/in-place');
    } finally {
      await closeTabs('l-2');
      cdpStub.pageStateEnabled = false;
      cdpStub.attachEnabled = false;
    }
  });

  await t.test('permissions: fullscreen is allowed, tracker abuses stay denied', async () => {
    assert.ok(calls.permissions, 'a permission request handler is installed');
    const decide = permission => new Promise(resolve => calls.permissions({}, permission, resolve));
    // YouTube's own fullscreen button calls requestFullscreen() — denying
    // the permission made every video player "refuse fullscreen".
    assert.equal(await decide('fullscreen'), true, 'video fullscreen is allowed');
    assert.equal(await decide('notifications'), false, 'notification abuse stays denied');
    assert.equal(await decide('media'), false, 'camera/microphone stays denied');
    assert.equal(await decide('geolocation'), false, 'geolocation stays denied');
  });

  await t.test('the window control and F11 toggle true browser fullscreen', async () => {
    calls.ipcOn.get('core:window')(fakeEvent(), 'fullscreen');
    assert.equal(winStub().__fullscreen, true, 'the OS window entered fullscreen');
    let state = calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1);
    assert.deepEqual(state.payload, { media: false, window: true }, 'the button state follows the window');

    // The button must work repeatedly: enter, exit, enter — no stuck state.
    for (let round = 0; round < 2; round += 1) {
      calls.ipcOn.get('core:window')(fakeEvent(), 'fullscreen');
      assert.equal(winStub().__fullscreen, false, `round ${round}: exited`);
      state = calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1);
      assert.deepEqual(state.payload, { media: false, window: false }, `round ${round}: icon back to inactive`);
      calls.ipcOn.get('core:window')(fakeEvent(), 'fullscreen');
      assert.equal(winStub().__fullscreen, true, `round ${round}: re-entered`);
      state = calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1);
      assert.deepEqual(state.payload, { media: false, window: true }, `round ${round}: icon purple again`);
    }

    // F11 from the app renderer exits again.
    winStub().webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'F11' });
    assert.equal(winStub().__fullscreen, false, 'F11 exited browser fullscreen');

    // Escape exits while the app renderer has focus (address bar, etc.).
    calls.ipcOn.get('core:window')(fakeEvent(), 'fullscreen');
    assert.equal(winStub().__fullscreen, true, 'entered fullscreen again');
    winStub().webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'Escape' });
    assert.equal(winStub().__fullscreen, false, 'Escape exited browser fullscreen');
    state = calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1);
    assert.deepEqual(state.payload, { media: false, window: false }, 'the icon left the active state');
  });

  await t.test('media fullscreen never flips the browser-fullscreen button state', async () => {
    await calls.ipcHandles.get('core:focus')(fakeEvent(), 'fs-tab', true);
    await calls.ipcHandles.get('core:navigate')(fakeEvent(), 'fs-tab', 'https://video.example.com/');
    const view = winStub().contentView.__views[0];
    view.webContents.emit('enter-html-full-screen');
    const duringMedia = calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1);
    assert.deepEqual(duringMedia.payload, { media: true, window: false }, 'media is maximise, not OS fullscreen');
    view.webContents.emit('leave-html-full-screen');
    const afterMedia = calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1);
    assert.deepEqual(afterMedia.payload, { media: false, window: false }, 'state fully restored after media exit');
    assert.equal(winStub().__fullscreen, false, 'no OS transition leaked into or out of media fullscreen');
    await calls.ipcHandles.get('core:close')(fakeEvent(), 'fs-tab');
  });

  await t.test('quitting persists the workspace atomically', () => {
    const store = path.join(userDataDir, 'workspace.json');
    appListeners.get('before-quit').forEach(fn => fn());
    assert.ok(fs.existsSync(store), 'workspace.json was written');
    const saved = JSON.parse(fs.readFileSync(store, 'utf8'));
    assert.ok(saved.protection, 'protection settings persisted');
    assert.ok(saved.stats, 'stats persisted');
  });
});

test('cleanup', () => {
  fs.rmSync(userDataDir, { recursive: true, force: true });
});
