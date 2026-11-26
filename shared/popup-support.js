/*
 * ChromiumCore popup support (document start, isolated world "cc-popup").
 *
 * Injected into EVERY frame of every external page (top frame and iframes)
 * before any page script runs. Desktop injects it through the DevTools
 * protocol with an explicit worldName, so it executes in its own JavaScript
 * world: page scripts cannot read, reset or fake the state below (a page
 * that could, would simply report a fake user gesture for every scripted
 * popup it fires).
 *
 * It records, per frame:
 *   - when the frame last had a real user activation (pointer, key, touch);
 *   - the details of the most recent window.open call made FROM THAT FRAME:
 *     whether it is the top frame, and whether the top document is
 *     cross-origin (the ad-iframe pattern: a third-party ad unit opens a
 *     tab "on" the user's click).
 *
 * The main process reads these through Runtime.evaluate in this world for
 * every frame of the page and compares them against its own (unspoofable)
 * input observation; the per-gesture quota is counted by the main process,
 * so this script only supplies the activation clock and the opener records.
 *
 * It never blocks anything itself and never throws into the page.
 */
(function () {
  'use strict';
  try {
    if (window.__ccPopupState) return;
    var state = { t: 0, lastOpen: null };
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

    function host(url) {
      try {
        return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
      } catch (error) {
        return '';
      }
    }

    // Wrap window.open in this frame (ad iframes included) so the main
    // process can see WHO is opening the tab. The wrapper only records; it
    // always hands the call through to the real window.open.
    var originalOpen = window.open;
    if (typeof originalOpen === 'function') {
      window.open = function () {
        try {
          var isTop = window.top === window;
          var frameHost = host(location.href);
          var crossOrigin = false;
          var topHost = frameHost;
          if (!isTop) {
            // Reading the top frame's location succeeds only when the top
            // document is same-origin with this frame; a cross-origin read
            // throws, which is exactly the signal we need.
            topHost = host(window.top.location.href);
            crossOrigin = topHost !== frameHost;
          }
          state.lastOpen = {
            t: Date.now(),
            isTop: isTop,
            crossOrigin: crossOrigin,
            frameHost: frameHost,
            topHost: topHost
          };
        } catch (error) { /* never break the page */ }
        return originalOpen.apply(window, arguments);
      };
    }
  } catch (error) {
    /* Popup support is best-effort; the page must never be broken by it. */
  }
})();
