'use strict';

// The double-click / two-finger-tap link-options feature lives in the
// isolated-world script `link-support.js`, injected into every frame before
// page scripts run. The main-process half is covered by
// electron/main.wiring.test.cjs (CC-LINK messages); THIS suite drives the
// in-page half — the detection that has to see the user's clicks and taps —
// in a minimal DOM, because that is the half that failed in the field:
// manual doubles (slower than an OS double-click) and trackpad two-finger
// taps (which arrive as contextmenu, not click).

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SCRIPT = fs.readFileSync(path.join(__dirname, 'link-support.js'), 'utf8');
const MAGIC = '%CC-LINK% ';

/** A virtual clock: Date.now() and setTimeout/clearTimeout both run on it,
 *  so tests can place clicks at exact intervals and flush the script's
 *  commit timer deterministically (no real-time sleeps). */
function makeClock(start = 1_000_000) {
  let t = start;
  const timers = [];
  let nextId = 1;
  return {
    now: () => t,
    advance: (ms) => { t += ms; },
    setTimeout: (fn, ms) => {
      nextId += 1;
      const entry = { id: nextId, at: t + (ms || 0), fn, cleared: false };
      timers.push(entry);
      return nextId;
    },
    clearTimeout: (id) => {
      const entry = timers.find((x) => x.id === id);
      if (entry) entry.cleared = true;
    },
    /** Fire every due timer (in due order), including ones the fired timers re-arm. */
    flush: () => {
      for (let i = 0; i < 1000; i += 1) {
        const due = timers.filter((x) => !x.cleared && x.at <= t).sort((a, b) => a.at - b.at);
        if (!due.length) break;
        for (const entry of due) {
          if (entry.cleared) continue;
          entry.cleared = true;
          entry.fn();
        }
      }
    },
  };
}

/** Boot the script in a sandbox with a virtual clock and one <a> target. */
function makePage({ target = '', download = false, href = 'https://site.example/article' } = {}) {
  const clock = makeClock();
  const messages = [];
  const listeners = { click: [], dblclick: [], contextmenu: [] };
  const anchor = {
    nodeType: 1,
    tagName: 'A',
    href,
    target,
    download: download || '',
    textContent: 'Article',
    title: '',
  };
  const location = { href: 'https://site.example/home', assign(url) { location.href = url; } };
  const consoleCapture = { log: (m) => messages.push(m) };
  const sandbox = {
    console: consoleCapture,
    Date: { now: clock.now },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    URL,
    JSON,
    location,
    document: {
      addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
    },
  };
  sandbox.window = sandbox;
  sandbox.top = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SCRIPT, sandbox);

  function makeEvent(type, { button = type === 'contextmenu' ? 2 : 0, isTrusted = true, on = anchor, ctrlKey = false } = {}) {
    return {
      type,
      button,
      isTrusted,
      ctrlKey,
      metaKey: false,
      shiftKey: false,
      altKey: false,
      target: on,
      composedPath: () => [on, { nodeType: 1, tagName: 'BODY', href: undefined }, sandbox],
      defaultPrevented: false,
      preventDefault: function () { this.defaultPrevented = true; },
    };
  }
  function fire(type, opts) {
    const event = makeEvent(type, opts);
    for (const fn of listeners[type] || []) fn(event);
    return event;
  }
  const ccMessages = () =>
    messages.filter((m) => typeof m === 'string' && m.startsWith(MAGIC))
      .map((m) => JSON.parse(m.slice(MAGIC.length)));

  return { clock, anchor, location, fire, ccMessages };
}

test('a single same-frame click is suppressed, then commits after the double window', () => {
  const page = makePage();
  const first = page.fire('click');
  assert.equal(first.defaultPrevented, true, 'the navigation is held for a possible second click');
  assert.equal(page.ccMessages().length, 0, 'nothing is emitted while the click is pending');
  // The commit window elapses with no second click: the page navigates.
  page.clock.advance(600);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/article', 'the single click committed');
  assert.equal(page.ccMessages().length, 0, 'a plain same-frame commit needs no message');
});

