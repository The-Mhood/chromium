const fs = require('node:fs');
const path = require('node:path');

const PLACEHOLDER = '/*__CC_ALLOW__*/[]';
let template;

// shared/ sits beside electron/ both in the repository and inside the packaged app.
function loadTemplate() {
  if (!template) template = fs.readFileSync(path.join(__dirname, '..', 'shared', 'youtube-shield.js'), 'utf8');
  if (!template.includes(PLACEHOLDER)) throw new Error('YouTube shield template is missing its allowlist placeholder');
  return template;
}

/** Returns the shield script with the user's allowlisted sites embedded. Invalid entries are dropped. */
function buildShieldScript(allowlist) {
  const safe = (Array.isArray(allowlist) ? allowlist : [])
    .filter(domain => typeof domain === 'string' && /^[a-z0-9.-]+$/i.test(domain))
    .map(domain => domain.toLowerCase());
  return loadTemplate().replace(PLACEHOLDER, () => JSON.stringify(safe));
}

module.exports = { buildShieldScript };
