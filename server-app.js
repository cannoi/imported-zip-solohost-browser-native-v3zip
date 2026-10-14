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
  try { return require('./package.json'); } catch { return { version: '10.20.0' }; }
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
// Access password: always required for remote/public IP clients.
// Local/loopback/private LAN can skip when BROWSER_ACCESS_PASSWORD is empty (SoloHost on-device).
// Health checks stay public so SoloHost can monitor container readiness.
function clientIp(req) {
  const xf = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = xf || req.ip || (req.socket && req.socket.remoteAddress) || '';
  return String(ip).replace(/^::ffff:/i, '');
}
function isLocalOrPrivateIp(ip) {
  const s = String(ip || '');
  if (!s || s === '127.0.0.1' || s === '::1' || s === 'localhost') return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(s)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(s)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\.\d+\.\d+$/.test(s)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(s)) return true; // CGNAT optional treat private
  return false;
}
app.use((req, res, next) => {
  const openPaths = ['/health', '/ready', '/api/health', '/api/ready', '/api/access/status', '/api/access/login'];
  if (openPaths.includes(req.path)) return next();
  // Allow shell assets so splash + password form can render before unlock
  if (req.method === 'GET' && (
    req.path === '/' ||
    req.path.startsWith('/style') ||
    req.path.startsWith('/app.js') ||
    req.path.startsWith('/public') ||
    req.path.endsWith('.css') ||
    req.path.endsWith('.js') ||
    req.path.endsWith('.png') ||
    req.path.endsWith('.jpg') ||
    req.path.endsWith('.svg') ||
    req.path.endsWith('.ico') ||
    req.path.endsWith('.woff2') ||
    req.path === '/index.html' ||
    req.path === '/splash-logo.jpg' ||
    req.path === '/ai-panel.css' ||
    req.path === '/ai-panel.js' ||
    req.path === '/ai-icon.png' ||
    req.path.startsWith('/ai-module') ||
    req.path.startsWith('/feedback-module') ||
    req.path === '/browser-agent.js' ||
    req.path === '/reader-injector.js'
  )) return next();

  const configured = String(process.env.BROWSER_ACCESS_PASSWORD || '').trim();
  const ip = clientIp(req);
  const local = isLocalOrPrivateIp(ip);
  // Remote public access must always authenticate
  if (!configured) {
    if (local) return next();
    res.setHeader('WWW-Authenticate', 'Basic realm="SoloHost Browser", charset="UTF-8"');
    return res.status(401).type('text/plain').send(
      'Remote access requires BROWSER_ACCESS_PASSWORD. Set it in SoloHost app settings, then restart.'
    );
  }
  const auth = String(req.headers.authorization || '');
  const m = auth.match(/^Basic\s+(.+)$/i);
  let supplied = '';
  try {
    if (m) {
      const decoded = Buffer.from(m[1], 'base64').toString('utf8');
      // Accept "user:password" or just "password"
      const idx = decoded.indexOf(':');
      supplied = idx >= 0 ? decoded.slice(idx + 1) : decoded;
    }
  } catch (_) {}
  // Also accept cookie session after first success
  const cookie = String(req.headers.cookie || '');
  const cookieOk = cookie.includes('solo_access=1');
  const crypto = require('crypto');
  const a = Buffer.from(supplied);
  const b = Buffer.from(configured);
  const basicOk = m && a.length === b.length && crypto.timingSafeEqual(a, b);
  if (basicOk || cookieOk) {
    if (basicOk && !cookieOk) {
      res.setHeader('Set-Cookie', 'solo_access=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
    }
    return next();
  }
  res.setHeader('WWW-Authenticate', 'Basic realm="SoloHost Browser", charset="UTF-8"');
  res.status(401).type('text/plain').send('SoloHost Browser access password required.');
});


app.get('/api/access/status', (req, res) => {
  const configured = String(process.env.BROWSER_ACCESS_PASSWORD || '').trim();
  const cookie = String(req.headers.cookie || '');
  const authenticated = cookie.includes('solo_access=1');
  const showGate = !!configured && !authenticated;
  res.json({
    ok: true,
    required: showGate,
    configured: !!configured,
    authenticated,
    local: isLocalOrPrivateIp(clientIp(req)),
    message: showGate ? 'password_required' : 'ok'
  });
});

app.post('/api/access/login', (req, res) => {
  const configured = String(process.env.BROWSER_ACCESS_PASSWORD || '').trim();
  if (!configured) {
    res.setHeader('Set-Cookie', 'solo_access=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
    return res.json({ ok: true, authenticated: true, note: 'no_password_configured' });
  }
  const supplied = String((req.body && req.body.password) || '');
  const crypto = require('crypto');
  const a = Buffer.from(supplied);
  const b = Buffer.from(configured);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) {
    res.setHeader('Set-Cookie', 'solo_access=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400');
    return res.json({ ok: true, authenticated: true });
  }
  res.status(401).json({ ok: false, error: 'invalid_password' });
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
    version: PKG.version || '10.20.0',
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
    version: PKG.version || '10.20.0'
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
    const profileId = String((req.body && req.body.profileId) || '').toLowerCase();
    const stableClientKey = /^[a-f0-9]{32}$/.test(profileId) ? 'profile:' + profileId : 'ip:' + String(ip);
    const locale = String((req.body && req.body.locale) || '').slice(0, 40);
    let timezoneId = String((req.body && req.body.timezoneId) || '').slice(0, 80);
    try { new Intl.DateTimeFormat('en-US', { timeZone: timezoneId }); } catch (_) { timezoneId = ''; }
    const privateSuffix = privateMode ? ':private:' + require('crypto').randomBytes(12).toString('hex') : '';
    const out = await domBridge.createSession({ clientKey: stableClientKey + privateSuffix, privateMode, locale, timezoneId });
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
  let html = session.html || '<!doctype html><p>Empty</p>';
  try {
    if (domBridge.stampScrollOnHtml) html = domBridge.stampScrollOnHtml(html, session);
  } catch (_) {}
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-SoloHost-Scroll-Y', String(Number(session.scrollY) || 0));
  // The bridge document itself cannot execute scripts. YouTube's nested player
  // needs its own scripts and frame origin, so allow only the official embed hosts.
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src https: http: data:; style-src 'unsafe-inline' https: http:; font-src https: http: data:; media-src https: http:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://www.tiktok.com https://www.vimeo.com https://player.vimeo.com https://open.spotify.com https://player.twitch.tv https://www.twitch.tv https://www.dailymotion.com https://geo.dailymotion.com https://www.bing.com https://bing.com https://*.bing.com https://*.bing.net; script-src 'none'; base-uri 'self'; form-action https: http:");
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


// Public-IP locale/time-zone hint. If the geolocation service is unavailable, client locale remains the fallback.
let runtimeLocaleCache = { at: 0, value: null };
app.get('/api/runtime/locale', async (_req, res) => {
  if (runtimeLocaleCache.value && Date.now() - runtimeLocaleCache.at < 6 * 60 * 60 * 1000) return res.json({ ok: true, ...runtimeLocaleCache.value });
  let value = { country: '', timeZone: process.env.TZ || 'UTC', lang: 'en', source: 'fallback' };
  try {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1800);
    const response = await fetch('https://ipapi.co/json/', { signal: controller.signal, headers: { 'Accept': 'application/json' } }).finally(() => clearTimeout(timer));
    if (response.ok) {
      const geo = await response.json();
      if (geo && !geo.error) value = { country: String(geo.country_code || ''), timeZone: String(geo.timezone || value.timeZone), lang: String(geo.country_code || '').toUpperCase() === 'VN' ? 'vi' : 'en', source: 'public_ip' };
    }
  } catch (_) {}
  runtimeLocaleCache = { at: Date.now(), value };
  res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, ...value });
});

