'use strict';
/**
 * Shared process log → data/app.log (same file as Universal AI Logs tab).
 */
const fs = require('fs');
const path = require('path');

let logFile = path.join(__dirname, '..', 'data', 'app.log');

function configure(dataDir) {
  if (dataDir) {
    try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }
    logFile = path.join(dataDir, 'app.log');
  }
}

function redact(obj) {
  try {
    const s = JSON.stringify(obj || {}).replace(
      /(api[-_]?key|token|authorization|password|secret|cookie)\s*["']?\s*[:=]\s*["']?[^"',}\s]+/ig,
      '$1:"[REDACTED]"'
    );
    return JSON.parse(s);
  } catch {
    return obj || {};
  }
}

function log(level, msg, extra = {}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: String(level || 'info'),
      msg: String(msg || ''),
      ...redact(extra)
    }) + '\n';
    fs.appendFileSync(logFile, line);
    const st = fs.statSync(logFile);
    if (st.size > 400000) {
      const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').slice(-1200);
      fs.writeFileSync(logFile, lines.join('\n') + '\n');
    }
  } catch { /* never throw from logger */ }
  if (level === 'error' || level === 'warn') {
    try { console.error(`[${level}]`, msg, extra && extra.error ? extra.error : ''); } catch { /* ignore */ }
  }
}

module.exports = { configure, log };
