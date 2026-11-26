const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ElectronBlocker, fromElectronDetails } = require('@ghostery/adblocker-electron');
const { Request } = require('@ghostery/adblocker');
const fetch = require('cross-fetch');
const { getDomain } = require('tldts');
const { webContents } = require('electron');
const { isAllowedDomain, trustedFilterUrl } = require('./security.cjs');

const fallbackRules = {
  ads: '||doubleclick.net^\n||googlesyndication.com^\n||googleadservices.com^\n||adnxs.com^\n||adsrvr.org^\n||popads.net^\n||popcash.net^\n||propellerads.com^\n||exoclick.com^\n||trafficjunky.net^\n||juicyads.com^\n||adsterra.com^\n##.ad-banner\n##.adsbygoogle\n##[data-ad-slot]',
  trackers: '||google-analytics.com^\n||analytics.google.com^\n||connect.facebook.net^$third-party\n||pixel.facebook.com^\n||scorecardresearch.com^',
  threats: '',
};
const cosmeticCSS = '.ad-banner,.sidebar-ad,.adsbygoogle,[data-ad-slot],.advertisement-container{display:none!important}';
const youtubeCSS = 'ytd-ad-slot-renderer,ytd-display-ad-renderer,ytd-promoted-sparkles-web-renderer,ytd-promoted-video-renderer,ytd-banner-promo-renderer,.ytp-ad-overlay-container{display:none!important}';

function createProtectionEngine({ browsingSession, cacheDir, getSettings, recordBlocked }) {
  let generation = 0;
  let currentSignature = '';
  let engines = Object.fromEntries(Object.entries(fallbackRules).map(([key, rules]) => [key, ElectronBlocker.parse(rules)]));
  const cssKeys = new Map();
  const groups = filters => ({
    ads: filters.filter(item => item.enabled && !['easyprivacy', 'malware'].includes(item.id) && item.id !== 'youtube'),
    trackers: filters.filter(item => item.enabled && item.id === 'easyprivacy'),
    threats: filters.filter(item => item.enabled && item.id === 'malware'),
  });

  // A single request listener preserves per-site exceptions and independent controls.
  browsingSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
    const { protection, allowlist } = getSettings();
    let sourceUrl = details.referrer;
    try { sourceUrl = webContents.fromId(details.webContentsId)?.getURL() || sourceUrl; } catch { /* A tab may have closed. */ }
    if (!protection.enabled || isAllowedDomain(sourceUrl, allowlist)) return callback({});
    const request = fromElectronDetails({ ...details, referrer: sourceUrl });
    const candidates = [];
    if (protection.network) candidates.push(['threats', 'Threat'], ['ads', 'Ad']);
    if (protection.tracking) candidates.push(['trackers', 'Tracker']);
    for (const [group, type] of candidates) {
      // Main-frame navigations are checked too: ad clicks often redirect the active tab.
      const result = engines[group].match(request);
      if (result.match) {
        recordBlocked(type, details.url, sourceUrl);
        return callback(result.redirect ? { redirectURL: result.redirect.dataUrl } : { cancel: true });
      }
      if (result.rewrite?.url && result.rewrite.url !== details.url) return callback({ redirectURL: result.rewrite.url });
    }
    callback({});
  });

  function shouldBlockPopup(url, sourceUrl) {
    const request = Request.fromRawDetails({ url, sourceUrl, type: 'popup' });
    return engines.ads.match(request).match || engines.threats.match(request).match;
  }

  async function rebuild(filters) {
    const signature = JSON.stringify(filters.filter(item => item.enabled).map(item => [item.id, item.url, item.updated]));
    if (signature === currentSignature) return;
    currentSignature = signature;
    const version = ++generation;
    const activeGroups = groups(filters);
    // Disable deselected groups immediately rather than waiting on a network fetch.
    for (const [group, lists] of Object.entries(activeGroups)) if (!lists.length) engines[group] = ElectronBlocker.empty();
    await fs.mkdir(cacheDir, { recursive: true });
    const replacements = await Promise.all(Object.entries(activeGroups).map(async ([group, lists]) => {
      if (!lists.length) return [group, ElectronBlocker.empty()];
      const urls = lists.map(item => item.url).filter(trustedFilterUrl);
      const key = crypto.createHash('sha256').update(JSON.stringify(urls)).digest('hex').slice(0, 18);
      const cache = path.join(cacheDir, `${group}-${key}.bin`);
      try {
        const stat = await fs.stat(cache);
        if (Date.now() - stat.mtimeMs < 24 * 60 * 60 * 1000) return [group, ElectronBlocker.deserialize(await fs.readFile(cache))];
      } catch { /* A fresh engine will be fetched below. */ }
      try {
        const controlledFetch = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(15000), size: 32 * 1024 * 1024 });
        const engine = await ElectronBlocker.fromLists(controlledFetch, urls, { loadCosmeticFilters: true, enableCompression: true });
        await fs.writeFile(cache, engine.serialize());
        return [group, engine];
      } catch (error) {
        console.warn(`Could not refresh ${group} filters; using cached or baseline rules.`, error.message);
        try { return [group, ElectronBlocker.deserialize(await fs.readFile(cache))]; }
        catch { return [group, ElectronBlocker.parse(fallbackRules[group])]; }
      }
    }));
    if (version === generation) engines = Object.fromEntries(replacements);
  }

  async function applyCosmetics(contents) {
    if (contents.isDestroyed()) return;
    const previous = cssKeys.get(contents.id) || [];
    await Promise.all(previous.map(key => contents.removeInsertedCSS(key).catch(() => {})));
    cssKeys.set(contents.id, []);
    const { protection, allowlist, filters } = getSettings();
    const url = contents.getURL();
    if (!protection.enabled || isAllowedDomain(url, allowlist) || !/^https?:/.test(url)) return;
    const hostname = new URL(url).hostname;
    const styles = [];
    if (protection.cosmetic) {
      styles.push(cosmeticCSS);
      for (const engine of Object.values(engines)) {
        const result = engine.getCosmeticsFilters({ url, hostname, domain: getDomain(hostname), getInjectionRules: false, getExtendedRules: false });
        if (result.active && result.styles) styles.push(result.styles);
      }
    }
    if (protection.youtube && filters.some(item => item.id === 'youtube' && item.enabled) && (hostname === 'youtube.com' || hostname.endsWith('.youtube.com'))) styles.push(youtubeCSS);
    const keys = [];
    for (const style of styles) { try { keys.push(await contents.insertCSS(style, { cssOrigin: 'user' })); } catch { /* Navigation may have replaced the document. */ } }
    cssKeys.set(contents.id, keys);
  }

  return { rebuild, applyCosmetics, shouldBlockPopup, forget: id => cssKeys.delete(id) };
}

module.exports = { createProtectionEngine };