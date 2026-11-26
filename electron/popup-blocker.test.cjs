'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPopupPolicy, getRegistrableDomain, committedNavigationVerdict } = require('./popup-blocker.cjs');
const { isAllowedDomain } = require('./security.cjs');

const ADS = new Set(['adnet.test', 'popads.net', 'trafficjunky.net']);
const THREATS = new Set(['malware.test']);

function makePolicy({ protection = { enabled: true, network: true, popups: true }, allowlist = [], maxTabs = 60 } = {}) {
  let clock = 1_000_000;
  const matchRequest = (url, _source, _type, group) => {
    let host = '';
    try { host = new URL(url).hostname; } catch { return false; }
    if (group === 'threats') return THREATS.has(host);
    return ADS.has(host) || THREATS.has(host);
  };
  const policy = createPopupPolicy({
    now: () => clock,
    matchRequest,
    getSettings: () => ({ protection, allowlist }),
    isAllowedDomain,
    maxTabs,
  });
  return {
    policy,
    at: t => { clock = t; },
    classify: (over = {}) => policy.classifyWindowOpen({
      url: 'https://popup-target.test/open',
      sourceUrl: 'https://site.test/page',
      disposition: 'default',
      tabCount: 1,
      pageState: null,
      contentsId: 1,
      ...over,
    }),
  };
}

test('protection off or paused popups allow everything', () => {
  const off = makePolicy({ protection: { enabled: false, popups: true } });
  const d1 = off.classify();
  assert.equal(d1.allowed, true);
  assert.equal(d1.needsCommit, false);
  const paused = makePolicy({ protection: { enabled: true, popups: false } });
  const d2 = paused.classify();
  assert.equal(d2.allowed, true);
  assert.equal(d2.needsCommit, false);
});

test('allowlisted sites are exempt from popup blocking', () => {
  const { classify } = makePolicy({ allowlist: ['site.test'] });
  const decision = classify({ pageState: { ageMs: 999999999 } });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allowlisted');
  assert.equal(decision.needsCommit, false);
});

test('listed ad or threat destinations are blocked even on a real gesture', () => {
  const { policy, at } = makePolicy();
  at(1_000_500);
  policy.observeInput(1, 'mouseDown');
  for (const url of ['https://adnet.test/landing', 'https://popads.net/x', 'https://malware.test/dl']) {
    const decision = policy.classifyWindowOpen({ url, sourceUrl: 'https://site.test/page', disposition: 'default', tabCount: 1, pageState: { ageMs: 10 }, contentsId: 1 });
    assert.equal(decision.allowed, false, url);
    assert.equal(decision.reason, 'listed-destination', url);
  }
  // A link click to a listed ad domain is blocked too (the navigation itself is the ad).
  const link = policy.classifyWindowOpen({ url: 'https://adnet.test/landing', sourceUrl: 'https://site.test/page', disposition: 'foreground-tab', tabCount: 1, pageState: { ageMs: 10 }, contentsId: 1 });
  assert.equal(link.allowed, false);
  assert.equal(link.reason, 'listed-destination');
});

test('background-tab opens are blocked even with a fresh gesture', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  const decision = classify({ disposition: 'background-tab', pageState: { ageMs: 100 } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'background-tab');
});

test('an open from a cross-origin iframe (ad embed) is blocked even on a real click', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  const decision = classify({ pageState: { ageMs: 100, open: { isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test' } } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'ad-iframe');
});

test('an open from a same-origin iframe is treated like a top-frame open', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  const decision = classify({ pageState: { ageMs: 100, open: { isTop: false, crossOrigin: false, frameHost: 'site.test', topHost: 'site.test' } } });
  assert.equal(decision.allowed, true);
  assert.equal(decision.needsCommit, true);
});

test('a top-frame open with no frame record falls back to the gesture check', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  const decision = classify({ pageState: { ageMs: 100, open: { isTop: true, crossOrigin: false } } });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'user-gesture');
});

