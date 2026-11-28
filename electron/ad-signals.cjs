'use strict';

// ---------------------------------------------------------------------------
// Interstitial-ad URL detector (rotating ad domains that never appear in the
// filter lists).
//
// Filter lists (EasyList & co.) cover KNOWN ad domains. Interstitial /
// sweepstakes / "answer 2 quick questions" networks serve their landing
// pages from SHORT-LIVED rotating domains (lwtz.com and friends), so no
// list update can keep up. Those landings are nevertheless recognisable
// from the URL itself: the campaign machinery appends a fixed cluster of
// tracking parameters to every hit, and — the strongest single signal —
// some of them ECHO THE VISITOR'S OWN IP ADDRESS as a query parameter
// (legitimate sites never do that).
//
// The detector is deliberately conservative (high precision): it must only
// fire on URLs that are unmistakably ad-campaign machinery, because the
// destinations it blocks include the user's movie sites, whose URLs carry
// their own (benign) parameters.
//
// Pure module — unit tested in plain Node (ad-signals.test.cjs). No
// Electron imports.
// ---------------------------------------------------------------------------

// Ad-network-specific parameter names. Any ONE of these next to ordinary
// campaign parameters (or two of them together) is the ad-campaign
// fingerprint.
const STRONG_PARAMS = new Set(['md5lp', 'clickid', 'campaignid', 'lp_md5', 'adclickid']);
// Ordinary-looking names that, in a cluster, are part of the same machinery
// (token lifetime, publisher id, signature). Alone they say nothing — real
// sites use `expires` and `token` all the time.
const WEAK_PARAMS = new Set(['pb', 'expires', 'token', 'sign', 'sig', 'camp', 'cid']);
// Parameters that carry an IP address value. A query param holding the
// VISITOR'S IPv4 address is ad fingerprinting, full stop.
const IP_ECHO_PARAMS = new Set(['p', 'ip', 'clientip', 'userip', 'remoteip', 'visitorip', 'visitoripaddress']);

function ipv4(value) {
  if (typeof value !== 'string') return false;
  const parts = value.split('.');
  if (parts.length !== 4) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number(part);
    if (n > 255) return false;
  }
  return true;
}

/**
 * True when the URL carries the fingerprint of an interstitial ad campaign
 * (rotating ad-network landing pages that are never in the filter lists).
 *
 * Fires when ANY of:
 *   1. an IP-echo parameter holds an IPv4 address (visitor IP fingerprint);
 *   2. at least one STRONG ad-network parameter is present AND at least one
 *      WEAK campaign parameter is present (the full cluster);
 *   3. two or more STRONG ad-network parameters are present.
 *
 * Anything else — including ordinary marketing parameters (utm_*, ref, id,
 * token, expires alone) — passes. `input` that is not a parseable http(s)
 * URL returns false (the caller's own URL validation owns that failure).
 *
 * @param {string} input
 * @returns {boolean}
 */
function looksLikeAdCampaignUrl(input) {
  if (typeof input !== 'string' || !input) return false;
  let url;
  try { url = new URL(input); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;

  let strongHits = 0;
  let weakHits = 0;
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase();
    if (STRONG_PARAMS.has(key)) strongHits += 1;
    else if (WEAK_PARAMS.has(key)) weakHits += 1;
    else if (IP_ECHO_PARAMS.has(key) && ipv4(value)) return true;
  }
  if (strongHits >= 2) return true;
  return strongHits >= 1 && weakHits >= 1;
}

module.exports = { looksLikeAdCampaignUrl };
