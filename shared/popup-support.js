/*
 * ChromiumCore popup support (document start, isolated world "cc-popup").
 *
 * Injected into the top frame of every external page before any page script
 * runs. Desktop injects it through the DevTools protocol with an explicit
 * worldName, so it executes in its own JavaScript world: page scripts cannot
 * read, reset or fake the state below (a page that could, would simply
 * report a fake user gesture for every scripted popup it fires).
 *
 * It records when the page last had a real user activation (pointer, key or
 * touch). The main process reads { t } through Runtime.evaluate in this world
 * and compares it against its own (unspoofable) input observation; the
 * per-gesture quota is counted by the main process, so this script only
 * supplies the activation clock.
 *
 * It never blocks anything itself and never throws into the page.
 */
(function () {
  'use strict';
  try {
    if (window.top !== window) return; // top frame only; in-frame input is seen by the main process
    if (window.__ccPopupState) return;
    var state = { t: 0 };
    Object.defineProperty(window, '__ccPopupState', { value: state });
    function noteActivity() {
      state.t = Date.now();
    }
    var events = ['pointerdown', 'keydown', 'touchstart'];
    for (var i = 0; i < events.length; i += 1) {
      try {
        document.addEventListener(events[i], noteActivity, { capture: true, passive: true });
      } catch (error) { /* some pages lock the event table; skip */ }
    }
  } catch (error) {
    /* Popup support is best-effort; the page must never be broken by it. */
  }
})();
