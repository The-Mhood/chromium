import { _electron as electron } from '@playwright/test';
import http from 'node:http';
import path from 'node:path';
import assert from 'node:assert/strict';

const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<!doctype html><title>Native protection test</title><h1>A real Chromium tab</h1><div class="ad-banner">Test advertising container</div>');
});
await new Promise(resolve => server.listen(9941, '127.0.0.1', resolve));
let app;
try {
  const stage = path.resolve('.desktop-build');
  app = await electron.launch({ executablePath: path.join(stage, 'node_modules/electron/dist/electron'), args: [stage, '--no-sandbox', '--disable-gpu'], env: { ...process.env, DISPLAY: process.env.DISPLAY || ':99' }, timeout: 30000 });
  const window = await app.firstWindow();
  await window.getByRole('heading', { name: 'A cleaner, safer internet.' }).waitFor();
  assert.equal(await window.evaluate(() => typeof window.chromiumCore.navigate), 'function');
  assert.equal(await window.evaluate(() => typeof window.require), 'undefined');
  await window.evaluate(() => window.chromiumCore.clearData());
  await window.getByRole('textbox', { name: 'Address and search bar' }).fill('http://127.0.0.1:9941');
  await window.getByRole('textbox', { name: 'Address and search bar' }).press('Enter');
  await window.waitForTimeout(2500);
  const remote = await app.evaluate(({ webContents }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:9941'));
    return { exists: !!contents, nodeIntegration: contents?.getLastWebPreferences().nodeIntegration, sandbox: contents?.getLastWebPreferences().sandbox };
  });
  assert.equal(remote.exists, true); assert.equal(remote.nodeIntegration, false); assert.equal(remote.sandbox, true);
  const display = await app.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:9941'));
    return contents.executeJavaScript('getComputedStyle(document.querySelector(".ad-banner")).display');
  });
  assert.equal(display, 'none');
  await app.evaluate(async ({ webContents }) => {
    const contents = webContents.getAllWebContents().find(item => item.getURL().startsWith('http://127.0.0.1:9941'));
    await contents.executeJavaScript('fetch("https://googleads.g.doubleclick.net/pagead/ads").catch(() => null)');
  });
  await window.waitForTimeout(700);
  const stats = await window.evaluate(() => window.chromiumCore.getStats());
  assert.ok(stats.ads + stats.trackers > 0, 'Known advertising request should be blocked by the native session');
  console.log('PASS: native application launch, secure IPC, isolated real Chromium tab, cosmetic hiding, and network request blocking.');
} finally {
  if (app) await app.close();
  server.close();
}