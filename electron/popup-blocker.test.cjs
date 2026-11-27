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

test('freshInput: only real click/key input within the gesture window counts', () => {
  const { policy, at } = makePolicy();
  at(1_000_000);
  // No input observed at all.
  assert.equal(policy.freshInput(1, 1_000_100), false, 'nothing observed is never fresh');
  // A real click is fresh inside the 1.5 s window...
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  assert.equal(policy.freshInput(1, 1_000_100), true, 'a mouse click is fresh');
  assert.equal(policy.freshInput(1, 1_001_499), true, '...right up to the window edge');
  // ...and stale after it.
  assert.equal(policy.freshInput(1, 1_001_501), false, 'a click older than the window is stale');
  // Other contents are unaffected.
  assert.equal(policy.freshInput(2, 1_000_100), false, 'input is per-contents');
  // Hover, movement and scroll are NOT activation: a page whose only
  // "input" is the cursor passing over it must not get popup activation.
  at(2_000_000);
  policy.observeInput(3, 'mouseEnter');
  policy.observeInput(3, 'mouseLeave');
  policy.observeInput(3, 'mouseMove');
  policy.observeInput(3, 'mouseWheel');
  assert.equal(policy.freshInput(3, 2_000_100), false, 'hover/move/scroll never count');
  // Keyboard counts (Enter/Space on a focused link is a click).
  at(2_000_000);
  policy.observeInput(4, 'keyDown');
  assert.equal(policy.freshInput(4, 2_000_100), true, 'key input counts');
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

test('a link click in a cross-origin iframe is verified, then rate-limited (ad click-throughs stop)', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  // The user clicked an anchor in a cross-origin iframe (an embedded
  // third-party widget with its own links). No open record exists (a link
  // click never calls window.open). The first such click-open is allowed
  // with commit verification — the destination is still vetted by the
  // filter engine and the hidden inspector...
  const first = classify({
    url: 'https://widget.example.org/doc',
    disposition: 'foreground-tab',
    pageState: { ageMs: 100, open: null, click: { t: 1_000_100, isTop: false, crossOrigin: true, frameHost: 'widget.example.org', topHost: 'site.test', href: 'https://widget.example.org/doc' } },
  });
  assert.equal(first.allowed, true);
  assert.equal(first.reason, 'link-click');
  assert.equal(first.needsCommit, true, 'the destination is still verified before a chip appears');
  // ...but an ad unit firing a SECOND cross-origin click-through within the
  // repeat window is an ad pattern, not a user workflow: blocked.
  at(1_002_000);
  policy.observeInput(1, 'mouseDown');
  at(1_002_100);
  const second = classify({
    url: 'https://widget.example.org/deal-2',
    disposition: 'foreground-tab',
    pageState: { ageMs: 100, open: null, click: { t: 1_002_100, isTop: false, crossOrigin: true, frameHost: 'widget.example.org', topHost: 'site.test', href: 'https://widget.example.org/deal-2' } },
  });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'repeat-cross-origin-click');
  // After the repeat window elapses, an ordinary cross-origin link works again.
  at(1_010_000);
  policy.observeInput(1, 'mouseDown');
  at(1_010_100);
  const later = classify({
    url: 'https://widget.example.org/doc-3',
    disposition: 'foreground-tab',
    pageState: { ageMs: 100, open: null, click: { t: 1_010_100, isTop: false, crossOrigin: true, frameHost: 'widget.example.org', topHost: 'site.test', href: 'https://widget.example.org/doc-3' } },
  });
  assert.equal(later.allowed, true);
});

