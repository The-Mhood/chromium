'use strict';

// ---------------------------------------------------------------------------
// ChromiumCore popup / popunder policy (v3 — default-deny).
//
// Pure module: no Electron imports, so the entire classification and state
// machine is unit tested in plain Node (popup-blocker.test.cjs). The main
// process feeds it:
//   - a `matchRequest(url, sourceUrl, type, group?)` predicate built from the
//     ad / threat engines,
//   - the page's user-activation age and per-frame window.open records read
//     from *isolated* JavaScript worlds (shared/popup-support.js, injected
//     with a CDP worldName so pages cannot observe or tamper with them),
//   - the disposition Chromium reports for each window.open request.
//
// Product requirement: an advertising tab or window must never become
// visible. So the policy never "allows and closes later" — an allowed open
// still has to pass commit verification in the main process (a hidden
// inspector navigates to the destination, follows redirects, and only the
// verified final URL is handed to the renderer as a tab).
//
// Trust model: pages can lie about anything inside their own world, so the
// decision never relies on page-visible state alone:
//   * activation age = min(isolated-world age, main-process input age);
//   * the per-gesture quota is counted by the main process (one script-driven
//     window.open per user activation) and cannot be reset from the page;
//   * when there is NO activation evidence at all, the open is BLOCKED.
//     (There is no "degraded allow": a page the user never touched cannot
//     legitimately open a browsing context, and unlisted ad domains cannot
//     be told apart from legitimate ones by a blocklist anyway.)
//
// Rules:
//   1. Protection off / site allowlisted            -> allow (no verification
//      hold: the user explicitly paused protection for that site).
//   2. Destination matches an ad/threat filter       -> block.
//   3. "background-tab" (window.open 'background' — the classic popunder
//      primitive) -> block, even with a fresh gesture.
//   4. An open initiated from a cross-origin iframe (the standard ad-embed
//      pattern) -> block, even on a real click. Same-origin iframe opens are
//      treated like top-frame opens. Attribution covers BOTH ways a frame
//      opens a tab: a window.open call recorded in that frame, and a
//      target=_blank anchor CLICK recorded in that frame (which never
//      involves window.open and was the hole that let "sponsored" ad
//      iframes open tabs on the user's click).
//   5. Tab budget exhausted                           -> block.
//   6. A second script popup from the same page within REPEAT_WINDOW_MS
//      (even with a fresh gesture each time) -> block, and report the
//      earlier popup's URL so the main process can close that tab.
//   7. Everything else requires a FRESH user gesture (real key/click input
//      within GESTURE_WINDOW_MS — scrolling never counts) and, for
//      script-driven opens, stays within the per-gesture quota.
//   8. Every other allowed open returns needsCommit: the main process
//      verifies the first committed main frame (after redirects) before the
//      tab chip is ever shown.
// This stops timer popups, popup chains, popunders and click-to-ad redirects
// to *unlisted* destinations, which a domain blocklist alone cannot catch.
// ---------------------------------------------------------------------------

const GESTURE_WINDOW_MS = 1500;
// A page that fires more than one script popup inside this window — even
// with a fresh click for each — is an ad redirector, not a user workflow.
// The second open is blocked and the first one is closed by the main process.
const REPEAT_WINDOW_MS = 8000;
const OPENS_PER_ACTIVATION = 1;
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

/** True when an anchor href and the destination it opened are the same URL. */
function sameAnchorHref(href, destination) {
  if (!href || !destination) return false;
  try {
    const a = new URL(href);
    const b = new URL(destination);
    a.hash = '';
    b.hash = '';
    return a.toString() === b.toString();
  } catch {
    return false;
  }
}

/**
 * Pick the per-frame record that most plausibly initiated a given open:
 *   - a click whose anchor href MATCHES the destination is an exact
 *     attribution (that click is what the browser acted on);
 *   - otherwise the freshest of the window.open and click records — the
 *     action that just happened is the one Chromium is reporting.
 * Returns null when the page keeps no usable record (CDP unavailable).
 */
