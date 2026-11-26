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
//   - Browser fullscreen: the user explicitly took the window fullscreen.
//   - Media fullscreen: a page's element is in the HTML fullscreen state,
//     owned by the tab whose document entered it.
// The OS window is fullscreen iff the user asked for it OR the *active* tab
// owns a media fullscreen. Chrome visibility is a third, independent state:
// it is forced off while media is active, and otherwise auto-hides after
// seven seconds of inactivity (only while focused and while an external page
// or browser fullscreen is on screen), revealing on any activity.
//
// Previously these were scattered booleans in main.cjs with no single owner;
// that is what produced the "stuck in fullscreen" states (closing the owning
// tab never cleared them) and the geometry races (layout computed from a
// stale window size mid-transition).
// ---------------------------------------------------------------------------

const IDLE_MS = 7000;

class FullscreenController {
  constructor(options = {}) {
    this.idleMs = options.idleMs ?? 7000;
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

  /** The OS window should be fullscreen in exactly these situations. */
  get wantsWindowFullscreen() {
    return this.userFullscreen || (this.mediaTabId !== null && this.mediaTabId === this.activeTabId);
  }

  get mediaActive() {
    return this.mediaTabId !== null && this.mediaTabId === this.activeTabId;
  }

  /** Chrome is off-screen while hidden by the idle rule, or while media is active. */
  chromeHidden() {
    return !this.chromeVisible || this.mediaActive;
  }

  viewTop() {
    return this.chromeHidden() ? 0 : this.chromeHeight;
  }

  autoHideAllowed() {
    return this.mediaTabId === null && this._windowFocused && (this._showingExternal || this.userFullscreen);
  }

  // ------------------------------------------------------------------ state

  /** Any user interaction in the window or a page. */
  activity() {
    this._lastActivityAt = this._now();
    if (!this.chromeVisible && this.autoHideAllowed()) {
      this.chromeVisible = true;
      this._emit({ type: 'chrome', visible: true });
      this._emit({ type: 'layout' });
    }
  }

  /** Idle-timer tick, driven by the main process (every ~250 ms). */
  tick({ windowFocused, showingExternal, cursorMoved = false } = {}) {
    if (windowFocused !== undefined) this._windowFocused = windowFocused;
    if (showingExternal !== undefined) this._showingExternal = showingExternal;
    if (cursorMoved) this._lastActivityAt = this._now();
    if (this.autoHideAllowed() && this.chromeVisible && this._now() - this._lastActivityAt >= this.idleMs) {
      this.chromeVisible = false;
      this._emit({ type: 'chrome', visible: false });
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

  /** A tab's document entered the HTML fullscreen state. */
  mediaEnter(tabId) {
    if (this.mediaTabId === tabId) return;
    const before = this._wants();
    this.mediaTabId = tabId;
    if (this.mediaTabId === this.activeTabId && this.chromeVisible) {
      this.chromeVisible = false;
      this._emit({ type: 'chrome', visible: false });
    }
    this._maybeEmitWindow(before);
    this._emit({ type: 'layout' });
  }

  /** A tab's document left the HTML fullscreen state (Esc, API, navigation, close). */
  mediaLeave(tabId) {
    if (this.mediaTabId !== tabId) return;
    const before = this._wants();
    this.mediaTabId = null;
    if (!this.chromeVisible) {
      this.chromeVisible = true;
      this._emit({ type: 'chrome', visible: true });
    }
    this._lastActivityAt = this._now();
    this._maybeEmitWindow(before);
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
    const before = this._wants();
    this.activeTabId = tabId;
    this._lastActivityAt = this._now();
    // A hidden tab's media fullscreen is abandoned when we look away; the real
    // state of the focused tab is re-synced below.
    if (this.mediaTabId !== null && this.mediaTabId !== tabId) this.mediaTabId = null;
    if (mediaIsFullscreen) this._adoptMedia(tabId, before);
    if (!this.chromeVisible && !this.mediaActive) {
      this.chromeVisible = true;
      this._emit({ type: 'chrome', visible: true });
    }
    this._maybeEmitWindow(before);
    this._emit({ type: 'layout' });
    return previousActive;
  }

  /** The focused tab actually reports HTML fullscreen (we missed the event). */
  adoptMedia(tabId) {
    this._adoptMedia(tabId, this._wants());
  }

  _adoptMedia(tabId, before) {
    if (this.mediaTabId === tabId) return;
    this.mediaTabId = tabId;
    if (this.chromeVisible) {
      this.chromeVisible = false;
      this._emit({ type: 'chrome', visible: false });
    }
    this._maybeEmitWindow(before);
    this._emit({ type: 'layout' });
  }

  /** A tab was closed. If it owned the media fullscreen, clear it: this is the
   *  transition that used to leave the app stuck in fullscreen. */
  tabClosed(tabId) {
    const before = this._wants();
    let changed = false;
    if (this.mediaTabId === tabId) {
      this.mediaTabId = null;
      changed = true;
    }
    if (changed && !this.chromeVisible) {
      this.chromeVisible = true;
      this._emit({ type: 'chrome', visible: true });
    }
    if (this.activeTabId === tabId) this.activeTabId = null;
    this._lastActivityAt = this._now();
    this._maybeEmitWindow(before);
    if (changed) this._emit({ type: 'layout' });
  }

  /** The OS told us the window entered/left native fullscreen. Reconcile:
   *  - media still wants it (display change) -> re-assert;
   *  - user fullscreen dropped by the OS (Esc / shortcut) -> treat as exited. */
  windowFullscreenChanged(actual) {
    const wants = this._wants();
    if (actual && !wants) {
      // The OS entered fullscreen on its own (user OS shortcut): adopt it so a
      // later toggle exits cleanly instead of fighting the OS.
      this.userFullscreen = true;
      return;
    }
    if (!actual && wants) {
      if (this.mediaTabId !== null && this.mediaTabId === this.activeTabId) {
        this._emit({ type: 'window-fullscreen', value: true });
        return;
      }
      this.userFullscreen = false;
      this._emit({ type: 'window-fullscreen', value: false });
    }
  }

  // ------------------------------------------------------------------ impl

  _wants() {
    return this.userFullscreen || (this.mediaTabId !== null && this.mediaTabId === this.activeTabId);
  }

  _maybeEmitWindow(before) {
    const after = this._wants();
    if (after !== before) this._emit({ type: 'window-fullscreen', value: after });
  }
}

module.exports = { FullscreenController, IDLE_MS };
