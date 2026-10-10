'use strict';

/**
 * SoloHost Browser — static WebView shell + frame proxy + Universal AI/Feedback.
 */

try { require('dotenv').config(); } catch { /* optional */ }

const path = require('path');
const fs = require('fs');
const http = require('http');
const express = require('express');

let cors = null;
try { cors = require('cors'); } catch { /* optional */ }

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const appLog = require('./lib/app-log');
const engineCaps = require('./lib/engine/capabilities');
const { webkitManager, installShutdownHooks } = require('./lib/engine/webkit-manager');
const domBridge = require('./lib/engine/dom-bridge');
const aiCompat = require('./lib/ai-compat');
installShutdownHooks();
appLog.configure(DATA_DIR);
const PKG = (() => {
  try { return require('./package.json'); } catch { return { version: '9.0.8' }; }
})();

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
// Baseline browser-facing hardening; CSP is intentionally not forced because the existing
// AI/Feedback panels use inline bootstrapping and remote sites are rendered through the proxy.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  if (req.path.startsWith('/api/')) res.setHeader('Cache-Control', 'no-store');
  next();
});
// Same-origin style CORS only (no open *). SoloHost UI and API share origin.
if (cors) {
  app.use(cors({
    origin: false, // reflect disabled — browser same-origin needs no CORS
    credentials: false
  }));
}
app.use(express.json({ limit: '1mb' }));
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

function healthPayload() {
  return {
    status: 'ok',
    ok: true,
    service: 'solohost-browser',
    version: PKG.version || '9.0.8',
    mode: 'hybrid-proxy',
    engine: engineCaps.detect(),
    port: PORT,
    timestamp: new Date().toISOString()
  };
}

// Quick search redirect (no JS required) — Google/YouTube shell forms
app.get('/api/browser/go', (req, res) => {
  try {
    const engine = String(req.query.engine || 'google').toLowerCase();
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).type('html').send('<p>Missing q</p>');
    let target;
    if (engine === 'youtube') {
      target = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
    } else {
      target = 'https://www.google.com/search?gbv=1&hl=en&q=' + encodeURIComponent(q);
    }
    const dest = '/api/proxy?url=' + encodeURIComponent(target);
    res.redirect(302, dest);
  } catch (e) {
    res.status(500).type('html').send('<p>Search error</p>');
  }
});


