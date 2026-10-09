'use strict';

/**
 * SoloHost Browser v9 — Lightweight AI Gateway + static shell.
 * No Playwright / headless Chromium. Browsing is 100% client WebView/iframe.
 */

try { require('dotenv').config(); } catch { /* optional */ }

const path = require('path');
const fs = require('fs');
const express = require('express');
let cors;
try { cors = require('cors'); } catch { cors = null; }

const { createAIService } = require('./lib/ai-module/ai-service');
const { mountAIRoutes } = require('./lib/ai-module/routes');
const { createFeedbackService, mountFeedbackRoutes } = require('./lib/feedback-module/feedback-service');
const appAdapter = require('./lib/app-adapter');
const { createMountApp } = require('./lib/module-http');

const PORT = Number(process.env.PORT || 8080);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const PKG = (() => { try { return require('./package.json'); } catch { return { version: '9.0.0' }; } })();

try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignore */ }

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
  version: PKG.version || '9.0.0',
  hubId: process.env.SHFH_HUB_ID || 'SHFH-CANNOI-0905428801',
  baseUrl: process.env.SHFH_HUB_URL || 'http://14.176.78.46:8090',
  ingestToken: process.env.SHFH_INGEST_TOKEN || 'cannoi_7Kp9xV2mQ8rN4tY6cL3wA5zD1eF0uH9'
});
mountFeedbackRoutes(universalApp, feedbackService);

const app = express();
app.disable('x-powered-by');
if (cors) app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.get('/api/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'solohost-browser',
    version: PKG.version,
    mode: 'client-webview',
    engine: { name: 'client-webview', ready: true },
    timestamp: new Date().toISOString()
  });
});
app.get('/health', (_req, res) => res.redirect(302, '/api/health'));
app.get('/ready', (_req, res) => res.json({ ready: true }));

/**
 * POST /api/ai/process
 * Body: { action: 'summarize'|'translate'|'ask'|'chat', text, query?, lang?, targetLang? }
 * Client extracts text from WebView DOM; server only talks to LLM providers.
 */
app.post('/api/ai/process', async (req, res) => {
  try {
    const body = req.body || {};
    const action = String(body.action || 'chat').toLowerCase();
    const text = String(body.text || body.raw_text || '').slice(0, 200000);
    const lang = String(body.lang || body.language || '').slice(0, 16);
    const query = String(body.query || body.question || '').slice(0, 4000);
    const targetLang = String(body.targetLang || body.target_lang || lang || 'vi').slice(0, 16);

    if (!text && action !== 'chat') {
      return res.status(400).json({ success: false, error: 'text required' });
    }

    let result;
    if (action === 'summarize' && typeof aiService.summarizeArticle === 'function') {
      result = await aiService.summarizeArticle(text, { lang });
    } else if (action === 'translate' && typeof aiService.translateArticle === 'function') {
      result = await aiService.translateArticle(text, targetLang);
    } else if ((action === 'ask' || action === 'question') && typeof aiService.askQuestion === 'function') {
      result = await aiService.askQuestion(text, query || 'Summarize key points', { lang });
    } else {
      // Generic chat — pass page context when present
      const messages = Array.isArray(body.messages) ? body.messages : null;
      const prompt = query || body.prompt || (text ? ('Context:\n' + text.slice(0, 12000) + '\n\nUser: ' + (query || 'Help me understand this page.')) : '');
      if (typeof aiService.chat === 'function') {
        result = await aiService.chat({
          message: prompt || query || 'Hello',
          history: Array.isArray(body.history) ? body.history : [],
          context: { lang, skill: 'chat', pageUrl: body.url || '' }
        });
      } else {
        result = { ok: true, reply: text ? text.slice(0, 500) : 'AI ready. Configure a provider in Settings.', localReply: true };
      }
    }

    return res.json({ success: true, action, result });
  } catch (err) {
    return res.status(500).json({ success: false, error: String(err.message || err) });
  }
});

// Legacy parse stub — client WebView owns navigation; keep route for older UI probes
app.get('/api/browser/parse', (req, res) => {
  const url = String((req.query && req.query.url) || '').trim();
  res.json({
    success: true,
    mode: 'WEBVIEW',
    url,
    cached: false,
    auth_required: false,
    metadata: { title: url, byline: '', siteName: '' },
    data: { webview_required: true, client_side: true },
    message: 'v9 uses client WebView — set iframe src on the client'
  });
});

// Mount AI + Feedback module routers
app.use(universalApp);

app.use(express.static(PUBLIC_DIR, {
  index: 'index.html',
  maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0
}));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) res.status(404).send('Not found');
  });
});

app.use((err, _req, res, _next) => {
  res.status(500).json({ success: false, error: String(err.message || err) });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`SoloHost Browser v${PKG.version} (client-webview) on port ${PORT}`);
});
