'use strict';

// ---------------------------------------------------------------------------
// ChromiumCore fullscreen + chrome-visibility state machine.
//
// Pure module (no Electron imports) so every transition can be unit tested in
// plain Node. The main process is the only writer; it forwards input events
// (media enter/leave, user toggle, focus, close, resize, activity, idle ticks)
// and applies the emitted effects (set the OS window fullscreen, show/hide the
// chrome, re-lay-out the WebContentsViews).
//
// Two independent fullscreen modes coexist:
//   - Browser fullscreen: the user explicitly took the window fullscreen
//     (F11 / maximize dot / OS shortcut). This is the ONLY thing that puts
//     the OS window into native fullscreen.
//   - Media fullscreen: a page's element is in the HTML fullscreen state,
//     owned by the tab whose document entered it. This is window-level:
//     the WebContentsView is laid out over the entire window and the chrome
//     is hidden. The document's fullscreen element already fills the
//     contents viewport, so no OS transition is needed. Deliberately NOT
//     routed through win.setFullScreen: layering an OS transition on top of
//     an active document-fullscreen makes Chromium tear the element down
//     (spurious leave-html-full-screen), which is why media fullscreen used
//     to appear broken or flash back out.
//
// Chrome visibility (the inactivity auto-hide) has ONE owner — this state
// machine — and ONE rule set, applied identically on macOS and Windows:
//
//   * The header is visible by default.
//   * ANY activity (mouse movement, click, key, wheel, window focus, tab
//     switch) reveals the header immediately and restarts the inactivity
//     clock — including while media is playing in fullscreen.
//   * Exactly IDLE_MS (10 s) after the last activity the header hides:
//       - in the hide context: the window is focused and an external page or
//         browser (window) fullscreen is on screen, or
//       - while media is fullscreen: the header was hidden immediately when
//         the media entered; after any reveal it hides again once the 10 s
//         elapse.
//   * When media exits, the header comes back and the clock restarts.
//
// The previous implementation let the renderer hide the header on its own
// (a second source of truth) and never revealed the chrome while media was
// active, which is what produced the "sometimes disappears, sometimes stays"
// behaviour and the 7 s instead of 10 s timeout.
// ---------------------------------------------------------------------------

const IDLE_MS = 10000;

class FullscreenController {
  constructor(options = {}) {
    this.idleMs = options.idleMs ?? IDLE_MS;
    this.chromeHeight = options.chromeHeight ?? 96;
    this._now = options.now || (() => Date.now());
    this._listeners = new Set();

    this.userFullscreen = false;
    this.mediaTabId = null;
    this.chromeVisible = true;
    this.activeTabId = options.activeTabId ?? null;
    this._lastActivityAt = this._now();
    this._windowFocused = options.windowFocused ?? true;
    this._showingExternal = options.showingExternal ?? false;
    this._size = { width: options.width || 0, height: options.height || 0 };
    this._mediaMaximized = false;
  }

