'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { FullscreenController, IDLE_MS } = require('./fullscreen-state.cjs');

function makeController(options = {}) {
  let clock = 1_000_000;
  const effects = [];
  const ctl = new FullscreenController({
    now: () => clock,
    chromeHeight: 96,
    activeTabId: 'tab-a',
    windowFocused: true,
    showingExternal: true,
    ...options,
  });
  ctl.onEffect(effect => effects.push(effect));
  const windowEffects = () => effects.filter(e => e.type === 'window-fullscreen');
  const maximizeEffects = () => effects.filter(e => e.type === 'window-maximize');
  return {
    ctl,
    effects,
    windowEffects,
    maximizeEffects,
    at: t => { clock = t; },
    last: type => {
      for (let i = effects.length - 1; i >= 0; i -= 1) if (effects[i].type === type) return effects[i];
      return null;
    },
    count: type => effects.filter(e => e.type === type).length,
  };
}

test('starts windowed with visible chrome and top=chromeHeight', () => {
  const { ctl } = makeController();
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeHidden(), false);
  assert.equal(ctl.viewTop(), 96);
});

test('media fullscreen on the active tab: window-level (maximize), chrome off, top=0, no OS fullscreen', () => {
  const { ctl, effects, windowEffects, maximizeEffects } = makeController();
  ctl.mediaEnter('tab-a');
  assert.equal(ctl.wantsWindowFullscreen, false); // OS fullscreen is the user's
  assert.equal(ctl.mediaActive, true);
  assert.equal(ctl.chromeHidden(), true);
  assert.equal(ctl.viewTop(), 0);
  assert.deepEqual(windowEffects(), []);
  assert.deepEqual(maximizeEffects(), [{ type: 'window-maximize', on: true }]);
  assert.equal(effects.some(e => e.type === 'chrome' && e.visible === false), true);
});

test('media exit restores chrome, layout and window size (no OS transition)', () => {
  const { ctl, windowEffects, maximizeEffects } = makeController();
  ctl.mediaEnter('tab-a');
  ctl.mediaLeave('tab-a');
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeVisible, true);
  assert.equal(ctl.viewTop(), 96);
  assert.deepEqual(windowEffects(), []);
  assert.deepEqual(maximizeEffects(), [
    { type: 'window-maximize', on: true },
    { type: 'window-maximize', on: false },
  ]);
  // Stale leave from a non-owner is ignored.
  ctl.mediaLeave('tab-b');
  assert.equal(ctl.chromeVisible, true);
  assert.equal(ctl.mediaTabId, null);
});

test('media fullscreen on a background tab does not change the window', () => {
  const { ctl, maximizeEffects } = makeController();
  ctl.mediaEnter('tab-b'); // not the active tab
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeVisible, true);
  assert.equal(ctl.viewTop(), 96);
  assert.equal(maximizeEffects().length, 0);
  // Focusing the tab presents the media fullscreen it really has.
  ctl.tabFocused('tab-b', { mediaIsFullscreen: true });
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeVisible, false);
  assert.equal(maximizeEffects().length, 1);
  ctl.tabFocused('tab-a', { mediaIsFullscreen: false });
  assert.equal(ctl.mediaTabId, null);
  assert.equal(ctl.chromeVisible, true);
  assert.equal(maximizeEffects().length, 2); // maximise undone
});

test('closing the tab that owns media fullscreen clears everything (no stuck state)', () => {
  const { ctl, maximizeEffects } = makeController();
  ctl.mediaEnter('tab-a');
  assert.equal(ctl.mediaActive, true);
  assert.equal(ctl.chromeVisible, false);
  ctl.tabClosed('tab-a');
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeVisible, true);
  assert.equal(ctl.mediaTabId, null);
  assert.deepEqual(maximizeEffects(), [
    { type: 'window-maximize', on: true },
    { type: 'window-maximize', on: false },
  ]);
  // A leave event arriving after the close must not disturb the state.
  ctl.mediaLeave('tab-a');
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeVisible, true);
});

test('switching tabs abandons the background tab media fullscreen and reveals chrome', () => {
  const { ctl, maximizeEffects } = makeController();
  ctl.mediaEnter('tab-a');
  ctl.tabFocused('tab-b', { mediaIsFullscreen: false });
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeVisible, true);
  assert.equal(ctl.mediaTabId, null);
  assert.deepEqual(maximizeEffects(), [
    { type: 'window-maximize', on: true },
    { type: 'window-maximize', on: false },
  ]);
});

