ChromiumCore Desktop Downloads

The actual unsigned portable ZIP archives belong in this folder:

ChromiumCore-1.0.0-win32-x64.zip
ChromiumCore-1.0.0-darwin-arm64.zip
ChromiumCore-1.0.0-darwin-x64.zip
chromiumcore-source.zip
manifest.json

Public URLs start with /download/, not /public/download/.
The old /downloads/ URLs are also supported by physical copies.

If your checkout or deployment omitted binary files, rebuild them from the
project root with Node.js 22.12 or later:

npm run build
node scripts/package-desktop.mjs --platform win32 --arch x64
node scripts/package-desktop.mjs --platform darwin --arch arm64
node scripts/package-desktop.mjs --platform darwin --arch x64
node scripts/package-source.mjs
npm run build
node scripts/verify-downloads.mjs --dist --require-all

Do not deploy manifest.json without the corresponding ZIP files.