app.get('/api/browser/diagnose', (_req, res) => {
  try {
    const appLog = require('./lib/app-log');
    const { analyzeLogs } = require('./lib/app-adapter');
    const logs = appLog.readLogs(100);
    res.json({ ok: true, ...analyzeLogs(logs) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});


function requireEngineEnabled(req, res, next) {
  if (process.env.SOLOHOST_WEBKIT_BRIDGE !== '1') {
    return res.status(403).json({ ok: false, error: 'engine_disabled', hint: 'Set SOLOHOST_WEBKIT_BRIDGE=1 to enable' });
  }
  const need = process.env.SOLOHOST_ENGINE_TOKEN;
  if (need) {
    const got = req.get('x-engine-token') || '';
    if (got !== need) return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
}

app.get('/api/engine/status', async (_req, res) => {
  try {
    const base = engineCaps.detect();
    const wk = await webkitManager.status();
    res.json({
      ok: true,
      ...base,
      webkitWorker: wk,
      mode: (wk && wk.ready) ? 'webkit-worker+proxy-fallback' : base.mode
    });
  } catch (e) {
    res.json({ ok: true, ...engineCaps.detect(), webkitWorker: { ready: false, error: String(e.message || e) } });
  }
});

app.post('/api/engine/session', requireEngineEnabled, async (req, res) => {
  try {
    const out = await webkitManager.createSession();
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(503).json({ ok: false, error: String(e.message || e), fallback: 'proxy' });
  }
});

app.post('/api/engine/session/:id/navigate', requireEngineEnabled, async (req, res) => {
  try {
    const url = String((req.body && req.body.url) || req.query.url || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    // SSRF guard: reuse proxy assert when possible
    try {
      const { assertPublicHttpUrl } = require('./lib/frame-proxy');
      if (url !== 'about:blank') await assertPublicHttpUrl(url);
    } catch (se) {
      return res.status(403).json({ ok: false, error: se.message || 'blocked', code: se.code });
    }
    const out = await webkitManager.navigate(req.params.id, url);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e), fallback: 'proxy' });
  }
});

app.get('/api/engine/session/:id', requireEngineEnabled, async (req, res) => {
  try {
    const out = await webkitManager.getState(req.params.id);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(404).json({ ok: false, error: String(e.message || e) });
  }
});

app.delete('/api/engine/session/:id', requireEngineEnabled, async (req, res) => {
  try {
    const out = await webkitManager.closeSession(req.params.id);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/health', (_req, res) => res.status(200).json(healthPayload()));
app.get('/health', (_req, res) => res.status(200).json(healthPayload()));
app.get('/ready', (_req, res) => res.status(200).json({ ready: true, ok: true }));
app.get('/api/ready', (_req, res) => res.status(200).json({ ready: true, ok: true }));

// Client-side diagnostic logs (shown in AI Logs tab via shared app.log)
app.post('/api/logs/client', (req, res) => {
  try {
    const body = req.body || {};
    const level = String(body.level || 'info');
    const msg = String(body.msg || body.message || 'client');
    appLog.log(level, 'client.' + msg, {
      url: body.url ? String(body.url).slice(0, 300) : undefined,
      error: body.error ? String(body.error).slice(0, 400) : undefined,
      detail: body.detail ? String(body.detail).slice(0, 400) : undefined
    });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false });
  }
});

// Frame proxy
try {
  const { handleProxy } = require('./lib/frame-proxy');
  app.get('/api/proxy', (req, res) => { handleProxy(req, res); });
  app.get('/proxy', (req, res) => { handleProxy(req, res); });
} catch (err) {
  console.error('[warn] frame-proxy:', err.message);
}

// Universal AI
const adapter = require('./lib/app-adapter');
const { createAIService } = require('./lib/ai-module/ai-service');
const { mountAIRoutes } = require('./lib/ai-module/routes');
const ai = createAIService({
  dataDir: DATA_DIR,
  appName: 'SoloHost Browser',
  adapter
});
mountAIRoutes(app, ai);

// Optional AI compatibility assist (never required for browsing)
app.post('/api/browser/ai-compat', async (req, res) => {
  try {
    const body = req.body || {};
    const out = await aiCompat.analyze(ai, body);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(200).json({
      ok: true,
      summary: 'AI assist unavailable',
      category: 'unknown',
      suggestions: ['Try Reload or Open ↗'],
      recommendedMode: 'UNCHANGED',
      confidence: 0,
      source: 'error_fallback'
    });
  }
});


// Universal Feedback — hub credentials default inside feedback-service.js
const { createFeedbackService, mountFeedbackRoutes } = require('./lib/feedback-module/feedback-service');
const fbOpts = {
  appId: process.env.SHFH_APP_ID || 'solohost-browser',
  appName: 'SoloHost Browser',
  version: PKG.version || '9.0.8'
};
if (process.env.SHFH_HUB_ID) fbOpts.hubId = process.env.SHFH_HUB_ID;
if (process.env.SHFH_HUB_URL) fbOpts.baseUrl = process.env.SHFH_HUB_URL;
if (process.env.SHFH_INGEST_TOKEN) fbOpts.ingestToken = process.env.SHFH_INGEST_TOKEN;
const fb = createFeedbackService(fbOpts);
mountFeedbackRoutes(app, fb);

// Lightweight persistent browser library: history and bookmarks (JSON fallback, optional SQLite).
const browserStore = require('./lib/store');

// —— Interactive DOM Bridge (versioned browser sessions) ——
app.post('/api/browser/sessions', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'anon';
    if (!domBridge.rateOk('create:' + ip)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    const out = await domBridge.createSession({ clientKey: ip });
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

app.post('/api/browser/sessions/:id/navigate', async (req, res) => {
  try {
    const tok = req.get('x-session-token') || (req.body && req.body.token) || '';
    const session = domBridge.authSession(req.params.id, tok);
    if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const ip = req.ip || 'anon';
    if (!domBridge.rateOk('nav:' + ip)) return res.status(429).json({ ok: false, error: 'rate_limited' });
    const url = String((req.body && req.body.url) || '').trim();
    if (!url) return res.status(400).json({ ok: false, error: 'url required' });
    try {
      const { assertPublicHttpUrl } = require('./lib/frame-proxy');
      if (!url.startsWith('about:')) await assertPublicHttpUrl(url);
    } catch (se) {
      return res.status(403).json({ ok: false, error: se.message || 'blocked', code: se.code });
    }
    const out = await domBridge.navigate(session, url);
    res.json({ ok: true, ...out });
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

app.get('/api/browser/sessions/:id/state', (req, res) => {
  const tok = req.get('x-session-token') || req.query.token || '';
  const session = domBridge.authSession(req.params.id, tok);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });
  res.json({ ok: true, ...domBridge.publicState(session, true) });
});

app.get('/api/browser/sessions/:id/content', (req, res) => {
  const tok = req.get('x-session-token') || req.query.token || '';
  const session = domBridge.authSession(req.params.id, tok);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });
  const c = domBridge.getContent(session);
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.json({ ok: true, ...c });
});

/** HTML document for iframe src (token required). Origin is SoloHost app — site JS stripped. */
app.get('/api/browser/sessions/:id/view', (req, res) => {
  const tok = req.get('x-session-token') || req.query.token || '';
  const session = domBridge.authSession(req.params.id, tok);
  if (!session) return res.status(401).type('html').send('<!doctype html><p>Unauthorized</p>');
  const html = session.html || '<!doctype html><p>Empty</p>';
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https: http:; font-src https: http: data:; media-src https: http:; frame-src 'none'; script-src 'none'; base-uri 'self'");
  res.send(html);
});

app.post('/api/browser/sessions/:id/events', async (req, res) => {
  try {
    const tok = req.get('x-session-token') || (req.body && req.body.token) || '';
    const session = domBridge.authSession(req.params.id, tok);
    if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });
    const ip = req.ip || 'anon';
    if (!domBridge.rateOk('ev:' + session.id)) return res.status(429).json({ ok: false, error: 'rate_limited' });
    const event = req.body || {};
    if (!event.type) return res.status(400).json({ ok: false, error: 'type required' });
    const out = await domBridge.dispatchEvent(session, event);
    res.json(out);
  } catch (e) {
    res.status(502).json({ ok: false, error: String(e.message || e) });
  }
});

app.delete('/api/browser/sessions/:id', async (req, res) => {
  const tok = req.get('x-session-token') || req.query.token || '';
  const session = domBridge.authSession(req.params.id, tok);
  if (!session) return res.status(401).json({ ok: false, error: 'unauthorized' });
  await domBridge.destroySession(session.id);
  res.json({ ok: true, closed: true });
});


app.get('/api/browser/history', async (_req, res, next) => {
  try { res.json({ ok: true, items: await browserStore.listHistory() }); } catch (e) { next(e); }
});
app.post('/api/browser/history', async (req, res, next) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    const title = String((req.body && req.body.title) || url).slice(0, 300);
    if (!/^https?:\/\//i.test(url) || url.length > 4096) return res.status(400).json({ ok: false, error: 'Invalid URL' });
    await browserStore.addHistory(title || url, url);
    res.json({ ok: true });
  } catch (e) { next(e); }
});
app.delete('/api/browser/history', async (_req, res, next) => {
  try { await browserStore.clearHistory(); res.json({ ok: true }); } catch (e) { next(e); }
});
app.get('/api/browser/bookmarks', async (_req, res, next) => {
  try { res.json({ ok: true, items: await browserStore.listBookmarks() }); } catch (e) { next(e); }
});
app.post('/api/browser/bookmarks', async (req, res, next) => {
  try {
    const url = String((req.body && req.body.url) || '').trim();
    const title = String((req.body && req.body.title) || url).slice(0, 300);
    if (!/^https?:\/\//i.test(url) || url.length > 4096) return res.status(400).json({ ok: false, error: 'Invalid URL' });
    res.json({ ok: true, item: await browserStore.addBookmark(title || url, url) });
  } catch (e) { next(e); }
});
app.delete('/api/browser/bookmarks/:id', async (req, res, next) => {
  try { await browserStore.removeBookmark(req.params.id); res.json({ ok: true }); } catch (e) { next(e); }
});

// Legacy parse stub
app.get('/api/browser/parse', (req, res) => {
  const url = String((req.query && req.query.url) || '').trim();
  res.json({
    success: true,
    mode: 'WEBVIEW',
    url,
    data: { client_side: true, proxy: true }
  });
});

app.use(express.static(PUBLIC_DIR, { index: 'index.html', fallthrough: true, maxAge: 0 }));
app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => { if (err) next(); });
  }
  return next();
});
app.use((err, _req, res, _next) => {
  console.error('[error]', err && err.message ? err.message : err);
  res.status(500).json({ success: false, error: String((err && err.message) || err) });
});

const server = http.createServer(app);
server.listen(PORT, HOST, () => {
  console.log(`SoloHost Browser v${PKG.version} listening on http://${HOST}:${PORT}`);
  appLog.log('info', 'server.listen', { host: HOST, port: PORT, version: PKG.version });
});
server.on('error', (err) => {
  console.error('Server listen error:', err);
  process.exit(1);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
