'use strict';

// ---------------------------------------------------------------------------
// ChromiumCore protection engine.
//
// Two layers:
//   createProtectionCore  — pure request pipeline (no Electron imports):
//                           owns the filter engines, matching decisions,
//                           popups, cosmetics extraction, list lifecycle
//                           (baseline -> cache -> fetched) and status.
//                           Unit tested in plain Node.
//   createProtectionEngine — thin Electron adapter: wires the core into
//                           session.webRequest and applies cosmetic CSS to
//                           webContents.
//
// Key fixes versus the previous implementation:
//   * A bundled baseline (EasyList/EasyPrivacy domain rules, see
//     electron/resources/) is parsed synchronously at startup, so protection
//     is active from the first request — previously the engine started with
//     ~15 hardcoded rules and only learned real lists after the renderer
//     connected *and* a network fetch finished.
//   * `rebuild` tracks per-group state (fetched / cache / baseline / fallback)
//     and never downgrades a working engine when a refresh fails.
//   * The `youtube` (annoyances) list now feeds the ads group, so its
//     cosmetic rules are actually applied — they were silently excluded
//     before.
//   * Service-worker registration requests flow through the same pipeline,
//     so ad-network service workers are blocked like any other request.
// ---------------------------------------------------------------------------

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { isAllowedDomain, trustedFilterUrl } = require('./security.cjs');
const { createPopupPolicy } = require('./popup-blocker.cjs');

let tldts;
let tldtsTried = false;
function getDomain(hostname) {
  if (!tldtsTried) {
    tldtsTried = true;
    try { tldts = require('tldts'); } catch { tldts = null; }
  }
  if (tldts) return tldts.getDomain(hostname);
  const labels = String(hostname || '').split('.');
  return labels.length > 2 ? labels.slice(-2).join('.') : String(hostname || '');
}

// Small hard fallback, used only if even the bundled baseline files are
// missing (corrupt install). The real baseline is electron/resources/*.txt.
const fallbackRules = {
  ads: '||doubleclick.net^\n||googlesyndication.com^\n||googleadservices.com^\n||adnxs.com^\n||adsrvr.org^\n||popads.net^\n||popcash.net^\n||propellerads.com^\n||exoclick.com^\n||trafficjunky.net^\n||juicyads.com^\n||adsterra.com^\n##.ad-banner\n##.adsbygoogle\n##[data-ad-slot]',
  trackers: '||google-analytics.com^\n||analytics.google.com^\n||connect.facebook.net^\n||pixel.facebook.com^\n||scorecardresearch.com^\n||doubleclick.net^\n||googlesyndication.com^\n||googletagmanager.com^',
  threats: '',
};
const cosmeticCSS = '.ad-banner,.sidebar-ad,.adsbygoogle,[data-ad-slot],[id^="div-gpt-ad"],[class^="ad-slot"],[class*=" ad-slot"],.advertisement-container{display:none!important}';
const youtubeCSS = 'ytd-ad-slot-renderer,ytd-display-ad-renderer,ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer,ytd-banner-promo-renderer,.ytp-ad-overlay-container{display:none!important}';
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function readFileSyncSafe(file) {
  try { return require('node:fs').readFileSync(file, 'utf8'); } catch { return null; }
}

function countRules(text) {
  if (!text) return 0;
  let count = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('!') && !trimmed.startsWith('[') && !trimmed.startsWith('#')) count += 1;
  }
  return count;
}

async function readCacheMeta(metaFile) {
  try { return JSON.parse(await fs.readFile(metaFile, 'utf8')); } catch { return { rules: 0 }; }
}

/**
 * Pure core. `engineFactory` must expose the @ghostery/adblocker engine API
 * (parse / empty / deserialize / serialize on the class; match / serialize /
 * getCosmeticsFilters on instances). In the desktop app it is
 * ElectronBlocker; in tests it is FiltersEngine.
 */
