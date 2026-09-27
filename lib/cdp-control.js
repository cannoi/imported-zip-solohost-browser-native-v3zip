'use strict';

const http = require('http');
const WebSocket = require('ws');
const engine = require('./engine-manager');

let pageWs = null;
let cmdId = 1;
const pending = new Map();
let meta = { url: '', title: '', lastError: null, lastHttpStatus: null };

// Separate connection for Browser-domain commands (Browser.setWindowBounds
// etc.) — these are only available on the top-level browser DevTools socket,
// not on a page target's socket, which is what `pageWs` above is for.
let browserWs = null;
let browserCmdId = 1;
const browserPending = new Map();
let lastResize = null;

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

function browserSend(method, params) {
  if (!browserWs || browserWs.readyState !== WebSocket.OPEN) return Promise.reject(new Error('browser cdp closed'));
  const id = browserCmdId++;
  return new Promise((resolve, reject) => {
    browserPending.set(id, { resolve, reject });
    browserWs.send(JSON.stringify({ id, method, params: params || {} }));
    setTimeout(() => {
      if (browserPending.has(id)) { browserPending.delete(id); reject(new Error('browser cdp timeout')); }
    }, 8000);
  });
}

async function attachBrowser() {
  if (browserWs && browserWs.readyState === WebSocket.OPEN) return;
  const info = await getJson('/json/version');
  const wsUrl = info && info.webSocketDebuggerUrl;
  if (!wsUrl) throw new Error('no browser-level debugger url');
  browserWs = new WebSocket(wsUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    browserWs.once('open', resolve);
    browserWs.once('error', reject);
  });
  browserWs.on('close', () => { browserWs = null; });
  browserWs.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.id && browserPending.has(msg.id)) {
      const p = browserPending.get(msg.id);
      browserPending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'cdp'));
      else p.resolve(msg.result || {});
    }
  });
}

