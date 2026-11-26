import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = {};
const excluded = new Set(['node_modules', '.desktop-build', '.git', 'dist', 'artifacts', 'test-results', 'playwright-report', 'build', '.gradle', '.kotlin', '.android-signing', 'local.properties']);
async function walk(dir, relative = '') {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    if (excluded.has(entry.name) || (relative === 'public' && ['download', 'downloads'].includes(entry.name))) continue;
    const name = path.join(relative, entry.name);
    if (entry.isDirectory()) await walk(path.join(dir, entry.name), name);
    else files[`chromiumcore/${name.replaceAll('\\', '/')}`] = new Uint8Array(await fs.readFile(path.join(dir, entry.name)));
  }
}
await walk(root);
files['chromiumcore/START-HERE.txt'] = strToU8('ChromiumCore 1.0.0\n\n1. npm install\n2. npm run build\n3. node scripts/prepare-desktop.mjs\n4. cd .desktop-build\n5. node node_modules/electron/install.js\n6. npm start\n\nPortable releases:\nnode scripts/package-desktop.mjs --platform win32 --arch x64\nnode scripts/package-desktop.mjs --platform darwin --arch arm64\nnode scripts/package-desktop.mjs --platform darwin --arch x64\n\nAndroid TV APK (JDK 17 and the Android SDK are required):\nnode scripts/package-android.mjs\n\nSee README.md for signing, platform requirements, and security limitations.\n');
await fs.mkdir(path.join(root, 'public/download'), { recursive: true });
await fs.mkdir(path.join(root, 'public/downloads'), { recursive: true });
await fs.writeFile(path.join(root, 'public/download/chromiumcore-source.zip'), zipSync(files, { level: 6 }));
await fs.copyFile(path.join(root, 'public/download/chromiumcore-source.zip'), path.join(root, 'public/downloads/chromiumcore-source.zip'));
console.log('Source download ready: public/download/chromiumcore-source.zip');