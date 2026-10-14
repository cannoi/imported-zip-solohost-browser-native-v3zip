'use strict';

/**
 * Bootstrap: bind PORT immediately (GHCR smoke), then mount full Express app.
 * Serves public/ static as fallback if mount is slow or fails partially.
 */
try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const PKG = (() => {
  try { return require('./package.json'); } catch { return { version: '10.25.25' }; }
})();

try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch (_) {}

function healthJson() {
  return JSON.stringify({
    ok: true,
    ready: !!global.__SOLOHOST_APP_READY__,
    service: 'solohost-browser',
    version: PKG.version,
    port: PORT,
    timestamp: new Date().toISOString()
  });
}

function sendFile(res, filePath, contentType) {
  try {
    const data = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-store',
      'Content-Length': data.length
    });
    res.end(data);
    return true;
  } catch (_) {
    return false;
  }
}

function contentTypeFor(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.json')) return 'application/json';
  if (file.endsWith('.ico')) return 'image/x-icon';
  return 'application/octet-stream';
}

function servePublic(req, res) {
  let url = (req.url || '/').split('?')[0];
  if (url === '/') url = '/index.html';
  // prevent path traversal
  const safe = path.normalize(url).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return true;
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    return sendFile(res, filePath, contentTypeFor(filePath));
  }
  // SPA fallback
  const index = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(index) && req.method === 'GET' && !url.startsWith('/api/')) {
    return sendFile(res, index, 'text/html; charset=utf-8');
  }
  return false;
}

let expressApp = null;
let mountError = null;

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];

  if (url === '/api/health' || url === '/health' || url === '/ready' || url === '/api/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(healthJson());
    return;
  }

  if (expressApp) {
    return expressApp(req, res);
  }

  // While Express is not ready: still serve static UI assets
  if (req.method === 'GET' && !url.startsWith('/api/')) {
    if (servePublic(req, res)) return;
  }

  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({
    ok: false,
    ready: false,
    error: mountError ? 'app_mount_failed' : 'app_loading',
    detail: mountError ? String(mountError).slice(0, 300) : undefined
  }));
});

function mountApp() {
  try {
    const express = require('express');
    const app = express();
    app.disable('x-powered-by');
    app.set('trust proxy', 1);
    require('./server-app').mount(app, server, { PORT, HOST, PKG });
    expressApp = app;
    global.__SOLOHOST_APP_READY__ = true;
    console.log('SoloHost Browser routes mounted');
  } catch (e) {
    mountError = e && e.message ? e.message : String(e);
    console.error('[error] failed to mount app routes:', e && e.stack ? e.stack : e);
    // Retry once after 2s (slow disk / transient require)
    setTimeout(() => {
      if (expressApp) return;
      try {
        const express = require('express');
        const app = express();
        app.disable('x-powered-by');
        app.set('trust proxy', 1);
        require('./server-app').mount(app, server, { PORT, HOST, PKG });
        expressApp = app;
        mountError = null;
        global.__SOLOHOST_APP_READY__ = true;
        console.log('SoloHost Browser routes mounted (retry)');
      } catch (e2) {
        mountError = e2 && e2.message ? e2.message : String(e2);
        console.error('[error] mount retry failed:', e2 && e2.stack ? e2.stack : e2);
      }
    }, 2000);
  }
}

server.listen(PORT, HOST, () => {
  console.log('SoloHost Browser v' + (PKG.version || '') + ' listening on http://' + HOST + ':' + PORT);
  setImmediate(mountApp);
});

server.on('error', (err) => {
  console.error('listen error', err);
  process.exit(1);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