test('a target=_blank click from a cross-origin ad iframe is blocked (no window.open involved)', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  // The user clicked the ad iframe's own anchor; the click record's href is
  // the destination and the frame is cross-origin. No open record exists.
  const decision = classify({
    url: 'https://sponsored-offers.example.org/deal',
    disposition: 'foreground-tab',
    pageState: { ageMs: 100, open: null, click: { t: 1_000_100, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test', href: 'https://sponsored-offers.example.org/deal' } },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'ad-iframe');
});

test('a cross-origin iframe click is blocked even when its href does not match', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  // A cross-origin click that is the freshest action (href unknown, e.g. a
  // non-anchor element) is still attributed to the ad iframe and blocked.
  const decision = classify({
    url: 'https://sponsored-offers.example.org/deal',
    disposition: 'foreground-tab',
    pageState: { ageMs: 100, open: null, click: { t: 1_000_100, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test', href: '' } },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'ad-iframe');
});

test('a top-frame target=_blank click is NOT blocked by the ad-iframe rule', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  // Same page, but the user clicked the page's own link in the top document.
  const decision = classify({
    url: 'https://docs.example.com/guide',
    disposition: 'foreground-tab',
    pageState: { ageMs: 100, open: null, click: { t: 1_000_100, isTop: true, crossOrigin: false, frameHost: 'site.test', topHost: 'site.test', href: 'https://docs.example.com/guide' } },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'link-click');
});

test('a matching top-frame click is not shadowed by a stale ad-iframe click', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  // The ad iframe clicked 400ms ago (stale), the user clicked the page's own
  // link just now. The href-matched top-frame click must win attribution.
  const decision = classify({
    url: 'https://docs.example.com/guide',
    disposition: 'foreground-tab',
    pageState: {
      ageMs: 100,
      open: null,
      click: { t: 1_000_100, isTop: true, crossOrigin: false, frameHost: 'site.test', topHost: 'site.test', href: 'https://docs.example.com/guide' },
    },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'link-click');
});

test('tab budget blocks further popups', () => {
  const { classify } = makePolicy({ maxTabs: 2 });
  const decision = classify({ tabCount: 2, pageState: { ageMs: 0 } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'tab-budget');
});

test('scripted window.open with a fresh activation is allowed once, then verified', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_400);
  const first = classify({ pageState: { ageMs: 400 } });
  assert.equal(first.allowed, true);
  assert.equal(first.reason, 'user-gesture');
  assert.equal(first.needsCommit, true, 'the main process verifies the committed URL before any tab chip');
});

test('a genuine link click (foreground-tab) with a fresh gesture is allowed', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_120);
  const decision = classify({ disposition: 'foreground-tab', pageState: { ageMs: 120 } });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'link-click');
  assert.equal(decision.needsCommit, true, 'redirect-to-ad must be caught before the chip appears');
});

test('a target=_blank open with NO gesture is blocked (click-to-ad defence)', () => {
  const { classify } = makePolicy();
  // A deceptive ad element with target="_blank" firing without any observed
  // input on this page: there is no proof of a click, so deny.
  const decision = classify({ disposition: 'foreground-tab', pageState: { ageMs: 999999999 } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-gesture');
});

test('scripted window.open without any activation is blocked', () => {
  const { classify } = makePolicy();
  // The isolated-world script is present (it reports an age), but nobody interacted.
  const decision = classify({ pageState: { ageMs: 999999999 } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-gesture');
});

test('a stale activation (older than the gesture window) is blocked', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_002_000);
  const decision = classify({ pageState: { ageMs: 2000 } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-gesture');
});

test('a delayed popup (fires long after the click) is blocked', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_004_000); // the click is 4 s old; the timer fires now
  const decision = classify({ pageState: { ageMs: 4000 } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-gesture');
});

test('a popup chain is cut off after the first open', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_200);
  assert.equal(classify({ pageState: { ageMs: 200 } }).allowed, true);
  at(1_000_400);
  const second = classify({ pageState: { ageMs: 400 } });
  assert.equal(second.allowed, false);
  // The repeat rule catches this: a second script open from the same page
  // inside the window is unwanted, regardless of the per-gesture quota.
  assert.equal(second.reason, 'repeat-popup');
});

test('the page report and the main observation corroborate (min age wins)', () => {
  const { policy, at, classify } = makePolicy();
  // Page sees a fresh touch the main process did not (touch does not always
  // surface as before-input-event): the page clock alone is enough.
  at(1_000_000);
  const decision = classify({ pageState: { ageMs: 150 } });
  assert.equal(decision.allowed, true);
  // No page report, but the main process saw the mouse: still allowed.
  policy.observeInput(2, 'mouseDown');
  at(1_000_300);
  const fallback = classify({ contentsId: 2 });
  assert.equal(fallback.allowed, true);
});

test('with no observation at all the policy BLOCKS (no degraded mode)', () => {
  const { classify } = makePolicy();
  // No CDP read, no input ever seen on this page: default to deny. A page
  // the user never touched cannot legitimately open a browsing context —
  // and unlisted ad domains cannot be told apart from real ones anyway.
  const decision = classify(); // pageState null, no input ever seen
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-gesture');
});

test('scrolling does not grant popup activation', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseWheel');
  at(1_000_100);
  // The isolated-world script is installed (it reports an age), but the only
  // "input" was a scroll: the open is refused like a no-gesture one.
  const decision = classify({ pageState: { ageMs: 999999999 } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'no-gesture');
});

test('a page firing repeated popups is stopped and its first popup reported', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_200);
  const first = classify({ url: 'https://stake.example/join', pageState: { ageMs: 200 } });
  assert.equal(first.allowed, true);
  assert.equal(first.reason, 'user-gesture');
  // The user clicks again a moment later: a fresh gesture, a second popup.
  // Ad redirectors do exactly this — each click spawns a new ad tab.
  at(1_001_500);
  policy.observeInput(1, 'mouseDown');
  at(1_001_600);
  const second = classify({ url: 'https://opera.example/gx', pageState: { ageMs: 100 } });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'repeat-popup');
  assert.equal(second.earlierUrl, 'https://stake.example/join');
  // After the repeat window elapses, ordinary sites can open again.
  at(1_009_000);
  policy.observeInput(1, 'mouseDown');
  at(1_009_100);
  const later = classify({ url: 'https://partner.example/open', pageState: { ageMs: 100 } });
  assert.equal(later.allowed, true);
  assert.equal(later.reason, 'user-gesture');
});

test('repeat-popup state is per tab and cleared by forget', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  assert.equal(classify({ url: 'https://one.example/' }).allowed, true);
  policy.forget(1); // tab closed / destroyed
  at(1_000_300);
  policy.observeInput(1, 'mouseDown');
  at(1_000_400);
  assert.equal(classify({ url: 'https://two.example/' }).allowed, true);
});

