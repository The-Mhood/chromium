'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { createProtectionCore } = require('./protection.cjs');

// The app uses the Electron adapter (createProtectionEngine); in plain Node
// the identical pure pipeline is tested against the same FiltersEngine the
// app uses. This covers matching, the refresh lifecycle and the cache.
const FiltersEngine = require('@ghostery/adblocker').FiltersEngine;

const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromiumcore-filters-'));
let fetchCalls = [];
const adListUrl = 'https://filters.test/ads.txt';
const trackerListUrl = 'https://filters.test/trackers.txt';
const ADS_TXT = [
  '!',
  '[Adblock Plus 2.0]',
  '||adnet.example^',
  '||ads.example.com^',
  '||doubleclick.example^',
  '##.ad-banner',
  '##[data-ad-zone]',
].join('\n');
const TRACKERS_TXT = ['||track.example^', '||analytics.example^'].join('\n');

const fakeFetch = async url => {
  fetchCalls.push(url);
  if (url === adListUrl) return new Response(ADS_TXT, { status: 200, statusText: 'OK' });
  if (url === trackerListUrl) return new Response(TRACKERS_TXT, { status: 200, statusText: 'OK' });
  return new Response('missing', { status: 404, statusText: 'Not Found' });
};

const settings = {
  protection: { enabled: true, network: true, popups: true, cosmetic: true, youtube: true, tracking: true },
  filters: [
    { id: 'easylist', name: 'Ads', url: adListUrl, enabled: true, updated: '' },
    { id: 'easyprivacy', name: 'Trackers', url: trackerListUrl, enabled: true, updated: '' },
  ],
  allowlist: [],
};

const realBaseline = name => {
  const file = path.join(__dirname, 'resources', `baseline-${name}.txt`);
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
};

const engine = createProtectionCore({
  getSettings: () => settings,
  engineFactory: FiltersEngine,
  loadBaseline: () => ({ ads: realBaseline('ads'), trackers: realBaseline('trackers'), threats: realBaseline('threats') }),
  cacheDir,
  fetch: fakeFetch,
});

function waitReady(core, ms = 15000) {
  return Promise.race([core.ready, new Promise((_, reject) => setTimeout(() => reject(new Error('ready timeout')), ms))]);
}

let adsCacheFile;

before(async () => {
  // Upgrade the baseline to the "fetched" lists, as the app does at startup.
  await engine.rebuild(settings.filters);
  await waitReady(engine);
  adsCacheFile = fs.readdirSync(cacheDir).find(name => /^ads-.*\.bin$/.test(name));
});

