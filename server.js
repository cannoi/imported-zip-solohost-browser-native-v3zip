'use strict';

/**
 * SoloHost Browser v9 — Lightweight static shell + AI gateway.
 * Must listen on 0.0.0.0:$PORT so GHCR/SoloHost smoke tests can reach it.
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
  try { return require('./package.json'); } catch { return { version: '9.0.0' }; }
})();

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
if (cors) app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

// --- Health first (smoke tests hit these immediately) ---
function healthPayload() {
  return {
    status: 'ok',
    ok: true,
    service: 'solohost-browser',
    version: PKG.version || '9.0.0',
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

// Same-origin HTML proxy so iframe can display sites that set X-Frame-Options
try {
  const { handleProxy } = require('./lib/frame-proxy');
  app.get('/api/proxy', (req, res) => { handleProxy(req, res); });
  app.get('/proxy', (req, res) => { handleProxy(req, res); });
} catch (err) {
  console.error('[warn] frame-proxy unavailable:', err.message);
  app.get('/api/proxy', (_req, res) => res.status(503).send('proxy unavailable'));
}


// --- AI + Feedback (Express-native routers) ---
let aiService = null;
try {
  const { createAIService } = require('./lib/ai-module/ai-service');
  const { mountAIRoutes } = require('./lib/ai-module/routes');
  let appAdapter = null;
  try { appAdapter = require('./lib/app-adapter'); } catch { /* optional */ }
  aiService = createAIService({
    dataDir: DATA_DIR,
    appName: 'SoloHost Browser',
    adapter: appAdapter || undefined
  });
  mountAIRoutes(app, aiService);
} catch (err) {
  console.error('[warn] AI module failed to load:', err.message);
  app.get('/api/ai/status', (_req, res) => res.json({ ok: false, error: 'ai_unavailable' }));
}

try {
  const { createFeedbackService, mountFeedbackRoutes } = require('./lib/feedback-module/feedback-service');
  const feedbackService = createFeedbackService({
    appId: process.env.SHFH_APP_ID || 'solohost-browser',
    appName: 'SoloHost Browser',
    version: PKG.version || '9.0.0',
    hubId: process.env.SHFH_HUB_ID || 'SHFH-CANNOI-0905428801',
    baseUrl: process.env.SHFH_HUB_URL || 'http://14.176.78.46:8090',
    ingestToken: process.env.SHFH_INGEST_TOKEN || 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9'
  });
  mountFeedbackRoutes(app, feedbackService);
} catch (err) {
  console.error('[warn] Feedback module failed to load:', err.message);
}

app.post('/api/ai/process', async (req, res) => {
  try {
    if (!aiService) return res.status(503).json({ success: false, error: 'ai_unavailable' });
    const body = req.body || {};
    const action = String(body.action || 'chat').toLowerCase();
    const text = String(body.text || body.raw_text || '').slice(0, 200000);
    const lang = String(body.lang || body.language || '').slice(0, 16);
    const query = String(body.query || body.question || body.message || '').slice(0, 4000);
    const targetLang = String(body.targetLang || body.target_lang || lang || 'vi').slice(0, 16);

    let result;
    if (action === 'summarize') {
      result = await aiService.summarizeArticle(text, { lang });
    } else if (action === 'translate') {
      result = await aiService.translateArticle(text, targetLang);
    } else if (action === 'ask' || action === 'question') {
      result = await aiService.askQuestion(text, query || 'Summarize', { lang });
    } else {
      const prompt = query || (text
        ? ('Context:\n' + text.slice(0, 12000) + '\n\nUser: Help me understand this page.')
        : 'Hello');
      result = await aiService.chat({
        message: prompt,
        history: Array.isArray(body.history) ? body.history : [],
        context: { lang, skill: 'chat', pageUrl: body.url || '' }
      });
    }
    return res.json({ success: true, action, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

app.get('/api/browser/parse', (req, res) => {
  const url = String((req.query && req.query.url) || '').trim();
  res.json({
    success: true,
    mode: 'WEBVIEW',
    url,
    data: { client_side: true, webview_required: true }
  });
});

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  fallthrough: true,
  maxAge: 0
}));

app.get('/', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// SPA fallback for non-API GETs
app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/')) {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
      if (err) next();
    });
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
  console.log(`Health: http://${HOST}:${PORT}/api/health`);
});

server.on('error', (err) => {
  console.error('Server listen error:', err);
  process.exit(1);
});

// Graceful stop for containers
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