test('a SCRIPTED open from a cross-origin iframe is still blocked outright', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  // The ad-embed pattern: the iframe's SCRIPT calls window.open. The click
  // rate limit does not soften scripted opens — they never get through.
  for (let i = 0; i < 3; i += 1) {
    at(1_000_100 + i * 1000);
    policy.observeInput(1, 'mouseDown');
    const decision = classify({
      url: 'https://adunit.net/promo' + i,
      disposition: 'default',
      pageState: { ageMs: 100, open: { t: 1_000_100 + i * 1000, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test' } },
    });
    assert.equal(decision.allowed, false, `attempt ${i}`);
    assert.equal(decision.reason, 'ad-iframe', `attempt ${i}`);
  }
});

test('a stale cross-origin click with a NON-matching href does not block a link click', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  // Regression guard (real app, fmhy.net): the user clicked an ad element
  // and then a site link within the record window. The ad iframe's click
  // is the only/freshest record but its href does not match the site link —
  // it must NOT be attributed as the cause, or legitimate site links are
  // refused. The gesture check decides instead (fresh click -> allowed).
  const decision = classify({
    url: 'https://site.test/another-page',
    disposition: 'foreground-tab',
    pageState: { ageMs: 100, open: null, click: { t: 1_000_100, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test', href: 'https://adunit.net/promo' } },
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'link-click');
});

test('a scripted open is still attributed to the window.open record', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  // A scripted window.open from a cross-origin iframe (open record) is
  // blocked even when a freshest-click fallback would have been ambiguous.
  const decision = classify({
    url: 'https://adunit.net/promo',
    disposition: 'default',
    pageState: { ageMs: 100, open: { t: 1_000_100, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test' }, click: { t: 1_000_090, isTop: true, crossOrigin: false, frameHost: 'site.test', topHost: 'site.test', href: '' } },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'ad-iframe');
});

// ---------------------------------------------------------------------------
// Root-cause regression guards for the real-app "links refuse to click"
// failures (fmhy.net): (1) ages must be measured against the OPEN-REQUEST
// time, not against whenever the async state read finishes; (2) a link open
// must never be attributed to a stale window.open record from another frame.
// ---------------------------------------------------------------------------

test('a slow isolated-world read does not starve a fresh click of its gesture', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown'); // the user clicks at t=1_000_000
  // The open request arrives a few ms later (t=1_000_030) — that is atMs.
  // classifyWindowOpen runs 2 s LATER, after the asynchronous DevTools read
  // finished on an ad-heavy page. The age must be measured against atMs:
  at(1_002_030);
  const decision = classify({
    url: 'https://site.test/movies/watch-123',
    disposition: 'foreground-tab',
    pageState: { ageMs: 30, open: null, click: null }, // age computed by main against atMs
    atMs: 1_000_030,
  });
  assert.equal(decision.allowed, true, 'the fresh click is not made "stale" by the read latency');
  assert.equal(decision.reason, 'link-click');
  // Sanity: with the same input but atMs genuinely 4 s after the click, the
  // open IS stale and must be blocked.
  at(1_004_030);
  const stale = classify({
    url: 'https://site.test/movies/watch-999',
    disposition: 'foreground-tab',
    pageState: { ageMs: 4000, open: null, click: null },
    atMs: 1_004_030,
  });
  assert.equal(stale.allowed, false);
  assert.equal(stale.reason, 'no-gesture');
});

test('fmhy fix: a link click whose href matches is NOT stolen by the ad iframe’s window.open record', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown'); // the user clicks a site link
  at(1_000_050);
  // The page state carries the ad iframe's window.open record from 2 s ago
  // (its popup attempt was blocked, but the record lingers in the isolated
  // world for 3 s) AND the click record of the anchor the user just
  // clicked. The href match must win the attribution — under the old
  // "freshest record" rule the ad's open record stole it and the
  // legitimate link was blocked as an "ad-iframe" open.
  const decision = classify({
    url: 'https://site.test/movies/watch-123',
    disposition: 'foreground-tab',
    pageState: {
      ageMs: 50,
      open: { t: 999_850, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test' },
      click: { t: 1_000_050, isTop: true, crossOrigin: false, frameHost: 'site.test', topHost: 'site.test', href: 'https://site.test/movies/watch-123' },
    },
  });
  assert.equal(decision.allowed, true, 'the user link is not attributed to the ad open');
  assert.equal(decision.reason, 'link-click');
  assert.equal(decision.needsCommit, true, 'commit verification still vets the destination');
});

test('an open with no click evidence and a cross-origin open record is an ad-iframe open (even as foreground-tab)', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_050);
  // A window.open() call from a cross-origin iframe — the browser may
  // report it as a foreground tab (window features), but the open record
  // is direct evidence of the scripted ad open: blocked, full stop. (With
  // NO click record at all there is no proof the user clicked anything.)
  const decision = classify({
    url: 'https://ad-landing.example.com/',
    disposition: 'foreground-tab',
    pageState: {
      ageMs: 50,
      open: { t: 1_000_050, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test' },
      click: null,
    },
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'ad-iframe');
});

test('a matching cross-origin click record still attributes (and rate-limits) even with a stale open record', () => {
  const { policy, at, classify } = makePolicy();
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_050);
  // First cross-origin click-open on this page: allowed (verification).
  const first = classify({
    url: 'https://widget.example.org/a',
    disposition: 'foreground-tab',
    pageState: {
      ageMs: 50,
      open: { t: 999_850, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test' },
      click: { t: 1_000_050, isTop: false, crossOrigin: true, frameHost: 'widget.example.org', topHost: 'site.test', href: 'https://widget.example.org/a' },
    },
  });
  assert.equal(first.allowed, true);
  // Second within the window: the REPEATED cross-origin click is blocked —
  // even though the stale open record is still sitting in the page state.
  at(1_003_000);
  policy.observeInput(1, 'mouseDown');
  at(1_003_050);
  const second = classify({
    url: 'https://widget.example.org/b',
    disposition: 'foreground-tab',
    pageState: {
      ageMs: 50,
      open: { t: 999_850, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'site.test' },
      click: { t: 1_003_050, isTop: false, crossOrigin: true, frameHost: 'widget.example.org', topHost: 'site.test', href: 'https://widget.example.org/b' },
    },
  });
  assert.equal(second.allowed, false);
  assert.equal(second.reason, 'repeat-cross-origin-click');
});

test('a page that popped once does not block the user\u2019s next link click', () => {
  const { policy, at, classify } = makePolicy();
  // A legitimate scripted popup (fresh gesture) goes through...
  at(1_000_000);
  policy.observeInput(1, 'mouseDown');
  at(1_000_100);
  const first = classify({ url: 'https://share-widget.test/', disposition: 'default', pageState: null });
  assert.equal(first.allowed, true);
  // ...and 2s later the user clicks a normal site link (fresh gesture).
  // The repeat rule targets scripted popups only — it must not swallow the
  // user's link navigation (and must not report the earlier popup to close).
  at(1_002_000);
  policy.observeInput(1, 'mouseDown');
  at(1_002_100);
  const link = classify({ url: 'https://site.test/next', disposition: 'foreground-tab', pageState: null });
  assert.equal(link.allowed, true);
  assert.equal(link.reason, 'link-click');
  assert.equal(link.earlierUrl, undefined);
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

test('commit: a SCRIPTED open through a cross-domain redirector to a third domain is blocked', () => {
  // The field shape the old rule missed: an ad script calls
  // window.open('https://innocent-redirector/…') — a registrable domain that
  // is NOT the opener's, so the "started on the opener's own domain" check
  // never fired — and that URL 302s to an ad domain before the first
  // commit. A scripted open may land on the domain it was asked about or
  // the opener's own domain; a third domain is a jump.
  const v = verdict({
    intendedUrl: 'https://redirector.test/offer?dest=bet',
    openerUrl: 'https://site.test/page',
    finalUrl: 'https://bet-ads.example.net/promo?c=xyz&clickid=123',
  });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'popunder');
  assert.equal(v.type, 'Pop-up');
  // A legitimate scripted popup (payment/share window) stays on the domain
  // it was pointed at, even when that domain is not the opener's:
  assert.equal(verdict({
    intendedUrl: 'https://checkout.payments.test/checkoutnow',
    openerUrl: 'https://shop.test/cart',
    finalUrl: 'https://checkout.payments.test/secure-step',
  }).block, false, 'a scripted open that commits to its own domain is legitimate');
  // And the window.open("") variant (intended domain empty) still only
  // allows the opener's own domain:
  const blank = verdict({
    intendedUrl: 'about:blank',
    openerUrl: 'https://site.test/page',
    finalUrl: 'https://bet-ads.example.net/promo',
  });
  assert.equal(blank.block, true);
  assert.equal(blank.reason, 'popunder');
});

test('commit: a LINK click that redirects across domains is NOT a popunder (site links work)', () => {
  // Real-world shape of the fmhy.net failure: the user clicks a movie link
  // on fmhy.net (intended == opener domain); the page 302s to its player on
  // a sister/CDN domain. The domain-jump rule must not fire for a link
  // click — the destination is the user's choice following the site's
  // normal redirects. Listed destinations are still caught above.
  const v = verdict({
    intendedUrl: 'https://fmhy.net/movie/watch-123',
    openerUrl: 'https://fmhy.net/',
    finalUrl: 'https://player.example-cdn.net/embed/123',
    viaLinkClick: true,
  });
  assert.equal(v.block, false, 'a link click crossing domains is the user navigating, not a popunder');
  assert.equal(v.reason, 'accepted');
  // The SAME jump for a SCRIPTED open is the window.open('') popunder
  // primitive and must still be blocked.
  const scripted = verdict({
    intendedUrl: 'https://fmhy.net/movie/watch-123',
    openerUrl: 'https://fmhy.net/',
    finalUrl: 'https://player.example-cdn.net/embed/123',
  });
  assert.equal(scripted.block, true);
  assert.equal(scripted.reason, 'popunder');
});

test('commit: a link click that lands on a LISTED ad domain is still blocked', () => {
  // viaLinkClick relaxes only the domain-jump rule, never the filter check.
  const v = verdict({
    intendedUrl: 'https://fmhy.net/ad-link',
    openerUrl: 'https://fmhy.net/',
    finalUrl: 'https://adnet.test/takeover',
    viaLinkClick: true,
  });
  assert.equal(v.block, true);
  assert.equal(v.reason, 'listed-redirect');
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

test('gated popup: fresh click in a third-party ad iframe + top-frame scripted open is blocked', () => {
  // The shape of the field bug: the user interacts with a third-party
  // widget (a trusted click recorded in the cross-origin iframe) and the
  // ad script immediately window.opens its landing page from the TOP
  // frame. The open record is top-frame + fresh, the input is genuine and
  // fresh — the only thing separating this from a real user action is
  // WHERE the click landed versus WHERE the open came from. The main
  // process routes this open as scripted (a window.open record, no anchor
  // href), so treatAsScripted is true — the disposition alone is not
  // evidence. (The click frame is a plain ad network, NOT a known captcha
  // provider — a real captcha continuation is exempt, see below.)
  const { classify } = makePolicy();
  const now = 1_000_000;
  const decision = classify({
    url: 'https://promo-landing.test/offer',
    sourceUrl: 'https://victim.test/page',
    disposition: 'foreground-tab',
    treatAsScripted: true,
    atMs: now,
    pageState: {
      ageMs: 0,
      open: { t: now, isTop: true, crossOrigin: false, frameHost: 'victim.test', topHost: 'victim.test' },
      click: { t: now - 80, isTop: false, crossOrigin: true, frameHost: 'adunit.net', topHost: 'victim.test' },
    },
  });
  assert.equal(decision.allowed, false, 'the gated popup is blocked');
  assert.equal(decision.reason, 'gated-popup');
});

test('gated popup: a click from a known captcha provider frame is exempt (continuation is commit-verified)', () => {
  // Field report: "the captcha doesn't open a new tab". After the user
  // solves a Google challenge, the page's own continuation (sign-in, age
  // check, payment) opens a tab from the top frame right after the
  // cross-origin captcha click. That is not the ad pattern — but its
  // destination must still pay the full commit verification.
  const { classify } = makePolicy();
  const now = 1_000_000;
  const decision = classify({
    url: 'https://gated.test/continue',
    sourceUrl: 'https://gated.test/verify',
    disposition: 'foreground-tab',
    treatAsScripted: true,
    atMs: now,
    pageState: {
      ageMs: 0,
      open: { t: now, isTop: true, crossOrigin: false, frameHost: 'gated.test', topHost: 'gated.test' },
      click: { t: now - 80, isTop: false, crossOrigin: true, frameHost: 'www.google.com', topHost: 'gated.test' },
    },
  });
  assert.notEqual(decision.reason, 'gated-popup', 'a captcha-provider click is not gated');
  assert.equal(decision.allowed, true, 'the post-captcha continuation opens');
  assert.equal(decision.needsCommit, true, 'and its committed URL is still verified');
});

test('gated popup rule does not fire for same-origin clicks or opens that preceded the click', () => {
  const { classify } = makePolicy();
  const now = 1_000_000;
  // (a) Same-origin top-frame click + top-frame open: the ordinary
  // user-click path must be untouched.
  const sameOrigin = classify({
    url: 'https://example.test/page',
    sourceUrl: 'https://example.test/home',
    disposition: 'foreground-tab',
    treatAsScripted: true,
    atMs: now,
    pageState: {
      ageMs: 0,
      open: { t: now, isTop: true, crossOrigin: false, frameHost: 'example.test', topHost: 'example.test' },
      click: { t: now - 50, isTop: true, crossOrigin: false, frameHost: 'example.test', topHost: 'example.test' },
    },
  });
  assert.notEqual(sameOrigin.reason, 'gated-popup', 'a same-origin click is never gated');
  assert.equal(sameOrigin.allowed, true, 'a real top-frame click still opens');
  // (b) The open happened BEFORE the third-party click — the click cannot
  // be its cause, so it must not veto the open.
  const openFirst = classify({
    url: 'https://promo-landing.test/offer',
    sourceUrl: 'https://victim.test/page',
    disposition: 'foreground-tab',
    treatAsScripted: true,
    atMs: now,
    pageState: {
      ageMs: 0,
      open: { t: now - 3000, isTop: true, crossOrigin: false, frameHost: 'victim.test', topHost: 'victim.test' },
      click: { t: now, isTop: false, crossOrigin: true, frameHost: 'accounts.google.com', topHost: 'victim.test' },
    },
  });
  assert.notEqual(openFirst.reason, 'gated-popup', 'an open that preceded the click is not gated');
});
