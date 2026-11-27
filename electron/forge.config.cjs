const path = require('node:path');

module.exports = {
  packagerConfig: {
    name: 'ChromiumCore',
    executableName: 'ChromiumCore',
    asar: true,
    appBundleId: 'com.chromiumcore.browser',
    appCategoryType: 'public.app-category.navigation',
    icon: path.join(__dirname, 'assets/icon'),
    osxSign: process.env.APPLE_SIGNING_IDENTITY ? { identity: process.env.APPLE_SIGNING_IDENTITY } : undefined,
    osxNotarize: process.env.APPLE_API_KEY ? { appleApiKey: process.env.APPLE_API_KEY, appleApiKeyId: process.env.APPLE_API_KEY_ID, appleApiIssuer: process.env.APPLE_API_ISSUER } : undefined,
    ignore: [/^\/out($|\/)/, /^\/package-lock\.json$/, /^\/forge\.config\.cjs$/],
  },
  // Default (release) path: Windows gets the Squirrel installer .exe (the
  // old maker-zip produced a folder archive that "wouldn't install" — the
  // field report). Squirrel's setup .exe is a proper one-click installer that
  // creates the Start menu shortcut; it is the same maker the CORE_INSTALLER
  // escape hatch uses. macOS/Linux keep the plain ZIP. (Electron Forge has no
  // NSIS/MSI maker; Squirrel is the official Windows installer path.)
  makers: process.env.CORE_INSTALLER === '1' ? [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { name: 'ChromiumCore', authors: 'ChromiumCore', description: 'A cleaner, safer internet.' } },
    { name: '@electron-forge/maker-dmg', platforms: ['darwin'], config: { name: 'ChromiumCore', format: 'ULFO' } },
  ] : [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { name: 'ChromiumCore', authors: 'ChromiumCore', description: 'A cleaner, safer internet.' } },
    { name: '@electron-forge/maker-zip', platforms: ['darwin', 'linux'] },
  ],
};