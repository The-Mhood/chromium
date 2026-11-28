'use strict';

// ---------------------------------------------------------------------------
// Interstitial-ad URL detector (electron/ad-signals.cjs).
//
// The field case: https://lwtz.com/1838/en.html?pb=27275087&browser=other
// &campaignid=1808628&city=lagos&country=NG&device=desktop&expires=1795861524
// &p=105.127.10.165&md5lp=… — a rotating ad domain that is in NO filter
// list, carrying the campaign parameter cluster (and the visitor's own IP).
// The detector must catch that shape while leaving every ordinary
// navigation alone (the user's movie sites, search, video, docs).
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { looksLikeAdCampaignUrl } = require('./ad-signals.cjs');

const LWTZ = 'https://lwtz.com/1838/en.html?pb=27275087&browser=other&campaignid=1808628&city=lagos&country=NG&device=desktop&expires=1795861524&p=105.127.10.165&md5lp=lyXB9Y38wVoXLAciW';

test('the field interstitial (lwtz.com) is detected', () => {
  assert.equal(looksLikeAdCampaignUrl(LWTZ), true, 'the reported ad landing is flagged');
});

test('the visitor-IP echo alone is enough (any ad network)', () => {
  assert.equal(looksLikeAdCampaignUrl('https://whatever.net/sweep?x=1&clientip=105.127.10.165'), true);
  assert.equal(looksLikeAdCampaignUrl('https://whatever.net/sweep?userip=8.8.8.8'), true);
  // An IP-valued parameter that is NOT an IP-echo name (e.g. an API server
  // address the user chose) is not a fingerprint by itself.
  assert.equal(looksLikeAdCampaignUrl('https://app.example.com/?server=10.0.0.4'), false);
});

test('the strong+weak cluster is detected without an IP echo', () => {
  assert.equal(looksLikeAdCampaignUrl('https://sweep.example.net/p?campaignid=123&expires=1795861524'), true);
  assert.equal(looksLikeAdCampaignUrl('https://sweep.example.net/p?md5lp=abc&pb=77'), true);
});

test('two strong parameters are detected on their own', () => {
  assert.equal(looksLikeAdCampaignUrl('https://sweep.example.net/p?md5lp=abc&clickid=zzz'), true);
});

test('ordinary sites are never flagged', () => {
  const ordinary = [
    'https://www.google.com/search?q=best+nollywood+films&hl=en&num=20',
    'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&index=4&t=42s',
    'https://cinelove.live/',
    'https://fmhy.net/home',
    // Movie / streaming sites with their own session machinery:
    'https://movies.example.com/play/1838?token=abc123&expires=1795861524',
    'https://movies.example.com/play/1838?token=abc123&expires=1795861524&sign=deadbeef',
    // A single strong name with no cluster is marketing, not the ad net:
    'https://shop.example.com/deal?campaignid=blackfriday',
    // Ordinary tokens / expiries / signatures:
    'https://api.example.com/v1/resource?token=xyz&expires=1700000000&sig=a1',
    // IP-ish values that are not visitor-IP echoes:
    'https://docs.example.com/proxy?url=http%3A%2F%2F10.0.0.4%2F&ref=home',
  ];
  for (const url of ordinary) {
    assert.equal(looksLikeAdCampaignUrl(url), false, url);
  }
});

test('unparseable / non-http input is not flagged (caller validates)', () => {
  assert.equal(looksLikeAdCampaignUrl('not a url'), false);
  assert.equal(looksLikeAdCampaignUrl('javascript:alert(1)?p=1.2.3.4'), false);
  assert.equal(looksLikeAdCampaignUrl('core://newtab'), false);
  assert.equal(looksLikeAdCampaignUrl(''), false);
  assert.equal(looksLikeAdCampaignUrl(null), false);
});

test('parameter names are case-insensitive and duplicates do not double-count', () => {
  assert.equal(looksLikeAdCampaignUrl('https://sweep.example.net/p?MD5LP=abc&Expires=99&pb=1'), true);
  // Repeated names count once each (searchParams iterates each occurrence —
  // but two of the same weak name still cannot fabricate a strong hit).
  assert.equal(looksLikeAdCampaignUrl('https://site.example.com/?token=a&token=b'), false);
});
