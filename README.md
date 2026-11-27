# ChromiumCore

A React, TypeScript, and Tailwind CSS browser workspace with a real Electron desktop implementation and Ghostery-powered request filtering. The web application is an interactive preview, not a browser extension: its sample protection activity is labeled, and it cannot intercept requests made by your existing browser.

## Web Preview

```sh
npm install
npm run dev
npm run build
npx tsc --noEmit
```

Open the Downloads page in the sidebar for the available Windows and macOS archives, architecture selection, SHA-256 verification, installation instructions, and source download.

## Desktop Development

Use Node.js 22.12 or later for the Electron 45 desktop toolchain.

```sh
npm run build
node scripts/prepare-desktop.mjs
cd .desktop-build
node node_modules/electron/install.js
npm start
```

The staging script generates the desktop manifest and installs Electron Forge 7.11, Electron 45.5, and Ghostery 2.20 without changing the web workspace's build configuration. Electron is updated from the obsolete version in the original proposal. The staging install skips the host Electron binary because cross-platform packaging downloads its own target runtime; the explicit install command above adds the host binary for development.

## Portable Downloads

Run these commands from the project root after `npm run build`:

```sh
node scripts/package-desktop.mjs --platform win32 --arch x64
node scripts/package-desktop.mjs --platform darwin --arch arm64
node scripts/package-desktop.mjs --platform darwin --arch x64
node scripts/package-source.mjs
npm run build
node scripts/verify-downloads.mjs --dist --require-all
```

Forge's ZIP maker supports cross-platform packaging. The output is an unsigned portable Windows application or a ZIP containing a macOS .app bundle, not a signed installer. The actual archives and SHA-256 checksums are written to `public/download/` and copied into `dist/download/` by the final web build. The old `public/downloads/` path contains physical compatibility copies, so previously shared `/downloads/` links still work. Public URLs use `/download/filename.zip`, never `/public/download/filename.zip`. macOS archives must preserve app-bundle symlinks and executable permissions. Verify these on a Mac before publishing.

Deploy the actual ZIP files along with the manifest. A source-only checkout may omit generated binary artifacts; rerun the packaging commands above if that happens. The Downloads page now verifies each file with a real HTTP request, rejects an HTML fallback masquerading as a successful response, and does not report a missing archive as a started download.

The GitHub Actions workflow builds on the corresponding native operating system. To create native installers, set `CORE_INSTALLER=1` before running the packaging command on Windows or macOS. This selects Squirrel.Windows or DMG rather than ZIP. Signing, notarization credentials, installer testing, and production release approval remain the publisher's responsibility. No auto-update service is configured.

## YouTube ad blocking

YouTube does not serve its video ads as separate requests that a domain or URL blocker can drop. The ad schedule travels inside the video data (`adPlacements`, `adSlots`, `playerAds`), and ads stream from the same hosts as the video. So the desktop and Android TV apps share one script, `shared/youtube-shield.js`, that runs in the page at document start and does four things:

1. **Removes the ad schedule before the player reads it.** It cleans the `ytInitialPlayerResponse` global the page assigns, `JSON.parse` results, `fetch` responses and `XMLHttpRequest` responses for YouTube's player endpoints (`/youtubei/v1/player`, `next`, `get_watch`, Shorts sequences). This is the same approach uBlock Origin uses today.
2. **Skips any ad that still starts.** When the player is in its ad state, it presses a skip button if one exists, mutes the ad, plays it at 16x, and seeks to its end. Your own volume and speed are restored afterwards. This also covers ads YouTube stitches into the stream, which the first step cannot see.
3. **Hides ad containers** (masthead, in-feed, companion, and overlay ads).
4. **Dismisses YouTube's ad-blocker warning** and resumes the video if it was paused by it.

On desktop the script is registered with the Chrome DevTools Protocol (`Page.addScriptToEvaluateOnNewDocument`), so it runs before page scripts and web pages gain no preload script or IPC channel. If that registration fails or stalls, browsing continues unprotected rather than blocked. On Android it uses `WebViewCompat.addDocumentStartJavaScript`. It is controlled by **YouTube protection** in Settings or the Android menu, and it respects per-site exceptions.

