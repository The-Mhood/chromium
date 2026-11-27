/*
 * ChromiumCore link support (document start, isolated world "cc-links").
 *
 * Injected into EVERY frame of every external page before any page script
 * runs, in its own isolated world (the page cannot observe, reset or fake
 * what happens here). It implements the DOUBLE-CLICK link options:
 *
 *   * a plain left click on a target=_blank / _new link is NOT suppressed:
 *     the browser opens the tab IMMEDIATELY (the intended single-click
 *     behaviour — no waiting), and the main process applies the full popup
 *     policy to that native open (real-input evidence, filters, dedup) and
 *     publishes the tab at once. If a SECOND click lands on the same anchor
 *     within the double window, the main process is asked to close the
 *     just-opened tab and open the link-options dialog instead — the
 *     double-click is detected at the user's own click interval (up to the
 *     OS double-click window), not by racing a 300 ms timer;
 *   * a plain left click on any OTHER link (same-frame, target=_top /
 *     _parent, media, `download`) suppresses ONLY the browser's default
 *     navigation — the page's own handlers still run (we never stop
 *     propagation) — and defers the action COMMIT_DELAY_MS; a second click
 *     on the same anchor cancels the deferral and opens the dialog;
 *   * otherwise the click is committed exactly as the browser would have
 *     done it: same-frame navigation, target=_top / _parent across origins
 *     handled by the main process, and media files or anchors with a
 *     `download` attribute routed to the main process download pipeline
 *     (which keeps the save dialog and the ad/threat checks);
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
    // A single click on a same-frame link waits this long before it commits,
    // leaving room for the SECOND click of a double-click to cancel it and
    // open the options dialog. This IS the effective double window for
    // same-frame links (the pending record only lives until the commit), so
    // it must cover a MANUAL double — 300 ms was an OS-double-click window
    // and a deliberate "double click" at desk or TV distance simply never
    // registered, which is the "double click doesn't work" report.
    var COMMIT_DELAY_MS = 600;
    var SECOND_CLICK_MS = 1000; // a second click/tap on the same anchor within this span is a double-click

    var state = { pending: null, last: null, lastBlank: null, rightTap: null, cooldownUntil: 0 };

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
        // (Plain target=_blank clicks are never deferred — they open the tab
        // natively and immediately; the click handler does not route them
        // through this commit path any more.)
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

        // A left click right after a right-side tap on the same anchor is a
        // double-click (the first tap was a trackpad two-finger tap, which
        // arrives as contextmenu, not click). Dialog, no navigation — this
        // check precedes both first-click paths so no tab/navigation starts.
        if (state.rightTap && state.rightTap.anchor === anchor && Date.now() - state.rightTap.at < SECOND_CLICK_MS) {
          state.last = { anchor: anchor, href: href, at: Date.now() };
          state.rightTap = null;
          state.cooldownUntil = Date.now() + 400;
          event.preventDefault(); // the click is the double, not a fresh navigation
          openDialog();
          return;
        }

        // Links that open a NEW TAB: do not touch the default action. The
        // browser opens the tab immediately (a single click gets its tab
        // NOW — waiting for a possible second click is what made new-tab
        // links feel dead), and the main process applies the full popup
        // policy to that native open and publishes the tab at once.
        // A second click on the SAME anchor within the double window is a
        // double-click: the main process closes the just-opened tab and
        // shows the options dialog instead. (Media links and anchors with a
        // `download` attribute keep the deferred path: their single click
        // belongs to the download pipeline, and the dialog offers the
        // "Download attached media" action.)
        var target = (anchor.target || '').toLowerCase();
        if ((target === '_blank' || target === '_new') && !anchor.download && !isMediaUrl(href)) {
          state.last = { anchor: anchor, href: href, at: Date.now() };
          if (state.lastBlank && state.lastBlank.anchor === anchor && Date.now() - state.lastBlank.at < SECOND_CLICK_MS) {
            state.lastBlank = null;
            state.cooldownUntil = Date.now() + 400;
            event.preventDefault(); // do not open a SECOND new-tab for the double-click
            openDialog();
            return;
          }
          state.lastBlank = { anchor: anchor, href: href, at: Date.now() };
          return;
        }

        // Second click on the anchor we just deferred: a double-click.
        // Cancel the single-click navigation and open the options dialog —
        // the page must NOT navigate.
        if (state.pending && state.pending.anchor === anchor && Date.now() - state.pending.at < SECOND_CLICK_MS) {
          state.last = { anchor: anchor, href: href, at: Date.now() };
          cancelPending();
          state.cooldownUntil = Date.now() + 400;
          event.preventDefault(); // the page must NOT navigate on a double-click
          openDialog();
          return;
        }

        // First click: remember it, suppress the default navigation (the
        // page's own handlers still run), and commit after the double
        // window. Everything above is pure, so preventDefault here can only
        // ever apply to a link this script knows how to re-perform.
        //
        // The listener MUST be non-passive: a passive listener's
        // preventDefault() is a no-op (the engine ignores it), which let the
        // browser navigate immediately on the first click — the deferred
        // commit then raced the real navigation and a second click could
        // never cancel anything, so the double-click dialog never won.
        // A previous click's deferral is superseded by this one: clear its
        // timer, or it would commit the OLD anchor early (and the user's
        // latest click — the one that should win — would be lost).
        cancelPending();
        state.pending = { anchor: anchor, href: href, at: Date.now(), urlBefore: location.href, timer: null };
        state.last = { anchor: anchor, href: href, at: Date.now() };
        event.preventDefault();
        state.pending.timer = setTimeout(commitPending, COMMIT_DELAY_MS);
      } catch (error) {
        state.pending = null; // fail open: the page must never break because of this
      }
    }, { capture: true, passive: false });

    // The native dblclick is the browser's own double-click detection and
    // fires right after the second click's dispatch. The plain click path
    // above already handled the pair; this is the safety net for the rare
    // platform that reports dblclick without the intermediate click reaching
    // us (event table locked, shadow boundary quirk).
    document.addEventListener('dblclick', function (event) {
      try {
        if (!event.isTrusted) return; // synthetic events are never a double-click
        var nodes = typeof event.composedPath === 'function' ? event.composedPath() : [event.target];
        var i;
        if (state.pending) {
          for (i = 0; i < nodes.length; i += 1) {
            if (nodes[i] === state.pending.anchor) {
              var lastHref = state.pending.href;
              state.last = { anchor: state.pending.anchor, href: lastHref, at: Date.now() };
              cancelPending();
              state.cooldownUntil = Date.now() + 400;
              openDialog();
              return;
            }
          }
        }
        // Same safety net for new-tab links: the first click already let the
        // browser open the tab, so the dialog message here also tells the
        // main process to close that tab.
        if (state.lastBlank) {
          for (i = 0; i < nodes.length; i += 1) {
            if (nodes[i] === state.lastBlank.anchor) {
              state.last = { anchor: state.lastBlank.anchor, href: state.lastBlank.href, at: Date.now() };
              state.lastBlank = null;
              state.cooldownUntil = Date.now() + 400;
              openDialog();
              return;
            }
          }
        }
      } catch (error) { /* never break the page */ }
    }, { capture: true, passive: true });

    // Trackpad two-finger taps (and plain right clicks) do NOT arrive as
    // click/dblclick — they arrive as `contextmenu` (button 2). A user who
    // "double-clicks" a link on a trackpad therefore produces either
    // click + contextmenu or contextmenu + contextmenu, and the dialog
    // above would never see it. Treat a second tap of EITHER kind within
    // the double window as the double-click: cancel what the first tap
    // started (a suppressed navigation, or the new-tab the browser opened)
    // and open the options dialog.
    document.addEventListener('contextmenu', function (event) {
      try {
        if (!event.isTrusted) return; // synthetic contextmenu is never a tap
        if (Date.now() < state.cooldownUntil) return;
        var anchor = anchorOf(event);
        if (!anchor) return;
        var href = safeHref(anchor);
        if (!href) return;
        var now = Date.now();
        var pendingHit = state.pending && state.pending.anchor === anchor && now - state.pending.at < SECOND_CLICK_MS;
        var blankHit = state.lastBlank && state.lastBlank.anchor === anchor && now - state.lastBlank.at < SECOND_CLICK_MS;
        var rightHit = state.rightTap && state.rightTap.anchor === anchor && now - state.rightTap.at < SECOND_CLICK_MS;
        if (!pendingHit && !blankHit && !rightHit) {
          // A lone tap on a link: remember it, and do NOT show the native
          // menu. The menu can't be kept: on Windows/Mac trackpads the
          // follow-up two-finger tap lands on the OPEN menu, which it only
          // dismisses — no second contextmenu ever fires and the dialog
          // never opens ("two-finger tap doesn't work"). We can't tell a
          // two-finger tap from a right click on the FIRST tap, so both get
          // the same treatment: the follow-up tap within the double window
          // opens the options dialog, which offers everything the menu's
          // link actions did (open in tab/window, copy, download).
          state.rightTap = { anchor: anchor, href: href, at: now };
          event.preventDefault();
          return;
        }
        // Second tap of a double: the dialog, and no context menu.
        state.last = { anchor: anchor, href: href, at: now };
        cancelPending();
        state.lastBlank = null;
        state.rightTap = null;
        state.cooldownUntil = now + 400;
        openDialog();
        event.preventDefault();
      } catch (error) { /* never break the page */ }
    }, { capture: true, passive: false });
  } catch (error) {
    /* Link support is best-effort; the page must never be broken by it. */
  }
})();
