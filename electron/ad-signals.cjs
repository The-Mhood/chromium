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
// Named campaign fallbacks: the network's router parameter when the
// original placement (a "north" traffic source) failed. Field evidence
// (Nov 2026): coronisoralogy.cfd/…/?param_3=nortb_fallback&md=…
const NAMED_CAMPAIGN_PARAMS = new Set(['param_3', 'param3']);
const NAMED_CAMPAIGN_VALUES = new Set(['nortb_fallback']);

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
 *   3. two or more STRONG ad-network parameters are present;
 *   4. a NAMED campaign-fallback parameter holds a known campaign value
 *      (param_3=nortb_fallback) — the coronisoralogy.cfd -> playnaja.com
 *      router shape. The value itself is the signal (no weak cluster
 *      needed; see adCampaignMatch).
 *
 * Anything else — including ordinary marketing parameters (utm_*, ref, id,
 * token, expires alone) — passes. `input` that is not a parseable http(s)
 * URL returns false (the caller's own URL validation owns that failure).
 *
 * @param {string} input
 * @returns {boolean}
 */
function looksLikeAdCampaignUrl(input) {
  return adCampaignMatch(input) !== null;
}

/**
 * The ad-campaign rule that fires for `input`, or null. Same rules as
 * looksLikeAdCampaignUrl, but names the rule so the caller can log WHY a
 * gate fired (which is what "works in tests, dead in the field" needs).
 *
 * @param {string} input
 * @returns {?{name: string, detail: string}}
 */
function adCampaignMatch(input) {
  if (typeof input !== 'string' || !input) return null;
  let url;
  try { url = new URL(input); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let strongHits = 0;
  let weakHits = 0;
  let namedFallback = null;
  for (const [name, value] of url.searchParams) {
    const key = name.toLowerCase();
    if (STRONG_PARAMS.has(key)) strongHits += 1;
    else if (WEAK_PARAMS.has(key)) weakHits += 1;
    else if (IP_ECHO_PARAMS.has(key) && ipv4(value)) return { name: 'ip-echo', detail: `${name}=${value}` };
    else if (NAMED_CAMPAIGN_PARAMS.has(key) && NAMED_CAMPAIGN_VALUES.has(value.toLowerCase())) namedFallback = `${name}=${value}`;
  }
  if (strongHits >= 2) return { name: 'strong-cluster', detail: `${strongHits} strong params` };
  if (strongHits >= 1 && weakHits >= 1) return { name: 'strong-weak-cluster', detail: `1+ strong with ${weakHits} weak` };
  // The named campaign fallback is unmistakable on its own: a legitimate
  // site never emits param_3=nortb_fallback, so no weak cluster is needed
  // (and requiring one would miss the shape the moment the network drops
  // a single tracking param).
  if (namedFallback) return { name: 'named-campaign-fallback', detail: namedFallback };
  return null;
}

module.exports = { looksLikeAdCampaignUrl, adCampaignMatch };