This is a cat-and-mouse area. YouTube changes its pages often and actively tries to detect blockers, so expect to update the script over time. Ad-free playback cannot be guaranteed. See `ENGINEERING-REPORT.md` for what was tested.

## Android TV

The TV app lives in `android-tv/`. It is a separate native Kotlin application on the system WebView, because Electron does not run on Android. It targets Android 6 and later: Android TV, Google TV, Fire TV, and set-top boxes. Touch is optional.

**Get the app (simple ZIP).** The release workflow builds one simple file for this: `ChromiumCore-1.0.0-android-tv-app.zip` — the APK plus an `INSTALL.md` with the install steps, in a single archive. It is uploaded as the **`ChromiumCore-android-tv-app`** artifact on the tagged release run (Actions → the release run → Artifacts → download that one file). Unzip it on any computer, get `ChromiumCore-1.0.0-android-universal.apk` onto the TV (USB stick or `adb install -r`), enable *unknown sources* in the TV settings, and open it from the LEANBACK launcher. The exact steps are in `INSTALL.md` inside the ZIP.

To (re)build that ZIP from a computer terminal:

```sh
git clone https://github.com/The-Mhood/chromium.git && cd chromium
node scripts/package-android.mjs       # build the signed APK (JDK 17 + Android SDK 34 below)
node scripts/package-android-tv-app.mjs # -> public/download/ChromiumCore-1.0.0-android-tv-app.zip
```

No Android SDK on the machine? Build is optional — download the APK from any release run's **`ChromiumCore-android-tv`** artifact and run `node scripts/package-android-tv-app.mjs --apk /path/to/ChromiumCore-1.0.0-android-universal.apk`. Committing the ZIP into `public/download/` also makes the web Downloads page offer it (the manifest entry is maintained by the script).

Requirements: JDK 17 and the Android SDK (platform 34, build-tools 34.0.0). Set `ANDROID_HOME` if the SDK is not in a standard location. On a Mac the one-time setup is:

```sh
brew install --cask temurin@17
brew install --cask android-commandlinetools
export ANDROID_HOME="$HOME/Library/Android/sdk"
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-34" "build-tools;34.0.0"
```

Then build from the terminal (no Android Studio needed):

```sh
node scripts/package-android.mjs        # tests + signed release APK
node scripts/package-android-tv-app.mjs # simple app ZIP: APK + INSTALL.md
node scripts/package-android-source.mjs # self-contained compilation ZIP
node scripts/package-source.mjs
npm run build
node scripts/verify-downloads.mjs --dist --require-all
```

`scripts/package-android.mjs` runs the Kotlin unit tests, builds the release APK, signs it with a preview key generated into `.android-signing/` (never committed), verifies the signature with `apksigner`, and publishes `ChromiumCore-1.0.0-android-universal.apk` with its SHA-256 into `public/download/`. Keep the key if you plan to ship updates, since Android only upgrades an app signed with the same key. The APK is self-signed and is not a Google Play release. Install with `adb connect <tv-ip>` then `adb install ChromiumCore-1.0.0-android-universal.apk`, or sideload with a file-transfer app.

`scripts/package-android-source.mjs` writes `ChromiumCore-1.0.0-android-tv-source.zip`: the complete `android-tv/` Gradle project, the `shared/` code the build pulls from, the one-command build script, and `android-tv/BUILD.md` with the exact Mac install-and-build steps (including a plain-Gradle path that needs no Node). Anyone can unzip it on a Mac, follow `android-tv/BUILD.md`, and compile the APK from the terminal. The tagged release workflow (`.github/workflows/desktop-release.yml`) builds and publishes both the APK and this compilation ZIP as run artifacts alongside the desktop builds.

