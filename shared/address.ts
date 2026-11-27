/**
 * Address bar / search box input classification (shared by the desktop
 * renderer and the test suite).
 *
 * Rules (deliberately explicit, and tested in address.test.ts):
 *   1. `core://…` passes through untouched (internal pages).
 *   2. An explicit scheme: only `http:` / `https:` may navigate. Any other
 *      scheme (mailto:, file:, javascript:, data:, …) is not a browsable
 *      address — it becomes a search, never an error.
 *   3. A schemeless value is a website address when its host part is a
 *      hostname:
 *        - an IPv4 address (any port/path),
 *        - `localhost` (single label, any port/path — the one single-label
 *          host that is not a search term),
 *        - or two or more valid DNS labels whose top-level label is purely
 *          alphabetic and at least two characters long
 *          (no public single-letter TLD exists, so `a.b` stays a search).
 *      An optional `:port`, path, query or fragment may follow the host.
 *      Anything else — a single label like `exam` (an incomplete domain),
 *      whitespace anywhere, or malformed host characters — is a SEARCH
 *      QUERY, never misclassified as a hostname.
 *   4. Search queries are encoded safely (encodeURIComponent) for the
 *      configured engine (Google by default).
 *
 * This mirrors how real browsers split "navigate" from "search" while
 * staying strict: an ordinary phrase with dots and spaces ("best free
 * software", "difference between http and https") can never become a
 * hostname because whitespace and single-label inputs are rejected.
 */

export type AddressKind = 'internal' | 'url' | 'search';

export interface Address {
  kind: AddressKind;
  /** The URL to navigate to (internal page, absolute http(s) URL, or the search results URL). */
  url: string;
  /** Present when kind === 'search': the decoded query that was searched. */
  query?: string;
}

export function searchUrl(query: string, engine: string): string {
  const base =
    engine === 'duckduckgo' ? 'https://duckduckgo.com/?q='
      : engine === 'bing' ? 'https://www.bing.com/search?q='
        : 'https://www.google.com/search?q=';
  return base + encodeURIComponent(query);
}

function isLetter(ch: string): boolean {
  return /\p{L}/u.test(ch);
}

function isDigit(ch: string): boolean {
  const code = ch.charCodeAt(0);
  return code >= 48 && code <= 57;
}

/** A valid DNS label: 1-63 chars of letters (any script), digits, hyphens;
 *  no leading or trailing hyphen. */
function isDnsLabel(label: string): boolean {
  if (!label || label.length > 63) return false;
  if (label[0] === '-' || label[label.length - 1] === '-') return false;
  for (const ch of label) {
    if (ch !== '-' && !isLetter(ch) && !isDigit(ch)) return false;
  }
  return true;
}

function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every(part => part.length > 0 && part.length <= 3 && /^\d+$/.test(part) && Number(part) <= 255);
}

/** A top-level label that can be a real TLD: purely alphabetic, length >= 2. */
function isTldLabel(label: string): boolean {
  if (label.length < 2) return false;
  for (const ch of label) if (!isLetter(ch)) return false;
  return true;
}

/** True when `host` (no port/path) is a hostname the user meant to visit:
 *  an IP, localhost, or a proper multi-label DNS name. */
function looksLikeHostname(host: string): boolean {
  if (!host) return false;
  if (host.startsWith('[')) {
    // Bracketed IPv6: [::1], [2001:db8::1]
    const inner = host.slice(1, -1);
    return inner.length > 0 && inner.includes(':') && /^[0-9a-fA-F:]+$/.test(inner);
  }
  const lowered = host.toLowerCase();
  if (isIpv4(lowered)) return true;
  if (lowered === 'localhost') return true;
  const labels = lowered.split('.');
  if (labels.length < 2) return false;
  if (!labels.every(isDnsLabel)) return false;
  return isTldLabel(labels[labels.length - 1]);
}

export function classifyAddress(input: string, engine = 'google'): Address {
  const value = (input || '').trim();
  if (!value) return { kind: 'search', url: searchUrl('', engine), query: '' };
  if (value.startsWith('core://')) return { kind: 'internal', url: value };

  // Any raw whitespace means a phrase, not an address. (URL-encoded %20 is
  // fine — that is a real, valid URL character sequence.)
  if (/\s/.test(value)) return { kind: 'search', url: searchUrl(value, engine), query: value };

  // An explicit scheme wins. The scheme part is dotted-label-free: a DOT
  // before the colon means `host:port`, not a scheme (`example.com:8080`
  // must navigate, and no browsable scheme needs the dots). One more
  // disambiguation: `localhost:8080/…` (a single label followed by a
  // numeric port) is a host, not a "localhost:" scheme.
  if (/^[a-z][a-z0-9+-]*:/i.test(value)) {
    const colonAt = value.indexOf(':');
    const looksLocalhostPort =
      value.slice(0, colonAt).toLowerCase() === 'localhost' && /^\d/.test(value.slice(colonAt + 1));
    if (!looksLocalhostPort) {
      try {
        const parsed = new URL(value);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return { kind: 'url', url: parsed.href };
      } catch { /* malformed — treat as a search below */ }
      return { kind: 'search', url: searchUrl(value, engine), query: value };
    }
    // fall through: the hostname rules below handle `localhost:port[+path]`
  }

  // Schemeless: split the host from an optional :port / path / query / fragment.
  let host: string;
  if (value.startsWith('[')) {
    const close = value.indexOf(']');
    if (close < 0) return { kind: 'search', url: searchUrl(value, engine), query: value };
    host = value.slice(0, close + 1);
    const rest = value.slice(close + 1);
    if (rest && !/^[/:?#]/.test(rest)) return { kind: 'search', url: searchUrl(value, engine), query: value };
  } else {
    const cut = value.search(/[:/?#]/);
    host = cut < 0 ? value : value.slice(0, cut);
    if (cut < 0) {
      if (!looksLikeHostname(host)) return { kind: 'search', url: searchUrl(value, engine), query: value };
    } else {
      const rest = value.slice(cut);
      if (!/^[/:?#]/.test(rest) || !looksLikeHostname(host)) return { kind: 'search', url: searchUrl(value, engine), query: value };
    }
  }

  try {
    const parsed = new URL(`https://${value}`);
    if (!parsed.hostname) return { kind: 'search', url: searchUrl(value, engine), query: value };
    return { kind: 'url', url: parsed.href };
  } catch {
    // The host shape passed but the URL does not parse (bad port, etc.):
    // do not guess — search.
    return { kind: 'search', url: searchUrl(value, engine), query: value };
  }
}

/** Backwards-compatible helper: the URL to navigate to for an address bar /
 *  search box value (search terms become a search results URL). */
export function safeUrl(value: string, engine = 'google'): string {
  return classifyAddress(value, engine).url;
}