  onEffect(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  _emit(effect) {
    for (const fn of this._listeners) {
      try { fn(effect); } catch { /* an effect sink must never kill the state machine */ }
    }
  }

  /** The OS window is in native fullscreen only for the user's own
   *  (browser) fullscreen. Media fullscreen is window-level and uses
   *  window-maximize instead, so a document-fullscreen element is never
   *  fought by an OS transition. */
  get wantsWindowFullscreen() {
    return this.userFullscreen;
  }

  get mediaActive() {
    return this.mediaTabId !== null && this.mediaTabId === this.activeTabId;
  }

  /** Chrome is off-screen only while this state machine says so. The
   *  renderer must not add its own hide rule: one source of truth keeps the
   *  CSS (header) and the view layout (page top) from ever disagreeing. */
  chromeHidden() {
    return !this.chromeVisible;
  }

  viewTop() {
    return this.chromeHidden() ? 0 : this.chromeHeight;
  }

  /** The 10 s idle hide only applies where the header belongs to the page:
   *  the window is focused AND an external page or browser fullscreen is on
   *  screen. Internal (workspace) pages and unfocused windows keep the
   *  header. */
  autoHideAllowed() {
    return this._windowFocused && (this._showingExternal || this.userFullscreen);
  }

  // ------------------------------------------------------------------ state

  /** Any user interaction in the window or a page — including while media is
   *  fullscreen: the header comes back and hides again after the idle time. */
  activity() {
    this._lastActivityAt = this._now();
    if (!this.chromeVisible) {
      this.chromeVisible = true;
      this._emit({ type: 'chrome', visible: true, reason: 'activity' });
      this._emit({ type: 'layout' });
    }
  }

  /** Idle-timer tick, driven by the main process (every ~250 ms). Hides the
   *  chrome exactly IDLE_MS after the last activity:
   *   - media fullscreen: the media already hid it on entry; this re-hides
   *     it after any activity-based reveal (immediate on entry, 10 s after
   *     the last interaction afterwards — never sooner);
   *   - otherwise: only in the auto-hide context (focused + page on screen). */
  tick({ windowFocused, showingExternal, cursorMoved = false } = {}) {
    if (windowFocused !== undefined) this._windowFocused = windowFocused;
    if (showingExternal !== undefined) this._showingExternal = showingExternal;
    if (cursorMoved) this._lastActivityAt = this._now();
    if (this.chromeVisible && this._now() - this._lastActivityAt >= this.idleMs &&
        (this.mediaActive || this.autoHideAllowed())) {
      this.chromeVisible = false;
      // 'idle-media': the media already hid the chrome on entry; this is a
      // re-hide after an activity-based reveal. 'idle': the plain 10 s rule
      // (focused window, external page on screen).
      this._emit({ type: 'chrome', visible: false, reason: this.mediaActive ? 'idle-media' : 'idle' });
      this._emit({ type: 'layout' });
    }
  }

  focusWindow() {
    this._windowFocused = true;
    this.activity();
  }

  blurWindow() {
    this._windowFocused = false;
  }

  /** The measured height of the React browser header (responsive CSS). */
  setChromeHeight(px) {
    const height = Math.round(px);
    if (height > 0 && height !== this.chromeHeight) {
      this.chromeHeight = height;
      this._emit({ type: 'layout' });
    }
  }

  /** The window content size changed (OS resize, fullscreen animation, display change). */
  resize(width, height) {
    this._size = { width, height };
    this._emit({ type: 'layout' });
  }

  get layoutSize() {
    return this._size || { width: 0, height: 0 };
  }

  // ------------------------------------------------------------------ input

  /** A tab's document entered the HTML fullscreen state. The header hides
   *  IMMEDIATELY (the "media is playing in fullscreen" rule) — and, for a
   *  background tab, the presentation is deferred until the tab is focused. */
  mediaEnter(tabId) {
    this._adoptMedia(tabId);
  }

  /** A tab's document left the HTML fullscreen state (Esc, API, navigation, close). */
  mediaLeave(tabId) {
    if (this.mediaTabId !== tabId) return;
    this.mediaTabId = null;
    if (this._mediaMaximized) {
      this._mediaMaximized = false;
      this._emit({ type: 'window-maximize', on: false });
    }
    if (!this.chromeVisible) {
      this.chromeVisible = true;
      this._emit({ type: 'chrome', visible: true, reason: 'media-leave' });
    }
    this._lastActivityAt = this._now();
    this._emit({ type: 'layout' });
  }

  /** The user toggled browser (window) fullscreen: maximize dot, F11, OS shortcut. */
  userToggle() {
    const before = this._wants();
    this.userFullscreen = !this.userFullscreen;
    this._lastActivityAt = this._now();
    this._maybeEmitWindow(before);
    this._emit({ type: 'layout' });
  }

  /** Request a specific user-fullscreen value (e.g. Escape while user-fullscreen). */
  setUserFullscreen(value) {
    if (this.userFullscreen === value) return;
    const before = this._wants();
    this.userFullscreen = value;
    this._lastActivityAt = this._now();
    this._maybeEmitWindow(before);
    this._emit({ type: 'layout' });
  }

  /** A different tab became active. `mediaIsFullscreen` is the real
   *  webContents.isFullscreen() of the focused tab (source of truth). */
  tabFocused(tabId, { mediaIsFullscreen = false } = {}) {
    const previousActive = this.activeTabId;
    this.activeTabId = tabId;
    this._lastActivityAt = this._now();
    // A hidden tab's media fullscreen is abandoned when we look away; the real
    // state of the focused tab is re-synced below.
    if (this.mediaTabId !== null && this.mediaTabId !== tabId) this._abandonMedia();
    if (mediaIsFullscreen) this._adoptMedia(tabId);
    if (!this.chromeVisible && !this.mediaActive) {
      this.chromeVisible = true;
      this._emit({ type: 'chrome', visible: true, reason: 'tab-focus' });
    }
    this._emit({ type: 'layout' });
    return previousActive;
  }

  /** The focused tab actually reports HTML fullscreen (we missed the event). */
  adoptMedia(tabId) {
    this._adoptMedia(tabId);
  }

  _adoptMedia(tabId) {
    this.mediaTabId = tabId;
    if (tabId !== this.activeTabId) return; // background: presented when focused
    if (this.chromeVisible) {
      // Media is playing in fullscreen: the header goes away NOW, without
      // waiting for the inactivity timeout.
      this.chromeVisible = false;
      this._emit({ type: 'chrome', visible: false, reason: 'media-enter' });
    }
    this._lastActivityAt = this._now();
    if (!this.userFullscreen && !this._mediaMaximized) {
      // Window-level media fullscreen: grow the window so the document's
      // fullscreen element can cover the screen. No OS transition — those
      // race with the active fullscreen element and tore it down.
      this._mediaMaximized = true;
      this._emit({ type: 'window-maximize', on: true });
    }
    this._emit({ type: 'layout' });
  }

  /** Abandon media fullscreen owned by a tab we are no longer looking at
   *  (hidden tabs don't keep the window maximized). */
  _abandonMedia() {
    this.mediaTabId = null;
    if (this._mediaMaximized) {
      this._mediaMaximized = false;
      this._emit({ type: 'window-maximize', on: false });
    }
  }

  /** A tab was closed. If it owned the media fullscreen, clear it: this is the
   *  transition that used to leave the app stuck in fullscreen. */
  tabClosed(tabId) {
    let changed = false;
    if (this.mediaTabId === tabId) {
      this.mediaTabId = null;
      changed = true;
      if (this._mediaMaximized) {
        this._mediaMaximized = false;
        this._emit({ type: 'window-maximize', on: false });
      }
    }
    if (changed && !this.chromeVisible) {
      this.chromeVisible = true;
      this._emit({ type: 'chrome', visible: true, reason: 'tab-closed' });
    }
    if (this.activeTabId === tabId) this.activeTabId = null;
    this._lastActivityAt = this._now();
    if (changed) this._emit({ type: 'layout' });
  }

  /** The OS told us the window entered/left native fullscreen. Reconcile:
   *  - OS entered on its own (user shortcut) -> adopt it;
   *  - OS dropped it while we still want it -> STRAY drop, keep the intent.
   *
   *  An intentional exit (F11 / Escape / maximize dot / the media session
   *  ending) always goes through userToggle() or setUserFullscreen(false)
   *  FIRST — those clear userFullscreen and emit the window effect before
   *  the OS transition completes, so by the time this event lands
   *  userFullscreen is already false and nothing happens. A drop that still
   *  finds userFullscreen true was never requested (taskbar click, Win+Down
   *  race, OS glitch) — the field contract is that the window stays in
   *  fullscreen until the session intentionally ends, so the intent is kept
   *  and the main process re-asserts the OS state (see the leave-full-screen
   *  handler and the re-assertion timer). */
  windowFullscreenChanged(actual) {
    if (actual && !this.userFullscreen) {
      this.userFullscreen = true;
      return;
    }
    if (!actual && this.userFullscreen) {
      return; // stray drop: keep the intent, the window is re-asserted
    }
  }

  // ------------------------------------------------------------------ impl

  _wants() {
    return this.userFullscreen;
  }

  _maybeEmitWindow(before) {
    const after = this._wants();
    if (after !== before) this._emit({ type: 'window-fullscreen', value: after });
  }
}

module.exports = { FullscreenController, IDLE_MS };
