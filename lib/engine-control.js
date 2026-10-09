'use strict';

/**
 * Control layer between the WebSocket/REST gateway and the Chromium engine.
 * (Replaces lib/webkit-control.js.) Validates every navigation against the
 * navigation + security policy before it reaches the engine.
 */

const engine = require('./chromium-engine');
const { validateNavigation } = require('./navigation-policy');
const { ExtractorError } = require('./content-extractor');

let meta = { url: '', title: '', lastError: null };

// Pointer/keyboard/viewport events belong to the old pixel-stream display and have no target now.
const PASSIVE = new Set(['resize', 'mouse', 'key', 'wheel']);

async function handle(msg = {}) {
  const type = String(msg.type || '');
  if (PASSIVE.has(type)) return { ok: true, engine: 'chromium', url: meta.url, title: meta.title };
  const next = { ...msg };
  if (type === 'create' || type === 'navigate') next.url = validateNavigation(msg.url || meta.url || 'about:blank');
  try {
    const out = await engine.handle(next);
    meta.url = out.url || meta.url;
    meta.title = out.title || meta.title;
    meta.lastError = null;
    return out;
  } catch (err) {
    meta.lastError = err.message;
    throw err;
  }
}

/** Validated one-shot extraction that does not touch any tab. */
async function extract(url, opts = {}) {
  let safe;
  try { safe = validateNavigation(String(url || '').trim()); }
  catch (err) { throw new ExtractorError(/private-network|restricted/i.test(err.message) ? 'BLOCKED' : 'INVALID_URL', err.message); }
  return engine.extract(safe, opts);
}

async function probe(url) {
  // Uses a one-shot extraction so diagnostics never hijack the user's active tab.
  try {
    const out = await extract(url || 'https://example.com/', { settleMs: 0 });
    return { ok: true, url: out.final_url, error: null };
  } catch (err) {
    meta.lastError = err.message;
    return { ok: false, url: meta.url, error: err.message };
  }
}

function snapshot() { return { ...meta, ...engine.snapshot() }; }

module.exports = { handle, extract, snapshot, probe, attach: async () => engine.start() };
