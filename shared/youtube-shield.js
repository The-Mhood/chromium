/*
 * ChromiumCore YouTube shield.
 *
 * Runs in the page's own JavaScript world at document start. Electron injects it with the Chrome
 * DevTools Protocol (Page.addScriptToEvaluateOnNewDocument) and Android with
 * WebViewCompat.addDocumentStartJavaScript, so both platforms share this one file.
 *
 * YouTube ships its ad schedule inside the video data (adPlacements, adSlots, playerAds), so domain
 * blocking cannot see it. This script removes that data before the player reads it, skips any ad that
 * still starts, hides ad containers, and dismisses the ad-blocker warning. YouTube changes its pages
 * often, so this is best-effort and will need updates over time.
 *
 * The allowlist placeholder below is replaced with a JSON array of hostnames when the script is injected.
 */
(function (ALLOW) {
  'use strict';

  try {
    var host = String(location.hostname || '').toLowerCase().replace(/^www\./, '');
    var isYouTube = /(^|\.)(youtube\.com|youtube-nocookie\.com|youtubekids\.com)$/.test(host) || host === 'youtube.googleapis.com';
    if (!isYouTube) return;
    for (var a = 0; a < ALLOW.length; a++) {
      var entry = ALLOW[a];
      if (host === entry || host.slice(-(entry.length + 1)) === '.' + entry) return;
    }
    if (window.__chromiumCoreYoutube) return;
    Object.defineProperty(window, '__chromiumCoreYoutube', { value: true });
  } catch (error) {
    return;
  }

  var AD_KEYS = ['adPlacements', 'playerAds', 'adSlots'];
  var PLAYER_URL = /\/youtubei\/v1\/(player|next|get_watch|reel\/reel_watch_sequence|reel\/reel_item_watch)(\?|$)/;
  var AD_MARKERS = /"(adPlacements|adSlots|playerAds)"|"isAd"/;
  var nativeParse = JSON.parse;

  // ---- 1. Remove ad data from player responses -------------------------------------------------

  function isAdEntry(entry) {
    try { return !!entry.command.reelWatchEndpoint.adClientParams.isAd; } catch (error) { return false; }
  }

  function prune(value, depth) {
    depth = depth || 0;
    if (!value || typeof value !== 'object' || depth > 3) return value;
    for (var i = 0; i < AD_KEYS.length; i++) {
      if (AD_KEYS[i] in value) {
        try { delete value[AD_KEYS[i]]; } catch (error) { /* frozen object: leave it */ }
      }
    }
    if (value.playerResponse) prune(value.playerResponse, depth + 1);
    if (value.reelWatchSequenceResponse) prune(value.reelWatchSequenceResponse, depth + 1);
    if (Array.isArray(value.entries) && value.entries.some(isAdEntry)) {
      try { value.entries = value.entries.filter(function (item) { return !isAdEntry(item); }); } catch (error) { /* ignore */ }
    }
    return value;
  }

  // The first video is embedded in the page as a global. Clean it as the page assigns it.
  function guardGlobal(name) {
    try {
      var current = window[name] ? prune(window[name]) : undefined;
      Object.defineProperty(window, name, {
        configurable: true,
        enumerable: true,
        get: function () { return current; },
        set: function (next) { current = prune(next); }
      });
    } catch (error) { /* property already locked */ }
  }
  guardGlobal('ytInitialPlayerResponse');

  // Later videos arrive as JSON, which the page parses with JSON.parse.
  JSON.parse = function () {
    var result = nativeParse.apply(this, arguments);
    try {
      if (result && typeof result === 'object' &&
          (result.playerResponse || result.adPlacements || result.playerAds || result.adSlots ||
           result.reelWatchSequenceResponse || result.entries)) {
        prune(result);
      }
    } catch (error) { /* never break the page's own parsing */ }
    return result;
  };

  // ...or through fetch...
  if (typeof window.fetch === 'function' && typeof window.Response === 'function') {
    var nativeFetch = window.fetch;
    window.fetch = function (input) {
      var promise = nativeFetch.apply(this, arguments);
      var url = '';
      try { url = typeof input === 'string' ? input : (input && input.url) || String(input); } catch (error) { /* ignore */ }
      if (!PLAYER_URL.test(url)) return promise;
      return promise.then(function (response) {
        try {
          if (!response || !response.ok) return response;
          return response.clone().text().then(function (text) {
            if (!AD_MARKERS.test(text)) return response;
            var cleaned = JSON.stringify(prune(nativeParse(text)));
            return new Response(cleaned, { status: response.status, statusText: response.statusText, headers: response.headers });
          }).catch(function () { return response; });
        } catch (error) {
          return response;
        }
      });
    };
  }

  // ...or through XMLHttpRequest, which older player builds and some embeds still use.
  if (typeof window.XMLHttpRequest === 'function') {
    var proto = window.XMLHttpRequest.prototype;
    var nativeOpen = proto.open;
    proto.open = function (method, url) {
      try { this.__ccUrl = String(url); } catch (error) { /* ignore */ }
      return nativeOpen.apply(this, arguments);
    };
    ['responseText', 'response'].forEach(function (property) {
      var descriptor = Object.getOwnPropertyDescriptor(proto, property);
      if (!descriptor || !descriptor.get) return;
      Object.defineProperty(proto, property, {
        configurable: true,
        enumerable: descriptor.enumerable,
        get: function () {
          var value = descriptor.get.call(this);
          try {
            if (this.__ccUrl && PLAYER_URL.test(this.__ccUrl)) {
              if (typeof value === 'string' && AD_MARKERS.test(value)) return JSON.stringify(prune(nativeParse(value)));
              if (value && typeof value === 'object') return prune(value);
            }
          } catch (error) { /* fall through to the original value */ }
          return value;
        }
      });
    });
  }

  // ---- 2. Hide ad containers ---------------------------------------------------------------------

  var CSS = [
    '#masthead-ad,#player-ads,.video-ads.ytp-ad-module,.ytp-ad-overlay-container,.ytp-ad-overlay-slot,.ytp-ad-text-overlay,',
    'ytd-ad-slot-renderer,ytd-display-ad-renderer,ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer,',
    'ytd-banner-promo-renderer,ytd-statement-banner-renderer,ytd-in-feed-ad-layout-renderer,ytd-companion-slot-renderer,',
    'ytd-action-companion-ad-renderer,yt-mealbar-promo-renderer,ytm-promoted-sparkles-web-renderer,ytm-companion-ad-renderer,',
    'ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-ads"]{display:none!important}',
    // :has() lives in its own rule so a browser without it cannot discard the rule above.
    'ytd-rich-item-renderer:has(ytd-ad-slot-renderer),ytd-rich-section-renderer:has(ytd-statement-banner-renderer){display:none!important}'
  ].join('');

  function addStyle() {
    if (document.querySelector && document.querySelector('style[data-chromiumcore-youtube]')) return true;
    var root = document.head || document.documentElement;
    if (!root) return false;
    var style = document.createElement('style');
    style.setAttribute('data-chromiumcore-youtube', '1');
    style.textContent = CSS;
    root.appendChild(style);
    return true;
  }
  try {
    if (!addStyle() && typeof MutationObserver === 'function') {
      var observer = new MutationObserver(function () { if (addStyle()) observer.disconnect(); });
      observer.observe(document, { childList: true, subtree: true });
    }
  } catch (error) { /* styling is optional */ }

  // ---- 3. Skip any ad that still starts, and clear the ad-blocker warning -------------------------

  var saved = null;
  var SKIP_BUTTONS = '.ytp-skip-ad-button,.ytp-ad-skip-button,.ytp-ad-skip-button-modern,.ytp-ad-skip-button-container button,.ytp-ad-skip-button-slot button';

  function dismissWarning() {
    var warning = document.querySelector('ytd-enforcement-message-view-model');
    if (!warning) return;
    var dialog = warning.closest ? warning.closest('tp-yt-paper-dialog') : null;
    (dialog || warning).remove();
    var backdrop = document.querySelector('tp-yt-iron-overlay-backdrop');
    if (backdrop) backdrop.remove();
    var video = document.querySelector('video.html5-main-video');
    if (video && video.paused && !video.ended) {
      var played = video.play();
      if (played && played.catch) played.catch(function () { /* autoplay may be refused */ });
    }
  }

  function tick() {
    try {
      var player = document.querySelector('.html5-video-player');
      if (!player) return;
      var video = player.querySelector('video.html5-main-video') || player.querySelector('video');
      var adShowing = player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting');
      if (adShowing && video) {
        if (!saved) saved = { muted: video.muted, rate: video.playbackRate };
        var skip = player.querySelector(SKIP_BUTTONS);
        if (skip) skip.click();
        video.muted = true;
        try { video.playbackRate = 16; } catch (error) { /* some rates are refused */ }
        var length = video.duration;
        if (isFinite(length) && length > 0 && video.currentTime < length - 0.25) video.currentTime = length - 0.1;
      } else if (saved && video) {
        video.muted = saved.muted;
        try { video.playbackRate = saved.rate; } catch (error) { /* ignore */ }
        saved = null;
      }
      var close = player.querySelector('.ytp-ad-overlay-close-button');
      if (close) close.click();
      dismissWarning();
    } catch (error) { /* a changed page layout must never throw into YouTube */ }
  }
  setInterval(tick, 250);
})(/*__CC_ALLOW__*/[]);
