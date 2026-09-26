'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const CDP_PORT = Number(process.env.CHROME_CDP_PORT || 9222);
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable'
].filter(Boolean);

let proc = null;
let pageWs = null;
let cmdId = 1;
const pending = new Map();
const pages = new Map();
let activeId = '';
let lastMeta = { url: '', title: '' };
let width = 1280;
let height = 800;

function findChrome() {
  for (const p of CHROME_CANDIDATES) {
    try { if (p && fs.existsSync(p)) return p; } catch { /* skip */ }
  }
  return null;
}

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${CDP_PORT}${pathname}`, { timeout: 2000 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body || 'null')); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('cdp timeout')); });
  });
}

function sendCdp(method, params) {
  if (!pageWs || pageWs.readyState !== WebSocket.OPEN) return Promise.reject(new Error('cdp closed'));
  const id = cmdId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    pageWs.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error('cdp method timeout'));
      }
    }, 8000);
  });
}

function packFrame(w, h, jpeg) {
  const out = Buffer.alloc(12 + jpeg.length);
  out[0] = 83; out[1] = 72; out[2] = 66; out[3] = 49;
  out.writeUInt32BE(w >>> 0, 4);
  out.writeUInt32BE(h >>> 0, 8);
  jpeg.copy(out, 12);
  return out;
}

async function attachPage(onFrame, onEvent) {
  const list = await getJson('/json/list');
  const page = (Array.isArray(list) ? list : []).find((p) => p.type === 'page') || (Array.isArray(list) ? list[0] : null);
  if (!page || !page.webSocketDebuggerUrl) throw new Error('no cdp page');
  pageWs = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    pageWs.once('open', resolve);
    pageWs.once('error', reject);
  });
  pageWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'cdp error'));
      else p.resolve(msg.result || {});
      return;
    }
    if (msg.method === 'Page.screencastFrame' && msg.params) {
      const jpeg = Buffer.from(msg.params.data, 'base64');
      const md = msg.params.metadata || {};
      const w = Number(md.deviceWidth) || width;
      const h = Number(md.deviceHeight) || height;
      onFrame(packFrame(w, h, jpeg));
      sendCdp('Page.screencastFrameAck', { sessionId: msg.params.sessionId }).catch(() => {});
    }
    if (msg.method === 'Page.frameNavigated' && msg.params && msg.params.frame && !msg.params.frame.parentId) {
      lastMeta.url = msg.params.frame.url || lastMeta.url;
      onEvent({ type: 'tab', event: 'state', id: activeId, url: lastMeta.url, title: lastMeta.title });
    }
    if (msg.method === 'Page.title' || (msg.method === 'Runtime.consoleAPICalled')) return;
  });
  await sendCdp('Page.enable');
  await sendCdp('Runtime.enable');
  await sendCdp('Page.startScreencast', { format: 'jpeg', quality: 45, maxWidth: width, maxHeight: height, everyNthFrame: 1 });
}

function startChrome() {
  if (proc && !proc.killed) return true;
  const bin = findChrome();
  if (!bin) return false;
  const profile = process.env.SOLOHOST_BROWSER_DATA || path.join(require('os').tmpdir(), 'solohost-browser', 'chromium');
  try { fs.mkdirSync(profile, { recursive: true }); } catch { /* ignore */ }
  proc = spawn(bin, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    '--window-size=1280,800',
    'about:blank'
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  proc.on('exit', () => { proc = null; pageWs = null; });
  proc.on('error', (err) => console.error('[chromium]', err.message));
  return true;
}

async function ready(onFrame, onEvent) {
  if (!startChrome()) throw new Error('chromium binary not found');
  for (let i = 0; i < 20; i++) {
    try {
      await attachPage(onFrame, onEvent);
      return true;
    } catch {
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw new Error('chromium cdp not ready');
}

async function handle(msg, onEvent) {
  const type = msg.type;
  const id = msg.id || activeId;
  if (type === 'create') {
    activeId = id;
    pages.set(id, { url: msg.url || 'about:blank' });
    width = Number(msg.w) || width;
    height = Number(msg.h) || height;
    await sendCdp('Page.navigate', { url: msg.url || 'about:blank' }).catch(() => {});
    lastMeta.url = msg.url || lastMeta.url;
    onEvent({ type: 'tab', event: 'state', id, url: lastMeta.url, title: lastMeta.title });
    return;
  }
  if (type === 'activate') { activeId = id; return; }
  if (type === 'navigate') {
    await sendCdp('Page.navigate', { url: msg.url || 'about:blank' });
    lastMeta.url = msg.url || lastMeta.url;
    return;
  }
  if (type === 'back') await sendCdp('Page.goBack').catch(() => {});
  if (type === 'forward') await sendCdp('Page.goForward').catch(() => {});
  if (type === 'reload') await sendCdp('Page.reload').catch(() => {});
  if (type === 'resize') {
    width = Number(msg.width) || width;
    height = Number(msg.height) || height;
  }
  if (type === 'mouse') {
    const x = Number(msg.x) || 0;
    const y = Number(msg.y) || 0;
    if (msg.phase === 'down' || msg.phase === 'up') {
      await sendCdp('Input.dispatchMouseEvent', {
        type: msg.phase === 'down' ? 'mousePressed' : 'mouseReleased',
        x, y, button: msg.button || 'left', clickCount: 1
      }).catch(() => {});
    } else {
      await sendCdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }).catch(() => {});
    }
  }
  if (type === 'wheel') {
    await sendCdp('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x: Number(msg.x) || 0,
      y: Number(msg.y) || 0,
      deltaX: 0,
      deltaY: -(Number(msg.delta) || 0)
    }).catch(() => {});
  }
  if (type === 'key') {
    await sendCdp('Input.dispatchKeyEvent', {
      type: msg.phase === 'up' ? 'keyUp' : (String(msg.key || '').length === 1 ? 'char' : 'keyDown'),
      key: msg.key || '',
      code: msg.code || '',
      text: String(msg.key || '').length === 1 ? msg.key : undefined
    }).catch(() => {});
  }
}

function snapshot() {
  return { url: lastMeta.url, title: lastMeta.title, engine: 'chromium-cdp', running: !!proc };
}

function available() {
  return Boolean(findChrome());
}

module.exports = { ready, handle, snapshot, available, findChrome, startChrome };
