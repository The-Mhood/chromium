/*
 * ChromiumCore link support (document start, isolated world "cc-links").
 *
 * Injected into EVERY frame of every external page before any page script
 * runs, in its own isolated world (the page cannot observe, reset or fake
 * what happens here). It implements the DOUBLE-CLICK link options:
 *
 *   * a plain left click on a link suppresses ONLY the browser's default
 *     navigation — the page's own handlers still run (we never stop
 *     propagation) — and defers the action COMMIT_DELAY_MS;
 *   * if a second click lands on the same anchor within the double window,
 *     the deferred navigation is cancelled and the main process is asked to
 *     open the link-options dialog (no single-click navigation ever happens
 *     for a double-click);
 *   * otherwise the click is committed exactly as the browser would have
 *     done it: same-frame navigation, target=_blank handled by the main
 *     process (so the full popup protection still applies), target=_top /
 *     _parent across origins handled by the main process, and media files
 *     or anchors with a `download` attribute routed to the main process
 *     download pipeline (which keeps the save dialog and the ad/threat
 *     checks);
 *   * SPA guard: if the page's own handlers already changed the document URL
 *     (router pushState & co.) between the click and the commit, no second
 *     navigation is performed.
 *
 * It talks to the main process through the DevTools protocol: a single
 * console.log with a magic prefix, in this isolated world only — the main
 * process verifies the execution context id of the isolated world, so the
 * page's own world can forge none of these messages.
 *
 * Fail-open contract: the script never throws into the page, and it only
 * suppresses the default action for links it can fully handle (http/https
 * hrefs). Anything unexpected leaves ordinary browsing untouched.
 */
