// Builds the Android TV compilation package: the complete android-tv Gradle
// project plus everything it needs to compile standalone (the shared/ folder
// that build.gradle.kts pulls the YouTube shield from, the one-command build
// script, and the build instructions). The result is a single ZIP that can be
// extracted on a Mac and built from the terminal (see android-tv/BUILD.md).
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipSync, strToU8 } from 'fflate';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = process.env.ANDROID_VERSION || '1.0.0';
const PREFIX = 'chromiumcore-android-tv';
const files = {};

// Build outputs, caches and machine-local files stay out of the package.
const excludedDirs = new Set(['.git', 'node_modules', '.gradle', '.kotlin', 'build', 'dist', '.desktop-build', '.android-signing', 'artifacts', 'test-results', 'playwright-report']);
const excludedFiles = new Set(['local.properties', 'gradle-wrapper.jar']); // the .b64 twin travels; the build restores the jar
const textFiles = new Map([
  // Small text additions that make the ZIP self-explanatory.
  [`${PREFIX}/README.txt`, strToU8(
    `ChromiumCore for Android TV ${VERSION}\n\n` +
    'Build it on a Mac (JDK 17 + Android SDK 34 required — exact commands inside):\n\n' +
    '  1. unzip chromiumcore-android-tv-*.zip\n' +
    '  2. cd chromiumcore-android-tv\n' +
    '  3. read android-tv/BUILD.md (SDK install + build commands)\n' +
    '  4. node scripts/package-android.mjs\n' +
    '     -> android-tv/app/build/outputs/apk/release/app-release.apk\n' +
    '  5. install the APK on your Android TV (adb install or file manager)\n\n' +
    'The debug-only terminal build (no Node) is documented in android-tv/BUILD.md, "Option B".\n')]
]);

async function addDir(dir, relative) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (excludedDirs.has(entry.name)) continue;
      await addDir(path.join(dir, entry.name), rel);
    } else if (entry.isFile()) {
      if (excludedFiles.has(entry.name)) continue;
      files[`${PREFIX}/${rel}`] = new Uint8Array(await fs.readFile(path.join(dir, entry.name)));
    }
  }
}

await addDir(path.join(root, 'android-tv'), 'android-tv');
await addDir(path.join(root, 'shared'), 'shared');
files[`${PREFIX}/scripts/package-android.mjs`] = new Uint8Array(await fs.readFile(path.join(root, 'scripts', 'package-android.mjs')));
for (const [name, data] of textFiles) files[name] = data;

const zip = zipSync(files, { level: 6 });
const outDir = path.join(root, 'public', 'download');
const legacyDir = path.join(root, 'public', 'downloads');
await fs.mkdir(outDir, { recursive: true });
await fs.mkdir(legacyDir, { recursive: true });
const outFile = path.join(outDir, `ChromiumCore-${VERSION}-android-tv-source.zip`);
await fs.writeFile(outFile, zip);
await fs.copyFile(outFile, path.join(legacyDir, path.basename(outFile)));
console.log(`Android TV source package ready: public/download/${path.basename(outFile)} (${(zip.length / 1024 / 1024).toFixed(1)} MB, ${Object.keys(files).length} files)`);
