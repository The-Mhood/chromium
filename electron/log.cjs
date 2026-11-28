'use strict';

// ---------------------------------------------------------------------------
// Field diagnostics for the desktop app.
//
// The user reports come from machines we cannot attach to: "the address bar
// does nothing on Windows", "double click does nothing on the Mac", "the
// page never scrolls to the dialog's Accept button". None of that is
// reproducible from the test suite (which stubs Electron), and a packaged
// app's stdout goes nowhere. So the main process keeps ONE small log file
// (userData/chromiumcore.log) with every decision that matters:
//
//   * uncaught exceptions / unhandled rejections (the Windows crash dialog),
//   * console.log/warn/error from the main process ([popup], [fullscreen] …),
//   * CDP attach / script-install state (the double-click channel's health),
//   * link messages received or dropped (with the drop reason),
//   * the link dialog's lifecycle (create / show / blur / close — the
//     "dialog never appears" race),
//   * popup decisions (already console-logged via logPopup).
//
// The file is capped (rotated once past the limit, keeping the newest half)
// and every write is fire-and-forget: logging must never slow the UI or
// throw. The user is asked to send this file when something misbehaves —
// it is the difference between "works in tests, dead in the field" and a
// one-line answer.
// ---------------------------------------------------------------------------

const MAX_BYTES = 1.5 * 1024 * 1024; // rotate past this
const KEEP_BYTES = 768 * 1024;       // keep the newest this much after rotation

function createAppLogger(logFile) {
  let size = 0;
  try { size = require('fs').statSync(logFile).size; } catch { /* first run */ }

  const write = (line) => {
    try {
      const fs = require('fs');
      const text = line.endsWith('\n') ? line : line + '\n';
      if (size + text.length > MAX_BYTES) {
        // Keep the newest tail (the interesting part is recent).
        let tail = '';
        try {
          const data = fs.readFileSync(logFile);
          tail = data.subarray(Math.max(0, data.length - KEEP_BYTES)).toString('utf8');
          if (tail && !tail.startsWith('\n')) tail = tail.slice(tail.indexOf('\n') + 1);
          size = tail.length;
        } catch { size = 0; }
        fs.writeFileSync(logFile, tail + text);
        size += text.length;
        return;
      }
      fs.appendFileSync(logFile, text);
      size += text.length;
    } catch { /* logging must never break the app */ }
  };

  const stamp = () => new Date().toISOString();

  const log = (level, ...args) => {
    let body;
    try {
      body = args.map(a => (a instanceof Error ? (a.stack || a.message) : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    } catch { body = String(args[0] || ''); }
    write(`[${stamp()}] ${level} ${body}`);
  };

  return {
    info: (...args) => log('INFO', ...args),
    warn: (...args) => log('WARN', ...args),
    error: (...args) => log('ERROR', ...args),
    /** One line for a structured event: log.event('link-message', {…}). */
    event: (name, details) => log('EVENT', name, details === undefined ? '' : JSON.stringify(details)),
    logFile,
  };
}

module.exports = { createAppLogger };
