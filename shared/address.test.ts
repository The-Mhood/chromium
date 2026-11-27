import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyAddress, safeUrl, searchUrl } from './address.ts';

test('internal core:// pages pass through untouched', () => {
  assert.deepEqual(classifyAddress('core://protection'), { kind: 'internal', url: 'core://protection' });
  assert.deepEqual(classifyAddress('  core://newtab  '), { kind: 'internal', url: 'core://newtab' });
});

test('valid URLs navigate normally (explicit and implied scheme)', () => {
  assert.equal(classifyAddress('https://youtube.com/watch?v=abc').url, 'https://youtube.com/watch?v=abc');
  assert.equal(classifyAddress('http://example.com').url, 'http://example.com/');
  assert.equal(classifyAddress('youtube.com').url, 'https://youtube.com/');
  assert.equal(classifyAddress('www.youtube.com').url, 'https://www.youtube.com/');
  assert.equal(classifyAddress('example.com/path?q=1#frag').url, 'https://example.com/path?q=1#frag');
  assert.equal(classifyAddress('example.com:8080/app').url, 'https://example.com:8080/app');
  assert.equal(classifyAddress('sub.example.co.uk/x').url, 'https://sub.example.co.uk/x');
  // URLs keep their query/fragment intact; only the search-QUERY path encodes.
  assert.equal(classifyAddress('example.com/a?b=c').url, 'https://example.com/a?b=c');
});

test('IP addresses and localhost navigate', () => {
  assert.equal(classifyAddress('192.168.1.1').url, 'https://192.168.1.1/');
  assert.equal(classifyAddress('10.0.0.42:8443/x').url, 'https://10.0.0.42:8443/x');
  assert.equal(classifyAddress('localhost').url, 'https://localhost/');
  assert.equal(classifyAddress('localhost:5173/foo').url, 'https://localhost:5173/foo');
  assert.equal(classifyAddress('[::1]:3000').url, 'https://[::1]:3000/');
});

test('plain search queries become Google searches, safely encoded', () => {
  const a = classifyAddress('best free software');
  assert.equal(a.kind, 'search');
  assert.equal(a.query, 'best free software');
  assert.equal(a.url, 'https://www.google.com/search?q=best%20free%20software');
  // Special characters are encoded, never injected into the URL.
  assert.equal(classifyAddress('what is &c++? <test>').url, 'https://www.google.com/search?q=what%20is%20%26c%2B%2B%3F%20%3Ctest%3E');
  assert.equal(safeUrl('best free software'), searchUrl('best free software', 'google'));
});

test('queries with dots and spaces are NOT misclassified as hostnames', () => {
  assert.equal(classifyAddress('difference between http and https').kind, 'search');
  assert.equal(classifyAddress('node.js and deno performance').kind, 'search');
  assert.equal(classifyAddress('exam').kind, 'search', 'an incomplete domain (no TLD) is a search');
  assert.equal(classifyAddress('a.b').kind, 'search', 'a one-letter TLD does not exist');
  assert.equal(classifyAddress('exam.123').kind, 'search', 'a numeric TLD is not a hostname');
  assert.equal(classifyAddress('example .com').kind, 'search', 'whitespace anywhere kills the hostname shape');
  assert.equal(classifyAddress('  ').kind, 'search');
});

test('single labels: only localhost is a hostname', () => {
  assert.equal(classifyAddress('localhost').kind, 'url');
  assert.equal(classifyAddress('example').kind, 'search');
  assert.equal(classifyAddress('youtube').kind, 'search');
  assert.equal(classifyAddress('192.168.1.1').kind, 'url');
});

test('malformed hosts and ports fall back to search, not navigation', () => {
  assert.equal(classifyAddress('example.com:abc').kind, 'search', 'a non-numeric port is not a URL');
  assert.equal(classifyAddress('-bad.com').kind, 'search', 'a leading hyphen is not a DNS label');
  assert.equal(classifyAddress('bad-.com').kind, 'search', 'a trailing hyphen is not a DNS label');
  assert.equal(classifyAddress('example..com').kind, 'search', 'an empty label is not a DNS name');
});

test('other schemes never navigate; they become searches', () => {
  assert.equal(classifyAddress('javascript:alert(1)').kind, 'search');
  assert.equal(classifyAddress('file:///etc/passwd').kind, 'search');
  assert.equal(classifyAddress('mailto:foo@example.com').kind, 'search');
  assert.equal(classifyAddress('data:text/html,<b>x</b>').kind, 'search');
  assert.equal(classifyAddress('intent://install#Intent;action=ad;end').kind, 'search');
});

test('unicode (IDN) hostnames are accepted', () => {
  const a = classifyAddress('münchen.de');
  assert.equal(a.kind, 'url');
  assert.ok(a.url.startsWith('https://'));
});

test('the configured search engine is used (Google default, DuckDuckGo/Bing alternatives)', () => {
  assert.equal(classifyAddress('quiet internet', 'duckduckgo').url, 'https://duckduckgo.com/?q=quiet%20internet');
  assert.equal(classifyAddress('quiet internet', 'bing').url, 'https://www.bing.com/search?q=quiet%20internet');
  assert.equal(classifyAddress('quiet internet').url.includes('google.com/search?q='), true);
});
