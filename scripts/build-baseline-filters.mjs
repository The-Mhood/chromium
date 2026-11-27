// Builds the baseline network filter rules bundled with the desktop app.
//
// Why: the desktop engine must protect from the very first request, before any
// filter list has been fetched over the network (first launch, offline, or a
// slow list server). The Android TV app already bundles domain lists derived
// from EasyList / EasyPrivacy (GPLv3 / CC BY-SA 3.0, see the blocklists NOTICE);
// this script converts those committed lists into Ghostery `||domain^` rules so
// desktop ships the same baseline and upgrades to the full fetched lists
// automatically when they are reachable.
//
// Run: node scripts/build-baseline-filters.mjs   (no network required)
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = path.join(root, 'android-tv/app/src/main/assets/blocklists');
const outDir = path.join(root, 'electron/resources');

const sources = {
  'baseline-ads': ['ads.txt', 'EasyList'],
  'baseline-trackers': ['trackers.txt', 'EasyPrivacy'],
};

await fs.mkdir(outDir, { recursive: true });
const summary = [];
for (const [name, [file, origin]] of Object.entries(sources)) {
  const lines = (await fs.readFile(path.join(sourceDir, file), 'utf8')).split('\n');
  const domains = lines
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(line));
  if (domains.length < 500) throw new Error(`Suspiciously small ${name} baseline: ${domains.length} domains`);
  const header = [
    `# ChromiumCore desktop baseline (${name}).`,
    `# Generated ${new Date().toISOString().slice(0, 10)} from ${origin} domains`,
    `# (${path.relative(root, path.join(sourceDir, file))}). Copyright the EasyList authors.`,
    `# Licensed under GPLv3 / CC BY-SA 3.0. Convenience subset, not a substitute`,
    `# for the full upstream lists, which replace this baseline at runtime.`,
  ].join('\n');
  await fs.writeFile(path.join(outDir, `${name}.txt`), header + '\n' + domains.map(domain => `||${domain}^`).join('\n') + '\n');
  summary.push(`${name}: ${domains.length.toLocaleString()} domains`);
}
console.log(summary.join('\n'));