// Persistent AI memory is keyed by a random browser profile ID; sensitive credential-like text is rejected.
try {
  const aiMemory = require('./lib/ai-memory');
  app.get('/api/ai/memory', (req, res) => {
    const memory = aiMemory.get(req.query.profile);
    if (!memory) return res.status(400).json({ ok: false, error: 'invalid_profile' });
    res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, memory });
  });
  app.post('/api/ai/memory', (req, res) => {
    const out = aiMemory.update(req.body && req.body.profile, req.body || {});
    res.status(out.ok ? 200 : 400).json(out);
  });
} catch (e) { console.error('[warn] AI memory routes:', e.message); }

// —— User library: playlists, AI tasks, SoloHost apps ——
try {
  const lib = require('./lib/user-library');
  app.get('/api/library/playlists', (_req, res) => {
    res.json({ ok: true, playlists: lib.listPlaylists() });
  });
  app.post('/api/library/playlists', (req, res) => {
    const pl = lib.createPlaylist((req.body && req.body.title) || 'Playlist');
    res.json({ ok: true, playlist: pl });
  });
  app.patch('/api/library/playlists/:id', (req, res) => {
    const pl = lib.updatePlaylist(req.params.id, req.body || {});
    if (!pl) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, playlist: pl });
  });
  app.delete('/api/library/playlists/:id', (req, res) => {
    lib.deletePlaylist(req.params.id);
    res.json({ ok: true });
  });
  app.post('/api/library/playlists/:id/items', (req, res) => {
    const item = lib.addPlaylistItem(req.params.id, req.body || {});
    if (!item) return res.status(400).json({ ok: false, error: 'invalid' });
    res.json({ ok: true, item });
  });
  app.delete('/api/library/playlists/:id/items/:itemId', (req, res) => {
    lib.removePlaylistItem(req.params.id, req.params.itemId);
    res.json({ ok: true });
  });
  app.get('/api/library/apps', (_req, res) => {
    res.json({ ok: true, apps: lib.listApps() });
  });
  app.post('/api/library/apps', (req, res) => {
    const url = String((req.body && req.body.url) || '').trim();
    if (!/^https?:\/\//i.test(url)) return res.status(400).json({ ok: false, error: 'url required' });
    const appEntry = lib.addApp((req.body && req.body.name) || 'App', url);
    res.json({ ok: true, app: appEntry });
  });
  app.delete('/api/library/apps/:id', (req, res) => {
    lib.removeApp(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/library/scripts', (_req, res) => {
    res.json({ ok: true, scripts: lib.listScripts() });
  });
  app.get('/api/library/tasks', (_req, res) => res.json({ ok: true, tasks: lib.listScripts() }));
  app.get('/api/library/youtube/first', async (req, res) => {
    const q = String(req.query.q || '').trim().slice(0, 160);
    if (!q) return res.status(400).json({ ok: false, error: 'query_required' });
    try {
      const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 4500);
      const response = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(q), { signal: controller.signal, headers: { 'User-Agent': 'SoloHostBrowser/10.20 scheduled-media-resolver', 'Accept-Language': String(req.get('accept-language') || 'en-US,en;q=0.8').slice(0, 200) } }).finally(() => clearTimeout(timer));
      const html = await response.text();
      const normalizedHtml = html.replace(/\\\"/g, '\"');
      const matches = [...normalizedHtml.matchAll(/\"videoId\"\s*:\s*\"([\w-]{11})\"/g)].map(m => m[1]);
      const id = matches[0] || ((html.match(/watch\?v=([\w-]{11})/) || [])[1]);
      if (!response.ok || !id) return res.status(502).json({ ok: false, error: 'youtube_results_unavailable' });
      res.setHeader('Cache-Control', 'no-store'); res.json({ ok: true, videoId: id, embedUrl: 'https://www.youtube-nocookie.com/embed/' + id + '?autoplay=1&rel=0&playsinline=1' });
    } catch (e) { res.status(502).json({ ok: false, error: 'youtube_lookup_failed' }); }
  });
  app.post('/api/library/tasks', (req, res) => {
    const body = req.body || {}; const text = String(body.instruction || body.message || '').trim();
    if (!text) return res.status(400).json({ ok: false, error: 'instruction_required' });
    const timeMatch = text.match(/(?:at|lúc|vào lúc|mỗi ngày lúc|hằng ngày lúc|daily at)\s*(\d{1,2})(?:[:h.](\d{2}))?\s*(am|pm|h|giờ)?/i) || text.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|h|giờ)\b/i);
    let hour = timeMatch ? Number(timeMatch[1]) : 21; const minute = timeMatch && timeMatch[2] ? Number(timeMatch[2]) : 0;
    const meridiem = String(timeMatch && timeMatch[3] || '').toLowerCase();
    if (meridiem === 'pm' && hour < 12) hour += 12; if (meridiem === 'am' && hour === 12) hour = 0;
    if (hour > 23 || minute > 59) return res.status(400).json({ ok: false, error: 'invalid_time' });
    const time = String(hour).padStart(2,'0') + ':' + String(minute).padStart(2,'0');
    const durationMatch = text.match(/(\d+)\s*(?:phút|phut|minutes?|mins?)/i) || text.match(/(\d+)\s*(?:tiếng|tieng|giờ|hours?|hrs?)/i);
    let duration = durationMatch ? Number(durationMatch[1]) * (/giờ|hours?|hrs?|tiếng|tieng/i.test(durationMatch[0]) ? 60 : 1) : 60; duration = Math.max(1, Math.min(720, duration));
    const query = /thiền|thien|meditation/i.test(text) ? 'nhac thien thu gian 1 tieng' : /lofi/i.test(text) ? 'lofi relaxing music' : 'relaxing music';
    const url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
    const name = /thiền|thien|meditation/i.test(text) ? 'Daily meditation music · ' + time : 'Scheduled YouTube music · ' + time;
    const task = lib.createScript({ name, nameVi: /thiền|thien|meditation/i.test(text) ? 'Nhạc thiền hằng ngày · ' + time : 'Nhạc YouTube theo lịch · ' + time, description: text, descriptionVi: text, schedule: { type: 'daily', time, durationMinutes: duration }, steps: [{ type: 'waitUntil', time }, { type: 'navigate', url }, { type: 'stopAfterMinutes', minutes: duration }], active: true });
    res.json({ ok: true, task, taskCreated: true, requiresBrowserOpen: true });
  });
  app.post('/api/library/scripts', (req, res) => {
    res.json({ ok: true, script: lib.createScript(req.body || {}) });
  });
  app.patch('/api/library/scripts/:id', (req, res) => {
    const s = lib.updateScript(req.params.id, req.body || {});
    if (!s) return res.status(404).json({ ok: false, error: 'not_found' });
    res.json({ ok: true, script: s });
  });
  app.delete('/api/library/scripts/:id', (req, res) => {
    lib.deleteScript(req.params.id);
    res.json({ ok: true });
  });
  console.log('[ok] library routes mounted');
} catch (e) {
  console.error('[warn] library routes:', e && e.message);
}

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


  try {
    app.get('/api/novnc/status', async (req, res) => {
      let novnc = { status: () => ({ featureEnabled: false, packagesPresent: false, ready: false }) };
      try { novnc = require('./lib/novnc-launcher'); } catch (_) {}
      const stn = novnc.status();
      if (!stn.featureEnabled) return res.json({ ok: true, enabled: false, reason: 'disabled', primary: 'bridge' });
      if (!stn.packagesPresent) return res.json({ ok: true, enabled: false, reason: 'packages_missing', primary: 'bridge' });
      res.json({ ok: true, enabled: true, ready: !!stn.ready,
        url: '/novnc/vnc.html?autoconnect=1&resize=scale&quality=6&compression=2&path=websockify',
        passwordRequired: false, primary: 'bridge', role: 'login_secondary' });
    });
    app.post('/api/novnc/start', async (req, res) => {
      let novnc;
      try { novnc = require('./lib/novnc-launcher'); } catch (e) {
        return res.status(500).json({ ok: false, error: 'launcher_missing' });
      }
      try {
        const out = await novnc.ensureStarted();
        res.json({ ok: !!out.ok, ready: !!out.ready, error: out.error || null,
          url: out.ok ? '/novnc/vnc.html?autoconnect=1&resize=scale&quality=6&compression=2&path=websockify' : null,
          primary: 'bridge', role: 'login_secondary' });
      } catch (e) {
        res.status(500).json({ ok: false, error: String(e.message || e) });
      }
    });
    (function mountNovncProxy() {
      const http = require('http');
      const NOVNC_UPSTREAM = Number(process.env.SOLOHOST_NOVNC_PORT || 6080);
      function proxyHttp(req, res) {
        let path = req.url || '/';
        if (!path.startsWith('/')) path = '/' + path;
        const headers = Object.assign({}, req.headers, { host: '127.0.0.1:' + NOVNC_UPSTREAM });
        const preq = http.request(
          { hostname: '127.0.0.1', port: NOVNC_UPSTREAM, path: path, method: req.method, headers: headers },
          function (pres) { res.writeHead(pres.statusCode || 502, pres.headers); pres.pipe(res); }
        );
        preq.on('error', function () {
          if (!res.headersSent) res.status(503).type('html').send('<p>Login desktop starting…</p>');
        });
        req.pipe(preq);
      }
      app.use('/novnc', function (req, res) { proxyHttp(req, res); });
      app.use('/websockify', function (req, res) { proxyHttp(req, res); });
      if (typeof server !== 'undefined' && server && server.on) {
        server.on('upgrade', function (req, socket, head) {
          const u = req.url || '';
          if (u.indexOf('websockify') < 0 && u.indexOf('/novnc') < 0) return;
          let path = u.replace(/^\/novnc/, '') || u;
          const upstream = require('net').connect(NOVNC_UPSTREAM, '127.0.0.1', function () {
            let hdr = 'GET ' + path + ' HTTP/1.1\r\n';
            for (const k of Object.keys(req.headers || {})) {
              const v = req.headers[k];
              if (v == null) continue;
              if (k.toLowerCase() === 'host') hdr += 'Host: 127.0.0.1:' + NOVNC_UPSTREAM + '\r\n';
              else hdr += k + ': ' + v + '\r\n';
            }
            hdr += '\r\n';
            upstream.write(hdr);
            if (head && head.length) upstream.write(head);
            upstream.pipe(socket); socket.pipe(upstream);
          });
          upstream.on('error', function () { try { socket.destroy(); } catch (_) {} });
        });
      }
    })();
    console.log('[ok] noVNC routes mounted (login secondary)');
  } catch (e) { console.error('[warn] noVNC mount:', e && e.message); }

}; // mount
