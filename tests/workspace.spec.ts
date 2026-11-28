import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test('overview shows sample metrics and an interactive date range', async ({ page }) => {
  await expect(page.getByRole('heading', { name: 'A cleaner, safer internet.' })).toBeVisible();
  await expect(page.locator('.metric-value').first()).toHaveText('24,831');
  await page.getByRole('button', { name: 'Last 7 days' }).click();
  await page.getByRole('button', { name: 'Last 30 days', exact: true }).click();
  await expect(page.locator('.metric-value').first()).toHaveText('94,358');
  await page.getByRole('button', { name: 'Ads blocked', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Ads blocked', exact: true })).toHaveClass('muted');
});

test('tab management and address navigation work', async ({ page }) => {
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(4);
  await expect(page.getByRole('heading', { name: /A little less noise/ })).toBeVisible();
  await page.getByRole('textbox', { name: 'Address and search bar' }).fill('core://filters');
  await page.getByRole('textbox', { name: 'Address and search bar' }).press('Enter');
  await expect(page.getByRole('heading', { name: 'Good filters. Better browsing.' })).toBeVisible();
  await page.getByRole('button', { name: 'Close Filter lists tab' }).click();
  await expect(page.getByRole('tab')).toHaveCount(3);
});

test('protection settings persist and master protection disables controls', async ({ page }) => {
  const adBlocking = page.getByRole('switch', { name: 'Ad blocking', exact: true });
  await adBlocking.click();
  await expect(adBlocking).toHaveAttribute('aria-checked', 'false');
  await page.reload();
  await expect(adBlocking).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Protection is on', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Protection paused', exact: true })).toBeVisible();
  await expect(adBlocking).toBeDisabled();
});

test('allowlist additions persist and can be removed', async ({ page }) => {
  await page.getByRole('button', { name: 'Allowlist', exact: true }).click();
  await page.getByRole('button', { name: 'Add website', exact: true }).click();
  await page.getByRole('textbox', { name: 'Website domain' }).fill('https://www.example.com/some-page');
  await page.getByRole('button', { name: 'Allow website', exact: true }).click();
  await expect(page.locator('.allowed-domain')).toHaveText('example.com');
  await page.reload();
  await page.getByRole('button', { name: 'Allowlist', exact: true }).click();
  await expect(page.locator('.allowed-domain')).toHaveText('example.com');
  await page.getByRole('button', { name: 'Remove example.com from allowlist' }).click();
  await expect(page.getByRole('heading', { name: 'Every website gets your protection.' })).toBeVisible();
});

