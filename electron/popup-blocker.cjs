'use strict';

// ---------------------------------------------------------------------------
// ChromiumCore popup / popunder policy.
//
// Pure module: no Electron imports, so the entire classification and state
// machine is unit tested in plain Node (popup-blocker.test.cjs). The main
// process feeds it:
//   - a `matchRequest(url, sourceUrl, type, group?)` predicate built from the
//     ad / threat engines,
//   - the page's user-activation age read from an *isolated* JavaScript world
//     (shared/popup-support.js, injected with a CDP worldName so pages cannot
//     observe or tamper with it),
//   - the disposition Chromium reports for each window.open request.
//
// Trust model: pages can lie about anything inside their own world, so the
// decision never relies on page-visible state alone:
//   * activation age = min(isolated-world age, main-process input age);
//   * the per-gesture quota is counted by the main process (one script-driven
//     window.open per user activation) and cannot be reset from the page.
//
// Rules (mirror a real browser popup blocker, not a domain blocklist):
//   1. Protection off / site allowlisted            -> allow.
//   2. Destination matches an ad/threat filter       -> block.
//   3. A genuine link click (disposition "foreground-tab") -> allow.
//   4. Tab budget exhausted                           -> block.
//   5. Script-driven window.open ("default" / "background-tab"):
//        allowed only with a recent user activation and within the per-gesture
//        quota. "background-tab" (window.open 'background' — the classic
//        popunder primitive) needs a near-synchronous gesture. Activation is
//        key/click input only — scrolling (mouseWheel) grants none.
//   6. A second script popup from the same page within REPEAT_WINDOW_MS
//        (even with a fresh gesture each time) -> block, and report the
//        earlier popup's URL so the main process can close that tab.
// This stops timer popups, popup chains and popunders to *unlisted*
// destinations, which a domain blocklist alone cannot catch.
//
// Popunder watching: when a script-opened tab is allowed, its *first*
// committed main-frame navigation is inspected. If it jumps to a
// filter-listed ad host, or to a different registrable domain than the page
// that opened it (the window.open('')-then-location=ad scheme), the tab is
// closed and the attempt recorded. Legit same-domain redirects pass.
// ---------------------------------------------------------------------------

const GESTURE_WINDOW_MS = 1500;
const BACKGROUND_GESTURE_WINDOW_MS = 500;
const OPENS_PER_ACTIVATION = 1;
// A page that fires more than one script popup inside this window — even
// with a fresh click for each — is an ad redirector, not a user workflow.
// The second open is blocked and the first one is closed by the main process.
const REPEAT_WINDOW_MS = 8000;
const WATCH_TTL_MS = 30000;
const NO_ACTIVATION_MS = 999999999;

function getRegistrableDomain(input) {
  try {
    const hostname = new URL(input).hostname.replace(/^www\./, '').toLowerCase();
    try {
      const { getDomain } = require('tldts');
      const domain = getDomain(hostname);
      if (domain) return domain;
    } catch { /* keep the fallback */ }
    const labels = hostname.split('.');
    return labels.length > 2 ? labels.slice(-2).join('.') : hostname;
  } catch {
    return '';
  }
}