(function () {
  'use strict';
  try {
    if (window.__ccLinkState) return;
    Object.defineProperty(window, '__ccLinkState', { value: {} });

    var MAGIC = '%CC-LINK% ';
    var COMMIT_DELAY_MS = 300;  // how long a single click waits before it commits
    var SECOND_CLICK_MS = 600;  // a second click on the same anchor within this span is a double-click

    var state = { pending: null, last: null, cooldownUntil: 0 };

    function emit(payload) {
      try { console.log(MAGIC + JSON.stringify(payload)); } catch (error) { /* channel unavailable; the page must not break */ }
    }

    function frameInfo() {
      var isTop = window.top === window;
      var crossOrigin = false;
      if (!isTop) {
        try { void window.top.location.href; } catch (error) { crossOrigin = true; }
      }
      return { isTop: isTop, crossOrigin: crossOrigin };
    }

    function isMediaUrl(url) {
      try {
        var pathname = new URL(url, location.href).pathname.toLowerCase();
        return /\.(mp4|webm|ogv|ogg|mov|mkv|m4v|avi|mp3|m4a|aac|flac|wav|opus)$/.test(pathname);
      } catch (error) { return false; }
    }

    function anchorOf(event) {
      var nodes = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
      for (var n = 0; n < nodes.length; n += 1) {
        var node = nodes[n];
        if (node && node.nodeType === 1 && node.tagName === 'A' && node.href) return node;
      }
      return null;
    }

    /** Only http(s) links are handled — mailto:, tel:, javascript:, data:
     *  and friends keep their native behaviour. */
    function safeHref(anchor) {
      try {
        var resolved = new URL(anchor.href);
        if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.href;
      } catch (error) { /* not a handleable link */ }
      return null;
    }

    function anchorText(anchor) {
      try {
        var text = (anchor.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) text = anchor.title || '';
        return text.slice(0, 160);
      } catch (error) { return ''; }
    }

    function cancelPending() {
      if (state.pending && state.pending.timer) clearTimeout(state.pending.timer);
      state.pending = null;
    }

    function openDialog() {
      if (!state.last || !state.last.href) return;
      var info = frameInfo();
      emit({
        t: 'dialog',
        url: state.last.href,
        text: anchorText(state.last.anchor),
        media: isMediaUrl(state.last.href) || !!(state.last.anchor && state.last.anchor.download),
        isTop: info.isTop,
        crossOrigin: info.crossOrigin
      });
    }

    function commitPending() {
      var p = state.pending;
      state.pending = null;
      if (!p) return;
      try {
        // SPA guard: the page's own click handlers already routed the
        // navigation (history.pushState & co. changed the URL) — do not
        // navigate a second time.
        if (location.href !== p.urlBefore) return;
        var target = (p.anchor.target || '').toLowerCase();
        var info = frameInfo();
        if (p.anchor.download || isMediaUrl(p.href)) {
          // Downloads keep the app's pipeline: save dialog + ad/threat checks.
          emit({ t: 'commit', url: p.href, target: 'download', isTop: info.isTop, crossOrigin: info.crossOrigin });
          return;
        }
        if (target === '_blank' || target === '_new') {
          // The main process opens the tab through the full popup policy
          // (this commit came from a real click on a real anchor).
          emit({ t: 'commit', url: p.href, target: 'blank', isTop: info.isTop, crossOrigin: info.crossOrigin });
          return;
        }
        if ((target === '_top' || target === '_parent') && !info.isTop) {
          if (!info.crossOrigin) {
            try {
              (target === '_top' ? window.top : window.parent).location.assign(p.href);
              return;
            } catch (error) { /* cross-origin read failed unexpectedly; ask main */ }
          }
          emit({ t: 'commit', url: p.href, target: 'top', isTop: info.isTop, crossOrigin: info.crossOrigin });
          return;
        }
        // Default: navigate this frame, exactly as the browser would.
        location.assign(p.href);
      } catch (error) {
        try { emit({ t: 'commit', url: p.href, target: 'top', isTop: false, crossOrigin: true }); } catch (error2) { /* give up silently */ }
      }
    }

    document.addEventListener('click', function (event) {
      try {
        // Only REAL user input drives this feature: a page that dispatches
        // synthetic click/dblclick events must not be able to open the
        // dialog or commit a navigation (and must not be able to swallow
        // the user's real clicks by faking a double).
        if (!event.isTrusted) return;
        // Modifier/middle clicks are the user's explicit "open in new tab"
        // gestures — the browser handles them (through the normal popup
        // policy path), we stay out of the way.
        if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        if (Date.now() < state.cooldownUntil) return;
        var anchor = anchorOf(event);
        if (!anchor) return;
        var href = safeHref(anchor);
        if (!href) return;

        // Second click on the anchor we just deferred: a double-click.
        // Cancel the single-click navigation and open the options dialog —
        // the page must NOT navigate.
        if (state.pending && state.pending.anchor === anchor && Date.now() - state.pending.at < SECOND_CLICK_MS) {
          state.last = { anchor: anchor, href: href, at: Date.now() };
          cancelPending();
          state.cooldownUntil = Date.now() + 400;
          openDialog();
          return;
        }

        // First click: remember it, suppress the default navigation (the
        // page's own handlers still run), and commit after the double
        // window. Everything above is pure, so preventDefault here can only
        // ever apply to a link this script knows how to re-perform.
        state.pending = { anchor: anchor, href: href, at: Date.now(), urlBefore: location.href, timer: null };
        state.last = { anchor: anchor, href: href, at: Date.now() };
        event.preventDefault();
        state.pending.timer = setTimeout(commitPending, COMMIT_DELAY_MS);
      } catch (error) {
        state.pending = null; // fail open: the page must never break because of this
      }
    }, { capture: true, passive: true });

    // The native dblclick is the browser's own double-click detection and
    // fires right after the second click's dispatch. The plain click path
    // above already handled the pair; this is the safety net for the rare
    // platform that reports dblclick without the intermediate click reaching
    // us (event table locked, shadow boundary quirk).
    document.addEventListener('dblclick', function (event) {
      try {
        if (!event.isTrusted) return; // synthetic events are never a double-click
        if (state.pending) {
          var nodes = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
          for (var n = 0; n < nodes.length; n += 1) {
            if (nodes[n] === state.pending.anchor) {
              var lastHref = state.pending.href;
              state.last = { anchor: state.pending.anchor, href: lastHref, at: Date.now() };
              cancelPending();
              state.cooldownUntil = Date.now() + 400;
              openDialog();
              return;
            }
          }
        }
      } catch (error) { /* never break the page */ }
    }, { capture: true, passive: true });
  } catch (error) {
    /* Link support is best-effort; the page must never be broken by it. */
  }
})();