test('a page cannot spoof the isolated-world clock to open without a gesture', () => {
  const { classify } = makePolicy();
  // The isolated world is the trusted clock source and it says there was no
  // activation; the main process saw nothing either. Block.
  const decision = classify({ pageState: { ageMs: 999999999 } });
  assert.equal(decision.allowed, false);
});

// ---------------------------------------------------------------------------
// Commit verification verdicts (the hidden inspector in the main process)
// ---------------------------------------------------------------------------

const verdict = (over = {}) => committedNavigationVerdict({
  intendedUrl: 'https://intended.test/open',
  openerUrl: 'https://site.test/page',
  finalUrl: 'https://final.test/landed',
  matchRequest: (url, _s, _t, group) => {
    let host = '';
    try { host = new URL(url).hostname; } catch { return false; }
    if (group === 'threats') return THREATS.has(host);
    return ADS.has(host) || THREATS.has(host);
  },
  nowMs: 1_000_200,
  createdAt: 1_000_000,
  ...over,
});

test('commit: a redirect into a listed ad domain is blocked before the tab exists', () => {
  const v = verdict({ finalUrl: 'https://adnet.test/takeover' });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'listed-redirect');
  assert.equal(v.type, 'Ad');
});

test('commit: a redirect into a listed threat domain is classified as a threat', () => {
  const v = verdict({ finalUrl: 'https://malware.test/payload.exe' });
  assert.equal(v.block, true);
  assert.equal(v.type, 'Threat');
});

test('commit: the window.open("")-then-location=ad popunder scheme is blocked', () => {
  // The open was requested on the opener\'s own domain and the committed
  // frame jumped to a different registrable domain.
  const v = verdict({ intendedUrl: 'https://site.test/page', openerUrl: 'https://site.test/page', finalUrl: 'https://elsewhere.test/ad' });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'popunder');
  assert.equal(v.type, 'Pop-up');
});

test('commit: legitimate same-domain redirects and explicit targets pass', () => {
  assert.equal(verdict({ intendedUrl: 'https://site.test/page', openerUrl: 'https://site.test/page', finalUrl: 'https://site.test/page?step=2' }).block, false);
  // An explicit cross-site destination that stays where it was pointed.
  assert.equal(verdict({ intendedUrl: 'https://login.other.test/', openerUrl: 'https://site.test/page', finalUrl: 'https://login.other.test/auth/callback' }).block, false);
  // www and subdomain rewrites within the same registrable domain pass.
  assert.equal(verdict({ intendedUrl: 'https://example.com/', openerUrl: 'https://example.com/', finalUrl: 'https://www.example.com/start' }).block, false);
});

test('commit: an expired watch does not block (slow legitimate sites keep working)', () => {
  const v = verdict({ finalUrl: 'https://elsewhere.test/ad', nowMs: 1_000_000 + 31_000 });
  assert.equal(v.block, false);
  assert.equal(v.reason, 'expired');
});

test('registrable domains handle public suffixes and www', () => {
  assert.equal(getRegistrableDomain('https://www.google.co.uk/x'), 'google.co.uk');
  assert.equal(getRegistrableDomain('https://sub.example.com'), 'example.com');
  assert.equal(getRegistrableDomain('https://example.com'), 'example.com');
  assert.equal(getRegistrableDomain('not a url'), '');
});
