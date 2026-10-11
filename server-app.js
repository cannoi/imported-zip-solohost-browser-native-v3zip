'use strict';

module.exports.mount = function mount(app, server, ctx) {
/* mount-guard */
try {
const express = require('express');
const path = require('path');
const fs = require('fs');
const http = require('http');

try { require('dotenv').config(); } catch (e) { /* optional */ }

const PORT = (ctx && ctx.PORT) || Number(process.env.PORT || 8080);
const HOST = (ctx && ctx.HOST) || process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

let cors = null;
try { cors = require('cors'); } catch { /* optional */ }

function softRequire(label, path, fallback) {
  try { return require(path); } catch (e) {
    console.error('[warn] softRequire ' + label + ':', e && e.message);
    return fallback;
  }
}

const appLog = softRequire('app-log', './lib/app-log', {
  configure() {},
  log() {},
  readLogs() { return []; },
  clearLogs() {}
});
const engineCaps = softRequire('capabilities', './lib/engine/capabilities', {
  detect() { return { mode: 'proxy', engine: 'none' }; }
});
let webkitManager = {
  status: async () => ({ ready: false }),
  createSession: async () => { throw new Error('webkit_off'); },
  navigate: async () => ({}),
  getState: async () => ({}),
  closeSession: async () => ({}),
  request: async () => ({})
};
let installShutdownHooks = () => {};
try {
  const wk = require('./lib/engine/webkit-manager');
  webkitManager = wk.webkitManager || webkitManager;
  installShutdownHooks = wk.installShutdownHooks || installShutdownHooks;
} catch (e) { console.error('[warn] webkit-manager:', e && e.message); }

let playwrightEngine = {
  status: async () => ({ ready: false, engine: 'playwright', reason: 'not_loaded' }),
  createSession: async () => { throw new Error('pw_off'); },
  navigate: async () => ({}),
  getContent: async () => ({ html: '' }),
  dispatchEvent: async () => ({}),
  closeSession: async () => ({}),
  installShutdownHooks() {}
};
try {
  playwrightEngine = require('./lib/engine/playwright-engine');
  try { playwrightEngine.installShutdownHooks(); } catch (_) {}
} catch (e) { console.error('[warn] playwright-engine:', e && e.message); }

const agentProgress = softRequire('agent-progress', './lib/agent-progress', {
  list() { return []; },
  bus: { on() {}, off() {}, emit() {} }
});

let domBridge = softRequire('dom-bridge', './lib/engine/dom-bridge', null);
if (!domBridge) {
  domBridge = {
    createSession: async () => ({ id: 'off', token: 'off' }),
    authSession: () => null,
    navigate: async () => ({ ok: false, error: 'bridge_off' }),
    getContent: async () => ({ html: '<p>bridge offline</p>' }),
    dispatchEvent: async () => ({ ok: false }),
    destroySession: async () => ({}),
    getState: async () => ({ url: '', title: '' })
  };
}

let aiCompat = softRequire('ai-compat', './lib/ai-compat', {
  analyze: async () => ({ summary: 'offline', category: 'unknown', suggestions: [], recommendedMode: 'UNCHANGED', confidence: 0 })
});

try { installShutdownHooks(); } catch (_) {}
try { appLog.configure(DATA_DIR); } catch (_) {}
const PKG = (() => {
  try { return require('./package.json'); } catch { return { version: '9.0.8' }; }
})();

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

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
  // 'no-referrer' breaks YouTube embeds (player error 153 needs a Referer origin)
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
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
    const engine = String(req.query.engine || 'bing').toLowerCase();
    const q = String(req.query.q || '').trim();
    if (!q) return res.status(400).type('html').send('<p>Missing q</p>');
    let target;
    if (engine === 'youtube') {
      target = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(q);
    } else if (engine === 'bing' || engine === 'msn') {
      target = 'https://www.bing.com/search?q=' + encodeURIComponent(q);
    } else if (engine === 'ddg' || engine === 'duckduckgo') {
      target = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
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
    let pw = { ready: false };
    try { pw = await playwrightEngine.status(); } catch (_) {}
    res.json({
      ok: true,
      ...base,
      webkitWorker: wk,
      playwright: pw,
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
let adapter = { analyzeLogs: () => ({ summary: 'n/a' }) };
try { adapter = require('./lib/app-adapter'); } catch (e) { console.error('[warn] app-adapter:', e.message); }
let ai = {
  configured: () => false,
  publicSettings: () => ({ provider: '', model: '', hasKey: false }),
  catalog: () => [],
  saveSettings: (s) => s,
  refreshModels: async () => ({ models: [] }),
  testConnection: async () => ({ ok: false, error: 'ai_unavailable' }),
  chat: async ({ message }) => ({ ok: true, reply: 'AI module unavailable: ' + String(message || '').slice(0, 80), provider: 'local', offline: true }),
  readLogs: () => [],
  clearLogs: () => {},
  log: () => {}
};
try {
  const { createAIService } = require('./lib/ai-module/ai-service');
  const { mountAIRoutes } = require('./lib/ai-module/routes');
  ai = createAIService({ dataDir: DATA_DIR, appName: 'SoloHost Browser', adapter });
  mountAIRoutes(app, ai);
  console.log('[ok] AI routes mounted');
} catch (e) {
  console.error('[error] AI mount failed:', e && e.stack ? e.stack : e);
  // Minimal AI stubs so UI chat does not return app_mount_failed
  app.get('/api/ai/status', (_req, res) => res.json({ ok: true, configured: false, settings: ai.publicSettings() }));
  app.get('/api/ai/catalog', (_req, res) => res.json({ providers: [
    { id: 'openai', name: 'OpenAI' }, { id: 'local', name: 'Local' }, { id: 'custom', name: 'Custom' }
  ] }));
  app.get('/api/ai/settings', (_req, res) => res.json(ai.publicSettings()));
  app.post('/api/ai/settings', (req, res) => res.json({ ok: true, settings: req.body || {} }));
  app.post('/api/ai/chat', (req, res) => res.json({ ok: true, reply: 'AI backend not ready. Check server logs.', provider: 'local', offline: true }));
  app.get('/api/logs', (_req, res) => {
    try { res.json({ logs: appLog.readLogs ? appLog.readLogs() : [] }); }
    catch (_) { res.json({ logs: [] }); }
  });
  app.delete('/api/logs', (_req, res) => { try { appLog.clearLogs && appLog.clearLogs(); } catch (_) {} res.json({ ok: true }); });
}
app.get('/api/agent/progress', (req, res) => {
  res.json({ ok: true, events: agentProgress.list(Number(req.query.limit) || 40) });
});


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


// Browser Agent planner: observation + task -> next validated action (executed by public/browser-agent.js)
let browserAgent = { planStep: async () => ({ ok: false, error: 'agent_off' }) };
let backendAgent = {
  start: async () => ({ ok: false, error: 'agent_off' }),
  status: () => ({ ok: false }),
  stop: () => ({ ok: true }),
  confirm: () => null
};
try { browserAgent = require('./lib/browser-agent'); } catch (e) { console.error('[warn] browser-agent:', e.message); }
try { backendAgent = require('./lib/backend-agent'); } catch (e) { console.error('[warn] backend-agent:', e.message); }
const agentHits = new Map();
function agentRateOk(key) {
  const now = Date.now();
  const arr = (agentHits.get(key) || []).filter((t) => now - t < 60000);
  if (arr.length >= 60) { agentHits.set(key, arr); return false; }
  arr.push(now); agentHits.set(key, arr);
  if (agentHits.size > 500) agentHits.delete(agentHits.keys().next().value);
  return true;
}
// Backend-owned Browser Agent tasks. The UI sends only the task and polls progress;
// observations and browser actions remain inside the authenticated backend session.
app.post('/api/browser/agent/tasks', async (req, res) => {
  try {
    if (!agentRateOk(req.ip || 'anon')) return res.status(429).json({ ok: false, code: 'RATE_LIMIT', error: 'Too many agent tasks, wait a minute.' });
    const body = req.body || {};
    const session = domBridge.authSession(String(body.sessionId || ''), String(body.token || req.get('x-session-token') || ''));
    if (!session) return res.status(401).json({ ok: false, error: 'browser_session_unauthorized' });
    const out = await backendAgent.start({ ai, session, task: body.task, lang: body.lang, history: body.history, maxSteps: body.maxSteps });
    appLog.log('info', 'agent.task.started', { taskId: out.taskId, sessionId: session.id });
    res.status(202).json(out);
  } catch (e) {
    appLog.log('warn', 'agent.task.start_fail', { error: String(e.message || e).slice(0, 200) });
    res.status(400).json({ ok: false, error: String(e.message || e).slice(0, 300) });
  }
});
app.get('/api/browser/agent/sessions/:sessionId/tasks/:taskId', (req, res) => {
  const session = domBridge.authSession(req.params.sessionId, String(req.get('x-session-token') || req.query.token || ''));
  if (!session) return res.status(401).json({ ok: false, error: 'browser_session_unauthorized' });
  const out = backendAgent.status(req.params.taskId, session.id, req.query.after);
  if (!out) return res.status(404).json({ ok: false, error: 'task_not_found' });
  res.json(out);
});
app.post('/api/browser/agent/sessions/:sessionId/tasks/:taskId/stop', (req, res) => {
  const body = req.body || {};
  const session = domBridge.authSession(req.params.sessionId, String(req.get('x-session-token') || body.token || ''));
  if (!session) return res.status(401).json({ ok: false, error: 'browser_session_unauthorized' });
  const out = backendAgent.stop(req.params.taskId, session.id);
  if (!out) return res.status(404).json({ ok: false, error: 'task_not_found' });
  res.json(out);
});
app.post('/api/browser/agent/sessions/:sessionId/tasks/:taskId/confirm', (req, res) => {
  const body = req.body || {};
  const session = domBridge.authSession(req.params.sessionId, String(req.get('x-session-token') || body.token || ''));
  if (!session) return res.status(401).json({ ok: false, error: 'browser_session_unauthorized' });
  const out = backendAgent.confirm(req.params.taskId, session.id, String(body.confirmationId || ''), body.approved === true);
  if (!out) return res.status(409).json({ ok: false, error: 'confirmation_not_pending' });
  res.json(out);
});

app.post('/api/browser/agent/step', async (req, res) => {
  try {
    if (!agentRateOk(req.ip || 'anon')) return res.status(429).json({ ok: false, code: 'RATE_LIMIT', error: 'Too many agent steps, wait a minute.' });
    const out = await browserAgent.planStep(ai, req.body || {});
    if (out && out.ok) {
      appLog.log('info', 'agent.step', { action: out.action && out.action.type, provider: out.provider, offline: out.offline || undefined });
      return res.json(out);
    }
    appLog.log('warn', 'agent.step.reject', { code: out && out.code, error: String((out && out.error) || '').slice(0, 200) });
    return res.status(out && out.code === 'AI_NOT_CONFIGURED' ? 200 : 400).json(out || { ok: false, error: 'agent failed' });
  } catch (e) {
    appLog.log('error', 'agent.step.fail', { error: String(e.message || e).slice(0, 300) });
    res.status(502).json({ ok: false, code: e.code || 'AI_PROVIDER_ERROR', error: String(e.message || e).replace(/Bearer\s+[^\s]+/ig, 'Bearer [REDACTED]').slice(0, 500) });
  }
});

// Universal Feedback — hub credentials default inside feedback-service.js
try {
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
  console.log('[ok] Feedback routes mounted');
} catch (e) {
  console.error('[warn] feedback mount:', e && e.message);
}

let browserStore = {
  listHistory: async () => [],
  addHistory: async () => {},
  clearHistory: async () => {},
  listBookmarks: async () => [],
  addBookmark: async (title, url) => ({ id: '1', title, url }),
  removeBookmark: async () => {}
};
try { browserStore = require('./lib/store'); } catch (e) { console.error('[warn] store:', e.message); }

// —— Interactive DOM Bridge (versioned browser sessions) ——
app.post('/api/browser/sessions', async (req, res) => {
  try {
    const ip = req.ip || req.socket.remoteAddress || 'anon';
    if (!domBridge.rateOk('create:' + ip)) {
      return res.status(429).json({ ok: false, error: 'rate_limited' });
    }
    const privateMode = !!(req.body && req.body.privateMode);
    const privateSuffix = privateMode ? ':private:' + require('crypto').randomBytes(12).toString('hex') : '';
    const out = await domBridge.createSession({ clientKey: ip + privateSuffix, privateMode });
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
    // Prevent the app's own bridge viewport/session API from being fetched as a remote page.
    // Logs showed /api/browser/sessions/:id/view?token=... entering this route and recursing.
    try {
      const target = new URL(url);
      const requestHost = String(req.get('host') || '').toLowerCase();
      if (requestHost && target.host.toLowerCase() === requestHost &&
          /^\/api\/browser\/sessions\/[^/]+\/(?:view|state|content|navigate|events)\/?$/i.test(target.pathname)) {
        return res.status(400).json({ ok: false, error: 'internal_url_not_navigable' });
      }
    } catch (_) { /* normal URL validation below returns the precise error */ }
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
  // The bridge document itself cannot execute scripts. YouTube's nested player
  // needs its own scripts and frame origin, so allow only the official embed hosts.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https: http:; font-src https: http: data:; media-src https: http:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://www.tiktok.com https://www.vimeo.com https://player.vimeo.com https://open.spotify.com https://player.twitch.tv https://www.twitch.tv https://www.dailymotion.com https://geo.dailymotion.com; script-src 'none'; base-uri 'self'; form-action https: http:");
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


} catch (mountErr) {
  console.error('[error] server-app mount exception:', mountErr && mountErr.stack ? mountErr.stack : mountErr);
}
// Always ensure static UI is served
try {
  const path = require('path');
  const express = require('express');
  const PUBLIC_DIR = path.join(__dirname, 'public');
  app.use(express.static(PUBLIC_DIR, { index: 'index.html', fallthrough: true, maxAge: 0 }));
  app.get('/', (_req, res) => {
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  });
} catch (e) {
  console.error('[error] static fallback:', e && e.message);
}

}; // mount
