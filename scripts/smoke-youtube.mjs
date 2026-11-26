// End-to-end check of the YouTube shield inside the real Electron app.
// A local server impersonates youtube.com (via --host-resolver-rules) and serves a page that carries ad data,
// a running "ad" with a skip button, and a player API response that also carries ad data.
import { _electron as electron } from '@playwright/test';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';

const PORT = 9942;
const PLAYER = { videoDetails: { title: 'Fake video' }, adPlacements: [{ id: 1 }], adSlots: [{ id: 2 }], playerAds: [{ id: 3 }] };
const page = `<!doctype html><title>Fake YouTube</title>
<div class="html5-video-player ad-showing"><video class="html5-main-video"></video><button class="ytp-skip-ad-button"></button></div>
<script>
  var ytInitialPlayerResponse = ${JSON.stringify(PLAYER)};
  window.__skipped = false;
  document.querySelector('.ytp-skip-ad-button').addEventListener('click', function () { window.__skipped = true; });
  window.__player = fetch('/youtubei/v1/player?prettyPrint=false', { method: 'POST', body: '{}' }).then(function (r) { return r.json(); });
</script>`;

// youtube.com is on Chromium's HTTPS-only list, so the impersonating server must speak HTTPS.
// A throwaway certificate is generated for it, and the test app is started trusting it.
const certDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chromiumcore-yt-'));
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(certDir, 'key.pem'), '-out', path.join(certDir, 'cert.pem'), '-subj', '/CN=www.youtube.com', '-days', '1'], { stdio: 'ignore' });
const server = https.createServer({ key: fs.readFileSync(path.join(certDir, 'key.pem')), cert: fs.readFileSync(path.join(certDir, 'cert.pem')) }, (request, response) => {
  if (request.url.startsWith('/youtubei/v1/player')) {
    response.setHeader('Content-Type', 'application/json');
    return response.end(JSON.stringify(PLAYER));
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(page);
});
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve));

let app;
try {
  const stage = path.resolve('.desktop-build');
  app = await electron.launch({
    executablePath: path.join(stage, 'node_modules/electron/dist/electron'),
    args: [stage, '--no-sandbox', '--disable-gpu', '--ignore-certificate-errors', '--host-resolver-rules=MAP www.youtube.com 127.0.0.1'],
    env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' },
    timeout: 30000,
  });
  const window = await app.firstWindow();
  await window.getByRole('heading', { name: 'A cleaner, safer internet.' }).waitFor();
  const address = window.getByRole('textbox', { name: 'Address and search bar' });
  const settings = (youtube) => ({ enabled: true, network: true, tracking: true, cosmetic: true, popups: true, youtube });

  // Runs inside the page that matches the query, once it has finished loading.
  const read = (query, final) => app.evaluate(async ({ webContents }, { query, final }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().includes(`www.youtube.com:9942/${query}`));
    if (!contents || contents.isLoading()) return null;
    return contents.executeJavaScript(`(async () => {
      if (document.readyState !== 'complete' || !window.__player || !window.ytInitialPlayerResponse) return null;
      if (!${final}) return { ready: true };
      const video = document.querySelector('video');
      const json = await window.__player;
      const ads = object => ['adPlacements', 'adSlots', 'playerAds'].filter(key => key in object);
      return { initial: ads(window.ytInitialPlayerResponse), fetched: ads(json), title: json.videoDetails.title, skipped: window.__skipped, muted: video.muted, rate: video.playbackRate };
    })()`).catch(() => null);
  }, { query, final });

  const visit = async (query) => {
    await address.fill(`https://www.youtube.com:${PORT}/${query}`);
    await address.press('Enter');
    for (let attempt = 0; attempt < 40; attempt++) {
      await window.waitForTimeout(500);
      if (await read(query, false)) {
        await window.waitForTimeout(900); // let the ad skipper run at least once
        return read(query, true);
      }
    }
    return null;
  };

  // 1. Protection on: ad data is stripped from both the page and the API response, and the ad is skipped.
  const protectedPage = await visit('?on=1');
  assert.ok(protectedPage, 'the fake YouTube page should load');
  assert.deepEqual(protectedPage.initial, [], 'ad data must be removed from the initial player response');
  assert.deepEqual(protectedPage.fetched, [], 'ad data must be removed from the player API response');
  assert.equal(protectedPage.title, 'Fake video', 'the real video data must be kept');
  assert.equal(protectedPage.skipped, true, 'the skip button must be pressed');
  assert.equal(protectedPage.muted, true, 'the ad must be muted');
  assert.equal(protectedPage.rate, 16, 'the ad must be sped up');

  // 2. YouTube protection off: the page is left alone.
  await window.evaluate(value => window.chromiumCore.setProtection(value), settings(false));
  const unprotected = await visit('?off=1');
  assert.ok(unprotected, 'the page should load with the shield off');
  assert.deepEqual([...unprotected.initial].sort(), ['adPlacements', 'adSlots', 'playerAds'], 'the toggle must disable the shield');
  assert.equal(unprotected.skipped, false);

  // 3. A site exception disables it for that site only.
  await window.evaluate(value => window.chromiumCore.setProtection(value), settings(true));
  await window.evaluate(() => window.chromiumCore.setAllowlist(['youtube.com']));
  const allowed = await visit('?allow=1');
  assert.ok(allowed, 'the page should load on an allowlisted site');
  assert.equal(allowed.initial.length, 3, 'an allowlisted site must not be modified');

  // 4. Removing the exception turns it back on without restarting.
  await window.evaluate(() => window.chromiumCore.setAllowlist([]));
  const again = await visit('?again=1');
  assert.ok(again, 'the page should load after the exception is removed');
  assert.deepEqual(again.initial, [], 'the shield must come back after the exception is removed');
  console.log('PASS: YouTube shield removes ad data from the page and API, skips the ad, and honours the toggle and site exceptions in the real app.');
} finally {
  if (app) await app.close();
  server.close();
}