function pickAttribution({ url, disposition, pageState }) {
  const openRecord = pageState && pageState.open;
  const clickRecord = pageState && pageState.click;
  if (!openRecord && !clickRecord) return null;
  if (clickRecord && sameAnchorHref(clickRecord.href, url)) return clickRecord;
  if (disposition !== 'foreground-tab' && openRecord && !clickRecord) return openRecord;
  const candidates = [openRecord, clickRecord].filter(Boolean);
  candidates.sort((a, b) => (b.t || 0) - (a.t || 0));
  return candidates[0];
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
  // Repeat-popup tracking: webContents id -> { url, firstAt } of the last
  // allowed script popup from that page.
  const repeatOpeners = new Map();

  function settingsOf() {
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

  /**
   * Classify a window.open / target=_blank request.
   * @param {object} p
   * @param {string} p.url          destination (already validated http/https)
   * @param {string} p.sourceUrl    the page that opened it
   * @param {string} p.disposition  "default" | "foreground-tab" | "background-tab"
   * @param {number} p.tabCount     external tabs currently open
   * @param {object|null} p.pageState { ageMs, open, click } from the isolated
   *                                   worlds, or null when CDP is unavailable.
   *                                   `open` = { t, isTop, crossOrigin, ... }
   *                                   of the freshest window.open record;
   *                                   `click` = { t, isTop, crossOrigin,
   *                                   href, ... } of the freshest anchor
   *                                   click (target=_blank never calls
   *                                   window.open, so this is the only
   *                                   record of that path).
   * @param {number} p.contentsId
   * @returns {{ allowed: boolean, reason: string, needsCommit?: boolean, earlierUrl?: string }}
   */
  function classifyWindowOpen(p) {
    const { url, sourceUrl, disposition, tabCount, pageState, contentsId } = p;
    const { protection, allowlist } = settingsOf();

    if (!protection.enabled || protection.popups === false) return { allowed: true, reason: 'protection-off', needsCommit: false };
    if (isAllowedDomain(sourceUrl, allowlist)) return { allowed: true, reason: 'allowlisted', needsCommit: false };

    if (matchRequest(url, sourceUrl, 'popup') || matchRequest(url, sourceUrl, 'main_frame')) {
      return { allowed: false, reason: 'listed-destination', needsCommit: false };
    }
    // A hidden background tab is never a user workflow.
    if (disposition === 'background-tab') {
      return { allowed: false, reason: 'background-tab', needsCommit: false };
    }
    // Frame attribution: which frame's action caused THIS open. A cross-
    // origin iframe is the canonical ad-embed pattern — a third-party ad
    // unit opens a tab "on" the user's click — and never gets one, even on
    // a real click. A same-origin iframe is part of the page being viewed.
    // Two mechanisms open tabs:
    //   * a scripted window.open      -> the `open` record in that frame;
    //   * a target=_blank anchor click -> the `click` record (window.open is
    //     NOT called; the browser opens the tab directly). This is the
    //     "sponsored link" ad pattern and the hole a window.open-only check
    //     misses.
    const attribution = pickAttribution({ url, disposition, pageState });
    if (attribution && attribution.crossOrigin === true) {
      return { allowed: false, reason: 'ad-iframe', needsCommit: false };
    }
    if (tabCount >= maxTabs) return { allowed: false, reason: 'tab-budget', needsCommit: false };

    // Repeat rule: this page already got a script popup through inside the
    // window. Ad redirectors fire one popup per user action, so a second
    // script open from the same page is unwanted: block it and report the
    // earlier popup's URL so the main process can close that tab too.
    const repeat = repeatOpeners.get(contentsId);
    if (repeat && now() - repeat.firstAt < REPEAT_WINDOW_MS) {
      return { allowed: false, reason: 'repeat-popup', needsCommit: false, earlierUrl: repeat.url };
    }

    const entry = pageInput.get(contentsId) || { lastInputAt: 0, opens: 0, observed: false };
    const isLinkClick = disposition === 'foreground-tab';
    if (!isLinkClick) entry.opens += 1; // every script-driven attempt consumes quota until a fresh gesture
    pageInput.set(contentsId, entry);

    // Activation evidence: the freshest of the isolated-world clock (any
    // frame) and the unspoofable main-process input observation.
    let age = NO_ACTIVATION_MS;
    if (pageState && typeof pageState.ageMs === 'number') age = Math.min(age, pageState.ageMs);
    if (entry.lastInputAt) age = Math.min(age, now() - entry.lastInputAt);

    if (age >= NO_ACTIVATION_MS) {
      // No input seen by the main process, no activation seen in the page:
      // there is no proof this is user-driven. Default to deny — a page the
      // user never interacted with does not get browsing contexts, whether
      // or not the destination looks familiar.
      return { allowed: false, reason: 'no-gesture', needsCommit: false };
    }

    if (age <= GESTURE_WINDOW_MS && entry.opens <= OPENS_PER_ACTIVATION) {
      if (!isLinkClick) repeatOpeners.set(contentsId, { url, firstAt: now() });
      // The allow is provisional: the main process verifies the first
      // committed main frame (following redirects) before any tab chip is
      // created, so a redirect-to-ad can never flash on screen.
      return { allowed: true, reason: isLinkClick ? 'link-click' : 'user-gesture', needsCommit: true };
    }
    return { allowed: false, reason: age <= GESTURE_WINDOW_MS ? 'popup-chain' : 'no-gesture', needsCommit: false };
  }

  function forget(contentsId) {
    pageInput.delete(contentsId);
    repeatOpeners.delete(contentsId);
  }

  return {
    GESTURE_WINDOW_MS,
    REPEAT_WINDOW_MS,
    OPENS_PER_ACTIVATION,
    WATCH_TTL_MS,
    classifyWindowOpen,
    observeInput,
    forget,
    getRegistrableDomain,
  };
}

/**
 * Verdict for a committed main frame, used by the hidden inspector in the
 * main process (and as a fallback watch for opens that could not be
 * verified in time). Pure: no state, fed by the caller.
 *
 * @param {object} p
 * @param {string} p.intendedUrl   the URL the open originally requested
 * @param {string} p.openerUrl     the page that opened it
 * @param {string} p.finalUrl      the URL the main frame actually committed to
 * @param {function} p.matchRequest (url, sourceUrl, type, group?) => bool
 * @param {number} p.nowMs
 * @param {number} p.createdAt     when the open was requested
 * @returns {{ block: boolean, reason: string, type: 'Ad'|'Threat'|'Pop-up'|null }}
 */
function committedNavigationVerdict(p) {
  const { intendedUrl, openerUrl, finalUrl, matchRequest, nowMs, createdAt } = p;
  if (nowMs - createdAt > WATCH_TTL_MS) return { block: false, reason: 'expired', type: null };

  if (matchRequest(finalUrl, intendedUrl, 'main_frame') || matchRequest(finalUrl, openerUrl, 'main_frame')) {
    const threat = matchRequest(finalUrl, intendedUrl, 'main_frame', 'threats') || matchRequest(finalUrl, openerUrl, 'main_frame', 'threats');
    return { block: true, reason: 'listed-redirect', type: threat ? 'Threat' : 'Ad' };
  }
  // window.open('') / location=ad popunder scheme: the open started on the
  // opener's own domain and the committed frame jumped to another one.
  const intendedDomain = getRegistrableDomain(intendedUrl);
  const openerDomain = getRegistrableDomain(openerUrl);
  const finalDomain = getRegistrableDomain(finalUrl);
  if (intendedDomain !== '' && intendedDomain === openerDomain && finalDomain !== '' && finalDomain !== openerDomain) {
    return { block: true, reason: 'popunder', type: 'Pop-up' };
  }
  return { block: false, reason: 'accepted', type: null };
}

module.exports = { createPopupPolicy, getRegistrableDomain, committedNavigationVerdict, pickAttribution, sameAnchorHref };
