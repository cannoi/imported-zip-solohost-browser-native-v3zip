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

function redactString(value) {
  let out = String(value == null ? '' : value);
  // Redact sensitive URL query parameters without injecting quotes into JSON.
  out = out.replace(/([?&](?:api[-_]?key|token|access_token|refresh_token|authorization|password|secret|cookie)=)[^&#\s]*/ig, '$1[REDACTED]');
  // Also redact credentials embedded in arbitrary log text.
  out = out.replace(/\b(api[-_]?key|access_token|refresh_token|token|authorization|password|secret|cookie)\s*[:=]\s*([^\s&,'"}]+)/ig, '$1=[REDACTED]');
  return out;
}

function redact(value, key = '') {
  const sensitiveKey = /^(api[-_]?key|access_token|refresh_token|token|authorization|password|secret|cookie)$/i.test(String(key));
  if (sensitiveKey && value != null) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redact(item));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redact(v, k);
    return out;
  }
  return value;
}

function log(level, msg, extra = {}) {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level: String(level || 'info'),
      msg: redactString(msg || ''),
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

function readLogs(limit = 100) {
  try {
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-Math.min(200, limit)).map((x) => {
      try { return JSON.parse(x); } catch { return { level: 'raw', msg: x }; }
    }).filter((l) => l && l.level !== 'debug');
  } catch {
    return [];
  }
}

module.exports = { configure, log, readLogs, redact };
