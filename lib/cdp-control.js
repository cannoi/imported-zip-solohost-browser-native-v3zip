'use strict';

const http = require('http');
const WebSocket = require('ws');
const engine = require('./engine-manager');

let pageWs = null;
let cmdId = 1;
const pending = new Map();
let meta = { url: '', title: '', lastError: null, lastHttpStatus: null };

function getJson(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${engine.CDP_PORT}${pathname}`, { timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body || 'null')); } catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('cdp timeout')); });
  });
}

function send(method, params) {
  if (!pageWs || pageWs.readyState !== WebSocket.OPEN) return Promise.reject(new Error('cdp closed'));
  const id = cmdId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    pageWs.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error('cdp timeout')); }
    }, 10000);
  });
}

async function ensurePage() {
  let list = [];
  try { list = await getJson('/json/list'); } catch { list = []; }
  let page = (Array.isArray(list) ? list : []).find((p) => p.type === 'page' && p.webSocketDebuggerUrl);
  if (page) return page;
  try { page = await getJson('/json/new?about:blank'); } catch { page = null; }
  if (page && page.webSocketDebuggerUrl) return page;
  throw new Error('no page');
}

async function attach() {
  if (pageWs && pageWs.readyState === WebSocket.OPEN) return;
  let last = null;
  for (let i = 0; i < 8; i++) {
    try {
      const page = await ensurePage();
      pageWs = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
      await new Promise((resolve, reject) => {
        pageWs.once('open', resolve);
        pageWs.once('error', reject);
      });
      pageWs.on('close', () => { pageWs = null; });
      pageWs.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (msg.id && pending.has(msg.id)) {
          const p = pending.get(msg.id);
          pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message || 'cdp'));
          else p.resolve(msg.result || {});
        }
        if (msg.method === 'Page.frameNavigated' && msg.params && msg.params.frame && !msg.params.frame.parentId) {
          meta.url = msg.params.frame.url || meta.url;
        }
        if (msg.method === 'Network.loadingFailed' && msg.params && msg.params.errorText) {
          meta.lastError = msg.params.errorText;
        }
        if (msg.method === 'Network.responseReceived' && msg.params && msg.params.response) {
          meta.lastHttpStatus = msg.params.response.status;
        }
      });
      await send('Page.enable').catch(() => {});
      await send('Network.enable').catch(() => {});
      await send('Runtime.enable').catch(() => {});
      return;
    } catch (err) {
      last = err;
      pageWs = null;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  throw last || new Error('cdp attach failed');
}

async function handle(msg) {
  if (msg.type === 'activate' || msg.type === 'resize' || msg.type === 'mouse' || msg.type === 'key' || msg.type === 'wheel') {
    try { await attach(); } catch { return { ok: true, skipped: msg.type }; }
    return { ok: true, url: meta.url };
  }
  await attach();
  const type = msg.type;
  if (type === 'create' || type === 'navigate') {
    meta.url = msg.url || meta.url;
    meta.lastError = null;
    await send('Page.navigate', { url: msg.url || 'about:blank' });
    return { ok: true, url: meta.url };
  }
  if (type === 'back') await send('Page.goBack').catch(() => {});
  if (type === 'forward') await send('Page.goForward').catch(() => {});
  if (type === 'reload') await send('Page.reload').catch(() => {});
  if (type === 'evaluate') {
    return send('Runtime.evaluate', { expression: String(msg.expression || ''), returnByValue: true });
  }
  return { ok: true, url: meta.url };
}

async function probe(url) {
  const target = url || 'https://example.com/';
  try {
    await attach();
    meta.lastError = null;
    await send('Page.navigate', { url: target });
    const href = await send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => ({}));
    const pageUrl = (href.result && href.result.value) || meta.url;
    return {
      ok: !meta.lastError && /^https?:/i.test(String(pageUrl)),
      url: pageUrl,
      error: meta.lastError,
      httpStatus: meta.lastHttpStatus
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function snapshot() {
  return { ...meta };
}

module.exports = { handle, snapshot, attach, probe };