function createProtectionCore({ getSettings, engineFactory, loadBaseline = null, cacheDir = null, fetch: fetchImpl, log = console.warn } = {}) {
  if (!engineFactory || !engineFactory.parse) throw new Error('createProtectionCore requires an engineFactory');
  // Injectable fetch (tests); the app uses the runtime's global fetch.
  const doFetch = typeof fetchImpl === 'function' ? fetchImpl : (url, options) => fetch(url, options);

  const baseline = loadBaseline ? loadBaseline() : { ads: null, trackers: null, threats: null };
  const make = (group) => {
    const text = (group === 'ads' && baseline.ads) || (group === 'trackers' && baseline.trackers) || (group === 'threats' && baseline.threats);
    if (text) {
      try {
        return { engine: engineFactory.parse(text), source: 'baseline', rules: countRules(text), updatedAt: null };
      } catch (error) { log(`Baseline ${group} parse failed:`, error.message); }
    }
    try {
      return { engine: engineFactory.parse(fallbackRules[group] || ''), source: 'fallback', rules: countRules(fallbackRules[group] || ''), updatedAt: null };
    } catch (error) { log(`Fallback ${group} parse failed:`, error.message); return { engine: engineFactory.empty(), source: 'empty', rules: 0, updatedAt: null }; }
  };

  const groups = { ads: make('ads'), trackers: make('trackers'), threats: make('threats') };
  let generation = 0;
  let currentSignature = null;
  let initialBuildDone = false;

  // `ready` settles once the initial list build is done: after the first
  // rebuild completes, or shortly after startup if no lists are requested at
  // all (the baseline is already active, so nothing to wait for).
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const finishInitialBuild = () => {
    if (initialBuildDone) return;
    initialBuildDone = true;
    resolveReady();
  };
  const readyFallback = setTimeout(finishInitialBuild, 5000);
  readyFallback.unref?.(); // never keep a plain-Node process alive on its own

  function resetToBaseline(group) {
    // Re-parse the baseline only when the group currently runs something else.
    if (groups[group].source !== 'baseline' && groups[group].source !== 'fallback') groups[group] = make(group);
  }

  /**
   * Decide whether a request should be blocked or rewritten.
   * @param {object} d { url, resourceType, sourceUrl, referrer, method }
   * @returns {{cancel?: boolean, redirectURL?: string, type?: 'Ad'|'Tracker'|'Threat'}}
   */
  function decide(d) {
    const { protection, allowlist } = getSettings();
    const sourceUrl = d.sourceUrl || d.referrer || '';
    if (!protection.enabled || isAllowedDomain(sourceUrl, allowlist)) return {};
    const type = d.resourceType || 'other';
    let request;
    try {
      request = requestFactory({ url: d.url, sourceUrl, type, method: d.method });
    } catch { return {}; }
    const candidates = [];
    if (protection.network !== false) candidates.push(['threats', 'Threat'], ['ads', 'Ad']);
    if (protection.tracking !== false) candidates.push(['trackers', 'Tracker']);
    for (const [group, blockedType] of candidates) {
      const result = groups[group].engine.match(request);
      if (result.match) {
        return result.redirect ? { redirectURL: result.redirect.dataUrl, type: blockedType } : { cancel: true, type: blockedType };
      }
      if (result.rewrite && result.rewrite.url && result.rewrite.url !== d.url) return { redirectURL: result.rewrite.url, type: blockedType };
    }
    return {};
  }

  function requestFactory({ url, sourceUrl, type, method }) {
    const { Request } = adblockerPure();
    return Request.fromRawDetails({ url, sourceUrl, type, method });
  }

  let pureAdblocker;
  function adblockerPure() {
    if (!pureAdblocker) pureAdblocker = require('@ghostery/adblocker');
    return pureAdblocker;
  }

  function shouldBlockPopup(url, sourceUrl) {
    const { protection } = getSettings();
    if (!protection.enabled) return false;
    let request;
    try { request = requestFactory({ url, sourceUrl, type: 'popup' }); } catch { return true; }
    if (protection.network !== false) {
      if (groups.ads.engine.match(request).match || groups.threats.engine.match(request).match) return true;
    }
    return false;
  }

  /** Match a main-frame URL against the active engines (used to catch JS /
   *  meta / click redirects at the navigation layer, not just the request layer). */
  function matchMainFrame(url, sourceUrl, group = null) {
    const { protection } = getSettings();
    if (!protection.enabled) return null;
    let request;
    try { request = requestFactory({ url, sourceUrl, type: 'main_frame' }); } catch { return null; }
    if (group === 'threats') {
      if (protection.network !== false && groups.threats.engine.match(request).match) return 'Threat';
      return null;
    }
    if (protection.network !== false) {
      if (groups.threats.engine.match(request).match) return 'Threat';
      if (groups.ads.engine.match(request).match) return 'Ad';
    }
    return null;
  }

  function groupRules(filters, id) {
    if (id === 'easyprivacy') return 'trackers';
    if (id === 'malware') return 'threats';
    // Everything else (EasyList, annoyances incl. the `youtube` list, regional
    // and custom lists) is advertising protection.
    return 'ads';
  }

  function signatureOf(filters) {
    return JSON.stringify(filters.filter(item => item.enabled).map(item => [item.id, item.url, item.updated]));
  }

  let rebuildInFlight = null;
  async function rebuild(filters) {
    const signature = signatureOf(filters);
    if (signature === currentSignature) {
      // Same lists as the (in-flight or finished) build: nothing to do.
      return rebuildInFlight || Promise.resolve(status());
    }
    currentSignature = signature;
    const version = ++generation;
    const byGroup = { ads: [], trackers: [], threats: [] };
    for (const item of filters) {
      if (!item.enabled) continue;
      if (!trustedFilterUrl(item.url)) { log(`Skipping untrusted filter list: ${item.url}`); continue; }
      byGroup[groupRules(filters, item.id)].push(item);
    }
    // Deselected groups drop to the baseline immediately (never to "no rules").
    for (const [group, lists] of Object.entries(byGroup)) {
      if (!lists.length) resetToBaseline(group);
    }
    if (cacheDir) await fs.mkdir(cacheDir, { recursive: true }).catch(() => {});
    const build = async () => {
      const replacements = await Promise.all(Object.entries(byGroup).filter(([, lists]) => lists.length).map(async ([group, lists]) => {
        const urls = lists.map(item => item.url);
        const key = crypto.createHash('sha256').update(JSON.stringify(urls)).digest('hex').slice(0, 18);
        const cacheFile = cacheDir ? path.join(cacheDir, `${group}-${key}.bin`) : null;
        const metaFile = cacheFile ? `${cacheFile}.meta.json` : null;
        if (cacheFile) {
          try {
            const stat = await fs.stat(cacheFile);
            if (Date.now() - stat.mtimeMs < CACHE_MAX_AGE_MS) {
              const engine = engineFactory.deserialize(await fs.readFile(cacheFile));
              const meta = await readCacheMeta(metaFile);
              return [group, { engine, source: 'cache', rules: meta.rules || 0, updatedAt: new Date(stat.mtimeMs).toISOString(), lists: lists.length }];
            }
          } catch { /* fetch a fresh engine below */ }
        }
        try {
          // Fetch the lists ourselves (instead of FiltersEngine.fromLists) so
          // that:
          //   * non-2xx responses are a hard failure (fromLists would happily
          //     parse an error page into an *empty* engine and silently
          //     replace the working baseline),
          //   * a list that ends up with zero rules is treated as a failure,
          //   * no hidden dependency on the adblocker project's own CDN
          //     (fromLists always fetches resources.json from GitHub).
          // Blocking behaviour of plain filter lists does not need that file.
          let fetchedRules = 0;
          const texts = [];
          for (const url of urls) {
            const response = await doFetch(url, { signal: AbortSignal.timeout(20000), size: 32 * 1024 * 1024 });
            if (!response.ok) throw new Error(`filter list ${url} answered HTTP ${response.status}`);
            const text = await response.text();
            fetchedRules += countRules(text);
            texts.push(text);
          }
          if (fetchedRules === 0) throw new Error(`filter list ${urls[0]} contained no usable rules`);
          const engine = engineFactory.parse(texts.join('\n'), { loadCosmeticFilters: true, enableCompression: true });
          if (cacheFile) {
            await fs.writeFile(cacheFile, engine.serialize()).catch(() => {});
            await fs.writeFile(metaFile, JSON.stringify({ rules: fetchedRules })).catch(() => {});
          }
          return [group, { engine, source: 'fetched', rules: fetchedRules, updatedAt: new Date().toISOString(), lists: lists.length }];
        } catch (error) {
          log(`Could not refresh ${group} filters (${error.message}); keeping the cached or baseline engine.`);
          if (cacheFile) {
            try {
              const engine = engineFactory.deserialize(await fs.readFile(cacheFile));
              const meta = await readCacheMeta(metaFile);
              return [group, { engine, source: 'cache-stale', rules: meta.rules || 0, updatedAt: null, lists: lists.length }];
            } catch { /* fall through to the baseline */ }
          }
          return [group, groups[group]]; // keep baseline — never empty
        }
      }));
      if (version === generation) for (const [group, value] of replacements) groups[group] = value;
      finishInitialBuild();
      return status();
    };
    rebuildInFlight = build().finally(() => { rebuildInFlight = null; });
    return rebuildInFlight;
  }

  function status() {
    const total = groups.ads.rules + groups.trackers.rules + groups.threats.rules;
    return {
      ready: initialBuildDone,
      totalRules: total,
      ads: { source: groups.ads.source, rules: groups.ads.rules, updatedAt: groups.ads.updatedAt },
      trackers: { source: groups.trackers.source, rules: groups.trackers.rules, updatedAt: groups.trackers.updatedAt },
      threats: { source: groups.threats.source, rules: groups.threats.rules, updatedAt: groups.threats.updatedAt },
    };
  }

  function cosmeticsFor(url) {
    const { protection, allowlist, filters } = getSettings();
    if (!protection.enabled || !protection.cosmetic || !/^https?:/.test(url)) return null;
    if (isAllowedDomain(url, allowlist)) return null;
    const hostname = new URL(url).hostname;
    const styles = [cosmeticCSS];
    for (const group of Object.values(groups)) {
      const result = group.engine.getCosmeticsFilters({ url, hostname, domain: getDomain(hostname), getInjectionRules: false, getExtendedRules: false });
      if (result.active && result.styles) styles.push(result.styles);
    }
    if (protection.youtube && filters.some(item => item.id === 'youtube' && item.enabled) &&
        (hostname === 'youtube.com' || hostname.endsWith('.youtube.com'))) styles.push(youtubeCSS);
    return styles.join('\n');
  }

  // The popup policy lives with the core so tests exercise the real predicate.
  const popupPolicy = createPopupPolicy({
    now: () => Date.now(),
    getSettings,
    isAllowedDomain,
    log: () => {},
    matchRequest: (url, sourceUrl, type, group = null) => {
      if (group === 'threats') return matchMainFrame(url, sourceUrl, 'threats') !== null;
      return matchMainFrame(url, sourceUrl) !== null;
    },
  });

  return {
    ready,
    rebuild,
    decide,
    shouldBlockPopup,
    matchMainFrame,
    cosmeticsFor,
    status,
    popupPolicy,
    engines: () => groups,
  };
}

