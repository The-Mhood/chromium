// Builds, signs, verifies, and publishes the Android TV APK into public/download.
// Requirements: JDK 17+, Android SDK (platform 34, build-tools 34.0.0), and network access for Gradle.
// The APK is signed with a locally generated preview key kept in .android-signing/ (never committed).
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tvDir = path.join(root, 'android-tv');
const signingDir = path.join(root, '.android-signing');
const windows = process.platform === 'win32';
const VERSION = '1.0.0';
const FILE = `ChromiumCore-${VERSION}-android-universal.apk`;

function findSdk() {
  const candidates = [
    process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT,
    path.join(os.homedir(), 'android-sdk'), path.join(os.homedir(), 'Android/Sdk'),
    path.join(os.homedir(), 'Library/Android/sdk'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android/Sdk'),
  ].filter(Boolean);
  const sdk = candidates.find(dir => fsSync.existsSync(path.join(dir, 'platforms')) && fsSync.existsSync(path.join(dir, 'build-tools')));
  if (!sdk) throw new Error('Android SDK not found. Install platform 34 and build-tools 34.0.0, then set ANDROID_HOME.');
  return sdk;
}

function keytool() {
  const home = process.env.JAVA_HOME;
  const candidate = home && path.join(home, 'bin', windows ? 'keytool.exe' : 'keytool');
  return candidate && fsSync.existsSync(candidate) ? candidate : 'keytool';
}

const readProperties = async file => Object.fromEntries((await fs.readFile(file, 'utf8')).split(/\r?\n/).filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));

// Saved workspaces can strip binary files such as .jks and .jar. Text (base64) copies are kept beside them
// and restored here, so the app keeps being signed by the same key and the Gradle wrapper keeps working.
async function ensureSigningKey() {
  const propertiesFile = path.join(signingDir, 'signing.properties');
  const storeFile = path.join(signingDir, 'preview.jks');
  const backup = path.join(signingDir, 'preview.jks.b64');
  await fs.mkdir(signingDir, { recursive: true, mode: 0o700 });
  let properties = fsSync.existsSync(propertiesFile) ? await readProperties(propertiesFile) : null;
  if (properties && !fsSync.existsSync(storeFile) && fsSync.existsSync(backup)) {
    await fs.writeFile(storeFile, Buffer.from((await fs.readFile(backup, 'utf8')).trim(), 'base64'), { mode: 0o600 });
    console.log('Restored the preview signing key from its text backup.');
  }
  if (!properties || !fsSync.existsSync(storeFile)) {
    const password = crypto.randomBytes(18).toString('base64url');
    await fs.rm(storeFile, { force: true });
    execFileSync(keytool(), [
      '-genkeypair', '-keystore', storeFile, '-storetype', 'PKCS12', '-alias', 'chromiumcore-preview',
      '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-storepass', password, '-keypass', password,
      '-dname', 'CN=ChromiumCore Preview, O=ChromiumCore',
    ], { stdio: 'inherit' });
    properties = { storePassword: password, keyAlias: 'chromiumcore-preview', keyPassword: password };
    console.log('Generated a new preview signing key in .android-signing/. Keep that folder: updates must be signed with the same key.');
    console.log('Note: an app installed from an earlier build signed with a different key must be uninstalled before this one is installed.');
  }
  if (!fsSync.existsSync(backup)) await fs.writeFile(backup, (await fs.readFile(storeFile)).toString('base64') + '\n', { mode: 0o600 });
  // The path is rewritten every run so the folder can be moved.
  const lines = [`storeFile=${storeFile.replace(/\\/g, '/')}`, `storePassword=${properties.storePassword}`, `keyAlias=${properties.keyAlias}`, `keyPassword=${properties.keyPassword}`];
  await fs.writeFile(propertiesFile, lines.join('\n') + '\n', { mode: 0o600 });
}

async function ensureGradleWrapper(env) {
  const jar = path.join(tvDir, 'gradle/wrapper/gradle-wrapper.jar');
  const backup = `${jar}.b64`;
  if (!fsSync.existsSync(jar)) {
    if (fsSync.existsSync(backup)) {
      await fs.writeFile(jar, Buffer.from((await fs.readFile(backup, 'utf8')).trim(), 'base64'));
      console.log('Restored the Gradle wrapper from its text backup.');
    } else {
      console.log('Generating the Gradle wrapper with the installed gradle...');
      try {
        execFileSync(windows ? 'gradle.bat' : 'gradle', ['wrapper', '--gradle-version', '8.7', '--distribution-type', 'bin'], { cwd: tvDir, stdio: 'inherit', env, shell: windows });
      } catch {
        throw new Error('gradle-wrapper.jar is missing and Gradle is not installed. Install Gradle 8.7 or Android Studio, then run "gradle wrapper --gradle-version 8.7" inside android-tv/.');
      }
    }
  }
  if (!fsSync.existsSync(backup)) await fs.writeFile(backup, (await fs.readFile(jar)).toString('base64') + '\n');
  if (!windows) await fs.chmod(path.join(tvDir, 'gradlew'), 0o755);
}

const sdk = findSdk();
const env = { ...process.env, ANDROID_HOME: sdk, ANDROID_SDK_ROOT: sdk };
await ensureSigningKey();
await ensureGradleWrapper(env);
const gradlew = path.join(tvDir, windows ? 'gradlew.bat' : 'gradlew');
// Unit tests gate the release build.
execFileSync(gradlew, ['--no-daemon', '--console=plain', 'testDebugUnitTest', 'assembleRelease'], { cwd: tvDir, stdio: 'inherit', env, shell: windows });

const built = path.join(tvDir, 'app/build/outputs/apk/release/app-release.apk');
if (!fsSync.existsSync(built)) throw new Error('Gradle did not produce a signed release APK.');

// Verify the signature with the SDK's apksigner before publishing.
const buildTools = (await fs.readdir(path.join(sdk, 'build-tools'))).sort().reverse()[0];
const apksigner = path.join(sdk, 'build-tools', buildTools, windows ? 'apksigner.bat' : 'apksigner');
const verification = execFileSync(apksigner, ['verify', '--verbose', '--print-certs', built], { env, shell: windows }).toString();
if (!/Verifies/.test(verification)) throw new Error(`APK signature did not verify:\n${verification}`);

const dir = path.join(root, 'public/download');
const legacyDir = path.join(root, 'public/downloads');
await fs.mkdir(dir, { recursive: true });
await fs.mkdir(legacyDir, { recursive: true });
await fs.copyFile(built, path.join(dir, FILE));
await fs.copyFile(built, path.join(legacyDir, FILE));
const bytes = await fs.readFile(path.join(dir, FILE));
let manifest = { version: VERSION, source: 'chromiumcore-source.zip', releases: [] };
try { manifest = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8')); } catch { /* First release. */ }
const release = { platform: 'android', arch: 'universal', name: 'Android TV', file: FILE, size: `${(bytes.length / 1024 / 1024).toFixed(1)} MB`, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
manifest.releases = [...manifest.releases.filter(item => item.platform !== 'android'), release];
await fs.writeFile(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await fs.copyFile(path.join(dir, 'manifest.json'), path.join(legacyDir, 'manifest.json'));
console.log(`Download ready: public/download/${FILE} (${release.size})`);