test('a second click on the same anchor cancels the commit and opens the dialog', () => {
  const page = makePage();
  page.fire('click');
  page.clock.advance(200);
  page.fire('click');
  const dialogs = page.ccMessages().filter((m) => m.t === 'dialog');
  assert.equal(dialogs.length, 1, 'the double-click opened the options dialog');
  assert.equal(dialogs[0].url, 'https://site.example/article');
  assert.equal(dialogs[0].isTop, true);
  // The first click's commit was cancelled: the page must NOT navigate.
  page.clock.advance(5000);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/home', 'no navigation after a double-click');
});

test('a MANUAL double (slower than an OS double-click, inside the same-frame commit window) opens the dialog', () => {
  // The field failure: a deliberate double-click at desk or TV distance is
  // slower than the OS double-click window (~300 ms). For SAME-FRAME links
  // the effective double window is the commit delay (the first click is
  // held that long before it navigates), so the second click must land
  // before the commit — 500 ms is a realistic manual double that the old
  // 300 ms window missed.
  const page = makePage();
  page.fire('click');
  page.clock.advance(500); // inside the 600 ms commit window, past the OS double
  const second = page.fire('click');
  assert.equal(second.defaultPrevented, true, 'the late second click still cancels the first');
  assert.equal(page.ccMessages().filter((m) => m.t === 'dialog').length, 1, 'the dialog opened');
  page.clock.advance(5000);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/home', 'and nothing navigated');
});

test('a MANUAL double on a new-tab link (up to 1500 ms apart) opens the dialog', () => {
  // The (1000,1500] ms field gap: for _blank links the first click opens
  // the tab natively (never deferred), so the double window is
  // SECOND_CLICK_MS itself. The old 1000 ms ceiling missed manual doubles
  // at 1000-1500 ms ("double click does nothing"); the window now matches
  // LINK_SECOND_CLICK_MS (1500) in the main process.
  const page = makePage({ target: '_blank' });
  page.fire('click');
  page.clock.advance(1400); // past the old 1000 ms ceiling, inside the 1500 ms window
  const second = page.fire('click');
  assert.equal(second.defaultPrevented, true, 'the late second click is the double, not a second tab');
  assert.equal(page.ccMessages().filter((m) => m.t === 'dialog').length, 1, 'the dialog opened');
  page.clock.advance(5000);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/home', 'the source page did not navigate');
});

test('a second click on a DIFFERENT anchor does not trigger the dialog; the latest click wins', () => {
  const page = makePage();
  page.fire('click');
  const other = { nodeType: 1, tagName: 'A', href: 'https://site.example/other', target: '', textContent: 'Other' };
  page.clock.advance(200);
  page.fire('click', { on: other });
  assert.equal(page.ccMessages().filter((m) => m.t === 'dialog').length, 0, 'no dialog for a different link');
  page.clock.advance(600);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/other', 'the LATEST click committed');
  assert.equal(page.ccMessages().filter((m) => m.t === 'commit').length, 0, 'plain same-frame commits emit nothing');
});

test('a target=_blank click opens immediately (never suppressed); the second click opens the dialog', () => {
  const page = makePage({ target: '_blank' });
  const first = page.fire('click');
  assert.equal(first.defaultPrevented, false, 'the browser opens the new tab natively at once');
  page.clock.advance(200);
  page.fire('click');
  const dialogs = page.ccMessages().filter((m) => m.t === 'dialog');
  assert.equal(dialogs.length, 1, 'the double-click asked the main process for the options dialog');
  assert.equal(dialogs[0].url, 'https://site.example/article');
  page.clock.advance(5000);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/home', 'the source page did not navigate');
});

