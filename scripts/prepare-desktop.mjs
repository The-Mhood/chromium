import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stage = path.join(root, '.desktop-build');
await fs.mkdir(stage, { recursive: true });
await fs.access(path.join(root, 'dist/index.html')).catch(() => { throw new Error('Run npm run build before preparing the desktop app.'); });
await fs.cp(path.join(root, 'electron'), path.join(stage, 'electron'), { recursive: true });
await fs.copyFile(path.join(root, 'electron/forge.config.cjs'), path.join(stage, 'forge.config.cjs'));
// Code shared with the Android TV app, such as the YouTube shield, lives beside electron/ in the packaged app.
await fs.rm(path.join(stage, 'shared'), { recursive: true, force: true });
await fs.cp(path.join(root, 'shared'), path.join(stage, 'shared'), { recursive: true });
await fs.rm(path.join(stage, 'renderer'), { recursive: true, force: true });
await fs.cp(path.join(root, 'dist'), path.join(stage, 'renderer'), { recursive: true, filter: source => !['download', 'downloads'].some(folder => source === path.join(root, 'dist', folder) || source.startsWith(path.join(root, 'dist', folder) + path.sep)) });
await fs.mkdir(path.join(stage, 'assets'), { recursive: true });
const png = await sharp(path.join(root, 'public/core.svg')).resize(512, 512).png().toBuffer();
await fs.writeFile(path.join(stage, 'assets/icon.png'), png);
// Modern Windows icons can contain PNG data; macOS ic10 is a 1024px PNG resource.
const smallPng = await sharp(png).resize(256, 256).png().toBuffer();
const ico = Buffer.alloc(22); ico.writeUInt16LE(1, 2); ico.writeUInt16LE(1, 4); ico.writeUInt16LE(1, 10); ico.writeUInt16LE(32, 12); ico.writeUInt32LE(smallPng.length, 14); ico.writeUInt32LE(22, 18);
await fs.writeFile(path.join(stage, 'assets/icon.ico'), Buffer.concat([ico, smallPng]));
const macPng = await sharp(png).resize(1024, 1024).png().toBuffer();
const icns = Buffer.alloc(16); icns.write('icns'); icns.writeUInt32BE(16 + macPng.length, 4); icns.write('ic10', 8); icns.writeUInt32BE(8 + macPng.length, 12);
await fs.writeFile(path.join(stage, 'assets/icon.icns'), Buffer.concat([icns, macPng]));

// The staging manifest is generated, leaving the Vite workspace configuration intact.
const manifest = {
  name: 'chromiumcore', productName: 'ChromiumCore', version: '1.0.0', private: true,
  description: 'A Chromium-powered desktop browser with built-in ad and tracker blocking.',
  author: 'ChromiumCore', license: 'MIT', main: 'electron/main.cjs',
  scripts: { start: 'electron-forge start', package: 'electron-forge package', make: 'electron-forge make', test: 'node --test electron/popup-blocker.test.cjs electron/fullscreen-state.test.cjs electron/protection.test.cjs electron/youtube-shield.test.cjs electron/main.wiring.test.cjs' },
  config: { forge: './forge.config.cjs' },
  dependencies: { '@ghostery/adblocker-electron': '2.20.3', '@ghostery/adblocker': '2.20.3', 'cross-fetch': '^4.1.0', tldts: '^7.0.0' },
  devDependencies: { electron: '45.5.0', '@electron-forge/cli': '7.11.2', '@electron-forge/maker-zip': '7.11.2', '@electron-forge/maker-dmg': '7.11.2', '@electron-forge/maker-squirrel': '7.11.2' },
};
await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
// Only the pure-JS runtime deps are needed to run the unit tests (the test
// harness stubs the Electron API). The devDependency tree (electron,
// electron-forge) is therefore skipped by default: it drags in a git-hosted
// @electron/node-gyp tarball and the Electron binary, which are slow to fetch
// and need network access test environments often do not have. Note
// `--omit=dev` alone is not enough — npm still resolves every dependency in
// the manifest (including git deps) while building the ideal tree — so the
// install runs against a temporary manifest without devDependencies, and the
// full manifest is restored afterwards. `--full` (used by the packaging path)
// installs the complete dependency set exactly as before.
if (!process.argv.includes('--no-install')) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const env = { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: '1' };
  if (process.argv.includes('--full')) {
    execFileSync(npm, ['install', '--no-audit', '--no-fund'], { cwd: stage, stdio: 'inherit', env });
  } else {
    const runtimeManifest = { ...manifest, devDependencies: {} };
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(runtimeManifest, null, 2) + '\n');
    execFileSync(npm, ['install', '--no-audit', '--no-fund', '--ignore-scripts'], { cwd: stage, stdio: 'inherit', env });
    await fs.writeFile(path.join(stage, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  }
}
console.log(`Desktop workspace ready: ${stage}`);