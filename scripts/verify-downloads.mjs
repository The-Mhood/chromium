import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(root, 'public/download/manifest.json'), 'utf8'));
if (process.argv.includes('--require-all')) {
  for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'arm64'], ['darwin', 'x64'], ['android', 'universal']]) {
    if (!manifest.releases.some(release => release.platform === platform && release.arch === arch)) throw new Error(`Missing release: ${platform}/${arch}`);
  }
}

const roots = ['public', ...(process.argv.includes('--dist') ? ['dist'] : [])];
for (const directory of roots) {
  for (const folder of ['download', 'downloads']) {
    for (const release of [...manifest.releases, { file: manifest.source }]) {
      if (!release.file || path.basename(release.file) !== release.file) throw new Error('Invalid download filename');
      const file = path.join(root, directory, folder, release.file);
      const handle = await fs.open(file, 'r');
      try {
        const header = Buffer.alloc(4);
        await handle.read(header, 0, 4, 0);
        // .zip and .apk are ZIP containers (PK\x03\x04 magic); the Windows
        // NSIS installer (.exe) is a native PE binary, so only the archives
        // are asserted to be real ZIPs.
        if (release.file.endsWith('.zip') || release.file.endsWith('.apk')) {
          if (!header.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw new Error(`Not a ZIP archive: ${file}`);
        }
      } finally { await handle.close(); }
      const hash = crypto.createHash('sha256');
      for await (const chunk of createReadStream(file)) hash.update(chunk);
      const checksum = hash.digest('hex');
      if (release.sha256 && checksum !== release.sha256) throw new Error(`Checksum mismatch: ${file}`);
      console.log(`PASS ${directory}/${folder}/${release.file}`);
    }
  }
}
console.log('Real ZIP files verified, not just manifest entries.');