function createPopupPolicy(options = {}) {
  const now = options.now || (() => Date.now());
  const matchRequest = options.matchRequest || (() => false);
  const getSettings = options.getSettings || (() => ({ protection: { enabled: true, popups: true }, allowlist: [] }));
  const maxTabs = options.maxTabs || 60;
  const isAllowedDomain = options.isAllowedDomain || (() => false);
  const log = options.log || (() => {});

  // Main-process input tracking (unspoofable: it reflects OS-level input
  // events, and doubles as the per-gesture quota counter).
  const pageInput = new Map();
  // Popunder watches: webContents id -> watch.
  const watches = new Map();
  // Repeat-popup tracking: webContents id -> { url, firstAt } of the last
  // allowed script popup from that page.
  const repeatOpeners = new Map();

  function settings() {
    const s = getSettings();
    return { protection: s.protection || {}, allowlist: s.allowlist || [] };
  }

  /** The main process reports input delivered to the page. Only key/click
   *  input grants popup activation: scrolling (mouseWheel) is continuous and
   *  would let a page fire a popup on every scroll position. */
  function observeInput(contentsId, type) {
    if (!type || type === 'mouseMove' || type === 'keyUp' || type === 'mouseUp' || type === 'mouseWheel') return;
    const entry = pageInput.get(contentsId) || { lastInputAt: 0, opens: 0, observed: false };
    entry.lastInputAt = now();
    entry.opens = 0;
    entry.observed = true;
    pageInput.set(contentsId, entry);
  }

  function settingsOf() { return settings(); }

  /**
   * Classify a window.open / target=_blank request.
   * @param {object} p
   * @param {string} p.url          destination (already validated http/https)
   * @param {string} p.sourceUrl    the page that opened it
   * @param {string} p.disposition  "default" | "foreground-tab" | "background-tab"
   * @param {number} p.tabCount     external tabs currently open
   * @param {object|null} p.pageState { ageMs } from the isolated world, or null
   * @param {number} p.contentsId
   */
  function classifyWindowOpen(p) {
    const { url, sourceUrl, disposition, tabCount, pageState, contentsId } = p;
    const { protection, allowlist } = settingsOf();

    if (!protection.enabled || protection.popups === false) return { allowed: true, reason: 'protection-off', needsWatch: false };
    if (isAllowedDomain(sourceUrl, allowlist)) return { allowed: true, reason: 'allowlisted', needsWatch: false };

    if (matchRequest(url, sourceUrl, 'popup') || matchRequest(url, sourceUrl, 'main_frame')) {
      return { allowed: false, reason: 'listed-destination', needsWatch: false };
    }
    if (disposition === 'foreground-tab') return { allowed: true, reason: 'link-click', needsWatch: false };
    if (tabCount >= maxTabs) return { allowed: false, reason: 'tab-budget', needsWatch: false };

    // Repeat rule: this page already got a script popup through inside the
    // window. Ad redirectors fire one popup per user action, so a second
    // script open from the same page is unwanted: block it and report the
    // earlier popup's URL so the main process can close that tab too.
    const repeat = repeatOpeners.get(contentsId);
    if (repeat && now() - repeat.firstAt < REPEAT_WINDOW_MS) {
      return { allowed: false, reason: 'repeat-popup', needsWatch: false, earlierUrl: repeat.url };
    }

    const entry = pageInput.get(contentsId) || { lastInputAt: 0, opens: 0, observed: false };
    entry.opens += 1; // every script-driven attempt consumes quota until a fresh gesture
    pageInput.set(contentsId, entry);

    const limit = disposition === 'background-tab' ? BACKGROUND_GESTURE_WINDOW_MS : GESTURE_WINDOW_MS;
    let age = NO_ACTIVATION_MS;
    if (pageState && typeof pageState.ageMs === 'number') age = Math.min(age, pageState.ageMs);
    if (entry.lastInputAt) age = Math.min(age, now() - entry.lastInputAt);

    if (age >= NO_ACTIVATION_MS) {
      // Neither the isolated world nor the main process saw any activation
      // for this page: no proof this is user-driven. Block — except when we
      // have no observation at all (script not installed / CDP degraded),
      // where blocking would break ordinary sites: degraded mode allows.
      const observed = (pageState !== null) || entry.observed;
      if (!observed) {
        log('popup: degraded allow (no activation data)', { url, disposition });
        repeatOpeners.set(contentsId, { url, firstAt: now() });
        return { allowed: true, reason: 'degraded', needsWatch: true };
      }
      return { allowed: false, reason: 'no-gesture', needsWatch: false };
    }

    if (age <= limit && entry.opens <= OPENS_PER_ACTIVATION) {
      repeatOpeners.set(contentsId, { url, firstAt: now() });
      return { allowed: true, reason: 'user-gesture', needsWatch: true };
    }
    return { allowed: false, reason: age <= limit ? 'popup-chain' : 'no-gesture', needsWatch: false };
  }

  function registerPopup(contentsId, { url, sourceUrl }) {
    const intendedDomain = getRegistrableDomain(url);
    const openerDomain = getRegistrableDomain(sourceUrl);
    watches.set(contentsId, {
      intendedUrl: url,
      intendedDomain,
      openerDomain,
      intendedWasOpener: intendedDomain !== '' && intendedDomain === openerDomain,
      createdAt: now(),
    });
  }

  /**
   * Inspect the first committed main-frame navigation of a watched tab.
   * @returns {{block: boolean, reason: string, type: 'Ad'|'Threat'|'Pop-up'|null}}
   */
  function checkFirstNavigation(contentsId, url) {
    const watch = watches.get(contentsId);
    watches.delete(contentsId);
    if (!watch) return { block: false, reason: 'no-watch', type: null };
    if (now() - watch.createdAt > WATCH_TTL_MS) return { block: false, reason: 'expired', type: null };

    if (matchRequest(url, watch.intendedUrl, 'main_frame')) {
      const threat = matchRequest(url, watch.intendedUrl, 'main_frame', 'threats');
      return { block: true, reason: 'listed-redirect', type: threat ? 'Threat' : 'Ad' };
    }
    const destinationDomain = getRegistrableDomain(url);
    if (watch.intendedWasOpener && destinationDomain !== '' && destinationDomain !== watch.openerDomain) {
      return { block: true, reason: 'popunder', type: 'Pop-up' };
    }
    return { block: false, reason: 'accepted', type: null };
  }

  function forget(contentsId) {
    pageInput.delete(contentsId);
    watches.delete(contentsId);
    repeatOpeners.delete(contentsId);
  }

  return {
    GESTURE_WINDOW_MS,
    BACKGROUND_GESTURE_WINDOW_MS,
    OPENS_PER_ACTIVATION,
    REPEAT_WINDOW_MS,
    WATCH_TTL_MS,
    classifyWindowOpen,
    registerPopup,
    checkFirstNavigation,
    observeInput,
    forget,
    getRegistrableDomain,
  };
}

module.exports = { createPopupPolicy, getRegistrableDomain };
