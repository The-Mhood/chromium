const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { buildShieldScript } = require('./youtube-shield.cjs');

const PLAYER_JSON = JSON.stringify({ videoDetails: { title: 'A video' }, adPlacements: [{ id: 1 }], adSlots: [{ id: 2 }], playerAds: [{ id: 3 }], streamingData: { ok: true } });

function createEnvironment({ hostname = 'www.youtube.com', allowlist = [], fetchImpl, player } = {}) {
  const intervals = [];
  class FakeXHR { open(method, url) { this.opened = url; } }
  Object.defineProperty(FakeXHR.prototype, 'responseText', { configurable: true, get() { return this.fakeText; } });
  Object.defineProperty(FakeXHR.prototype, 'response', { configurable: true, get() { return this.fakeText; } });
  const styles = [];
  const document = {
    head: { appendChild: node => styles.push(node) },
    documentElement: { appendChild: node => styles.push(node) },
    createElement: () => ({ setAttribute() {}, textContent: '' }),
    querySelector: selector => (selector === '.html5-video-player' ? player || null : null),
  };
  const context = vm.createContext({
    document, location: { hostname }, Response, fetch: fetchImpl, XMLHttpRequest: FakeXHR,
    setInterval: fn => { intervals.push(fn); return intervals.length; },
    MutationObserver: class { observe() {} disconnect() {} },
  });
  context.window = context;
  vm.runInContext(buildShieldScript(allowlist), context);
  return { context, intervals, styles, FakeXHR };
}

function fakePlayer(adShowing) {
  const video = { muted: false, playbackRate: 1, duration: 30, currentTime: 2 };
  const skip = { clicked: 0, click() { this.clicked++; } };
  const state = { adShowing };
  const player = {
    classList: { contains: name => state.adShowing && name === 'ad-showing' },
    querySelector(selector) { return /video/.test(selector) ? video : /skip/.test(selector) ? skip : null; },
  };
  return { player, video, skip, state };
}

const hasAdData = value => ['adPlacements', 'adSlots', 'playerAds'].some(key => key in value);

test('does nothing on websites other than YouTube', () => {
  const { context, intervals, styles } = createEnvironment({ hostname: 'example.com' });
  assert.equal(intervals.length, 0);
  assert.equal(styles.length, 0);
  assert.equal(hasAdData(vm.runInContext(`JSON.parse('${PLAYER_JSON}')`, context)), true);
});

test('does nothing on an allowlisted YouTube host', () => {
  const { context, intervals } = createEnvironment({ allowlist: ['youtube.com'] });
  assert.equal(intervals.length, 0);
  assert.equal(hasAdData(vm.runInContext(`JSON.parse('${PLAYER_JSON}')`, context)), true);
});

test('removes ad data from the initial player response as the page assigns it', () => {
  const { context } = createEnvironment();
  vm.runInContext(`var ytInitialPlayerResponse = ${PLAYER_JSON};`, context);
  const response = context.ytInitialPlayerResponse;
  assert.equal(hasAdData(response), false);
  assert.equal(response.videoDetails.title, 'A video');
  assert.equal(response.streamingData.ok, true);
});

test('removes ad data from parsed JSON, including nested player responses', () => {
  const { context } = createEnvironment();
  const parsed = vm.runInContext(`JSON.parse(${JSON.stringify(JSON.stringify({ playerResponse: JSON.parse(PLAYER_JSON), other: 1 }))})`, context);
  assert.equal(hasAdData(parsed.playerResponse), false);
  assert.equal(parsed.other, 1);
  assert.equal(parsed.playerResponse.videoDetails.title, 'A video');
});

test('removes ad entries from Shorts sequences and keeps real videos', () => {
  const { context } = createEnvironment();
  const text = JSON.stringify({ entries: [{ id: 'a', command: { reelWatchEndpoint: { adClientParams: { isAd: true } } } }, { id: 'b', command: { reelWatchEndpoint: {} } }] });
  const parsed = vm.runInContext(`JSON.parse(${JSON.stringify(text)})`, context);
  // The array comes from the script's isolated realm, so compare plain values rather than prototypes.
  assert.equal(JSON.stringify(parsed.entries.map(entry => entry.id)), '["b"]');
});

test('strips ad data from player fetch responses and leaves other requests untouched', async () => {
  const original = new Response('{"ok":true}', { status: 200 });
  const { context } = createEnvironment({
    fetchImpl: async url => (String(url).includes('/youtubei/v1/player') ? new Response(PLAYER_JSON, { status: 200, headers: { 'content-type': 'application/json' } }) : original),
  });
  const player = await (await context.fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', { method: 'POST' })).json();
  assert.equal(hasAdData(player), false);
  assert.equal(player.videoDetails.title, 'A video');
  assert.equal(await context.fetch('https://www.youtube.com/api/other'), original);
});

test('passes failed or ad-free player responses through unchanged', async () => {
  const failed = new Response('nope', { status: 500 });
  const clean = new Response('{"videoDetails":{}}', { status: 200 });
  const { context } = createEnvironment({ fetchImpl: async url => (String(url).includes('fail') ? failed : clean) });
  assert.equal(await context.fetch('https://www.youtube.com/youtubei/v1/player?fail=1'), failed);
  assert.equal(await (await context.fetch('https://www.youtube.com/youtubei/v1/player')).text(), '{"videoDetails":{}}');
});

test('strips ad data from XMLHttpRequest responses for player URLs only', () => {
  const { context } = createEnvironment();
  const player = new context.XMLHttpRequest();
  player.open('POST', '/youtubei/v1/player?x=1');
  player.fakeText = PLAYER_JSON;
  assert.equal(hasAdData(JSON.parse(player.responseText)), false);
  const other = new context.XMLHttpRequest();
  other.open('GET', '/something/else');
  other.fakeText = PLAYER_JSON;
  assert.equal(other.responseText, PLAYER_JSON);
});

test('skips a running ad: presses skip, mutes, speeds up, and seeks to the end', () => {
  const { player, video, skip } = fakePlayer(true);
  const { intervals } = createEnvironment({ player });
  assert.equal(intervals.length, 1);
  intervals[0]();
  assert.equal(skip.clicked, 1);
  assert.equal(video.muted, true);
  assert.equal(video.playbackRate, 16);
  assert.ok(video.currentTime > 29);
});

test('restores the viewer\'s volume and speed once the ad has ended', () => {
  const { player, video, state } = fakePlayer(true);
  video.muted = false;
  video.playbackRate = 1.5;
  const { intervals } = createEnvironment({ player });
  intervals[0]();
  state.adShowing = false;
  intervals[0]();
  assert.equal(video.muted, false);
  assert.equal(video.playbackRate, 1.5);
});

test('never touches normal playback when no ad is showing', () => {
  const { player, video, skip } = fakePlayer(false);
  const { intervals } = createEnvironment({ player });
  intervals[0]();
  assert.equal(skip.clicked, 0);
  assert.equal(video.currentTime, 2);
  assert.equal(video.playbackRate, 1);
});

test('the allowlist is embedded safely and invalid entries are dropped', () => {
  const script = buildShieldScript(['Example.com', '"; alert(1)//', 5, 'news.org']);
  assert.ok(script.includes('["example.com","news.org"]'));
  assert.ok(!script.includes('alert(1)'));
  assert.ok(!script.includes('/*__CC_ALLOW__*/'));
});