**Remote pointer.** A D-pad cannot click a desktop website, so the app draws a pointer above the page. Arrow keys move it, and holding a key accelerates it (speed is adjustable). OK clicks at the pointer through real touch events, so text fields open the on-screen keyboard. Pushing the pointer against the top or bottom edge scrolls with mouse-wheel events, which also scrolls inner panels. Channel and Page keys scroll too. Pushing Up at the top of a page moves focus to the toolbar, and Down returns to the page. Menu or Info opens settings, Search edits the address, and Back goes back or leaves full-screen video. Hover events follow the pointer so menus that need hovering open. The pointer also works over full-screen video. If a site has its own remote navigation, switch the pointer off in the menu. A full keyboard typing into a field is passed through to the page instead.

**Protection on Android.** WebView exposes each request to `shouldInterceptRequest`, so the app blocks ad and tracker requests by host from bundled EasyList and EasyPrivacy domain lists (about 46,000 and 47,000 domains). It never blocks the page's own site or main-frame navigations, lets you pause protection per site, hides common ad containers and YouTube ad elements at document start, blocks pop-ups opened without a user gesture, and disables third-party cookies while tracker blocking is on. Regenerate the lists with `node scripts/build-android-blocklist.mjs`. They are derived from EasyList and EasyPrivacy (GPLv3 or CC BY-SA 3.0, see `assets/blocklists/NOTICE.txt`).

**Differences from the desktop app.** The Android engine matches hosts only. It cannot match URL paths or run the full Ghostery engine, so it cannot remove ads served from the same domain as the content. YouTube is handled separately by the shared YouTube shield described above. There is a single tab, no bookmarks UI, and no downloads. Camera, microphone, and location requests are always denied. Pages load as desktop Chrome by default because desktop layouts suit a pointer, and this is switchable. DRM video such as Netflix is not supported. Widevine playback depends on the device.

## Architecture

- `src/App.tsx`: web and desktop renderer entry point.
- `src/components/`: browser chrome, sidebar, controls, dialogs, and branding.
- `src/pages/`: protection overview, request activity, filters, allowlist, bookmarks, settings, new tab, and downloads.
- `src/store/browser.ts`: persistent Zustand preferences and tab management.
- `electron/main.cjs`: secure window and native WebContentsView tab lifecycle.
- `electron/preload.cjs`: narrowly scoped, sender-validated IPC bridge.
- `electron/protection.cjs`: Ghostery network matching, per-site exceptions, cached filter subscriptions, and cosmetic CSS.
- `scripts/`: reproducible source and platform packaging.

External sites run in sandboxed, isolated Chromium web contents with Node.js disabled and no application preload. Privileged URL schemes are rejected. Permissions are denied by default in this preview. Tab, settings, and protection IPC handlers accept messages only from the trusted application renderer. Ghostery matching is run through a single request pipeline so individual protection switches and domain exceptions do not overwrite one another's network handlers.

Preferences are stored in local renderer storage. Native protection counts, request activity, and subscriptions use a local JSON file in Electron's user-data directory. Filter engines are cached and refreshed after 24 hours. If a filter server is unavailable, previously cached or explicitly limited baseline rules remain in use. Time and data savings are estimates. The overview shows session/cumulative native counts; the web preview's range controls demonstrate sample time-series data.

## Verification

```sh
npx tsc --noEmit
npm run build
node --test .desktop-build/electron/protection.test.cjs .desktop-build/electron/youtube-shield.test.cjs
DISPLAY=:99 node scripts/smoke-youtube.mjs   # needs the Electron runtime in .desktop-build and a display such as Xvfb
npx playwright test
```

The Node tests verify supported navigation protocols, safe domain matching, subscription URL validation, known ad matching, and exception rules. The Playwright suite exercises the web workspace. Passing these checks is not equivalent to testing Windows/macOS application launch, Gatekeeper, SmartScreen, installer behavior, DRM playback, or all dynamic ad formats.

## Preview Limitations

Unsigned builds may trigger operating-system security warnings. Only proceed after checking the archive's origin and checksum. Native Windows and macOS launch must be verified on those systems. YouTube video ads and sponsored content cannot be guaranteed to disappear. Scriptlet injection, DRM/Widevine provisioning, password management, default-browser registration, permission prompts, crash reporting, automatic updates, and production code signing are not included. Custom filter subscriptions should only come from trusted sources; this is an early browser preview, not a hardened production browser.