// Builds the domain-level ad and tracker lists bundled with the Android TV app.
// Source lists: EasyList and EasyPrivacy (https://easylist.to), licensed GPLv3 / CC BY-SA 3.0.
// The Android WebView cannot run the full Ghostery request engine, so only simple
// `||domain^` network rules are extracted. Path, regex, and cosmetic rules are not included.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'android-tv/app/src/main/assets/blocklists');
const sources = {
  ads: ['https://easylist.to/easylist/easylist.txt'],
  trackers: ['https://easylist.to/easylist/easyprivacy.txt'],
};

// Rules limited to resource types the WebView cannot distinguish are only accepted when they
// are plainly third-party advertising or tracking requests.
const allowedOptions = new Set(['third-party', '3p', 'important', 'script', 'subdocument', 'xmlhttprequest', 'ping', 'image', 'other', 'media', 'stylesheet', 'font', 'object', 'websocket', 'match-case']);
// Never block these registrable domains outright; sites depend on them for normal content.
const neverBlock = new Set(['google.com', 'gstatic.com', 'googleapis.com', 'googleusercontent.com', 'googlevideo.com', 'ytimg.com', 'youtube.com', 'youtu.be', 'facebook.com', 'fbcdn.net', 'twitter.com', 'twimg.com', 'microsoft.com', 'live.com', 'apple.com', 'icloud.com', 'amazon.com', 'amazonaws.com', 'cloudfront.net', 'cloudflare.com', 'akamaihd.net', 'akamaized.net', 'fastly.net', 'azureedge.net', 'jsdelivr.net', 'unpkg.com', 'github.com', 'githubusercontent.com', 'github.io', 'paypal.com', 'recaptcha.net', 'hcaptcha.com', 'wikipedia.org', 'wikimedia.org', 'bing.com', 'netflix.com', 'nflxvideo.net', 'twitch.tv', 'ttvnw.net', 'reddit.com', 'redd.it', 'redditstatic.com', 'redditmedia.com']);
const rulePattern = /^(@@)?\|\|([a-z0-9][a-z0-9.-]*[a-z0-9])\^(?:\$(.+))?$/;
const ipPattern = /^\d{1,3}(\.\d{1,3}){3}$/;

function optionsAllowed(raw) {
  if (!raw) return true;
  return raw.split(',').every(option => allowedOptions.has(option.trim()));
}

async function fetchList(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(90000) });
  if (!response.ok) throw new Error(`${url} returned ${response.status}`);
  const text = await response.text();
  if (!text.startsWith('[Adblock') && !text.includes('! Title:')) throw new Error(`${url} did not look like a filter list`);
  return text;
}

function extract(text) {
  const blocks = new Set();
  const exceptions = new Set();
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('||') && !line.startsWith('@@||')) continue;
    const match = rulePattern.exec(line.trim());
    if (!match) continue;
    const [, exception, domain, options] = match;
    if (!domain.includes('.') || ipPattern.test(domain) || !optionsAllowed(options)) continue;
    (exception ? exceptions : blocks).add(domain);
  }
  return { blocks, exceptions };
}

function compact(domains) {
  const set = new Set(domains);
  return [...set].filter(domain => {
    if (neverBlock.has(domain)) return false;
    const labels = domain.split('.');
    // Drop entries already covered by a blocked parent domain.
    for (let index = 1; index < labels.length - 1; index++) if (set.has(labels.slice(index).join('.'))) return false;
    return true;
  }).sort();
}

await fs.mkdir(outDir, { recursive: true });
const summary = [];
for (const [name, urls] of Object.entries(sources)) {
  const blocks = new Set();
  const exceptions = new Set();
  for (const url of urls) {
    const parsed = extract(await fetchList(url));
    parsed.blocks.forEach(item => blocks.add(item));
    parsed.exceptions.forEach(item => exceptions.add(item));
  }
  exceptions.forEach(item => blocks.delete(item));
  const domains = compact(blocks);
  if (domains.length < 500) throw new Error(`Suspiciously small ${name} list: ${domains.length}`);
  const header = `# ChromiumCore ${name} domains. Generated ${new Date().toISOString().slice(0, 10)} from ${urls.join(', ')}\n# Licensed under CC BY-SA 3.0 / GPLv3 by the EasyList authors. See NOTICE.txt.\n`;
  await fs.writeFile(path.join(outDir, `${name}.txt`), header + domains.join('\n') + '\n');
  summary.push(`${name}: ${domains.length.toLocaleString()} domains`);
}
await fs.writeFile(path.join(outDir, 'NOTICE.txt'), 'The domain lists in this folder are derived from EasyList and EasyPrivacy.\nCopyright The EasyList authors. https://easylist.to\nLicensed under GPLv3 or CC BY-SA 3.0. Only simple domain rules were extracted and the lists were compacted.\nThe lists are a convenience subset and are not a substitute for the full upstream lists.\n');
console.log(summary.join('\n'));
