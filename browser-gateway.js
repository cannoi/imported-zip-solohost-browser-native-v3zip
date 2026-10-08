'use strict';

const WebSocket = require('ws');
const engine = require('./lib/engine-adapter');
const engineControl = require('./lib/webkit-control');

let clients = new Set();

function install(server) {
  const wss = new WebSocket.Server({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    const p = new URL(req.url, 'http://localhost').pathname;
    if (p === '/view' || p.startsWith('/view/')) {
      return require('./lib/display-proxy').handleUpgrade(req, socket, head);
    }
    if (p !== '/ws') return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      clients.add(ws);
      ws.on('close', () => clients.delete(ws));
      const snap = engine.snapshot();
      ws.send(JSON.stringify({
        type: 'gateway',
        ready: snap.status === 'ready',
        engine: 'webkit',
        display: snap.display
      }));
      ws.on('message', async (data) => {
        let msg = {};
        try { msg = JSON.parse(String(data)); } catch { return; }
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
          ws.send(JSON.stringify({
            type: fatal ? 'error' : 'warn',
            layer: 'engine',
            error: err.message
          }));
        }
      });
    });
  });
  const timer = setInterval(() => {
    if (!clients.size) return;
    const snap = engine.snapshot();
    const payload = JSON.stringify({ type: 'browser-state', state: { ok: true, engine: 'webkit', active: snap.active || '', tabs: snap.tabs || [] } });
    for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }, 1000);
  server.once('close', () => clearInterval(timer));
}

function status() {
  const s = engine.snapshot();
  return {
    running: s.status === 'ready' || s.status === 'degraded',
    core: s.status === 'ready',
    engine: s.engine,
    display: s.display,
    mode: 'webkit-display',
    ...s
  };
}

function pageSnapshot() {
  return engineControl.snapshot();
}

async function navigate(url) {
  return engineControl.handle({ type: 'navigate', url });
}

module.exports = { install, status, pageSnapshot, navigate, startCore: () => engine.start() };
