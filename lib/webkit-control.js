'use strict';

const engine = require('./webkit-engine-manager');
const { validateNavigation } = require('./navigation-policy');
let meta = { url: '', title: '', lastError: null };

async function handle(msg) {
  const type = String(msg.type || '');
  if (type === 'resize' || type === 'activate' || type === 'mouse' || type === 'key' || type === 'wheel') {
    // Input is delivered directly to the X11 surface by VNC/noVNC.
    return { ok: true, engine: 'webkit', url: meta.url, title: meta.title };
  }
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

async function probe(url) {
  try {
    const out = await handle({ type: 'navigate', url: url || 'https://example.com/' });
    return { ok: true, url: out.url, error: null };
  } catch (err) {
    meta.lastError = err.message;
    return { ok: false, url: meta.url, error: err.message };
  }
}

function snapshot() { return { ...meta, ...engine.snapshot() }; }
module.exports = { handle, snapshot, probe, attach: async () => engine.start() };
