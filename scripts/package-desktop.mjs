import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argument = (name, fallback) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const platform = argument('--platform', process.platform);
const arch = argument('--arch', process.arch);
if (!['win32', 'darwin', 'linux'].includes(platform) || !['x64', 'arm64'].includes(arch)) throw new Error('Unsupported platform or architecture.');
// Packaging needs the full dependency tree (electron + forge); the default
// prepare install is runtime-only and would leave forge out of node_modules.
execFileSync(process.execPath, ['scripts/prepare-desktop.mjs', '--full'], { cwd: root, stdio: 'inherit' });
const stage = path.join(root, '.desktop-build');
execFileSync(process.execPath, [path.join(stage, 'node_modules/@electron-forge/cli/dist/electron-forge.js'), 'make', '--platform', platform, '--arch', arch], { cwd: stage, stdio: 'inherit', env: process.env });

if (process.env.CORE_INSTALLER !== '1') {
  const collect = async dir => { const entries = await fs.readdir(dir, { withFileTypes: true }); return (await Promise.all(entries.map(entry => entry.isDirectory() ? collect(path.join(dir, entry.name)) : [path.join(dir, entry.name)]))).flat(); };
  const candidates = await collect(path.join(stage, 'out/make'));
  const artifact = candidates.find(file => file.endsWith('.zip') && file.includes(platform) && file.includes(arch));
  if (!artifact) throw new Error('Forge did not produce the expected archive.');
  const dir = path.join(root, 'public/download'); await fs.mkdir(dir, { recursive: true });
  const legacyDir = path.join(root, 'public/downloads'); await fs.mkdir(legacyDir, { recursive: true });
  const file = `ChromiumCore-1.0.0-${platform}-${arch}.zip`;
  await fs.copyFile(artifact, path.join(dir, file));
  await fs.copyFile(path.join(dir, file), path.join(legacyDir, file));
  const bytes = await fs.readFile(path.join(dir, file));
  let manifest = { version: '1.0.0', source: 'chromiumcore-source.zip', releases: [] };
  try { manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')); } catch { /* First release. */ }
  const release = { platform, arch, name: `${platform === 'win32' ? 'Windows' : platform === 'darwin' ? 'macOS' : 'Linux'} ${arch === 'arm64' ? 'Apple Silicon' : platform === 'darwin' ? 'Intel' : '64-bit'}`, file, size: `${(bytes.length / 1024 / 1024).toFixed(1)} MB`, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  manifest.releases = [...manifest.releases.filter(item => item.platform !== platform || item.arch !== arch), release];
  await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.copyFile(path.join(dir, 'manifest.json'), path.join(legacyDir, 'manifest.json'));
  console.log(`Download ready: public/download/${file} (${release.size})`);
}