'use strict';

// ---------------------------------------------------------------------------
// ChromiumCore popup / popunder policy (v6 — browser-level input evidence).
//
// Pure module: no Electron imports, so the entire classification and state
// machine is unit tested in plain Node (popup-blocker.test.cjs). The main
// process feeds it:
//   - a `matchRequest(url, sourceUrl, type, group?)` predicate built from the
//     ad / threat engines,
//   - its OWN observation of real input events: keyboard via
//     before-input-event, mouse via before-mouse-event. These fire in the
//     browser's input pipeline BEFORE the page sees the event — real,
//     unspoofable, and independent of DevTools. A synthetic element.click()
//     is generated inside the renderer and never passes through this
//     pipeline, so it observes to nothing here;
//   - page-activation and per-frame window.open / click records read from
//     *isolated* JavaScript worlds (shared/popup-support.js, injected with
//     a CDP worldName so pages cannot observe, reset or fake the records —
//     and its listeners only accept isTrusted events, so a page cannot
//     even dispatch synthetic input to refresh them);
//   - the disposition Chromium reports for each window.open request;
//   - the time the open was REQUESTED (`atMs`). Every age is measured
//     against this — never against the time the (asynchronous, up to a few
//     seconds on ad-heavy pages) isolated-world state read finishes.
//     Measuring against "now" was one half of the "links refuse to click"
//     defect on pages like fmhy.net; the other half was that the main
//     process only observed KEYBOARD (before-input-event is keyboard-only
//     in Electron), so a real mouse click left no browser-level trace and
//     its evidence hinged entirely on the flaky CDP read. Both are fixed.
//
// Product requirement: an advertising tab or window must never become
// visible. So the policy never "allows and closes later" — an allowed open
// still has to pass commit verification in the main process (a hidden
// inspector navigates to the destination, follows redirects, and only the
// verified final URL is handed to the renderer as a tab).
//
// Trust model: pages can lie about anything inside their own world, so the
// decision never relies on page-visible state alone:
//   * activation age = min(isolated-world age, main-process input age),
//     both measured against the open-request time. The main-process age
//     comes from the browser's input pipeline (real keyboard and mouse
//     events) and works even when the CDP read fails; the isolated-world
//     age covers frames/devices the main process might not see and
//     counts isTrusted input only.
//   * The same split is the link/ad discriminator. A GENUINE link click
//     necessarily passes through the browser's input pipeline (it is the
//     click that opens the tab), so it always has fresh main-process
//     evidence — even on ad-heavy pages where the CDP read fails. A
//     scripted element.click() on a target=_blank anchor ALSO arrives as
//     a "foreground-tab" request (Chromium sets the disposition from the
//     target attribute, not from isTrusted), but it never passes through
//     the input pipeline and writes no isTrusted record — so it has NO
//     evidence and is blocked like any other unactivated open.
//   * the per-gesture quota is counted by the main process (one script-driven
//     window.open per user activation) and cannot be reset from the page;
//   * when there is NO activation evidence at all, the open is BLOCKED.
//     (There is no "degraded allow": a page the user never touched cannot
//     legitimately open a browsing context, and unlisted ad domains cannot
//     be told apart from legitimate ones by a blocklist anyway.)
//
// Attribution — which frame initiated an open — is precise, never "freshest
// record":
//   * a CLICK whose anchor href MATCHES the destination is the initiator
//     (that is the click the browser acted on) — for ANY disposition, in any
//     frame;
//   * a SCRIPTED open (any disposition but "foreground-tab") is attributed
//     to the window.open record (the call that caused it);
//   * a LINK open ("foreground-tab") is never attributed to a window.open
//     record: a target=_blank click does not call window.open, so a stale
//     window.open record from an ad iframe (its popup attempt was blocked,
//     but the record lingers for 3 s) is a DIFFERENT event. Attributing it
//     is what kept blocking legitimate site links after an ad popup fired.
//
// Frame policy:
//   * a SCRIPTED open from a cross-origin iframe (the standard ad-embed
//     pattern) is BLOCKED, even on a real click elsewhere on the page;
//   * a LINK CLICK inside a cross-origin iframe (an embedded third-party
//     widget with its own links) is allowed with commit verification, but a
//     page may only get ONE such click-open per REPEAT_WINDOW_MS — ad units
//     fire repeated click-throughs, a user rarely clicks two different
//     third-party iframe links within seconds. Same-origin iframe links are
//     part of the page and are treated like top-frame links.
//
// Rules:
//   1. Protection off / site allowlisted            -> allow (no verification
//      hold: the user explicitly paused protection for that site).
//   2. Destination matches an ad/threat filter       -> block.
//   3. "background-tab" (window.open 'background' — the classic popunder
//      primitive) -> block, even with a fresh gesture.
//   4. Tab budget exhausted                           -> block.
//   5. A second script popup from the same page within REPEAT_WINDOW_MS
//      (even with a fresh gesture each time) -> block, and report the
//      earlier popup's URL so the main process can close that tab.
//   6. Everything else requires a FRESH user gesture (real key/click input
//      within GESTURE_WINDOW_MS of the OPEN-REQUEST time — scrolling never
//      counts) and, for script-driven opens, stays within the per-activation
//      quota. This includes link clicks: a genuine link click always has
//      fresh browser-level mouse evidence (see trust model), while a
//      scripted element.click() on a target=_blank anchor — which the
//      browser reports the same way — has none, and is blocked.
//   7. Every other allowed open returns needsCommit: the main process
//      verifies the first committed main frame (after redirects) before the
//      tab chip is ever shown.
//
// Commit verdict (committedNavigationVerdict): a redirect into a listed
// ad/threat domain is always blocked, for every kind of open. The
// popunder domain-JUMP rule (open started on the opener's own registrable
// domain but committed on a different one) applies to SCRIPTED opens only:
// it is the window.open('')-then-location=ad primitive. A LINK CLICK that
// bounces across domains (a movie page redirecting to its player or a
// sister domain, google.com to accounts.google.com) is the user's chosen
// destination following the site's normal redirects — blocking it is what
// made "site links refuse to click".
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
 * Pick the per-frame record that initiated a given open — precisely:
 *   - a click whose anchor href MATCHES the destination is an exact
 *     attribution (that click is what the browser acted on): it catches the
 *     "sponsored link in a cross-origin ad iframe" pattern, and it
 *     attributes a top-frame link click to the top frame;
 *   - a scripted open (not "foreground-tab") is attributed to the freshest
 *     window.open record;
 *   - a link open with NO matching-href click has NO attribution: a stale
 *     window.open record from another frame is a different event, and the
 *     freshest-record heuristic misfired in practice — a user who clicked
 *     an ad element and then a site link within the record window had their
 *     site link blocked as an "ad-iframe" open. When no record matches, the
 *     (unspoofable) gesture check and commit verification decide instead.
 */
