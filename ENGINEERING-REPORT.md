# ChromiumCore Preview Verification

## Delivered

- Windows x64 portable ZIP containing ChromiumCore.exe and its runtime.
- macOS Apple Silicon portable ZIP containing ChromiumCore.app.
- macOS Intel portable ZIP containing ChromiumCore.app.
- Android TV APK (self-signed preview, Android 6+) with a remote-controlled on-screen pointer.
- A YouTube shield shared by the desktop and Android TV apps: it removes the ad schedule from video data, skips ads that still start, hides ad containers, and dismisses the ad-blocker warning.
- Downloadable source ZIP and architecture-specific SHA-256 manifest.
- Responsive React workspace with browser tabs, address navigation, bookmarks, protection controls, filter subscriptions, allowlist, settings, and CSV activity export.
- Electron Forge 7 packaging, Electron 45 runtime, secure IPC, native WebContentsView tabs, Ghostery request matching, and targeted cosmetic filtering.

## Checks Performed

- Vite production build: passed.
- TypeScript strict check: passed.
- Playwright production-site interaction suite: 16 tests passed, including the Android TV card, its sideload steps, and its checksum.
- Download regression coverage: each desktop archive downloaded through its actual platform button, ZIP signatures and SHA-256 checksums matched, legacy URLs served the same files, and missing/HTML fallback responses did not trigger false success notifications.
- Engine and security unit suite: 4 tests passed.
- Native Electron smoke test on Linux: passed application launch, trusted preload bridge, renderer Node.js isolation, sandboxed external Chromium tab, cosmetic hiding, and blocking of a doubleclick.net request.
- All three release ZIPs: archive CRC integrity passed.
- macOS archives: executable mode 0755 and 14 framework symlinks preserved in each archive.
- Desktop and mobile layouts reviewed at 1440px and 390px viewport widths.

## YouTube Shield

Why earlier blocking failed on YouTube: request and domain blocking cannot see YouTube ads. The ad schedule is part of the video data (`adPlacements`, `adSlots`, `playerAds`) and ads stream from the same hosts as the video. `shared/youtube-shield.js` removes that data in the page before the player reads it (the initial player global, `JSON.parse`, `fetch`, and `XMLHttpRequest`), skips any ad that still starts, hides ad containers, and dismisses the ad-blocker warning. Desktop registers it with the DevTools protocol at document start. Android injects it with `addDocumentStartJavaScript`.

Checks performed:
- 12 Node unit tests (in an isolated VM): initial-global pruning, `JSON.parse`, `fetch` and `XMLHttpRequest` pruning for player URLs only, Shorts ad entries, the ad skipper (skip pressed, muted, 16x, seek to end), restoration of the viewer's volume and speed, no effect on normal playback, no effect on other sites or allowlisted sites, and safe allowlist embedding.
- Live A/B against real YouTube in headless Chromium on three popular videos. Without the shield, each video's data carried an ad schedule (`AD_PLACEMENT_KIND_START`, one placement each). With the shield it carried none. Playback ran for 24 to 40 seconds with no page errors and no ad-blocker warning.
- An end-to-end test in the real Electron app, with a local HTTPS server impersonating youtube.com: ad data was removed from the page and from the API response, a running ad was skipped, and the YouTube protection toggle, a per-site exception, and removing that exception each took effect without a restart. This test found and fixed a real bug: registering the shield stalled the first navigation of every new tab.
- The Android APK ships a byte-identical copy of the script (matching SHA-256), and Kotlin tests cover the placeholder and allowlist handling.

Limitations: in the headless sandbox the baseline never rendered an ad on screen, so the ad skipper and the warning dismissal were verified by unit tests and the Electron test only, not against a live ad. The Android injection has not been run on a device. YouTube changes its pages often and detects blockers, so this will need maintenance. Ads stitched into the stream, regional or logged-in variations, and new enforcement can still get through. Ad-free playback cannot be guaranteed.

## Android TV

A native Kotlin app on the system WebView (`android-tv/`), built because Electron does not run on Android. D-pad input drives a pointer that moves, hovers, clicks, and scrolls through synthesized mouse and touch events. Protection is domain-level request blocking from bundled EasyList/EasyPrivacy domains, per-site pausing, cosmetic hiding, pop-up blocking, and third-party-cookie control.

Checks performed: 33 JVM unit tests passed (pointer movement and edge rules, host matching, first-party exemption, address parsing, script escaping, user agent, settings). The release build succeeded. The APK was inspected with `aapt2` (package com.chromiumcore.tv, minSdk 23, targetSdk 34, INTERNET as the only permission, TV launcher entry with a banner, touchscreen and leanback not required, not debuggable) and verified with `apksigner` (v1 and v2 signatures). The bundled lists were checked to exclude Google, YouTube, and major CDN domains.

Limitations: the app has not been run on a physical TV or an emulator, so the pointer's on-device feel, WebView input synthesis on every Android release, IME behavior, and full-screen video are verified by construction and unit tests only. Matching is host-only, so same-domain ads are not removed, apart from YouTube, which has its own shield (see above). There is one tab, no downloads, and no DRM guarantee. The APK is signed with a self-generated key, so it is not a store release and an update must use the same key.

## Not Verified Or Included

Windows and macOS application launch has not been tested on those operating systems. The generated artifacts are unsigned previews. Code signing, Apple notarization, signed installer testing, SmartScreen/Gatekeeper acceptance, auto-update infrastructure, and production browser security review remain outstanding. The included GitHub Actions workflow supplies native platform build jobs, but has not been executed from this environment.

No claims are made about startup timing, comprehensive malware protection, DRM playback, or complete YouTube ad removal. Cosmetic hiding and request matching cannot guarantee an ad-free YouTube experience. Native permissions are denied by default; there is not yet an interactive permission management UI.

The web workspace uses explicitly labeled sample protection activity and cannot block requests in the host browser. Real network blocking runs only in the desktop Electron browsing session. Data savings and time saved are estimates. Local request history is bounded to the latest 1,000 events; native lifetime counters are maintained separately. The native dashboard labels its cumulative figures as All time, while its chart uses recent local activity.

## Output Locations

Portable archives, source ZIP, and checksums are in `public/download/` and copied into `dist/download/` by the final web build. Physical compatibility copies also support the old `/downloads/` URLs. The Downloads page checks that each actual archive exists and rejects HTML fallback responses before enabling downloads. `scripts/verify-downloads.mjs --dist --require-all` verifies real ZIP headers and release checksums in both the source public folder and production output.