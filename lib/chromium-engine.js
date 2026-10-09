'use strict';

/**
 * Chromium engine manager — SoloHost Browser v8 Phase 1.
 *
 * Replaces the native WebKitGTK engine + Xvfb/x11vnc/noVNC pipeline.
 * There is no pixel stream any more: pages are rendered by headless Chromium
 * (Playwright) inside ContentExtractor and delivered as clean article data.
 *
 * It keeps the same public surface the rest of the app already uses:
 *   start() / stop() / handle(msg) / snapshot() / ready()
 * plus new content accessors: extract(url) / getContent(tabId).
 */

const fs = require('fs');
const path = require('path');
const { ContentExtractor } = require('./content-extractor');

const PROFILE = process.env.SOLOHOST_BROWSER_DATA || '/app/data/webkit-profile'; // legacy folder name kept for existing volumes
const DOWNLOADS = process.env.SOLOHOST_DOWNLOADS || path.join(PROFILE, 'downloads');
const LOAD_TIMEOUT = Math.max(10000, Number(process.env.SOLOHOST_NAV_TIMEOUT_MS || 30000));
const MAX_TABS = 12;
const MAX_HISTORY = 50;
const DUPLICATE_WINDOW_MS = 3000;
const NO_OP_TYPES = new Set([
  'zoom', 'fullscreen', 'find', 'find-next', 'find-prev', 'stop',
  'media-play', 'media-mute', 'media-volume', 'media-captions', 'media-fullscreen', 'state'
]);

function readPpid(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    return Number(stat.slice(close + 2).trim().split(/\s+/)[1]);
  } catch { return null; }
}

/** Find the Chromium process spawned by this Node process (Linux only, best effort). */
function findChromiumPid() {
  try {
    for (const entry of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(entry)) continue;
      const pid = Number(entry);
      if (readPpid(pid) !== process.pid) continue;
      let cmd = '';
      try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch { continue; }
      if (/chrom/i.test(cmd.split('\0')[0] || '')) return pid;
    }
  } catch { /* not Linux or /proc unavailable */ }
  return null;
}