test('focus re-syncs the real media state of the focused tab', () => {
  const { ctl, maximizeEffects } = makeController();
  // We missed the enter event (it happened while the tab was backgrounded);
  // focusing the tab and reporting its real isFullscreen() adopts it.
  ctl.tabFocused('tab-b', { mediaIsFullscreen: true });
  assert.equal(ctl.mediaTabId, 'tab-b');
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeVisible, false);
  assert.equal(maximizeEffects().length, 1);
  ctl.tabFocused('tab-a', { mediaIsFullscreen: false });
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(ctl.chromeVisible, true);
  assert.equal(maximizeEffects().length, 2);
});

test('user toggle enters and exits browser fullscreen', () => {
  const { ctl, windowEffects } = makeController();
  ctl.userToggle();
  assert.equal(ctl.userFullscreen, true);
  assert.equal(ctl.wantsWindowFullscreen, true);
  assert.equal(ctl.chromeVisible, true); // chrome stays visible; idle rule hides it
  ctl.userToggle();
  assert.equal(ctl.userFullscreen, false);
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.deepEqual(windowEffects(), [
    { type: 'window-fullscreen', value: true },
    { type: 'window-fullscreen', value: false },
  ]);
});

test('user fullscreen + media fullscreen interact without double work', () => {
  const { ctl, effects, windowEffects, maximizeEffects } = makeController();
  ctl.userToggle(); // on
  ctl.mediaEnter('tab-a');
  assert.deepEqual(windowEffects(), [{ type: 'window-fullscreen', value: true }]); // no second request
  // No maximise: the OS fullscreen already covers the screen.
  assert.equal(maximizeEffects().length, 0);
  ctl.mediaLeave('tab-a'); // user fullscreen keeps the window fullscreen
  assert.equal(ctl.wantsWindowFullscreen, true);
  assert.deepEqual(windowEffects(), [{ type: 'window-fullscreen', value: true }]);
  assert.equal(effects.filter(e => e.type === 'chrome' && e.visible === true).length, 1); // chrome back
  ctl.userToggle(); // off
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.equal(windowEffects().length, 2);
});

test('media enter while user fullscreen: exit media keeps user fullscreen', () => {
  const { ctl, maximizeEffects } = makeController();
  ctl.userToggle();
  ctl.mediaEnter('tab-a');
  ctl.mediaLeave('tab-a');
  assert.equal(ctl.wantsWindowFullscreen, true);
  assert.equal(maximizeEffects().length, 0);
  ctl.userToggle();
  assert.equal(ctl.wantsWindowFullscreen, false);
});

test('the OS dropping user fullscreen while media is active only clears the user flag', () => {
  const { ctl, windowEffects } = makeController();
  ctl.userToggle();
  ctl.mediaEnter('tab-a');
  ctl.windowFullscreenChanged(false); // e.g. the user used the OS shortcut
  assert.equal(ctl.userFullscreen, false);
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.deepEqual(windowEffects(), [
    { type: 'window-fullscreen', value: true },
    { type: 'window-fullscreen', value: false },
  ]);
  // Media keeps its window-level presentation until it leaves.
  assert.equal(ctl.mediaActive, true);
  assert.equal(ctl.viewTop(), 0);
});

test('the OS dropping user fullscreen is treated as the user exiting', () => {
  const { ctl, windowEffects } = makeController();
  ctl.userToggle();
  ctl.windowFullscreenChanged(false); // user pressed Esc / OS shortcut
  assert.equal(ctl.userFullscreen, false);
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.deepEqual(windowEffects(), [
    { type: 'window-fullscreen', value: true },
    { type: 'window-fullscreen', value: false },
  ]);
});

test('an OS-initiated fullscreen is adopted, not fought', () => {
  const { ctl, windowEffects } = makeController();
  ctl.windowFullscreenChanged(true);
  assert.equal(ctl.userFullscreen, true);
  assert.deepEqual(windowEffects(), []); // no re-assert: we did not ask for it
  ctl.userToggle();
  assert.equal(ctl.wantsWindowFullscreen, false);
  assert.deepEqual(windowEffects(), [{ type: 'window-fullscreen', value: false }]);
});

test('chrome hides after seven idle seconds while browsing', () => {
  const { ctl, at } = makeController();
  at(1_000_000 + IDLE_MS - 1);
  ctl.tick({ windowFocused: true, showingExternal: true });
  assert.equal(ctl.chromeVisible, true);
  at(1_000_000 + IDLE_MS);
  ctl.tick({ windowFocused: true, showingExternal: true });
  assert.equal(ctl.chromeVisible, false);
  assert.equal(ctl.viewTop(), 0);
});

