'use strict';

const http = require('http');
const https = require('https');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const appManager = require('./lib/app-manager');
const store = require('./lib/store');
const netProbe = require('./lib/net-probe');
const netStatus = require('./lib/net-status');
const browserGateway = require('./browser-gateway');
const engineManager = require('./lib/engine-adapter');
const engineControl = require('./lib/engine-control');
const readerView = require('./lib/reader-view');
const securityPolicy = require('./lib/security-policy');
const performanceMonitor = require('./lib/performance-monitor');
const { createMountApp } = require('./lib/module-http');
const { createAIService } = require('./lib/ai-module/ai-service');
const { mountAIRoutes } = require('./lib/ai-module/routes');
const { createFeedbackService, mountFeedbackRoutes } = require('./lib/feedback-module/feedback-service');
const appAdapter = require('./lib/app-adapter');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PKG = (() => { try { return require('./package.json'); } catch { return { version: '0.0.0' }; } })();

const universalApp = createMountApp();
const aiService = createAIService({
  dataDir: DATA_DIR,
  appName: 'SoloHost Browser',
  adapter: appAdapter
});
mountAIRoutes(universalApp, aiService);
const feedbackService = createFeedbackService({
  appId: process.env.SHFH_APP_ID || 'solohost-browser',
  appName: 'SoloHost Browser',
  version: PKG.version || '7.8.1',
  hubId: process.env.SHFH_HUB_ID || 'SHFH-CANNOI-0905428801',
  baseUrl: process.env.SHFH_HUB_URL || 'http://14.176.78.46:8090',
  ingestToken: process.env.SHFH_INGEST_TOKEN || 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9'
});
mountFeedbackRoutes(universalApp, feedbackService);

function logApp(level, msg, extra) {
  try { aiService.log(level, msg, extra || {}); } catch { /* optional */ }
}

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

/** Phase 2 — Chromium health (headless Playwright). */
async function handleApiHealth(_req, res) {
  try {
    const health = await browserGateway.chromiumHealth();
    const code = health.engine && health.engine.ready ? 200 : 503;
    res.status(code).json(health);
  } catch (err) {
    res.status(503).json({
      status: 'error',
      service: 'solohost-browser',
      engine: { name: 'chromium', ready: false, error: String(err.message || err) },
      timestamp: new Date().toISOString()
    });
  }
}

/** Phase 2 — structured article parse for clients. */
async function handleBrowserParse(req, res) {
  const target = String((req.query && req.query.url) || '').trim();
  try {
    const out = await browserGateway.parseUrl(target, {
      acceptLanguage: req.get ? (req.get('accept-language') || '') : (req.headers['accept-language'] || '')
    });
    res.status(200).json(out);
  } catch (err) {
    const map = {
      INVALID_URL: 400,
      UNSUPPORTED_SCHEME: 400,
      BLOCKED: 403,
      BUSY: 429,
      NAVIGATION_TIMEOUT: 504,
      HTTP_ERROR: 502,
      DEPENDENCY_MISSING: 503
    };
    const status = map[err.code] || err.httpStatus || 502;
    res.status(status).json({
      success: false,
      url: target || null,
      error: String(err.message || err),
      code: err.code || 'EXTRACT_FAILED'
    });
  }
}

app.get('/api/health', handleApiHealth);
app.get('/health', handleApiHealth);
app.get('/api/browser/parse', handleBrowserParse);

// Universal AI + Feedback can use real Express routers
try {
  mountAIRoutes(app, aiService);
  mountFeedbackRoutes(app, feedbackService);
} catch (e) {
  console.error('[modules]', e.message);
}