test('trackpad two-finger tap, twice: the first tap no longer opens the native menu; the second opens the dialog', () => {
  // Two-finger taps arrive as contextmenu, not click. The field failure on
  // Windows/Mac: the FIRST tap opened the native context menu, and the
  // follow-up tap only dismissed that menu — no second contextmenu ever
  // fired, so the dialog never opened. The first tap must therefore be
  // suppressed too, so the second tap reaches the page.
  const page = makePage();
  const first = page.fire('contextmenu');
  assert.equal(first.defaultPrevented, true, 'the native menu is suppressed on the first tap over a link');
  assert.equal(page.ccMessages().length, 0, 'one tap alone opens nothing');
  page.clock.advance(300);
  const second = page.fire('contextmenu');
  assert.equal(second.defaultPrevented, true, 'the second tap suppresses the menu too');
  const dialogs = page.ccMessages().filter((m) => m.t === 'dialog');
  assert.equal(dialogs.length, 1, 'the two-finger double opened the dialog');
  assert.equal(dialogs[0].url, 'https://site.example/article');
  page.clock.advance(5000);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/home', 'no navigation');
});

test('two-finger tap then a plain click (the other mixed order) also opens the dialog', () => {
  const page = makePage();
  page.fire('contextmenu');
  page.clock.advance(300);
  const click = page.fire('click');
  assert.equal(click.defaultPrevented, true, 'the click after the tap is the double, not a navigation');
  assert.equal(page.ccMessages().filter((m) => m.t === 'dialog').length, 1, 'the dialog opened');
  page.clock.advance(5000);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/home', 'no navigation');
});

test('a tap older than the double window does not combine with a later click', () => {
  const page = makePage();
  page.fire('contextmenu');
  page.clock.advance(1600); // past the 1500 ms window
  const click = page.fire('click');
  assert.equal(click.defaultPrevented, true, 'a fresh click is still held for ITS own double window');
  assert.equal(page.ccMessages().filter((m) => m.t === 'dialog').length, 0, 'the stale tap was ignored');
  page.clock.advance(600);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/article', 'the fresh click committed');
});

test('synthetic (untrusted) events can neither double-click nor single-click', () => {
  const page = makePage();
  const fake1 = page.fire('click', { isTrusted: false });
  assert.equal(fake1.defaultPrevented, false, 'a script click is untouched');
  page.fire('contextmenu', { isTrusted: false });
  page.clock.advance(200);
  page.fire('click', { isTrusted: false });
  page.clock.advance(600);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/home', 'no navigation at all');
  assert.equal(page.ccMessages().length, 0, 'no dialog, no commit');
});

test('clicks on non-links and privileged links are left to the browser', () => {
  const page = makePage();
  const div = { nodeType: 1, tagName: 'DIV', href: undefined };
  const onDiv = page.fire('click', { on: div });
  assert.equal(onDiv.defaultPrevented, false, 'a click on a div is untouched');

  const mailto = makePage({ href: 'mailto:hello@example.com' });
  const onMailto = mailto.fire('click');
  assert.equal(onMailto.defaultPrevented, false, 'mailto: keeps its native behaviour');
  mailto.clock.advance(600);
  mailto.clock.flush();
  assert.equal(mailto.location.href, 'https://site.example/home', 'no navigation');
  assert.equal(mailto.ccMessages().length, 0, 'no messages');
});

test('a download link commits through the download pipeline, not a navigation', () => {
  const page = makePage({ href: 'https://files.example.com/movie.mp4', download: true });
  page.fire('click');
  page.clock.advance(600);
  page.clock.flush();
  const commits = page.ccMessages().filter((m) => m.t === 'commit');
  assert.equal(commits.length, 1, 'the download was routed to the main process');
  assert.equal(commits[0].target, 'download');
  assert.equal(page.location.href, 'https://site.example/home', 'the page did not navigate');
});

test('a fast OS double-click (dblclick safety net) opens the dialog', () => {
  const page = makePage();
  page.fire('click');
  page.clock.advance(80);
  page.fire('click');
  // The OS also fires dblclick; the plain-click path already handled the
  // pair, and the net must not double-emit.
  page.fire('dblclick');
  assert.equal(page.ccMessages().filter((m) => m.t === 'dialog').length, 1, 'exactly one dialog');
  page.clock.advance(5000);
  page.clock.flush();
  assert.equal(page.location.href, 'https://site.example/home', 'no navigation');
});