/**
 * Electron adapter. Requires Electron-only modules lazily so the rest of this
 * file stays loadable in plain Node (unit tests).
 */
function createProtectionEngine({ browsingSession, cacheDir, getSettings, recordBlocked, log = console.warn }) {
  const { ElectronBlocker } = require('@ghostery/adblocker-electron');
  const { webContents } = require('electron');
  const resourcesDir = path.join(__dirname, 'resources');

  const core = createProtectionCore({
    getSettings,
    recordBlocked,
    log,
    cacheDir,
    engineFactory: ElectronBlocker,
    loadBaseline: () => ({
      ads: readFileSyncSafe(path.join(resourcesDir, 'baseline-ads.txt')),
      trackers: readFileSyncSafe(path.join(resourcesDir, 'baseline-trackers.txt')),
      threats: readFileSyncSafe(path.join(resourcesDir, 'baseline-threats.txt')),
    }),
  });

  // A single request listener keeps per-site exceptions and the individual
  // protection switches from clobbering each other.
  browsingSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    let sourceUrl = details.referrer;
    try { sourceUrl = webContents.fromId(details.webContentsId)?.getURL() || sourceUrl; } catch { /* tab closing */ }
    const decision = core.decide({ url: details.url, resourceType: details.resourceType, sourceUrl, referrer: details.referrer, method: details.method });
    if (decision.cancel || decision.redirectURL) {
      if (recordBlocked && decision.type) recordBlocked(decision.type, details.url, sourceUrl);
      return callback(decision.redirectURL ? { redirectURL: decision.redirectURL } : { cancel: true });
    }
    callback({});
  });

  const cssKeys = new Map();
  async function applyCosmetics(contents) {
    if (contents.isDestroyed()) return;
    const previous = cssKeys.get(contents.id) || [];
    await Promise.all(previous.map(key => contents.removeInsertedCSS(key).catch(() => {})));
    cssKeys.set(contents.id, []);
    const url = contents.getURL();
    const css = core.cosmeticsFor(url);
    if (!css) return;
    const keys = [];
    try { keys.push(await contents.insertCSS(css, { cssOrigin: 'user' })); } catch { /* navigation replaced the document */ }
    cssKeys.set(contents.id, keys);
  }

  return {
    ready: core.ready,
    rebuild: core.rebuild,
    decide: core.decide,
    shouldBlockPopup: core.shouldBlockPopup,
    matchMainFrame: core.matchMainFrame,
    status: core.status,
    applyCosmetics,
    refreshCosmetics: async views => { await Promise.all(views.map(view => applyCosmetics(view.webContents).catch(log))); },
    popupPolicy: core.popupPolicy,
    forget: id => cssKeys.delete(id),
  };
}

module.exports = { createProtectionCore, createProtectionEngine, fallbackRules, cosmeticCSS, youtubeCSS };