const BROWSER_PROFILE = path.resolve(process.env.SOLOHOST_BROWSER_DATA || '/app/data/webkit-profile');
const BROWSER_DOWNLOADS = path.resolve(process.env.SOLOHOST_DOWNLOADS || path.join(BROWSER_PROFILE, 'downloads'));
function safeDownloadName(raw) {
  let name;
  try { name = decodeURIComponent(String(raw || '')); } catch { return null; }
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) return null;
  return name;
}
async function listDownloads() {
  await fs.promises.mkdir(BROWSER_DOWNLOADS, { recursive: true });
  const entries = await fs.promises.readdir(BROWSER_DOWNLOADS, { withFileTypes: true });
  const rows = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(BROWSER_DOWNLOADS, entry.name);
    const stat = await fs.promises.stat(full);
    rows.push({ name: entry.name, size: stat.size, modified: stat.mtime.toISOString(), url: '/api/files/downloads/' + encodeURIComponent(entry.name) });
  }
  return rows.sort((a, b) => b.modified.localeCompare(a.modified));
}
function downloadsPage(items, lang) {
  const vi = lang.toLowerCase().startsWith('vi');
  const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const rows = items.map(item => `<li><span class="file">📄 ${esc(item.name)}</span><small>${(item.size/1024).toFixed(1)} KB · ${esc(item.modified)}</small><a href="${item.url}">${vi?'Tải xuống':'Download'}</a></li>`).join('');
  return `<!doctype html><html lang="${vi?'vi':'en'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${vi?'Tệp đã tải xuống':'Downloads'} · SoloHost</title><style>body{margin:0;background:#101116;color:#eee;font:15px system-ui;padding:24px}main{max-width:820px;margin:auto}a{color:#a9c7ff}li{list-style:none;display:grid;grid-template-columns:1fr auto;gap:8px;padding:14px 0;border-bottom:1px solid #333}small{grid-column:1;color:#aaa}.file{overflow-wrap:anywhere}header{display:flex;justify-content:space-between;align-items:center}p{color:#aaa}</style><main><header><h1>⬇ ${vi?'Tệp đã tải xuống':'Downloads'}</h1><a href="/">${vi?'Về trình duyệt':'Back to Browser'}</a></header><p>${vi?'Tệp được lưu trong hồ sơ trình duyệt SoloHost.':'Files are stored in the SoloHost browser profile.'}</p><ul>${rows || `<li>${vi?'Chưa có tệp tải xuống.':'No downloads yet.'}</li>`}</ul></main></html>`;
}


const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8'
};

function send(res, status, body, headers = {}) {
  const payload = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  res.writeHead(status, {
    'Content-Length': payload.length,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'SAMEORIGIN',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    ...headers
  });
  res.end(payload);
}