function createEngine(options = {}) {
  const extractor = options.extractor || new ContentExtractor(options.extractorOptions);

  let status = 'STARTING';
  let lastError = null;
  let restarts = 0;
  let startedAt = 0;
  let startPromise = null;
  let stopping = false;
  let watchdogTimer = null;
  let restartTimer = null;
  let backoffMs = 2000;
  let rev = 1;
  let pidCache = { at: 0, pid: null };

  const tabs = new Map(); // id -> tab
  let active = 'home';
  const inflight = new Map();

  function bump() { rev += 1; }
  function newId() { return `tab-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`; }

  function profileHealthy() {
    try {
      fs.mkdirSync(PROFILE, { recursive: true });
      fs.mkdirSync(DOWNLOADS, { recursive: true });
      fs.accessSync(PROFILE, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch (e) {
      lastError = `profile unavailable: ${e.message}`;
      return false;
    }
  }

  /* ---------- lifecycle ---------- */

  async function start() {
    if (status === 'READY' || status === 'DEGRADED') return;
    if (startPromise) return startPromise;
    stopping = false;
    startPromise = (async () => {
      status = 'STARTING';
      lastError = null;
      if (!profileHealthy()) { status = 'CRASHED'; throw new Error(lastError); }
      try {
        await extractor.warmUp();
        status = 'READY';
        startedAt = Date.now();
        backoffMs = 2000;
        startWatchdog();
      } catch (e) {
        lastError = e.message;
        status = 'CRASHED';
        scheduleRestart();
        throw e;
      }
    })().finally(() => { startPromise = null; bump(); });
    return startPromise;
  }

  function scheduleRestart() {
    if (restartTimer || stopping) return;
    // A missing dependency will not fix itself; retry slowly instead of spinning.
    const delay = Math.min(60000, backoffMs);
    backoffMs = Math.min(60000, backoffMs * 2);
    restartTimer = setTimeout(async () => {
      restartTimer = null;
      if (stopping) return;
      restarts += 1;
      try { await start(); } catch { /* start() reschedules itself */ }
    }, delay);
    if (restartTimer.unref) restartTimer.unref();
  }

  function startWatchdog() {
    if (watchdogTimer) clearInterval(watchdogTimer);
    watchdogTimer = setInterval(async () => {
      if (stopping || status === 'STARTING') return;
      if (extractor.isAlive()) { if (status === 'DEGRADED') status = 'READY'; return; }
      try {
        await extractor.warmUp();
        restarts += 1;
        status = 'READY';
        lastError = null;
      } catch (e) {
        lastError = e.message;
        status = 'DEGRADED';
      }
    }, 10000);
    if (watchdogTimer.unref) watchdogTimer.unref();
  }

  async function stop() {
    stopping = true;
    status = 'STOPPING';
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (restartTimer) clearTimeout(restartTimer);
    watchdogTimer = restartTimer = null;
    try { await extractor.close(); } catch { /* ignore */ }
    status = 'STOPPED';
  }

  async function ensureStarted() {
    if (status === 'READY' || status === 'DEGRADED') return;
    await start();
  }

  function ready() { return status === 'READY' || status === 'DEGRADED'; }

  /* ---------- tabs ---------- */

  function tabView(t) {
    return { id: t.id, url: t.url, title: t.title, loading: !!t.loading, error: t.error || null };
  }

  function stateSnapshot() {
    return { ok: true, engine: 'chromium', active, tabs: Array.from(tabs.values()).map(tabView) };
  }

  function createTab(id) {
    if (tabs.size >= MAX_TABS) {
      const oldest = tabs.keys().next().value;
      tabs.delete(oldest);
    }
    const tab = {
      id: id || newId(), url: 'about:blank', title: '', loading: false, error: null,
      history: [], index: -1, content: null, lastRequested: '', lastAt: 0, locale: null
    };
    tabs.set(tab.id, tab);
    bump();
    return tab;
  }

  function currentTab(id) {
    const key = id || active;
    return tabs.get(key) || null;
  }

  function pushHistory(tab, url) {
    if (tab.history[tab.index] === url) return;
    tab.history = tab.history.slice(0, tab.index + 1);
    tab.history.push(url);
    if (tab.history.length > MAX_HISTORY) tab.history.shift();
    tab.index = tab.history.length - 1;
  }

  async function navigateTab(tab, url, { push = true, force = false } = {}) {
    const key = `${tab.id}|${url}`;
    if (!force) {
      if (inflight.has(key)) return inflight.get(key);
      // The shell asks for the same URL twice (WebSocket create + REST navigate); serve the first result.
      if (tab.lastRequested === url && tab.content && Date.now() - tab.lastAt < DUPLICATE_WINDOW_MS) return tab.content;
    }
    const job = (async () => {
      tab.loading = true;
      tab.error = null;
      tab.lastRequested = url;
      bump();
      try {
        if (url === 'about:blank') {
          tab.url = url; tab.title = ''; tab.content = null;
          if (push) pushHistory(tab, url);
          return null;
        }
        await ensureStarted();
        const result = await extractor.extract(url, { locale: tab.locale || undefined });
        tab.content = result;
        tab.url = result.final_url || url;
        tab.title = String(result.title || result.site_name || tab.url).slice(0, 120);
        tab.lastAt = Date.now();
        if (push) pushHistory(tab, tab.url);
        return result;
      } catch (err) {
        tab.error = { code: err.code || 'ERROR', message: String(err.message || err).slice(0, 300) };
        tab.content = null;
        tab.url = url;
        throw err;
      } finally {
        tab.loading = false;
        bump();
      }
    })().finally(() => { inflight.delete(key); });
    inflight.set(key, job);
    return job;
  }

  /* ---------- command protocol (same message types as before) ---------- */

  async function handle(msg = {}) {
    const type = String(msg.type || '');
    let tab = null;

    if (type === 'create') {
      tab = createTab(msg.id);
      active = tab.id;
      if (msg.locale) tab.locale = String(msg.locale);
      if (msg.url) await navigateTab(tab, String(msg.url));
    } else if (type === 'activate') {
      if (msg.id === 'home' || tabs.has(msg.id)) { active = msg.id; bump(); }
      tab = currentTab(msg.id);
    } else if (type === 'close') {
      tabs.delete(msg.id);
      if (active === msg.id) active = Array.from(tabs.keys()).pop() || 'home';
      bump();
    } else if (type === 'navigate') {
      tab = currentTab(msg.id) || createTab();
      active = tab.id;
      await navigateTab(tab, String(msg.url || 'about:blank'));
    } else if (type === 'back' || type === 'forward') {
      tab = currentTab(msg.id);
      if (tab) {
        const next = tab.index + (type === 'back' ? -1 : 1);
        if (next >= 0 && next < tab.history.length) {
          tab.index = next;
          await navigateTab(tab, tab.history[next], { push: false, force: true });
        }
      }
    } else if (type === 'reload') {
      tab = currentTab(msg.id);
      if (tab && tab.url) await navigateTab(tab, tab.url, { push: false, force: true });
    } else if (NO_OP_TYPES.has(type)) {
      tab = currentTab(msg.id);
    }

    const view = tab || currentTab();
    return {
      ok: ready(),
      engine: 'chromium',
      url: view ? view.url : '',
      title: view ? view.title : '',
      state: stateSnapshot()
    };
  }

  /* ---------- content API ---------- */

  async function extract(url, opts = {}) {
    await ensureStarted();
    return extractor.extract(url, opts);
  }

  function getContent(id) {
    const tab = currentTab(id);
    if (!tab) return { rev, active, tab: null, content: null, loading: false, error: null };
    return { rev, active, tab: tabView(tab), content: tab.content, loading: !!tab.loading, error: tab.error || null };
  }

  function revision() { return { rev, active, loading: Array.from(tabs.values()).some(t => t.loading) }; }

  /* ---------- diagnostics ---------- */

  function chromiumPid() {
    if (Date.now() - pidCache.at > 5000) pidCache = { at: Date.now(), pid: extractor.isAlive() ? findChromiumPid() : null };
    return pidCache.pid;
  }

  function snapshot() {
    return {
      status: status.toLowerCase(),
      engine: 'chromium',
      mode: 'headless-extract',
      display: 'none',
      error: lastError,
      restarts,
      uptime: startedAt ? Date.now() - startedAt : 0,
      profile: PROFILE,
      downloads: DOWNLOADS,
      tabs: Array.from(tabs.values()).map(tabView),
      active,
      loadTimeoutMs: LOAD_TIMEOUT,
      processIds: { chromium: chromiumPid() },
      extractor: extractor.stats()
    };
  }

  return { start, stop, handle, snapshot, ready, extract, getContent, revision, extractor };
}

const engine = createEngine();
engine.createEngine = createEngine;
module.exports = engine;
