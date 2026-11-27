# Building ChromiumCore for Android TV on a Mac

This folder is a complete, self-contained Android TV (Leanback) project:
Kotlin + Gradle, a `WebView`-based browser with D-pad pointer control,
ad/tracker blocking, and the shared YouTube shield. Everything needed to
compile it is in the ZIP you downloaded — no other source is required.

The layout inside the ZIP is:

```
chromiumcore-android-tv/
├── android-tv/            <- this Gradle project (read me first)
│   ├── BUILD.md           <- you are here
│   ├── gradlew            <- the Gradle wrapper (see the note below)
│   ├── settings.gradle.kts
│   ├── build.gradle.kts
│   └── app/
│       ├── build.gradle.kts
│       └── src/
│           ├── main/      <- manifest, Kotlin sources, layouts, assets
│           └── test/      <- JVM unit tests (they gate the build)
├── shared/                <- shared browser code (the YouTube shield is
│                             packaged into the APK from here — do not
│                             delete this folder)
├── scripts/
│   └── package-android.mjs  <- one-command build (recommended)
└── .android-signing/      <- created by the build; keep it for updates
```

## What you need

| Dependency      | Version | Install on macOS |
| --------------- | ------- | ---------------- |
| Java (JDK)      | 17      | `brew install --cask temurin@17` (or `brew install openjdk@17`) |
| Android SDK     | 34      | command-line tools below |
| Gradle          | 8.7     | **not needed** — the wrapper downloads it |
| Node.js         | 18+     | `brew install node` (only for the one-command build) |

The SDK's *platform 34* and *build-tools 34.0.0* packages are installed
by the commands below (the Gradle wrapper itself needs no setup).

## Install the Android SDK (once)

```sh
brew install --cask android-commandlinetools
export ANDROID_HOME="$HOME/Library/Android/sdk"

# If the cask installed to a different location, point ANDROID_HOME there
# (Android Studio users: that is ~/Library/Android/sdk already).

"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --licenses
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-34" "build-tools;34.0.0"
```

Add `export ANDROID_HOME=...` to your `~/.zshrc` if you want it permanent.
The build also honors `ANDROID_SDK_ROOT` and checks the usual locations
(`~/Library/Android/sdk`, `~/android-sdk`, …), so an existing Android
Studio SDK works as-is.

## Build the APK

**Option A — one command (recommended).** From the ZIP root:

```sh
node scripts/package-android.mjs
```

This restores the Gradle wrapper, generates (or reuses) the preview
signing key in `.android-signing/`, runs the JVM unit tests, assembles
the **signed release APK**, verifies the signature with `apksigner`, and
copies the result to `public/download/` (ignore that last step locally).

Output: `android-tv/app/build/outputs/apk/release/app-release.apk`

**Option B — plain Gradle, debug APK.** If you want to stay in pure
terminal without Node:

```sh
cd android-tv
chmod +x gradlew
# The wrapper JAR is stored as base64 (some file transports strip binary
# files); restore it once if the plain .jar is missing:
test -f gradle/wrapper/gradle-wrapper.jar \
  || base64 -d gradle/wrapper/gradle-wrapper.jar.b64 > gradle/wrapper/gradle-wrapper.jar
./gradlew testDebugUnitTest assembleDebug
```

Output: `android-tv/app/build/outputs/apk/debug/app-debug.apk`
(a debug build is automatically signed with your local debug key —
fine for installation on your own TV).

To rebuild a signed release APK by hand, create
`.android-signing/signing.properties` next to `android-tv/` (the
one-command build shows the exact format it generates), or just use
Option A — it is the documented path.

## Install it on the TV

1. Enable **Settings → Device preferences → Security → Allow
   Unknown Sources** (or Developer options → USB debugging) on the TV.
2. Easiest: copy the APK to the TV (USB stick, or `adb push`) and open
   it with any file manager.
3. Or over ADB (USB debugging on the TV, same network or cable):

```sh
adb install -r android-tv/app/build/outputs/apk/release/app-release.apk
```

Then open **ChromiumCore** from the TV launcher (it appears under the
LEANBACK launcher, not the phone launcher).

### Remote-control guide

| Key | Action |
| --- | ------ |
| Arrows | Move the on-screen pointer (hold to accelerate) |
| OK / Select | Click at the pointer |
| Push pointer up at the top of a page | Reach the toolbar |
| Channel / Page Up / Down | Scroll the page |
| Menu / Info | Options (protection, pointer speed, site allow-list, …) |
| Search | Edit the address bar |
| Back | Go back / exit fullscreen video / double-press to quit |

## Notes

- **Updates:** an app signed with a different key cannot update over an
  older install — keep the `.android-signing/` folder (or build with
  Option B every time, which reuses the same debug key).
- **Block lists:** the APK ships with bundled block lists in
  `app/src/main/assets/blocklists/`. They are regenerated from the
  desktop protection rules by `scripts/build-android-blocklist.mjs`
  (in the full ChromiumCore source) when those rules change; the
  baseline rules are built into the code, so the APK works even if the
  asset files are missing.
- **Privacy:** everything (settings, counters, the allow-list) stays on
  the device. No analytics, no accounts, no network calls other than
  the pages you visit.