function json(res, status, obj) {
  send(res, status, JSON.stringify(obj), {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
}

function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function localAppPage(title, icon, body) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>${title}</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0; min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, sans-serif;
      background: radial-gradient(1200px 700px at 50% -10%, #1a1c22 0%, #0c0d10 55%);
      color: #eceae6; display: grid; place-items: center; padding: 32px;
    }
    main { text-align: center; max-width: 420px; }
    .mark { font-size: 42px; margin-bottom: 12px; }
    h1 { font-weight: 420; letter-spacing: .18em; text-transform: uppercase; font-size: 13px; color: #9a9790; margin: 0 0 10px; }
    p { color: #c8c4bc; line-height: 1.6; font-size: 15px; }
    .hint { color: #6f6c66; font-size: 12px; letter-spacing: .04em; }
  </style>
</head>
<body>
  <main>
    <div class="mark">${icon}</div>
    <h1>${title}</h1>
    ${body}
  </main>
</body>
</html>`;
}

const localApps = {
  calculator: localAppPage('Calculator', '∑', '<p>A quiet place for numbers. Connect a registered SoloHost calculator to replace this surface.</p><p class="hint">Gateway route /apps/calculator</p>'),
  music: localAppPage('Music', '♪', '<p>Listening room is ready. Point this route at your SoloHost music app when it is installed.</p><p class="hint">Gateway route /apps/music</p>'),
  ai: localAppPage('AI', '◎', '<p>Local assistant surface. Pi Account remains optional in V1. No keys or seed phrases are stored here.</p><p class="hint">Gateway route /apps/ai</p>'),
  node: localAppPage('Node', '⬡', '<p>Node status will appear here when the SoloHost node app is registered.</p><p class="hint">Gateway route /apps/node</p>')
};

function safePublicPath(urlPath) {
  const clean = decodeURIComponent(urlPath.split('?')[0]);
  const rel = clean === '/' ? '/index.html' : clean;
  const full = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!full.startsWith(PUBLIC_DIR)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  let file = safePublicPath(urlPath);
  if (!file) return send(res, 403, 'Forbidden', { 'Content-Type': 'text/plain' });
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    const index = path.join(PUBLIC_DIR, 'index.html');
    if (fs.existsSync(index) && !urlPath.startsWith('/api')) {
      file = index;
    } else {
      return false;
    }
  }
  const ext = path.extname(file).toLowerCase();
  const stream = fs.createReadStream(file);
  const cacheable = /\.(?:css|js|png|svg|ico|woff2)$/i.test(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': cacheable ? 'public, max-age=86400' : 'no-cache'
  });
  stream.pipe(res);
  return true;
}

function proxyTo(targetUrl, req, res) {
  let dest;
  try {
    dest = new URL(targetUrl);
  } catch {
    return send(res, 502, 'Invalid app target', { 'Content-Type': 'text/plain' });
  }
  const lib = dest.protocol === 'https:' ? https : http;
  const headers = { ...req.headers, host: dest.host };
  delete headers['content-length'];
  const proxyReq = lib.request(
    {
      protocol: dest.protocol,
      hostname: dest.hostname,
      port: dest.port,
      path: dest.pathname + dest.search,
      method: req.method,
      headers,
      timeout: 8000
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    }
  );
  proxyReq.on('error', () => {
    if (!res.headersSent) send(res, 502, 'App gateway unreachable', { 'Content-Type': 'text/plain' });
  });
  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!res.headersSent) send(res, 504, 'App gateway timeout', { 'Content-Type': 'text/plain' });
  });
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') req.pipe(proxyReq);
  else proxyReq.end();
}

async function handleAppGateway(id, req, res) {
  await appManager.discover();
  const internal = appManager.getInternal(id);
  if (internal && internal.target && /^https?:\/\//i.test(internal.target)) {
    return proxyTo(internal.target, req, res);
  }
  const html =
    localApps[id] ||
    (internal
      ? localAppPage(internal.name, '◇', `<p>${internal.description || 'This SoloHost application is registered.'}</p><p class="hint">No public target is configured for this route.</p>`)
      : null);
  if (!html) {
    return send(res, 404, localAppPage('Not found', '○', '<p>No SoloHost app is registered at this route.</p>'), {
      'Content-Type': 'text/html; charset=utf-8'
    });
  }
  send(res, 200, html, { 'Content-Type': 'text/html; charset=utf-8' });
}

const server = http.createServer(app);

// Legacy raw-HTTP path handler (bookmarks, static, reader view, etc.)
app.use(async (req, res, next) => {
  if (res.headersSent) return;
  try {
    // Skip paths already served by Express Phase-2 / AI / Feedback mounts
    const p0 = (req.path || req.url || '').split('?')[0];
    if (p0 === '/api/health' || p0 === '/health' || p0 === '/api/browser/parse') return;
    if (p0.startsWith('/api/ai') || p0.startsWith('/api/feedback') || p0 === '/api/logs') return;

    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;
    const method = req.method || 'GET';

    if (p === '/security' && method === 'GET') {
      return serveStatic(req, res, '/security.html');
    }
    if (p === '/api/security/settings' && method === 'GET') {
      return json(res, 200, { ok: true, settings: securityPolicy.load() });
    }
    if (p === '/api/security/settings' && method === 'PUT') {
      const body = await readBody(req, 20000);
      const settings = securityPolicy.save(body.settings || body);
      return json(res, 200, { ok: true, settings });
    }
    if (p === '/api/security/validate' && method === 'POST') {
      const body = await readBody(req, 8192);
      try { return json(res, 200, { ok: true, url: securityPolicy.validateNavigation(body.url, securityPolicy.load()) }); }
      catch (error) { return json(res, 403, { ok: false, error: String(error.message || error) }); }
    }
    if (p === '/downloads' && method === 'GET') {
      const items = await listDownloads();
      return send(res, 200, downloadsPage(items, req.headers['accept-language'] || 'en'), { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    }
    if (p === '/api/files/downloads' && method === 'GET') {
      return json(res, 200, { ok: true, downloads: await listDownloads() });
    }
    if (p.startsWith('/api/files/downloads/') && (method === 'GET' || method === 'HEAD')) {
      const name = safeDownloadName(p.slice('/api/files/downloads/'.length));
      if (!name) return json(res, 400, { error: 'invalid file name' });
      const full = path.resolve(BROWSER_DOWNLOADS, name);
      if (path.dirname(full) !== BROWSER_DOWNLOADS) return json(res, 400, { error: 'invalid file path' });
      let stat;
      try { stat = await fs.promises.lstat(full); } catch { return json(res, 404, { error: 'download not found' }); }
      if (!stat.isFile() || stat.isSymbolicLink()) return json(res, 404, { error: 'download not found' });
      res.writeHead(200, { 'Content-Length': stat.size, 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(name)}`, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' });
      if (method === 'HEAD') return res.end();
      return fs.createReadStream(full).pipe(res);
    }
    if (p === '/health') {
      return json(res, 200, {
        status: 'ok',
        service: 'solohost-browser',
        http: 'READY',
        timestamp: new Date().toISOString()
      });
    }
    if (p === '/ready') {
      const ok = engineManager.ready();
      return json(res, ok ? 200 : 503, {
        status: ok ? 'READY' : 'NOT_READY',
        engine: engineManager.snapshot()
      });
    }
    if (p === '/api/browser/status') {
      return json(res, 200, engineManager.snapshot());
    }
    if (p === '/api/display/status') {
      // The noVNC/Xvfb pixel transport was removed in v8 Phase 1; kept so existing clients get a clear answer.
      const eng = engineManager.snapshot();
      return json(res, 200, {
        path: 'disabled',
        mode: 'off',
        transport: 'none',
        renderer: 'chromium-headless-extract',
        note: 'Pixel streaming removed. Pages are rendered by headless Chromium and delivered as reader content via /view.',
        engineStatus: eng.status
      });
    }
    if (p === '/api/performance' || p === '/api/diagnostics/performance') {
      return json(res, 200, performanceMonitor.sample(engineManager.snapshot()));
    }
    if (p === '/api/browser/navigate' && method === 'POST') {
      const body = await readBody(req);
      const target = String(body.url || '').trim();
      if (!target) return json(res, 400, { ok: false, error: 'url required' });
      try {
        const out = await browserGateway.navigate(target);
        return json(res, 200, { ok: true, ...out });
      } catch (err) {
        return json(res, 503, { ok: false, error: String(err.message || err) });
      }
    }
    if (p === '/api/browser/content' && method === 'GET') {
      if (url.searchParams.get('summary')) return json(res, 200, engineManager.revision());
      return json(res, 200, { ok: true, ...engineManager.getContent(url.searchParams.get('id') || undefined) });
    }
    if (p === '/api/extract' && method === 'POST') {
      const body = await readBody(req, 8192);
      const target = String(body.url || '').trim();
      if (!target) return json(res, 400, { ok: false, error: 'url required' });
      try {
        const out = await engineControl.extract(target, { acceptLanguage: req.headers['accept-language'] || '' });
        return json(res, 200, out);
      } catch (err) {
        const code = err.code || 'EXTRACT_FAILED';
        const status = { INVALID_URL: 400, UNSUPPORTED_SCHEME: 400, BLOCKED: 403, BUSY: 429, NAVIGATION_TIMEOUT: 504, HTTP_ERROR: 502 }[code] || (code === 'DEPENDENCY_MISSING' ? 503 : 502);
        return json(res, status, { ok: false, code, error: String(err.message || err), http_status: err.httpStatus || undefined });
      }
    }
    if (p === '/diagnostics' || p === '/api/diagnostics') {
      const eng = engineManager.snapshot();
      const net = await netProbe.probeOutbound();
      let mem = null;
      try { mem = process.memoryUsage(); } catch { mem = null; }
      return json(res, 200, {
        app: require('./package.json').version,
        runtime: 'solohost-web',
        engine: eng,
        network: { layer: 'https', state: net.outbound ? 'PASS' : 'FAILED' },
        memory: mem,
        page: browserGateway.pageSnapshot(),
        solohost: 'PASS'
      });
    }
    if (p === '/view' || p.startsWith('/view/')) {
      return readerView.handle(req, res, engineManager);
    }
    if (p === '/api/net') {
      const probe = await netProbe.probeOutbound();
      return json(res, probe.ok ? 200 : 503, probe);
    }
    if (p === '/api/network/status') {
      return json(res, 200, await netStatus.collect());
    }
    // Universal AI + Feedback modules (Express-style mount on raw HTTP)
    if (p.startsWith('/api/ai') || p.startsWith('/api/feedback') || p === '/api/logs') {
      let body = {};
      if (method === 'POST' || method === 'PUT' || method === 'PATCH') {
        try { body = await readBody(req, 200000); } catch { body = {}; }
      }
      const u = new URL(req.url || '/', 'http://127.0.0.1');
      const query = {};
      u.searchParams.forEach((v, k) => { query[k] = v; });
      const handled = await universalApp.dispatch(req, res, {
        method,
        pathname: p,
        query,
        body
      });
      if (handled) return;
    }
    if (p === '/api/engine' && method === 'GET') {
      return json(res, 200, browserGateway.status());
    }
    if (p === '/api/hub') {
      return json(res, 200, {
        name: 'SoloHost Browser',
        status: 'active',
        version: require('./package.json').version,
        features: ['Headless Chromium', 'Reader Mode', 'Media Sniffing (m3u8/mp4)', 'HTTP/HTTPS', 'Safe Downloads', 'Profile-Scoped Files', 'Security Policy', 'Persistent Profile', 'Tabs', 'App Discovery', 'Bookmarks', 'History', 'AI Assistant (optional)', 'Search', 'Summarize', 'Explain', 'Translate', 'Navigate', 'Extract', 'Assist']
      });
    }
    if (p === '/api/status') {
      const discovered = await appManager.discover();
      return json(res, 200, {
        solohost: discovered.ok ? 'online' : 'offline',
        source: discovered.source,
        apps: discovered.apps.length,
        auth: { available: false, optional: true }
      });
    }
    if (p === '/api/apps') {
      try {
        const discovered = await appManager.discover();
        if (!discovered.ok && !discovered.apps.length) {
          return json(res, 503, { ok: false, error: 'My Apps unavailable', apps: [] });
        }
        return json(res, 200, {
          ok: true,
          source: discovered.source,
          apps: discovered.apps.map(appManager.publicApp)
        });
      } catch {
        return json(res, 503, { ok: false, error: 'My Apps unavailable', apps: [] });
      }
    }
    if (p === '/api/bookmarks' && method === 'GET') {
      return json(res, 200, { bookmarks: await store.listBookmarks() });
    }
    if (p === '/api/bookmarks' && method === 'POST') {
      const body = await readBody(req);
      const link = String(body.url || '').trim();
      const title = String(body.title || link).trim().slice(0, 180);
      if (!link) return json(res, 400, { error: 'url required' });
      const row = await store.addBookmark(title, link);
      return json(res, 200, { ok: true, bookmark: row });
    }
    if (p.startsWith('/api/bookmarks/') && method === 'DELETE') {
      await store.removeBookmark(p.split('/').pop());
      return json(res, 200, { ok: true });
    }
    if (p === '/api/history' && method === 'GET') {
      return json(res, 200, { history: await store.listHistory() });
    }
    if (p === '/api/history' && method === 'POST') {
      const body = await readBody(req);
      const link = String(body.url || '').trim();
      const title = String(body.title || link).trim().slice(0, 180);
      if (!link) return json(res, 400, { error: 'url required' });
      await store.addHistory(title, link);
      return json(res, 200, { ok: true });
    }
    if (p === '/api/auth/status') {
      return json(res, 200, { authenticated: false, optional: true, provider: 'pi-account', ready: true });
    }
    if (p.startsWith('/apps/')) {
      return handleAppGateway(p.slice(6).split('/')[0], req, res);
    }

    if (method === 'GET' || method === 'HEAD') {
      if (serveStatic(req, res, p)) return;
    }
    json(res, 404, { error: 'not found' });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: 'server error' });
    console.error(err);
  }
});

browserGateway.install(server);

server.on('upgrade', (req, socket) => {
  const u = req.url || '';
  if (u.startsWith('/ws')) return;
  socket.destroy();
});

async function shutdown(signal) {
  console.log(`[shutdown] ${signal}`);
  try { await engineManager.stop(); } catch (err) { console.error('[engine stop]', err.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`SoloHost Browser running on port ${PORT}`);
  engineManager.start().catch((err) => {
    console.error('[engine]', err.message);
  });
});

