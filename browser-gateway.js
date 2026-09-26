'use strict';

const WebSocket = require('ws');
const engine = require('./lib/engine-manager');
const cdp = require('./lib/cdp-control');

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
        engine: 'chromium',
        display: snap.display
      }));
      ws.on('message', async (data) => {
        let msg = {};
        try { msg = JSON.parse(String(data)); } catch { return; }
        try {
          const out = await cdp.handle(msg);
          if (out && out.url) {
            ws.send(JSON.stringify({ type: 'tab', event: 'state', id: msg.id, url: out.url, title: out.title || '' }));
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
}

function status() {
  const s = engine.snapshot();
  return {
    running: s.status === 'ready' || s.status === 'degraded',
    core: s.status === 'ready',
    engine: s.engine,
    display: s.display,
    mode: 'chromium-display',
    ...s
  };
}

function pageSnapshot() {
  return cdp.snapshot();
}

async function navigate(url) {
  return cdp.handle({ type: 'navigate', url });
}

module.exports = { install, status, pageSnapshot, navigate, startCore: () => engine.start() };
