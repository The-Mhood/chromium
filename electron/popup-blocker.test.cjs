'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPopupPolicy, getRegistrableDomain } = require('./popup-blocker.cjs');
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
  assert.equal(off.classify().allowed, true);
  const paused = makePolicy({ protection: { enabled: true, popups: false } });
  assert.equal(paused.classify().allowed, true);
});

test('allowlisted sites are exempt from popup blocking', () => {
  const { classify } = makePolicy({ allowlist: ['site.test'] });
  const decision = classify({ pageState: { ageMs: 999999999 } });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'allowlisted');
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
  const link = policy.classifyWindowOpen({ url: 'https://adnet.test/landing', sourceUrl: 'https://site.test/page', disposition: 'foreground-tab', tabCount: 1, pageState: null, contentsId: 1 });
  assert.equal(link.allowed, false);
});

test('link clicks (foreground-tab) are always allowed for unlisted destinations', () => {
  const { classify } = makePolicy();
  const decision = classify({ disposition: 'foreground-tab' });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'link-click');
  assert.equal(decision.needsWatch, false);
});

test('tab budget blocks further popups', () => {
  const { classify } = makePolicy({ maxTabs: 2 });
  const decision = classify({ tabCount: 2, pageState: { ageMs: 0 } });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'tab-budget');
});

test('scripted window.open with a fresh activation is allowed once', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_400);
  const first = classify({ pageState: { ageMs: 400 } });
  assert.equal(first.allowed, true);
  assert.equal(first.reason, 'user-gesture');
  assert.equal(first.needsWatch, true);
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

test('background-tab opens need a near-synchronous gesture', () => {
  const { policy, at } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_400);
  assert.equal(policy.classifyWindowOpen({ url: 'https://popup-target.test/open', sourceUrl: 'https://site.test/page', disposition: 'background-tab', tabCount: 1, pageState: { ageMs: 400 }, contentsId: 1 }).allowed, true);
  // A stale gesture on a fresh tab (no earlier popup) is refused outright.
  at(1_000_000);
  policy.observeInput(2, 'mouseDown');
  at(1_001_200);
  const stale = policy.classifyWindowOpen({ url: 'https://popup-target.test/open', sourceUrl: 'https://site.test/page', disposition: 'background-tab', tabCount: 1, pageState: { ageMs: 1200 }, contentsId: 2 });
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason, 'no-gesture');
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

test('with no observation at all the policy degrades to allow (never break sites)', () => {
  const { classify } = makePolicy();
  const decision = classify(); // pageState null, no input ever seen
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'degraded');
  assert.equal(decision.needsWatch, true);
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
  // Malicious page fakes a fresh activation in its own world, but the main
  // process never saw input and the isolated world (the trusted source) says
  // there was none. The spoofed value would arrive as a *trusted* read only
  // if it came from the isolated world — which the page cannot write.
  const decision = classify({ pageState: { ageMs: 999999999 } });
  assert.equal(decision.allowed, false);
});

test('popunder: blank/same-page open that jumps to another domain is closed', () => {
  const { policy, at } = makePolicy();
  at(1_000_000);
  policy.registerPopup(7, { url: 'https://site.test/page', sourceUrl: 'https://site.test/page' });
  const verdict = policy.checkFirstNavigation(7, 'https://elsewhere.test/ad');
  assert.equal(verdict.block, true);
  assert.equal(verdict.reason, 'popunder');
  assert.equal(verdict.type, 'Pop-up');
});

test('popunder: first navigation to a listed ad domain is blocked as an ad', () => {
  const { policy } = makePolicy();
  policy.registerPopup(8, { url: 'https://site.test/page', sourceUrl: 'https://site.test/page' });
  const verdict = policy.checkFirstNavigation(8, 'https://adnet.test/takeover');
  assert.equal(verdict.block, true);
  assert.equal(verdict.reason, 'listed-redirect');
  assert.equal(verdict.type, 'Ad');
});

test('popunder: threat destinations are classified as threats', () => {
  const { policy } = makePolicy();
  policy.registerPopup(9, { url: 'https://site.test/page', sourceUrl: 'https://site.test/page' });
  const verdict = policy.checkFirstNavigation(9, 'https://malware.test/payload.exe');
  assert.equal(verdict.block, true);
  assert.equal(verdict.type, 'Threat');
});

test('popunder: legitimate same-domain redirects and explicit targets pass', () => {
  const { policy } = makePolicy();
  policy.registerPopup(10, { url: 'https://site.test/page', sourceUrl: 'https://site.test/page' });
  assert.equal(policy.checkFirstNavigation(10, 'https://site.test/page?step=2').block, false);

  policy.registerPopup(11, { url: 'https://login.other.test/', sourceUrl: 'https://site.test/page' });
  assert.equal(policy.checkFirstNavigation(11, 'https://login.other.test/auth/callback').block, false);
  // The watch is one-shot: a later navigation is not inspected twice.
  assert.equal(policy.checkFirstNavigation(11, 'https://elsewhere.test/x').block, false);
});

test('popunder watches expire after the TTL', () => {
  const { policy, at } = makePolicy();
  at(1_000_000);
  policy.registerPopup(12, { url: 'https://site.test/page', sourceUrl: 'https://site.test/page' });
  at(1_000_000 + 31_000);
  const verdict = policy.checkFirstNavigation(12, 'https://elsewhere.test/ad');
  assert.equal(verdict.block, false);
  assert.equal(verdict.reason, 'expired');
});

test('forget clears all per-tab state', () => {
  const { policy } = makePolicy();
  policy.observeInput(13, 'mouseDown');
  policy.registerPopup(13, { url: 'https://site.test/', sourceUrl: 'https://site.test/' });
  policy.forget(13);
  assert.equal(policy.checkFirstNavigation(13, 'https://elsewhere.test/x').reason, 'no-watch');
});

test('registrable domains handle public suffixes and www', () => {
  assert.equal(getRegistrableDomain('https://www.google.co.uk/x'), 'google.co.uk');
  assert.equal(getRegistrableDomain('https://sub.example.com'), 'example.com');
  assert.equal(getRegistrableDomain('https://example.com'), 'example.com');
  assert.equal(getRegistrableDomain('not a url'), '');
});
