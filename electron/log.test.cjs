'use strict';

// ---------------------------------------------------------------------------
// Field-diagnostics logger (electron/log.cjs).
//
// The user reports come from machines we cannot attach to; this file is how
// the main process tells us what happened. The contract under test:
//   * every level writes a timestamped line,
//   * errors carry their stack,
//   * the file is bounded (rotation keeps the NEWEST tail),
//   * logging NEVER throws (a logging fault must not take down the app).
// ---------------------------------------------------------------------------

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAppLogger } = require('./log.cjs');

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-log-'));
  return path.join(dir, 'chromiumcore.log');
}

test('writes timestamped lines for every level', () => {
  const file = tmpFile();
  const log = createAppLogger(file);
  log.info('hello');
  log.warn('careful');
  log.error('bad');
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 3);
  assert.ok(/^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] INFO hello$/.test(lines[0]), lines[0]);
  assert.ok(/^\[.*\] WARN careful$/.test(lines[1]), lines[1]);
  assert.ok(/^\[.*\] ERROR bad$/.test(lines[2]), lines[2]);
});

test('errors carry their stack; structured events are JSON', () => {
  const file = tmpFile();
  const log = createAppLogger(file);
  const err = new Error('boom');
  err.stack = 'Error: boom\n    at somewhere';
  log.error('UNCAUGHT EXCEPTION (app kept alive):', err);
  log.event('link-message', { t: 'dialog', url: 'https://x.test/a' });
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.includes('at somewhere'), 'the stack is logged');
  assert.ok(text.includes('EVENT link-message {"t":"dialog","url":"https://x.test/a"}'), 'the event is structured');
});

test('rotation keeps the newest tail when the file passes the cap', () => {
  const file = tmpFile();
  const log = createAppLogger(file);
  // The cap is 1.5 MiB; the newest 768 KiB survives rotation. Fill past
  // the cap with numbered lines, then append a marker and check ordering.
  const line = `INFO ${'x'.repeat(200)}\n`;
  const chunks = [];
  for (let i = 0; i < 12000; i += 1) chunks.push(line);
  fs.writeFileSync(file, chunks.join(''));
  // Re-create the logger on the existing file so it sees the size.
  const log2 = createAppLogger(file);
  log2.info('MARKER-LAST-LINE');
  const text = fs.readFileSync(file, 'utf8');
  assert.ok(text.endsWith('MARKER-LAST-LINE\n'), 'the newest line is intact');
  assert.ok(text.includes('MARKER-LAST-LINE'));
  // Rotation happened (the file is back under the cap + one write).
  assert.ok(fs.statSync(file).size < 1.6 * 1024 * 1024, `file is bounded, got ${fs.statSync(file).size} bytes`);
});

test('logging never throws, even when the file path is unwritable', () => {
  // A directory path is a guaranteed write failure on every platform; the
  // logger must swallow it (logging must never break the app).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-log-'));
  const log = createAppLogger(dir); // "file" is a directory: every write fails
  assert.doesNotThrow(() => {
    log.info('should not throw');
    log.error('also should not throw', new Error('stacked'));
    log.event('x', { a: 1 });
  });
});
