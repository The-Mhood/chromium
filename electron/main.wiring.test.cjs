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
};

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromiumcore-wiring-'));

function makeWebContents(id) {
  const listeners = new Map();
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
    send: (channel, payload) => calls.sends.push({ id, channel, payload }),
    setWindowOpenHandler: fn => { wc.__openHandler = fn; },
    on: (event, fn) => { listeners.set(event, [...(listeners.get(event) || []), fn]); },
    emit: (event, ...args) => { for (const fn of listeners.get(event) || []) fn(...args); },
    debugger: {
      isAttached: () => false,
      attach: () => { throw new Error('CDP unavailable in wiring smoke (degraded path)'); },
      on: () => {},
      sendCommand: () => Promise.reject(new Error('no CDP')),
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

class BrowserWindowStub {
  static windows = [];
  constructor(_options) {
    this.webContents = makeWebContents(1);
    this.__listeners = new Map();
    this.__once = new Map();
    this.__fullscreen = false;
    this.__destroyed = false;
    this.contentView = {
      __views: [],
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
  show() { this.emit('ready-to-show'); }
  close() { this.emit('closed'); }
  isDestroyed() { return this.__destroyed; }
  getContentSize() { return [1440, 1000]; }
  setFullScreen(value) { this.__fullscreen = value; }
  isFullScreen() { return this.__fullscreen; }
  getBounds() { return { x: 0, y: 0, width: 1440, height: 1000 }; }
  isFocused() { return true; }
  minimize() {}
  maximize() {}
  isMaximized() { return false; }
  unmaximize() {}
  loadFile() {}
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
      on: () => {},
    }),
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

  await t.test('an unlisted destination opens a tab (degraded mode never breaks sites)', async () => {
    const view = winStub().contentView.__views[0];
    // No CDP in this smoke: the page cannot report activation and no input
    // event was observed, so the policy runs in degraded mode — it allows the
    // open (never breaking ordinary sites) and arms the popunder watch.
    view.webContents.__openHandler({ url: 'https://docs.example.com/new', disposition: 'default' });
    await new Promise(resolve => setTimeout(resolve, 300));
    const opens = calls.sends.filter(s => s.channel === 'core:open-tab');
    assert.ok(opens.some(s => s.payload.url === 'https://docs.example.com/new'), 'the tab open was published to the renderer');
    assert.equal(winStub().contentView.__views.length, 1, 'the main process does not create the view itself');
  });

  await t.test('the chrome hides after seven idle seconds and reveals on activity', async () => {
    const view = winStub().contentView.__views[0];
    const hiddenBefore = calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === false).length;

    // The idle timer ticks every 250 ms with a static cursor; the last
    // activity was at startup, so the chrome must hide within ~7.3 s.
    await new Promise(resolve => setTimeout(resolve, 7500));
    const hiddenAfter = calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === false).length;
    assert.ok(hiddenAfter > hiddenBefore, 'the chrome was hidden after seven idle seconds');
    await new Promise(resolve => setTimeout(resolve, 400));
    assert.deepEqual(view.__bounds, { x: 0, y: 0, width: 1440, height: 1000 },
      'the page view expanded to the full window while the chrome is hidden');

    // A mouse event reveals the chrome and restores the layout.
    const visibleBefore = calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === true).length;
    winStub().webContents.emit('before-input-event', {}, { type: 'mouseDown' });
    await new Promise(resolve => setTimeout(resolve, 400));
    const visibleAfter = calls.sends.filter(s => s.channel === 'core:chrome-visibility' && s.payload === true).length;
    assert.ok(visibleAfter > visibleBefore, 'activity revealed the chrome');
    assert.deepEqual(view.__bounds, { x: 0, y: 96, width: 1440, height: 904 },
      'the layout returned below the chrome');
  });

  await t.test('closing a tab removes its view and state', async () => {
    await calls.ipcHandles.get('core:close')(fakeEvent(), 'tab-1');
    assert.equal(winStub().contentView.__views.length, 0, 'the view was removed from the window');
  });

  await t.test('the window control and F11 toggle true browser fullscreen', async () => {
    calls.ipcOn.get('core:window')(fakeEvent(), 'fullscreen');
    assert.equal(winStub().__fullscreen, true, 'the OS window entered fullscreen');
    const state = calls.sends.filter(s => s.channel === 'core:fullscreen-state').at(-1);
    assert.deepEqual(state.payload, { media: false, window: true });

    // F11 from the app renderer exits again.
    winStub().webContents.emit('before-input-event', {}, { type: 'keyDown', key: 'F11' });
    assert.equal(winStub().__fullscreen, false, 'F11 exited browser fullscreen');
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