// Resizes Chromium's real (kiosk) window to (width, height) via the CDP
// Browser domain, then asks engine-manager to re-export exactly that same
// rectangle over VNC (see lib/engine-manager.js respawnVncClip). The two
// always move together so the exported image can never show more or less
// than what Chromium is actually rendering — this is what lets the page
// truly reflow to a portrait or landscape shape instead of being scaled or
// cropped.
async function applyResize(width, height) {
  const w = Math.max(320, Math.round(Number(width) || 0));
  const h = Math.max(240, Math.round(Number(height) || 0));
  if (!w || !h) return { ok: false, error: 'invalid size' };
  if (lastResize && lastResize.w === w && lastResize.h === h) {
    return { ok: true, unchanged: true, width: w, height: h };
  }
  try {
    await attach();
    await attachBrowser();
    let targetId = null;
    try {
      const list = await getJson('/json/list');
      const page = (Array.isArray(list) ? list : []).find((p) => p.type === 'page');
      targetId = page && page.id;
    } catch { /* fall through without a target */ }
    if (targetId) {
      let windowId = null;
      try {
        const win = await browserSend('Browser.getWindowForTarget', { targetId });
        windowId = win && win.windowId;
      } catch { /* best effort: still try the VNC-side clip below */ }
      if (windowId != null) {
        // A kiosk/fullscreen window rejects explicit bounds until it is
        // back in the 'normal' state; ignore failure, it may already be.
        try { await browserSend('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } }); } catch { /* ignore */ }
        await browserSend('Browser.setWindowBounds', { windowId, bounds: { left: 0, top: 0, width: w, height: h, windowState: 'normal' } });
      }
    }
    lastResize = { w, h };
    const vnc = await engine.respawnVncClip(w, h).catch((err) => ({ ok: false, error: err.message }));
    return { ok: true, width: w, height: h, vnc };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}


const tabMap = new Map();
let activeUi = '';
let attachedTarget = '';

function httpPath(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${engine.CDP_PORT}${pathname}`, { timeout: 2500 }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(body ? JSON.parse(body) : {}); } catch { resolve({}); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('cdp timeout')); });
  });
}

async function pages() {
  const list = await getJson('/json/list').catch(() => []);
  return (Array.isArray(list) ? list : []).filter((p) => p.type === 'page');
}

async function attachToTarget(targetId) {
  if (attachedTarget === targetId && pageWs && pageWs.readyState === WebSocket.OPEN) return;
  if (pageWs) {
    try { pageWs.removeAllListeners(); pageWs.close(); } catch { /* ignore */ }
    pageWs = null;
  }
  attachedTarget = '';
  const list = await pages();
  const page = list.find((p) => p.id === targetId) || list[0];
  if (!page || !page.webSocketDebuggerUrl) throw new Error('no page');
  pageWs = new WebSocket(page.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((resolve, reject) => {
    pageWs.once('open', resolve);
    pageWs.once('error', reject);
  });
  pageWs.on('close', () => { if (attachedTarget === page.id) { pageWs = null; attachedTarget = ''; } });
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
  attachedTarget = page.id;
  await send('Page.enable').catch(() => {});
  await send('Network.enable').catch(() => {});
  await send('Runtime.enable').catch(() => {});
  await send('Page.bringToFront').catch(() => {});
}

async function createUiTab(uiId, url) {
  const target = url || 'about:blank';
  if (tabMap.has(uiId)) return activateUiTab(uiId);
  let created = null;
  try { created = await httpPath('/json/new?' + encodeURIComponent(target)); } catch { created = null; }
  const id = created && created.id;
  if (id) tabMap.set(uiId, id);
  else {
    const list = await pages();
    if (list[0]) tabMap.set(uiId, list[0].id);
  }
  return activateUiTab(uiId, target);
}

async function activateUiTab(uiId, fallbackUrl) {
  activeUi = uiId;
  let targetId = tabMap.get(uiId);
  if (!targetId) {
    const list = await pages();
    if (list[0]) {
      targetId = list[0].id;
      tabMap.set(uiId, targetId);
    }
  }
  if (!targetId) throw new Error('no chromium tab');
  try { await httpPath('/json/activate/' + targetId); } catch { /* older builds */ }
  try {
    await attachBrowser();
    await browserSend('Target.activateTarget', { targetId }).catch(() => {});
  } catch { /* optional */ }
  await attachToTarget(targetId);
  return { ok: true, url: meta.url, targetId };
}

async function closeUiTab(uiId) {
  const targetId = tabMap.get(uiId);
  tabMap.delete(uiId);
  if (!targetId) return { ok: true };
  try { await httpPath('/json/close/' + targetId); } catch { /* ignore */ }
  try { await attachBrowser(); await browserSend('Target.closeTarget', { targetId }); } catch { /* ignore */ }
  if (attachedTarget === targetId) {
    if (pageWs) try { pageWs.close(); } catch { /* ignore */ }
    pageWs = null;
    attachedTarget = '';
  }
  return { ok: true };
}

async function handle(msg) {
  if (msg.type === 'resize') {
    try { await attach(); } catch { return { ok: true, skipped: 'resize' }; }
    if (msg.width && msg.height) {
      // Fire-and-forget: don't block the WS message loop on a window resize
      // + x11vnc respawn round trip. applyResize de-dupes unchanged sizes.
      applyResize(msg.width, msg.height).catch(() => {});
    }
    return { ok: true, url: meta.url };
  }
  if (msg.type === 'mouse' || msg.type === 'key' || msg.type === 'wheel') {
    try { await attach(); } catch { return { ok: true, skipped: msg.type }; }
    return { ok: true, url: meta.url };
  }
  if (msg.type === 'activate') {
    if (!msg.id || msg.id === 'home') return { ok: true, url: meta.url };
    return activateUiTab(msg.id);
  }
  if (msg.type === 'close') {
    return closeUiTab(msg.id);
  }
  if (msg.type === 'create') {
    meta.lastError = null;
    return createUiTab(msg.id, msg.url || 'about:blank');
  }
  await attach();
  const type = msg.type;
  if (type === 'navigate') {
    if (msg.id) await activateUiTab(msg.id);
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

module.exports = { handle, snapshot, attach, probe, applyResize };
