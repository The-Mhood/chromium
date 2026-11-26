const { test } = require('node:test');
const assert = require('node:assert/strict');
const { browsingUrl, isAllowedDomain, trustedFilterUrl } = require('./security.cjs');

test('navigation only accepts HTTP and HTTPS, without credentials', () => {
  assert.equal(browsingUrl('https://example.com'), 'https://example.com/');
  for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'https://user:pass@example.com']) assert.throws(() => browsingUrl(value));
});
test('site exceptions match domains and subdomains, never lookalikes', () => {
  assert.equal(isAllowedDomain('https://www.example.com', ['example.com']), true);
  assert.equal(isAllowedDomain('https://news.example.com', ['example.com']), true);
  assert.equal(isAllowedDomain('https://notexample.com', ['example.com']), false);
  assert.equal(isAllowedDomain('https://example.com.attacker.com', ['example.com']), false);
});
test('filter subscriptions require public HTTPS hostnames', () => {
  assert.equal(trustedFilterUrl('https://easylist.to/easylist/easylist.txt'), true);
  for (const value of ['http://example.com/filters', 'https://127.0.0.1/filters', 'https://localhost/filters', 'file:///filters', 'https://host.local/filters']) assert.equal(trustedFilterUrl(value), false);
});
test('Ghostery matches a known ad request and respects exception rules', async () => {
  const { FiltersEngine, Request } = await import('@ghostery/adblocker');
  const engine = FiltersEngine.parse('||doubleclick.net^\n@@||doubleclick.net/allowed.js');
  const request = url => Request.fromRawDetails({ url, sourceUrl: 'https://example.com', type: 'script' });
  assert.equal(engine.match(request('https://doubleclick.net/pagead/conversion')).match, true);
  assert.equal(engine.match(request('https://doubleclick.net/allowed.js')).match, false);
  assert.equal(engine.match(Request.fromRawDetails({ url: 'https://doubleclick.net/pagead/landing', sourceUrl: 'https://example.com', type: 'main_frame' })).match, true);
  assert.equal(engine.match(Request.fromRawDetails({ url: 'https://doubleclick.net/popup', sourceUrl: 'https://example.com', type: 'popup' })).match, true);
  assert.equal(engine.match(request('https://example.com/app.js')).match, false);
});