/**
 * Which frame action caused THIS open, and through which mechanism.
 *
 * Priority (the order matters — it is the fmhy.net fix):
 *   1. A click record whose href is exactly the destination: the user
 *      clicked THIS anchor. Ads react to user clicks (the ad iframe calls
 *      window.open milliseconds after the click), so without this rule the
 *      ad's open record could steal the attribution of the user's link —
 *      the exact failure that blocked legitimate site links.
 *   2. An open record (a window.open() call from a frame): direct evidence
 *      of a SCRIPTED open — even when the browser reported the open as a
 *      foreground tab (window.open with window features reports
 *      'foreground-tab'). Without this rule a cross-origin ad iframe's
 *      window.open could never be blocked under that disposition.
 *   3. A click record without an href match: the click was on a different
 *      anchor (or the href was not captured). Weak evidence; the gesture
 *      check below still gates it.
 *   4. Nothing: no attribution — the gesture check decides.
 *
 * Returns the record annotated with `via` ('open' | 'click') so the caller
 * can tell scripted opens from link clicks even under identical
 * dispositions.
 */
function pickAttribution({ url, pageState }) {
  const openRecord = pageState && pageState.open;
  const clickRecord = pageState && pageState.click;
  if (clickRecord && sameAnchorHref(clickRecord.href, url)) {
    return Object.assign({}, clickRecord, { via: 'click' });
  }
  if (openRecord) return Object.assign({}, openRecord, { via: 'open' });
  if (clickRecord) return Object.assign({}, clickRecord, { via: 'click' });
  return null;
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
  // Cross-origin click-open tracking: webContents id -> { firstAt } of the
  // last allowed LINK click from a cross-origin iframe on that page.
  const repeatCrossOriginClicks = new Map();

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
   *                                   ("new-window" | "other" behave like
   *                                   "default"). "foreground-tab" is how
   *                                   Chromium reports a user link click —
   *                                   and a scripted element.click() on a
   *                                   target=_blank anchor — so the
   *                                   evidence rules (module header) are
   *                                   what tell the two apart.
   * @param {number} p.tabCount     external tabs currently open
   * @param {object|null} p.pageState { ageMs, open, click } from the isolated
   *                                   worlds, or null when CDP is unavailable.
   *                                   `ageMs` is measured against the open
   *                                   request time (the main process
   *                                   computes it from raw timestamps).
   *                                   `open` = { t, isTop, crossOrigin, ... }
   *                                   of the freshest window.open record;
   *                                   `click` = { t, isTop, crossOrigin,
   *                                   href, ... } of the freshest anchor
   *                                   click (target=_blank never calls
   *                                   window.open, so this is the only
   *                                   record of that path).
   * @param {number} p.contentsId
   * @param {number} [p.atMs]       when the open was REQUESTED. All ages are
   *                                 measured against this, not against the
   *                                 time this function runs (the isolated-
   *                                 world read is asynchronous and can take
   *                                 seconds on ad-heavy pages — measuring
   *                                 against "now" is what starved fresh
   *                                 clicks of their gesture).
   * @returns {{ allowed: boolean, reason: string, needsCommit?: boolean, earlierUrl?: string }}
   */
  function classifyWindowOpen(p) {
    const { url, sourceUrl, disposition, tabCount, pageState, contentsId } = p;
    const atMs = typeof p.atMs === 'number' ? p.atMs : now();
    const { protection, allowlist } = settingsOf();
    const isLinkClick = disposition === 'foreground-tab';

    if (!protection.enabled || protection.popups === false) return { allowed: true, reason: 'protection-off', needsCommit: false };
    if (isAllowedDomain(sourceUrl, allowlist)) return { allowed: true, reason: 'allowlisted', needsCommit: false };

    if (matchRequest(url, sourceUrl, 'popup') || matchRequest(url, sourceUrl, 'main_frame')) {
      return { allowed: false, reason: 'listed-destination', needsCommit: false };
    }
    // A hidden background tab is never a user workflow.
    if (disposition === 'background-tab') {
      return { allowed: false, reason: 'background-tab', needsCommit: false };
    }
    // Frame attribution: which frame's action caused THIS open. Two
    // mechanisms open tabs:
    //   * a scripted window.open      -> the `open` record in that frame;
    //   * a target=_blank anchor click -> the `click` record (window.open is
    //     NOT called; the browser opens the tab directly).
    const attribution = pickAttribution({ url, pageState });
    if (attribution && attribution.crossOrigin === true) {
      if (attribution.via === 'open' || !isLinkClick) {
        // A scripted window.open from a cross-origin iframe is the canonical
        // ad-embed pattern — it never opens, even on a real click elsewhere
        // and even when the browser reports it as a foreground tab. (The
        // href-matched click record above already took priority, so this
        // only fires when the open's own evidence says "ad".)
        return { allowed: false, reason: 'ad-iframe', needsCommit: false };
      }
      // A LINK click inside a cross-origin iframe: an embedded third-party
      // widget with its own links is legitimate (commit verification still
      // vets the destination), but a page that gets more than one such
      // click-open inside the window is an ad unit firing click-throughs.
      const repeatClick = repeatCrossOriginClicks.get(contentsId);
      if (repeatClick && atMs - repeatClick.firstAt < REPEAT_WINDOW_MS) {
        return { allowed: false, reason: 'repeat-cross-origin-click', needsCommit: false };
      }
    }
    if (tabCount >= maxTabs) return { allowed: false, reason: 'tab-budget', needsCommit: false };

    // Repeat rule (SCRIPTED opens only): this page already got a script
    // popup through inside the window. Ad redirectors fire one popup per
    // user action, so a second script open from the same page is unwanted:
    // block it and report the earlier popup's URL so the main process can
    // close that tab too. Link clicks (foreground-tab) are user
    // navigations, not popups — a page that legitimately popped once must
    // not swallow the user's next link click.
    const repeat = repeatOpeners.get(contentsId);
    if (!isLinkClick && repeat && atMs - repeat.firstAt < REPEAT_WINDOW_MS) {
      return { allowed: false, reason: 'repeat-popup', needsCommit: false, earlierUrl: repeat.url };
    }

    const entry = pageInput.get(contentsId) || { lastInputAt: 0, opens: 0, observed: false };
    if (!isLinkClick) entry.opens += 1; // every script-driven attempt consumes quota until a fresh gesture
    pageInput.set(contentsId, entry);

    // Activation evidence: the freshest of the isolated-world clock (real,
    // isTrusted input only) and the main-process input observation (real
    // key/mouse events from the browser's input pipeline — unspoofable,
    // and present even when the CDP read fails), both measured against the
    // moment the open was requested.
    let age = NO_ACTIVATION_MS;
    if (pageState && typeof pageState.ageMs === 'number') age = Math.min(age, pageState.ageMs);
    if (entry.lastInputAt) age = Math.min(age, atMs - entry.lastInputAt);

    if (age >= NO_ACTIVATION_MS) {
      // No input seen by the main process, no activation seen in the page:
      // there is no proof this is user-driven. Default to deny — a page the
      // user never interacted with does not get browsing contexts, whether
      // or not the destination looks familiar. This is also what stops a
      // scripted element.click() on a target=_blank anchor: the browser
      // reports it as a "foreground-tab" open, but no REAL input passed
      // through the browser's input pipeline and no isTrusted record was
      // written — it has no evidence behind it.
      return { allowed: false, reason: 'no-gesture', needsCommit: false };
    }

    if (age <= GESTURE_WINDOW_MS && entry.opens <= OPENS_PER_ACTIVATION) {
      if (!isLinkClick) repeatOpeners.set(contentsId, { url, firstAt: atMs });
      if (isLinkClick && attribution && attribution.crossOrigin === true) {
        repeatCrossOriginClicks.set(contentsId, { firstAt: atMs });
      }
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
    repeatCrossOriginClicks.delete(contentsId);
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
 * @param {boolean} [p.viaLinkClick] true when the open was a user LINK click
 *   (the destination is the user's choice). The popunder domain-jump rule
 *   then does NOT apply: a page may legitimately redirect the user across
 *   registrable domains (player/CDN/sister domains). Scripted keeps are
 *   still vetted against the filter lists above.
 * @returns {{ block: boolean, reason: string, type: 'Ad'|'Threat'|'Pop-up'|null }}
 */
function committedNavigationVerdict(p) {
  const { intendedUrl, openerUrl, finalUrl, matchRequest, nowMs, createdAt } = p;
  const viaLinkClick = p.viaLinkClick === true;
  if (nowMs - createdAt > WATCH_TTL_MS) return { block: false, reason: 'expired', type: null };

  if (matchRequest(finalUrl, intendedUrl, 'main_frame') || matchRequest(finalUrl, openerUrl, 'main_frame')) {
    const threat = matchRequest(finalUrl, intendedUrl, 'main_frame', 'threats') || matchRequest(finalUrl, openerUrl, 'main_frame', 'threats');
    return { block: true, reason: 'listed-redirect', type: threat ? 'Threat' : 'Ad' };
  }
  // Scripted opens only: window.open('') / location=ad popunder scheme: the
  // open started on the opener's own domain and the committed frame jumped
  // to another one. (A user link click is exempt — see viaLinkClick.)
  if (!viaLinkClick) {
    const intendedDomain = getRegistrableDomain(intendedUrl);
    const openerDomain = getRegistrableDomain(openerUrl);
    const finalDomain = getRegistrableDomain(finalUrl);
    if (intendedDomain !== '' && intendedDomain === openerDomain && finalDomain !== '' && finalDomain !== openerDomain) {
      return { block: true, reason: 'popunder', type: 'Pop-up' };
    }
  }
  return { block: false, reason: 'accepted', type: null };
}

module.exports = { createPopupPolicy, getRegistrableDomain, committedNavigationVerdict, pickAttribution, sameAnchorHref };
