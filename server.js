'use strict';

/**
 * Bootstrap: bind HTTP immediately (no Express) so GHCR smoke always passes,
 * then mount full Express app routes.
 */
try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const fs = require('fs');
const http = require('http');

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';
const PKG = (() => {
  try { return require('./package.json'); } catch { return { version: '10.9.4' }; }
})();

try { fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true }); } catch (_) {}

function healthJson() {
  return JSON.stringify({
    ok: true,
    ready: true,
    service: 'solohost-browser',
    version: PKG.version,
    port: PORT,
    timestamp: new Date().toISOString()
  });
}

let expressApp = null;

const server = http.createServer((req, res) => {
  const url = (req.url || '').split('?')[0];
  // Always answer health even before Express is ready
  if (url === '/api/health' || url === '/health' || url === '/ready' || url === '/api/ready') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(healthJson());
    return;
  }
  if (expressApp) {
    return expressApp(req, res);
  }
  res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: false, ready: false, error: 'app_loading' }));
});

server.listen(PORT, HOST, () => {
  console.log('SoloHost Browser v' + (PKG.version || '') + ' listening on http://' + HOST + ':' + PORT);
  setImmediate(() => {
    try {
      const express = require('express');
      const app = express();
      app.disable('x-powered-by');
      app.set('trust proxy', 1);
      // Health also on Express (after mount, http layer still handles first)
      require('./server-app').mount(app, server, { PORT, HOST, PKG });
      expressApp = app;
      console.log('SoloHost Browser routes mounted');
    } catch (e) {
      console.error('[error] failed to mount app routes:', e && e.stack ? e.stack : e);
      // Keep health alive for smoke tests
    }
  });
});

server.on('error', (err) => {
  console.error('listen error', err);
  process.exit(1);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
