'use strict';

/**
 * SoloHost Browser API Gateway (Phase 2/3).
 * Structured JSON for the Native Reader client — no pixel streaming.
 */

const engine = require('./lib/engine-adapter');
const engineControl = require('./lib/engine-control');
const { ContentExtractor, ExtractorError } = require('./lib/content-extractor');

const EXTRACT_TIMEOUT_MS = Math.max(5000, Math.min(30000, Number(process.env.SOLOHOST_NAV_TIMEOUT_MS || 30000)));

let sharedExtractor = null;

function getExtractor() {
  if (!sharedExtractor) {
    sharedExtractor = new ContentExtractor({ timeoutMs: EXTRACT_TIMEOUT_MS });
  }
  return sharedExtractor;
}

function mapMedia(list) {
  const videos = [];
  const images = [];
  for (const item of list || []) {
    if (!item || !item.url) continue;
    if (item.type === 'm3u8') videos.push({ type: 'hls', src: item.url });
    else if (item.type === 'mp4') videos.push({ type: 'mp4', src: item.url });
    else if (item.type === 'image' || /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(item.url)) {
      images.push({ src: item.url, type: item.type || 'image' });
    }
  }
  return { videos, images };
}

function toParseSchema(raw) {
  const media = mapMedia(raw.media);
  return {
    success: true,
    url: raw.final_url || raw.url,
    metadata: {
      title: raw.title || '',
      byline: raw.author || '',
      siteName: raw.site_name || '',
      favicon: raw.favicon || '',
      publishedAt: raw.published_at || null,
      lang: raw.lang || null
    },
    content: {
      clean_html: raw.clean_html || '',
      raw_text: raw.raw_text || '',
      reading_time_minutes: Number(raw.reading_minutes) || 0,
      excerpt: raw.excerpt || '',
      word_count: Number(raw.word_count) || 0,
      readable: !!raw.readable
    },
    media,
    diagnostics: {
      http_status: raw.http_status || null,
      content_type: raw.content_type || null,
      kind: raw.kind || 'html',
      duration_ms: raw.duration_ms || null,
      truncated: !!raw.truncated,
      extracted_at: raw.extracted_at || null
    }
  };
}

function errorPayload(err, url) {
  return {
    success: false,
    url: url || null,
    error: String((err && err.message) || err || 'Extract failed'),
    code: (err && err.code) || 'EXTRACT_FAILED'
  };
}

function isValidHttpUrl(value) {
  try {
    const u = new URL(String(value || '').trim());
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * Parse URL → structured article. Never throws to callers that use safeParse;
 * parseUrl still throws for Express status mapping but always with code.
 */
async function parseUrl(url, options = {}) {
  const target = String(url || '').trim();
  if (!target) {
    const err = new Error('url required');
    err.code = 'INVALID_URL';
    err.httpStatus = 400;
    throw err;
  }
  if (!isValidHttpUrl(target)) {
    const err = new Error('Only http/https URLs are supported');
    err.code = 'INVALID_URL';
    err.httpStatus = 400;
    throw err;
  }
  try {
    const raw = await getExtractor().extract(target, {
      ...options,
      timeoutMs: Math.min(EXTRACT_TIMEOUT_MS, options.timeoutMs || EXTRACT_TIMEOUT_MS)
    });
    return toParseSchema(raw);
  } catch (err) {
    if (err instanceof ExtractorError || err.code) {
      const e = new Error(err.message);
      e.code = err.code || 'EXTRACT_FAILED';
      e.httpStatus = err.httpStatus || undefined;
      throw e;
    }
    const e = new Error(String(err.message || err));
    e.code = 'EXTRACT_FAILED';
    throw e;
  }
}

async function safeParse(url, options = {}) {
  try {
    return await parseUrl(url, options);
  } catch (err) {
    return errorPayload(err, url);
  }
}

async function chromiumHealth() {
  const snap = engine.snapshot();
  let extractorReady = false;
  let chromiumPath = null;
  let error = null;
  try {
    await engine.start();
    extractorReady = true;
    try {
      const pw = require('playwright-core');
      chromiumPath = pw.chromium.executablePath();
    } catch (e) {
      error = e.message;
    }
  } catch (e) {
    error = e.message;
  }
  const ok = snap.status === 'ready' || snap.status === 'degraded' || extractorReady;
  return {
    status: ok ? 'ok' : 'degraded',
    service: 'solohost-browser',
    engine: {
      name: 'chromium',
      mode: 'headless-extract',
      status: snap.status || (ok ? 'ready' : 'not_ready'),
      ready: ok,
      path: chromiumPath,
      error: error || snap.error || null,
      tabs: snap.tabs || [],
      restarts: snap.restarts || 0,
      extractTimeoutMs: EXTRACT_TIMEOUT_MS
    },
    gateway: 'json-api',
    pixelStream: false,
    websocketFrames: false,
    timestamp: new Date().toISOString()
  };
}

function install(server) {
  let WebSocket;
  try { WebSocket = require('ws'); } catch { return; }
  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p !== '/ws') {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const snap = engine.snapshot();
      ws.send(JSON.stringify({
        type: 'gateway',
        ready: snap.status === 'ready' || snap.status === 'degraded',
        engine: 'chromium',
        mode: 'json-api',
        display: 'none'
      }));
      ws.on('message', async (data) => {
        let msg = {};
        try { msg = JSON.parse(String(data)); } catch { return; }
        if (msg.type === 'mouse' || msg.type === 'key' || msg.type === 'wheel' || msg.type === 'frame') return;
        try {
          const out = await engineControl.handle(msg);
          if (out && out.url) {
            ws.send(JSON.stringify({ type: 'tab', event: 'state', id: msg.id, url: out.url, title: out.title || '' }));
          }
          if (out && out.state) {
            ws.send(JSON.stringify({ type: 'browser-state', state: out.state }));
          }
        } catch (err) {
          const fatal = msg.type === 'create' || msg.type === 'navigate';
          ws.send(JSON.stringify({ type: fatal ? 'error' : 'warn', layer: 'engine', error: err.message }));
        }
      });
    });
  });
}

function status() {
  const s = engine.snapshot();
  return {
    running: s.status === 'ready' || s.status === 'degraded',
    core: s.status === 'ready',
    engine: s.engine || 'chromium',
    display: 'none',
    mode: 'json-api',
    ...s
  };
}

function pageSnapshot() {
  return engineControl.snapshot();
}

async function navigate(url) {
  return engineControl.handle({ type: 'navigate', url });
}

module.exports = {
  install,
  status,
  pageSnapshot,
  navigate,
  parseUrl,
  safeParse,
  chromiumHealth,
  toParseSchema,
  errorPayload,
  isValidHttpUrl,
  EXTRACT_TIMEOUT_MS,
  startCore: () => engine.start()
};
