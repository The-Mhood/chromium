// Packages the Android TV APK into a single, simple ZIP that users can
// download and install: the APK plus a plain INSTALL.md with step-by-step
// instructions. Also keeps public/download/manifest.json and README.txt in
// sync, so the download page offers the bundle too.
//
// Usage (from the repo root, Node.js 22.12 or later):
//   node scripts/package-android-tv-app.mjs
//   node scripts/package-android-tv-app.mjs --apk /path/to/app-release.apk
//
// Without --apk, the APK is expected at
//   public/download/ChromiumCore-1.0.0-android-universal.apk
// (the output of scripts/package-android.mjs — see android-tv/BUILD.md).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = '1.0.0';
const APK_FILE = `ChromiumCore-${VERSION}-android-universal.apk`;
const ZIP_FILE = `ChromiumCore-${VERSION}-android-tv-app.zip`;
const downloadDir = path.join(root, 'public/download');

const apkArgIndex = process.argv.indexOf('--apk');
const apkPath = apkArgIndex > -1 && process.argv[apkArgIndex + 1]
  ? path.resolve(process.argv[apkArgIndex + 1])
  : path.join(downloadDir, APK_FILE);
if (!fsSync.existsSync(apkPath)) {
  throw new Error(
    `APK not found: ${apkPath}\n`
    + 'Build it first (JDK 17 + Android SDK 34 — see android-tv/BUILD.md):\n'
    + '  node scripts/package-android.mjs\n'
    + 'or point at an existing APK with: --apk /path/to/app-release.apk'
  );
}

const installMd = `# ChromiumCore for Android TV — install guide

This ZIP contains the app:

    ${APK_FILE}

ChromiumCore is a small, privacy-first web browser for Android TV with
built-in ad/tracker blocking. Everything stays on the device: no accounts,
no analytics, no telemetry.

## 1. Allow unknown sources on the TV

    Settings → Device preferences → Security
        → allow "Install unknown apps" (or "Allow unknown sources")

If you install over ADB instead, enable
    Settings → Device preferences → Developer options → USB debugging

## 2. Get the APK onto the TV — pick one

Option A — USB stick: copy ${APK_FILE} to a USB stick, plug it into the
TV, open it with any file manager, and confirm the install.

Option B — ADB from your computer (the TV and the computer on the same
network, or a cable):

    adb install -r ${APK_FILE}

Option C — sideload from a browser on the TV is also possible: open any
page that serves the APK and tap it.

## 3. Launch it

Open **ChromiumCore** from the TV launcher. It appears under the LEANBACK
launcher (the TV apps), not the phone launcher.

## Remote-control guide

| Key                     | Action                                            |
| ----------------------- | ------------------------------------------------- |
| Arrows                  | Move the on-screen pointer (hold to accelerate)   |
| OK / Select             | Click at the pointer                              |
| Channel / Page Up/Down  | Scroll the page                                   |
| Menu / Info             | Options (protection, pointer speed, allow-list)   |
| Search                  | Edit the address bar                              |
| Back                    | Go back / exit fullscreen video / press twice to quit |

## Updating the app

An app signed with a different key cannot update over an older install.
The APK in this ZIP is signed with the project's preview key: re-install
this same build (or a later one from the project's releases) with the
\`-r\` flag above. If you build your own APK locally, keep the
\`.android-signing/\` folder so updates keep working (see
android-tv/BUILD.md in the source).

## Rebuilding this ZIP from a computer terminal

Clone the project and run:

    git clone https://github.com/The-Mhood/chromium.git
    cd chromium

    # 1. Build the APK (needs JDK 17 + Android SDK 34 — full guide in
    #    android-tv/BUILD.md):
    node scripts/package-android.mjs

    # 2. Bundle the APK + this guide into the ZIP:
    node scripts/package-android-tv-app.mjs

Output: public/download/${ZIP_FILE}

If you do not have the Android SDK installed, skip step 1: download the
APK from the project's latest Actions release run (artifact
"ChromiumCore-android-tv") and run

    node scripts/package-android-tv-app.mjs --apk /path/to/ChromiumCore-1.0.0-android-universal.apk
`;

// --- assemble the zip (fflate: no system `zip` dependency) --------------
const apkBytes = await fs.readFile(apkPath);
const files = {
  [APK_FILE]: new Uint8Array(apkBytes),
  'INSTALL.md': strToU8(installMd),
};
const zipBytes = Buffer.from(zipSync(files, { level: 9 }));
const outPath = path.join(downloadDir, ZIP_FILE);
await fs.writeFile(outPath, zipBytes);

// --- keep manifest.json in sync ------------------------------------------
const manifestPath = path.join(downloadDir, 'manifest.json');
const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
const sha256 = crypto.createHash('sha256').update(zipBytes).digest('hex');
const sizeMb = (Buffer.byteLength(zipBytes) / (1024 * 1024)).toFixed(1) + ' MB';
const entry = {
  platform: 'android',
  arch: 'universal',
  name: 'Android TV (app bundle: APK + install guide)',
  file: ZIP_FILE,
  size: sizeMb,
  sha256,
};
const existing = manifest.releases.findIndex(r => r.file === ZIP_FILE);
if (existing > -1) manifest.releases[existing] = entry;
else manifest.releases.push(entry);
await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');

// --- keep README.txt in sync ----------------------------------------------
const readmePath = path.join(downloadDir, 'README.txt');
let readme = await fs.readFile(readmePath, 'utf8');
if (!readme.includes(ZIP_FILE)) {
  readme = readme.replace(
    'ChromiumCore-1.0.0-android-tv-source.zip',
    `ChromiumCore-1.0.0-android-tv-source.zip\nChromiumCore-${VERSION}-android-tv-app.zip   (APK + install guide)`
  );
  readme = readme.replace(
    'node scripts/package-source.mjs',
    `node scripts/package-source.mjs\nnode scripts/package-android-tv-app.mjs   (needs the APK from scripts/package-android.mjs)`
  );
  await fs.writeFile(readmePath, readme);
}

console.log(`Wrote ${path.relative(root, outPath)} (${sizeMb})`);
console.log(`  sha256 ${sha256}`);
console.log(`  contains: ${APK_FILE}, INSTALL.md`);
