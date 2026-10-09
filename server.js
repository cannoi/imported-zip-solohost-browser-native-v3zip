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
const PKG = (() => {
  try { return require('./package.json'); } catch { return { version: '9.0.6' }; }
})();

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
if (cors) app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

function healthPayload() {
  return {
    status: 'ok',
    ok: true,
    service: 'solohost-browser',
    version: PKG.version || '9.0.6',
    mode: 'webview-proxy',
    engine: { name: 'webview-proxy', ready: true },
    port: PORT,
    timestamp: new Date().toISOString()
  };
}
app.get('/api/health', (_req, res) => res.status(200).json(healthPayload()));
app.get('/health', (_req, res) => res.status(200).json(healthPayload()));
app.get('/ready', (_req, res) => res.status(200).json({ ready: true, ok: true }));
app.get('/api/ready', (_req, res) => res.status(200).json({ ready: true, ok: true }));

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

// Universal Feedback — hub credentials default inside feedback-service.js
const { createFeedbackService, mountFeedbackRoutes } = require('./lib/feedback-module/feedback-service');
const fbOpts = {
  appId: process.env.SHFH_APP_ID || 'solohost-browser',
  appName: 'SoloHost Browser',
  version: PKG.version || '9.0.6'
};
if (process.env.SHFH_HUB_ID) fbOpts.hubId = process.env.SHFH_HUB_ID;
if (process.env.SHFH_HUB_URL) fbOpts.baseUrl = process.env.SHFH_HUB_URL;
if (process.env.SHFH_INGEST_TOKEN) fbOpts.ingestToken = process.env.SHFH_INGEST_TOKEN;
const fb = createFeedbackService(fbOpts);
mountFeedbackRoutes(app, fb);

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
});
server.on('error', (err) => {
  console.error('Server listen error:', err);
  process.exit(1);
});
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