test('activity reveals the chrome and resets the idle clock', () => {
  const { ctl, at } = makeController();
  at(1_000_000 + IDLE_MS);
  ctl.tick({});
  assert.equal(ctl.chromeVisible, false);
  const activityAt = 1_000_000 + IDLE_MS + 1000;
  at(activityAt);
  ctl.activity();
  assert.equal(ctl.chromeVisible, true);
  at(activityAt + IDLE_MS - 1);
  ctl.tick({});
  assert.equal(ctl.chromeVisible, true);
  at(activityAt + IDLE_MS);
  ctl.tick({});
  assert.equal(ctl.chromeVisible, false);
});

test('the idle timer never touches the chrome while media is active', () => {
  const { ctl, at, effects } = makeController();
  ctl.mediaEnter('tab-a');
  const chromeEffectsAfterEnter = effects.filter(e => e.type === 'chrome').length;
  at(1_000_000 + IDLE_MS + 5000);
  ctl.tick({ windowFocused: true, showingExternal: true });
  assert.equal(ctl.chromeVisible, false);
  assert.equal(effects.filter(e => e.type === 'chrome').length, chromeEffectsAfterEnter); // no new chrome events
  ctl.activity(); // activity during media must not reveal the chrome over the player
  assert.equal(ctl.chromeVisible, false);
});

test('the idle timer pauses while the window is unfocused', () => {
  const { ctl, at } = makeController();
  at(1_000_000 + IDLE_MS);
  ctl.tick({ windowFocused: false, showingExternal: true });
  assert.equal(ctl.chromeVisible, true);
  ctl.focusWindow();
  assert.equal(ctl.chromeVisible, true);
});

test('the idle timer does not hide the chrome on internal pages (windowed)', () => {
  const { ctl, at } = makeController();
  at(1_000_000 + IDLE_MS);
  ctl.tick({ windowFocused: true, showingExternal: false });
  assert.equal(ctl.chromeVisible, true);
  // ...but it does hide in browser fullscreen, where the chrome belongs to the page.
  ctl.userToggle();
  at(1_000_000 + IDLE_MS + IDLE_MS);
  ctl.tick({ windowFocused: true, showingExternal: false });
  assert.equal(ctl.chromeVisible, false);
});

test('tab switch reveals the chrome (no inconsistent state on focus changes)', () => {
  const { ctl, at } = makeController();
  at(1_000_000 + IDLE_MS);
  ctl.tick({});
  assert.equal(ctl.chromeVisible, false);
  ctl.tabFocused('tab-b', { mediaIsFullscreen: false });
  assert.equal(ctl.chromeVisible, true);
});

test('window focus reveals the chrome', () => {
  const { ctl, at } = makeController();
  at(1_000_000 + IDLE_MS);
  ctl.tick({});
  assert.equal(ctl.chromeVisible, false);
  ctl.focusWindow();
  assert.equal(ctl.chromeVisible, true);
});

test('layout effects are emitted only on real changes (no resize spam)', () => {
  const { ctl, count } = makeController();
  const before = count('layout');
  ctl.resize(1440, 1000);
  const afterFirst = count('layout');
  ctl.activity(); // activity with visible chrome changes nothing
  const afterActivity = count('layout');
  assert.equal(afterFirst, before + 1);
  assert.equal(afterActivity, afterFirst);
});

test('responsive chrome height is tracked (96px and 91px breakpoints)', () => {
  const { ctl } = makeController();
  assert.equal(ctl.viewTop(), 96);
  ctl.setChromeHeight(91);
  assert.equal(ctl.chromeHeight, 91);
  assert.equal(ctl.viewTop(), 91);
  ctl.setChromeHeight(96);
  assert.equal(ctl.viewTop(), 96);
});

test('a destroyed owner cannot re-enter media fullscreen through stale events', () => {
  const { ctl } = makeController();
  ctl.mediaEnter('tab-a');
  ctl.tabClosed('tab-a');
  ctl.mediaEnter('tab-a'); // stale enter from the destroyed document
  // The state machine allows it (the document is gone, but be safe): the next
  // focus of a real tab re-syncs and clears it.
  ctl.tabFocused('tab-b', { mediaIsFullscreen: false });
  assert.equal(ctl.mediaTabId, null);
  assert.equal(ctl.wantsWindowFullscreen, false);
});

test('media maximize is not re-emitted when it is already in effect', () => {
  const { ctl, maximizeEffects } = makeController();
  ctl.mediaEnter('tab-a');
  // A second enter from the same document is a no-op.
  ctl.mediaEnter('tab-a');
  assert.equal(maximizeEffects().length, 1);
  // Re-adopting the active tab (focus re-sync) does not re-maximize.
  ctl.adoptMedia('tab-a');
  assert.equal(maximizeEffects().length, 1);
});
