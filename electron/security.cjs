const { isIP } = require('node:net');

function browsingUrl(input) {
  if (typeof input !== 'string' || input.length > 8192) throw new Error('Invalid address');
  const url = new URL(input);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Only public HTTP and HTTPS navigation is supported');
  return url.href;
}

function isAllowedDomain(url, allowlist) {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
    return allowlist.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
  } catch { return false; }
}

function trustedFilterUrl(input) {
  try {
    const url = new URL(input);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || isIP(host)) return false;
    return host.includes('.') && host !== 'localhost' && !host.endsWith('.localhost') && !host.endsWith('.local') && !host.endsWith('.internal');
  } catch { return false; }
}

module.exports = { browsingUrl, isAllowedDomain, trustedFilterUrl };