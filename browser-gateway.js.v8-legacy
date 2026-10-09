'use strict';

/**
 * SoloHost Browser API Gateway (Phase 2/3).
 * Structured JSON for the Native Reader client — no pixel streaming.
 */

const engine = require('./lib/engine-adapter');
const engineControl = require('./lib/engine-control');
const { ExtractorError } = require('./lib/content-extractor');

const EXTRACT_TIMEOUT_MS = Math.max(5000, Math.min(30000, Number(process.env.SOLOHOST_NAV_TIMEOUT_MS || 30000)));

/**
 * v8.5: the gateway no longer owns a private ContentExtractor. It goes through engine-control →
 * chromium-engine, so /api/browser/parse, /api/extract and the tab UI share ONE Chromium process
 * and ONE LRU result cache (20 min TTL).
 */

function mapMedia(list) {
  const videos = [];
  for (const item of list || []) {
    if (!item || !item.url) continue;
    if (item.type === 'm3u8') videos.push({ type: 'hls', src: item.url });
    else if (item.type === 'mp4') videos.push({ type: 'mp4', src: item.url });
  }
  return { videos };
}

/**
 * Normalised response for GET /api/browser/parse.
 *
 *   { success, mode, url, cached, metadata{title,byline,siteName}, content{clean_html,raw_text,
 *     reading_time_min}, media{videos[]} }
 *
 * Extra fields (lang, data, diagnostics, challenge, metadata.favicon/publishedAt and the legacy
 * content.reading_time_minutes) are kept so the existing Reader UI keeps working.
 */
function toParseSchema(raw) {
  const mode = String(raw.mode || (raw.kind === 'embed' ? 'EMBED' : raw.kind === 'webview' ? 'WEBVIEW' : 'READER')).toUpperCase();
  const media = mapMedia(raw.media);
  const readingMin = Number(raw.reading_minutes) || 0;
  const base = {
    success: true,
    mode,
    url: raw.final_url || raw.url,
    cached: !!raw.cached,
    auth_required: !!raw.auth_required,
    metadata: {
      title: raw.title || '',
      byline: raw.author || '',
      siteName: raw.site_name || '',
      favicon: raw.favicon || '',
      publishedAt: raw.published_at || null
    },
    content: {
      clean_html: raw.clean_html || '',
      raw_text: raw.raw_text || '',
      reading_time_min: readingMin,
      // legacy aliases for older Reader clients
      reading_time_minutes: readingMin,
      excerpt: raw.excerpt || '',
      word_count: Number(raw.word_count) || 0,
      readable: !!raw.readable
    },
    media,
    lang: raw.lang || 'en',
    data: {},
    diagnostics: {
      http_status: raw.http_status || null,
      content_type: raw.content_type || null,
      kind: raw.kind || mode.toLowerCase(),
      duration_ms: raw.duration_ms || null,
      truncated: !!raw.truncated,
      extracted_at: raw.extracted_at || null,
      challenge: raw.challenge || null,
      used_fallback: !!raw.used_fallback,
      intent_reason: raw.intent_reason || null,
      tier: raw.tier || null,
      extraction_method: raw.extraction_method || null,
      timing: raw.timing || null,
      geo: raw.geo || null
    },
    challenge: raw.challenge || null
  };

  if (mode === 'EMBED') {
    base.data = {
      embed_url: raw.embed_url || '',
      platform: raw.platform || '',
      videoId: raw.videoId || null
    };
  } else if (mode === 'WEBVIEW') {
    base.data = {
      webview_required: true,
      auth_required: true,
      reason: raw.intent_reason || 'LOGIN_OR_COMPLEX_APP'
    };
  } else {
    base.data = {
      clean_html: raw.clean_html || '',
      raw_text: raw.raw_text || '',
      reading_time_min: readingMin
    };
  }
  return base;
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
 * options.noCache bypasses the 20-minute LRU cache (used by ?refresh=1).
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
    const raw = await engineControl.extract(target, {
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
