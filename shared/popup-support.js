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
 *   - when the frame last had a REAL user activation (pointer, key, touch;
 *     isTrusted events only — page-dispatched synthetic events count for
 *     nothing, so a page cannot fake its own activation);
 *   - the details of the most recent window.open call made FROM THAT FRAME
 *     (scripted opens);
 *   - the details of the most recent REAL CLICK in that frame (isTrusted):
 *     whether the frame is the top document or a cross-origin iframe, and
 *     the href of the anchor the click landed on. That is how a
 *     target=_blank click inside an ad iframe (the "sponsored link"
 *     pattern) is attributed to the frame that caused it — no window.open
 *     call is involved at all, which is why this had to be recorded
 *     separately.
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
    var state = { t: 0, lastOpen: null, lastClick: null };
    Object.defineProperty(window, '__ccPopupState', { value: state });

    // Only REAL user input counts as activation. The isolated world sees
    // every DOM event, including the synthetic ones a page can dispatch on
    // its own (element.click() & co.) — counting those would let any page
    // refresh its own "I was just used" clock at will and open popups
    // without a human. isTrusted is engine-set and unforgeable.
    function noteActivity(event) {
      if (!event.isTrusted) return;
      state.t = Date.now();
    }
    var events = ['pointerdown', 'keydown', 'touchstart', 'mousedown'];
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

    // Who am I: the top frame, a same-origin iframe, or a cross-origin
    // iframe (the ad-embed pattern). Reading the top frame's location
    // succeeds only when the top document is same-origin with this frame;
    // a cross-origin read throws, which is exactly the signal we need.
    function frameInfo() {
      var isTop = window.top === window;
      var frameHost = host(location.href);
      var crossOrigin = false;
      var topHost = frameHost;
      if (!isTop) {
        topHost = host(window.top.location.href);
        crossOrigin = topHost !== frameHost;
      }
      return { isTop: isTop, crossOrigin: crossOrigin, frameHost: frameHost, topHost: topHost };
    }

    // Wrap window.open in this frame (ad iframes included) so the main
    // process can see WHO is opening the tab. The wrapper only records; it
    // always hands the call through to the real window.open.
    var originalOpen = window.open;
    if (typeof originalOpen === 'function') {
      window.open = function () {
        try {
          state.lastOpen = { t: Date.now() };
          for (var key in frameInfo()) state.lastOpen[key] = frameInfo()[key];
        } catch (error) { /* never break the page */ }
        return originalOpen.apply(window, arguments);
      };
    }

    // Record clicks the same way. A target=_blank anchor click does NOT
    // call window.open — the browser opens the new tab directly — so
    // without this record the main process would see "a fresh click, no
    // opener information" and could not tell a sponsored link inside an ad
    // iframe apart from the page's own link. Capture phase runs before the
    // page's own handlers and before the navigation.
    try {
      document.addEventListener('click', function (event) {
        try {
          // Same isTrusted rule as the clock: a synthetic click is not a
          // click the user made, and must not become click attribution.
          if (!event.isTrusted) return;
          var record = { t: Date.now() };
          for (var key in frameInfo()) record[key] = frameInfo()[key];
          record.href = '';
          var nodes = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          for (var n = 0; n < nodes.length; n += 1) {
            var node = nodes[n];
            if (node && node.nodeType === 1 && node.tagName === 'A' && node.href) {
              record.href = node.href;
              break;
            }
          }
          state.lastClick = record;
        } catch (error) { /* never break the page */ }
      }, { capture: true, passive: true });
    } catch (error) { /* some pages lock the event table; skip */ }
  } catch (error) {
    /* Popup support is best-effort; the page must never be broken by it. */
  }
})();