test('custom filters validate HTTPS and support toggle and removal', async ({ page }) => {
  await page.getByRole('button', { name: 'Filter lists', exact: true }).click();
  await page.getByRole('button', { name: 'Add filter list', exact: true }).click();
  await page.getByRole('textbox', { name: 'List name' }).fill('My test filters');
  await page.getByRole('textbox', { name: 'Filter list URL' }).fill('http://example.com/list.txt');
  await page.getByRole('dialog').getByRole('button', { name: 'Add filter list' }).click();
  await expect(page.getByText('Use a secure HTTPS URL.')).toBeVisible();
  await page.getByRole('textbox', { name: 'Filter list URL' }).fill('https://example.com/list.txt');
  await page.getByRole('dialog').getByRole('button', { name: 'Add filter list' }).click();
  await expect(page.getByRole('heading', { name: 'My test filters', exact: true })).toBeVisible();
  await page.getByRole('switch', { name: 'Enable My test filters' }).click();
  await expect(page.getByRole('switch', { name: 'Enable My test filters' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('button', { name: 'Remove My test filters' }).click();
  await expect(page.getByRole('heading', { name: 'My test filters', exact: true })).toHaveCount(0);
});

test('activity search, type filtering, export, and clear work', async ({ page }) => {
  await page.getByRole('button', { name: 'Browsing activity', exact: true }).click();
  await page.getByRole('button', { name: 'Trackers', exact: true }).click();
  await expect(page.locator('.activity-table tbody tr')).toHaveCount(8);
  await page.getByRole('textbox', { name: 'Search browsing activity' }).fill('google-analytics');
  await expect(page.locator('.activity-table tbody tr')).toHaveCount(4);
  const exported = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Export activity' }).click();
  expect((await exported).suggestedFilename()).toBe('chromiumcore-activity.csv');
  await page.getByRole('button', { name: 'Clear browsing activity' }).click();
  await page.getByRole('button', { name: 'Clear activity', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search browsing activity' }).fill('');
  await expect(page.getByRole('heading', { name: 'A fresh start.' })).toBeVisible();
});

test('bookmarks can be added, opened in tabs, and removed', async ({ page }) => {
  await page.getByRole('button', { name: 'Bookmarks', exact: true }).click();
  await page.getByRole('button', { name: 'Add bookmark' }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Example website');
  await page.getByRole('textbox', { name: 'Website URL' }).fill('https://example.com');
  await page.getByRole('button', { name: 'Save bookmark' }).click();
  await page.locator('.bookmark-row').filter({ hasText: 'Example website' }).getByRole('button').first().click();
  await expect(page.getByRole('heading', { name: 'Example website' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open example.com' })).toHaveAttribute('href', 'https://example.com/');
  await page.getByRole('button', { name: 'Close Example website tab' }).click();
  await page.getByRole('button', { name: 'Remove Example website bookmark' }).click();
  await expect(page.locator('.bookmark-row')).toHaveCount(3);
});

test('appearance and default search engine persist', async ({ page }) => {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Dark theme' }).click();
  await expect(page.locator('html')).toHaveClass('theme-dark');
  await page.getByRole('combobox', { name: 'Default search engine' }).selectOption('duckduckgo');
  await page.reload();
  await expect(page.locator('html')).toHaveClass('theme-dark');
  await page.getByRole('button', { name: 'New tab', exact: true }).click();
  await page.getByRole('textbox', { name: 'Search the web' }).fill('a quieter internet');
  await page.getByRole('textbox', { name: 'Search the web' }).press('Enter');
  await expect(page.getByRole('textbox', { name: 'Address and search bar' })).toHaveValue('https://duckduckgo.com/?q=a%20quieter%20internet');
});

test('download page provides real architecture-specific artifacts and checksums', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Downloads', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Take a quieter internet with you.' })).toBeVisible();
  const response = await request.get('/download/manifest.json');
  expect(response.ok()).toBeTruthy();
  const manifest = await response.json();
  expect(manifest.releases).toHaveLength(4);
  for (const release of manifest.releases) {
    const file = await request.head(`/download/${release.file}`);
    expect(file.ok()).toBeTruthy();
    expect(file.headers()['content-type']).not.toContain('text/html');
    expect(Number(file.headers()['content-length'])).toBeGreaterThan(1000000);
    const legacyFile = await request.head(`/downloads/${release.file}`);
    expect(legacyFile.ok()).toBeTruthy();
    expect(legacyFile.headers()['content-length']).toBe(file.headers()['content-length']);
  }
  await expect(page.getByRole('button', { name: /Download for Windows/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Download for macOS/ })).toBeEnabled();
  await expect(page.getByRole('button', { name: /Download for Android TV/ })).toBeEnabled();
  await page.getByRole('combobox', { name: 'Architecture' }).selectOption('x64');
  await page.locator('.download-platform').nth(1).getByRole('button', { name: 'SHA-256' }).click();
  await expect(page.locator('.checksum-code')).toHaveText(manifest.releases.find((item: { platform: string; arch: string }) => item.platform === 'darwin' && item.arch === 'x64').sha256);
});

test('platform buttons download real ZIP bytes with matching checksums', async ({ page, request }) => {
  test.setTimeout(120000);
  const manifest = await (await request.get('/download/manifest.json')).json();
  await page.getByRole('button', { name: 'Downloads', exact: true }).click();
  for (const release of manifest.releases) {
    const isMac = release.platform === 'darwin';
    const label = isMac ? /Download for macOS/ : release.platform === 'android' ? /Download for Android TV/ : /Download for Windows/;
    if (isMac) await page.getByRole('combobox', { name: 'Architecture' }).selectOption(release.arch);
    const started = page.waitForEvent('download');
    await page.getByRole('button', { name: label }).click();
    const download = await started;
    expect(download.suggestedFilename()).toBe(release.file);
    expect(new URL(download.url()).pathname).toBe(`/download/${release.file}`);
    const stream = await download.createReadStream();
    if (!stream) throw new Error('Downloaded file could not be read');
    const hash = createHash('sha256');
    let header: Buffer | undefined;
    for await (const chunk of stream) {
      header ??= Buffer.from(chunk).subarray(0, 4);
      hash.update(chunk);
    }
    expect(header).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    expect(hash.digest('hex')).toBe(release.sha256);
    await page.getByRole('button', { name: 'Sounds good' }).click();
    await download.delete();
  }
  const sourceStarted = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download source' }).click();
  const source = await sourceStarted;
  expect(source.suggestedFilename()).toBe('chromiumcore-source.zip');
  expect(await source.failure()).toBeNull();
});

for (const fallback of ['missing', 'html']) {
  test(`unavailable ${fallback} archive responses never enable a false download`, async ({ page }) => {
    await page.route('**/download/ChromiumCore-1.0.0-win32-x64.zip', route => route.fulfill({
      status: fallback === 'missing' ? 404 : 200,
      contentType: 'text/html',
      body: '<!doctype html><html><body>Not an archive</body></html>',
    }));
    await page.getByRole('button', { name: 'Downloads', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Native build not available', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: /Download for macOS/ })).toBeEnabled();
    await expect(page.getByText('Some download files are missing from this server.', { exact: false })).toBeVisible();
  });
}

test('a file removed after page load does not trigger a success notification', async ({ page }) => {
  await page.getByRole('button', { name: 'Downloads', exact: true }).click();
  const button = page.getByRole('button', { name: /Download for Windows/ });
  await expect(button).toBeEnabled();
  await page.route('**/download/ChromiumCore-1.0.0-win32-x64.zip', route => route.fulfill({ status: 404 }));
  await button.click();
  await expect(page.getByText('The archive is missing. No download was started.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Native build not available', exact: true })).toBeDisabled();
});

test('Android TV card documents the remote pointer and sideload steps', async ({ page }) => {
  // The SHA-256 button only enables when the archive actually exists on the
  // server (the dev server ships no release files), so the test serves a
  // fake Android APK + manifest over the network: the card must report the
  // file available and the checksum modal must show the manifest's hash.
  const fakeSha = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  await page.route('**/download/ChromiumCore-1.0.0-android-universal.apk', route => route.fulfill({
    contentType: 'application/vnd.android.package-archive',
    headers: { 'content-length': '1234' },
    body: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  }));
  await page.route('**/download/manifest.json', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({
      version: '1.0.0',
      source: 'chromiumcore-source.zip',
      releases: [
        { platform: 'android', arch: 'universal', name: 'Android TV', file: 'ChromiumCore-1.0.0-android-universal.apk', size: '1.7 MB', sha256: fakeSha },
      ],
    }),
  }));
  await page.getByRole('button', { name: 'Downloads', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'ChromiumCore for Android TV' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Built for the remote. Pointer included.' })).toBeVisible();
  await expect(page.getByText('Move the on-screen pointer', { exact: false })).toBeVisible();
  await expect(page.getByText('Click wherever the pointer is.', { exact: true })).toBeVisible();
  await page.locator('.download-platform').nth(2).getByRole('button', { name: 'Installation instructions' }).click();
  await expect(page.getByRole('dialog').getByText('Install the APK.')).toBeVisible();
  await expect(page.getByRole('dialog').getByText('adb install', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Sounds good' }).click();
  const shaButton = page.locator('.download-platform').nth(2).getByRole('button', { name: 'SHA-256' });
  await expect(shaButton).toBeEnabled('the served APK makes the card available, enabling SHA-256');
  await shaButton.click();
  const manifest = await (await page.request.get('/download/manifest.json')).json();
  await expect(page.locator('.checksum-code')).toHaveText(manifest.releases.find((item: { platform: string }) => item.platform === 'android').sha256);
});

test('three download cards fit without horizontal overflow at tablet width', async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 900 });
  await page.getByRole('button', { name: 'Downloads', exact: true }).click();
  await expect(page.locator('.download-platform')).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
});

test('mobile navigation is usable without horizontal overflow', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBeTruthy();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: 'Downloads', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Take a quieter internet with you.' })).toBeVisible();
  await expect(page.locator('.sidebar')).not.toHaveClass(/mobile-open/);
});