after(() => {
  try { fs.rmSync(cacheDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

test('baseline protection is active synchronously, before any list fetch exists', () => {
  // A fresh core with no rebuild at all: the bundled baseline must already
  // block known ad infrastructure on the very first decide() call.
  const bare = createProtectionCore({
    getSettings: () => settings,
    engineFactory: FiltersEngine,
    loadBaseline: () => ({ ads: realBaseline('ads'), trackers: realBaseline('trackers'), threats: null }),
    fetch: fakeFetch,
  });
  assert.equal(bare.status().ready, false, 'nothing has been built yet');
  const decision = bare.decide({ url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', resourceType: 'script' });
  assert.equal(decision.cancel, true);
  assert.equal(decision.type, 'Ad');
  const tracker = bare.decide({ url: 'https://www.google-analytics.com/g/collect', resourceType: 'fetch' });
  assert.equal(tracker.cancel, true);
  assert.equal(tracker.type, 'Tracker');
  const harmless = bare.decide({ url: 'https://example.com/page', resourceType: 'document' });
  assert.deepEqual(harmless, {});
});

test('fetched lists replace the baseline and are parsed with per-group counts', async () => {
  assert.ok(fetchCalls.includes(adListUrl));
  assert.ok(fetchCalls.includes(trackerListUrl));
  const status = engine.status();
  assert.equal(status.ready, true);
  assert.equal(status.ads.source, 'fetched');
  assert.ok(status.ads.rules >= 3, `fetched ad rules: ${status.ads.rules}`);
  assert.equal(status.trackers.source, 'fetched');
  assert.ok(status.trackers.rules >= 2, `fetched tracker rules: ${status.trackers.rules}`);

  assert.equal(engine.decide({ url: 'https://adnet.example/pixel', resourceType: 'image' }).type, 'Ad');
  assert.equal(engine.decide({ url: 'https://analytics.example/collect', resourceType: 'fetch' }).type, 'Tracker');
  assert.deepEqual(engine.decide({ url: 'https://example.com/page', resourceType: 'document' }), {});

  // The fetched list replaced the baseline for its group: a baseline-only
  // domain is no longer blocked (the list is the source of truth now).
  assert.deepEqual(engine.decide({ url: 'https://pagead2.googlesyndication.com/x.js', resourceType: 'script' }), {});
});

test('cosmetic rules from the fetched lists are exposed to the renderer', () => {
  const css = engine.cosmeticsFor('https://example.com/');
  assert.ok(css.includes('.ad-banner'), `css: ${css}`);
  assert.ok(css.includes('[data-ad-zone]'));
  // The always-on hardening rules ship too.
  assert.ok(css.includes('display:none'));
});

test('the main-frame redirect matcher recognises ad landing pages', () => {
  assert.equal(engine.matchMainFrame('https://adnet.example/landing'), 'Ad');
  assert.equal(engine.matchMainFrame('https://docs.example.com/'), null);
  assert.equal(engine.matchMainFrame('https://adnet.example/landing', null, 'threats'), null);
});

test('the popup policy is wired to the same engines', () => {
  const policy = engine.popupPolicy;
  const listed = policy.classifyWindowOpen({
    url: 'https://adnet.example/landing', sourceUrl: 'https://example.com/page',
    disposition: 'default', tabCount: 1, pageState: { ageMs: 10 }, contentsId: 99,
  });
  assert.equal(listed.allowed, false);
  assert.equal(listed.reason, 'listed-destination');
  // Default deny: the same clean URL with NO observed gesture is blocked...
  const unobserved = policy.classifyWindowOpen({
    url: 'https://docs.example.com/new', sourceUrl: 'https://example.com/page',
    disposition: 'foreground-tab', tabCount: 1, pageState: null, contentsId: 98,
  });
  assert.equal(unobserved.allowed, false);
  assert.equal(unobserved.reason, 'no-gesture');
  // ...and a real click right before it is allowed (then commit-verified).
  policy.observeInput(98, 'mouseDown');
  const clean = policy.classifyWindowOpen({
    url: 'https://docs.example.com/new', sourceUrl: 'https://example.com/page',
    disposition: 'foreground-tab', tabCount: 1, pageState: null, contentsId: 98,
  });
  assert.equal(clean.allowed, true);
  assert.equal(clean.needsCommit, true);
});

test('refresh persists the engine to the cache and a new core loads from it without fetching', async () => {
  assert.ok(adsCacheFile, 'the refresh must have written the ads cache');
  const meta = path.join(cacheDir, `${adsCacheFile}.meta.json`);
  assert.ok(fs.existsSync(meta));
  const metaCount = JSON.parse(fs.readFileSync(meta, 'utf8')).rules;
  assert.ok(metaCount >= 3, `meta rule count: ${metaCount}`);

  fetchCalls = [];
  const adsOnly = [{ id: 'easylist', name: 'Ads', url: adListUrl, enabled: true, updated: '' }];
  const second = createProtectionCore({
    getSettings: () => ({ ...settings, filters: adsOnly }),
    engineFactory: FiltersEngine,
    loadBaseline: () => ({ ads: null, trackers: null, threats: null }),
    cacheDir,
    fetch: fakeFetch,
  });
  await second.rebuild(adsOnly);
  await waitReady(second);
  assert.equal(second.status().ads.source, 'cache');
  assert.ok(second.status().ads.rules >= 3, `cached rules: ${second.status().ads.rules}`);
  assert.equal(second.decide({ url: 'https://adnet.example/pixel', resourceType: 'image' }).type, 'Ad');
  assert.equal(fetchCalls.length, 0, `cache hit must not fetch: ${fetchCalls.join(', ')}`);
});

test('an expired cache plus a failed refresh downgrades to cache-stale, never to empty', async () => {
  const full = path.join(cacheDir, adsCacheFile);
  const past = (Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000;
  fs.utimesSync(full, past, past); // older than the 24h TTL

  const failing = createProtectionCore({
    getSettings: () => ({ ...settings, filters: [{ id: 'easylist', name: 'Ads', url: adListUrl, enabled: true, updated: '' }] }),
    engineFactory: FiltersEngine,
    loadBaseline: () => ({ ads: null, trackers: null, threats: null }),
    cacheDir,
    fetch: async () => new Response('boom', { status: 500, statusText: 'Internal Error' }),
  });
  await failing.rebuild([{ id: 'easylist', name: 'Ads', url: adListUrl, enabled: true, updated: '' }]);
  await waitReady(failing);
  assert.equal(failing.status().ads.source, 'cache-stale');
  assert.equal(failing.decide({ url: 'https://adnet.example/pixel', resourceType: 'image' }).type, 'Ad',
    'stale cache must still protect');
});

test('a failed refresh with no cache at all keeps the bundled baseline', async () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromiumcore-empty-'));
  try {
    const failing = createProtectionCore({
      getSettings: () => ({ ...settings, filters: [{ id: 'easylist', name: 'Ads', url: adListUrl, enabled: true, updated: '' }] }),
      engineFactory: FiltersEngine,
      loadBaseline: () => ({ ads: realBaseline('ads'), trackers: null, threats: null }),
      cacheDir: emptyDir,
      fetch: async () => new Response('boom', { status: 500, statusText: 'Internal Error' }),
    });
    await failing.rebuild([{ id: 'easylist', name: 'Ads', url: adListUrl, enabled: true, updated: '' }]);
    await waitReady(failing);
    assert.equal(failing.status().ads.source, 'baseline');
    assert.ok(failing.status().ads.rules > 1000);
    assert.equal(failing.decide({ url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', resourceType: 'script' }).type, 'Ad');
  } finally {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

test('an identical rebuild is deduplicated (no re-fetch, no re-parse)', async () => {
  fetchCalls = [];
  await engine.rebuild(settings.filters);
  assert.equal(fetchCalls.length, 0, `dedup must skip the fetch: ${fetchCalls.join(', ')}`);
});

test('removing all lists falls back to the bundled baseline (never to nothing)', async () => {
  const noLists = { ...settings, filters: [] };
  const scoped = createProtectionCore({
    getSettings: () => noLists,
    engineFactory: FiltersEngine,
    loadBaseline: () => ({ ads: realBaseline('ads'), trackers: realBaseline('trackers'), threats: null }),
    fetch: fakeFetch,
  });
  await scoped.rebuild([]);
  await waitReady(scoped);
  const status = scoped.status();
  assert.equal(status.ads.source, 'baseline');
  assert.equal(status.trackers.source, 'baseline');
  assert.ok(status.totalRules > 2000);
  assert.equal(scoped.decide({ url: 'https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', resourceType: 'script' }).type, 'Ad');
});

test('service worker registration and XHR are blocked like other requests', () => {
  // adnet.example comes from the fetched list the main engine now runs.
  assert.equal(engine.decide({ url: 'https://adnet.example/sw.js', resourceType: 'serviceWorker' }).type, 'Ad');
  assert.equal(engine.decide({ url: 'https://adnet.example/beacon', resourceType: 'xhr', sourceUrl: 'https://example.com/' }).type, 'Ad');
  assert.equal(engine.decide({ url: 'https://example.com/asset.js', resourceType: 'script' }).cancel, undefined);
});

test('popups to listed destinations are blocked; ordinary tabs pass', () => {
  assert.equal(engine.shouldBlockPopup('https://adnet.example/landing', 'https://example.com/'), true);
  assert.equal(engine.shouldBlockPopup('https://docs.example.com/', 'https://example.com/'), false);
});

test('allowlisted sites bypass the request pipeline (and are blocked without it)', () => {
  const makeScoped = allowlist => createProtectionCore({
    getSettings: () => ({ ...settings, allowlist }),
    engineFactory: FiltersEngine,
    loadBaseline: () => ({ ads: null, trackers: null, threats: null }),
    fetch: fakeFetch,
  });
  const request = { url: 'https://popads.net/pixel', resourceType: 'image', sourceUrl: 'https://example.com/' };
  // Without an allowlist the fallback rules block the ad request.
  assert.equal(makeScoped([]).decide(request).type, 'Ad');
  // With the source page allowlisted, the same request passes.
  assert.deepEqual(makeScoped(['example.com']).decide(request), {});
});

test('untrusted filter URLs (file://, ftp://) are never fetched or applied', async () => {
  const scoped = createProtectionCore({
    getSettings: () => ({ ...settings, filters: [{ id: 'easylist', name: 'Local', url: 'file:///etc/passwd', enabled: true, updated: '' }] }),
    engineFactory: FiltersEngine,
    loadBaseline: () => ({ ads: realBaseline('ads'), trackers: null, threats: null }),
    fetch: fakeFetch,
  });
  fetchCalls = [];
  await scoped.rebuild([{ id: 'easylist', name: 'Local', url: 'file:///etc/passwd', enabled: true, updated: '' }]);
  await waitReady(scoped);
  assert.equal(fetchCalls.length, 0, 'file:// lists must never be fetched');
  assert.equal(scoped.status().ads.source, 'baseline');
});
