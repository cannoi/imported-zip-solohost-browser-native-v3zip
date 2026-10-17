'use strict';

/**
 * Playwright Chromium engine — full JS/CSS/network/cookies in headless Chromium.
 * Display to SoloHost UI is still via DOM Bridge snapshots (not VNC).
 * Cookies & storage live in the engine context (login can succeed when user types via bridge events).
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const appLog = require('../app-log');

/**
 * Virtual tabs vs hot Chromium pages:
 * - MAX_SESSIONS: metadata slots (up to 50 SoloHost tabs)
 * - MAX_HOT_PAGES: live Chromium pages only (default 6) — inactive tabs are parked
 */
const MAX_SESSIONS = Math.max(8, Math.min(50, Number(process.env.SOLOHOST_PW_MAX_SESSIONS) || 50));
function perfHotPages() {
  const profile = String(process.env.SOLOHOST_PERF_PROFILE || 'balanced').toLowerCase();
  let def = 6;
  if (profile === 'high') def = 10;
  if (profile === 'low') def = 3;
  try {
    const os = require('os');
    const gb = os.totalmem() / (1024 * 1024 * 1024);
    if (profile === 'auto' || !process.env.SOLOHOST_PERF_PROFILE) {
      if (gb >= 8) def = 10;
      else if (gb <= 2) def = 3;
    }
  } catch (_) {}
  return Math.max(2, Math.min(16, Number(process.env.SOLOHOST_MAX_PAGES) || Number(process.env.SOLOHOST_HOT_PAGES) || def));
}
const MAX_HOT_PAGES = perfHotPages();
const MAX_PAGES = MAX_HOT_PAGES; // alias used by page-limit checks
/** Park/close cold sessions idle longer than this (ms). Default 8 minutes. */
const SESSION_IDLE_MS = Math.max(120000, Number(process.env.SOLOHOST_SESSION_IDLE_MS) || 10 * 60 * 1000);
/** After last session closes, fully release Chromium process (ms). Default 2 minutes. */
const ENGINE_IDLE_MS = Math.max(30000, Number(process.env.SOLOHOST_ENGINE_IDLE_MS) || 2 * 60 * 1000);
const NAV_TIMEOUT = Number(process.env.SOLOHOST_PW_NAV_TIMEOUT_MS || 25000);
const DATA = process.env.SOLOHOST_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PROFILE_DIR = path.join(DATA, 'pw-profiles');
const STATE_DIR = path.join(DATA, 'browser-state');
const PERSIST_SESSIONS = String(process.env.SOLOHOST_BROWSER_PERSIST_SESSIONS || '1') !== '0';
const BLOCK_ADS = String(process.env.SOLOHOST_BROWSER_BLOCK_ADS || '1') !== '0';
const storageSaveQueues = new Map();
const dispatchQueues = new Map();
const filteredLogCounts = new Map();

/** Extra Chromium flags to cap renderer/JS memory in Docker. */
function memoryLaunchArgs() {
  return [
    '--renderer-process-limit=3',
    '--js-flags=--max-old-space-size=384',
    '--disable-extensions',
    '--disable-component-extensions-with-background-pages',
    '--disable-background-networking',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-ipc-flooding-protection',
    '--disable-features=TranslateUI,BlinkGenPropertyTrees,InterestFeedContentSuggestions',
    '--disable-hang-monitor',
    '--metrics-recording-only',
    '--mute-audio',
    '--no-first-run'
  ];
}

function fullChromiumArgs(extra) {
  const base = ['--no-sandbox', '--disable-dev-shm-usage'];
  const mem = memoryLaunchArgs();
  const out = base.concat(mem);
  if (Array.isArray(extra)) out.push.apply(out, extra);
  // de-dupe
  return [...new Set(out)];
}

let browser = null;
let selectedEngine = null;
let lastSessionActivity = Date.now();
let _engineReleaseTimer = null;
/** Shared Chromium user-data dirs — one profile survives restarts (cookies, localStorage, IndexedDB). */
const persistentContexts = new Map(); // clientKey -> BrowserContext from launchPersistentContext
/** Headed Chromium for noVNC login only — separate from Bridge engine (never stops Bridge). */
let loginBrowser = null;
let loginContext = null;
let loginPage = null;

const engineCooldowns = new Map();
let launching = null;
const sessions = new Map(); // id -> { context, page, url, title, loading, error, createdAt }

function enabled() {
  return process.env.SOLOHOST_PLAYWRIGHT !== '0';
}

async function getBrowserTypes() {
  // SoloHost Browser: Chromium only (no Firefox / Playwright-WebKit fallback).
  try {
    const pw = require('playwright');
    if (pw.chromium) return { chromium: pw.chromium };
  } catch (_) {}
  try {
    const pw = require('playwright-core');
    if (pw.chromium) return { chromium: pw.chromium };
  } catch (_) {}
  return {};
}

function engineOrder(types) {
  if (types && types.chromium) return ['chromium'];
  return [];
}

function isMobileSession(opts = {}) {
  if (opts.mobile != null) return !!opts.mobile;
  return String(process.env.SOLOHOST_BROWSER_MOBILE || '1') !== '0';
}

function classifyPageType(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl || 'about:blank')); } catch (_) { return 'generic'; }
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const path = u.pathname.toLowerCase();
  if (/(^|\.)((google|bing|duckduckgo|search\.yahoo)\.[a-z.]+)$/.test(host) || /\/(search|results)(\/|$)/.test(path) || ['q','query','search_query'].some(k => u.searchParams.has(k))) return 'search';
  if (/(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com|twitch\.tv|tiktok\.com)$/.test(host) && (/\/(watch|shorts|video|embed|clip|player|live)(\/|$)/.test(path) || host === 'youtu.be' || host === 'player.vimeo.com' || host === 'player.twitch.tv' || (host.endsWith('vimeo.com') && /^\/\d+/.test(path)))) return 'video';
  if (/(amazon\.[a-z.]+|ebay\.[a-z.]+|aliexpress\.com|etsy\.com|shopify\.com|walmart\.com|target\.com)$/.test(host) || /\/(product|products|item|dp|gp\/product|shop)(\/|$)/.test(path)) return 'commerce';
  if (/(facebook\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|reddit\.com|threads\.net)$/.test(host)) return 'social';
  if (/\/(blog|article|articles|news|post|posts|story|stories)(\/|$)/.test(path) || /\.(md|html?)$/.test(path)) return 'article';
  return 'generic';
}
function isTrustedMediaFrame(rawUrl, baseUrl = '') {
  try {
    const u = new URL(String(rawUrl || ''), baseUrl || undefined);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com' ||
      host.endsWith('.youtube-nocookie.com') || host === 'player.vimeo.com' || host === 'open.spotify.com' ||
      host === 'www.tiktok.com' || host === 'player.twitch.tv' || host === 'www.dailymotion.com' || host === 'geo.dailymotion.com';
  } catch (_) { return false; }
}

function profileStatePath(opts = {}) {
  if (!PERSIST_SESSIONS || opts.persist === false) return null;
  const identity = String(opts.clientKey || 'solohost-default-profile').slice(0, 512);
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return path.join(STATE_DIR, key + '.json');
}

function contextOptions(opts = {}, engine = selectedEngine) {
  const mobile = isMobileSession(opts);
  const stateFile = profileStatePath(opts);
  const options = {
    viewport: mobile
      ? { width: Number(process.env.SOLOHOST_MOBILE_W) || 390, height: Number(process.env.SOLOHOST_MOBILE_H) || 844 }
      : { width: Number(process.env.SOLOHOST_DESKTOP_W) || 1280, height: Number(process.env.SOLOHOST_DESKTOP_H) || 800 },
    locale: /^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(String(opts.locale || '')) ? String(opts.locale) : (process.env.SOLOHOST_BROWSER_LOCALE || 'en-US'),
    timezoneId: (() => { const candidate = String(opts.timezoneId || process.env.SOLOHOST_BROWSER_TIMEZONE || 'UTC'); try { new Intl.DateTimeFormat('en-US', { timeZone: candidate }); return candidate; } catch (_) { return 'UTC'; } })(),
    ignoreHTTPSErrors: false,
    javaScriptEnabled: opts.javaScriptEnabled !== false,
    acceptDownloads: true,
    serviceWorkers: 'allow',
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    extraHTTPHeaders: {
      'Accept-Language': String(opts.locale || process.env.SOLOHOST_BROWSER_LOCALE || 'en-US,en;q=0.9')
    }
  };
  if (stateFile && fs.existsSync(stateFile)) options.storageState = stateFile;
  if (mobile) {
    if (opts.userAgent) options.userAgent = opts.userAgent;
    if (engine === 'chromium') { options.isMobile = true; options.hasTouch = true; }
  } else {
    if (opts.userAgent) options.userAgent = opts.userAgent;
  }
  return options;
}

function isAdOrTrackerRequest(rawUrl) {
  if (!BLOCK_ADS) return false;
  try {
    const easylist = require('./easylist-lite');
    return easylist.isBlockedUrl(rawUrl);
  } catch (_) {
    try {
      const u = new URL(rawUrl);
      const host = u.hostname.toLowerCase().replace(/^www\./, '');
      return /doubleclick|googlesyndication|googleadservices|google-analytics|hotjar|scorecardresearch/.test(host);
    } catch (e) { return false; }
  }
}



function profileUserDataDir(opts = {}) {
  const identity = String(opts.clientKey || 'solohost-default-profile').slice(0, 512);
  const key = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
  return path.join(PROFILE_DIR, 'ud_' + key);
}

async function attachAdFilter(context) {
  if (!context || typeof context.route !== 'function') return;
  try {
    await context.route('**/*', async (route) => {
      try {
        const req = route.request();
        const type = req.resourceType();
        const url = req.url();
        // Lightweight snapshot mode: skip heavy binary assets (client loads images from origin when needed)
        if (type === 'image' || type === 'media' || type === 'font') {
          return route.abort();
        }
        if (typeof isAdOrTrackerRequest === 'function' && isAdOrTrackerRequest(url)) {
          return route.abort();
        }
        return route.continue();
      } catch (_) {
        try { await route.continue(); } catch (__) {}
      }
    });
  } catch (_) {}
}



async function newContext(opts = {}) {
  // Ephemeral / private: in-memory browser context (+ optional storageState file restore)
  if (!browser || (browser.isConnected && !browser.isConnected())) await ensureBrowser();
  if (PERSIST_SESSIONS) {
    try { fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(STATE_DIR, 0o700); } catch (_) {}
  }
  const context = await browser.newContext(contextOptions(opts, selectedEngine));
  await attachAdFilter(context);
  return context;
}

/**
 * One shared Chromium profile on disk for non-private sessions.
 * Survives app/container restart when /app/data is volume-mounted.
 */
async function getSessionContext(opts = {}) {
  const privateMode = !!(opts.privateMode || opts.persist === false);
  const clientKey = String(opts.clientKey || 'solohost-default-profile');
  if (privateMode || !PERSIST_SESSIONS) {
    const ctx = await newContext({ ...opts, persist: false });
    return { context: ctx, persistent: false, clientKey };
  }

  if (persistentContexts.has(clientKey)) {
    const existing = persistentContexts.get(clientKey);
    try {
      // Touch context — throws if closed
      existing.pages();
      return { context: existing, persistent: true, clientKey };
    } catch (_) {
      persistentContexts.delete(clientKey);
    }
  }

  const types = await getBrowserTypes();
  const name = 'chromium';
  if (!types.chromium) {
    // Fallback engines: storageState file only
    const ctx = await newContext(opts);
    return { context: ctx, persistent: false, clientKey };
  }

  try { fs.mkdirSync(PROFILE_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
  const userDataDir = profileUserDataDir({ clientKey });
  try { fs.mkdirSync(userDataDir, { recursive: true, mode: 0o700 }); } catch (_) {}

  let args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'];
  const interactiveDisplay = String(process.env.SOLOHOST_BROWSER_HEADFUL || '0') === '1' && !!process.env.DISPLAY;
  if (interactiveDisplay) args = args.concat(['--window-position=0,0', '--window-size=1440,900', '--start-maximized']);
  const baseOpts = contextOptions({ ...opts, persist: false }, name); // no storageState — disk profile is source of truth
  delete baseOpts.storageState;

  const launchArgs = fullChromiumArgs(
    interactiveDisplay ? ['--window-position=0,0', '--window-size=1440,900', '--start-maximized'] : ['--disable-gpu']
  );
  const context = await types.chromium.launchPersistentContext(userDataDir, {
    headless: !interactiveDisplay,
    args: launchArgs,
    viewport: baseOpts.viewport,
    locale: baseOpts.locale,
    timezoneId: baseOpts.timezoneId,
    userAgent: baseOpts.userAgent,
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    acceptDownloads: true,
    serviceWorkers: 'allow',
    colorScheme: baseOpts.colorScheme || 'light',
    extraHTTPHeaders: baseOpts.extraHTTPHeaders,
    isMobile: !!baseOpts.isMobile,
    hasTouch: !!baseOpts.hasTouch
  });
  selectedEngine = name;
  await attachAdFilter(context);
  // Also restore storageState JSON if present (migration from older versions)
  try {
    const stateFile = profileStatePath({ clientKey, persist: true });
    if (stateFile && fs.existsSync(stateFile)) {
      const raw = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      if (raw && Array.isArray(raw.cookies) && raw.cookies.length) {
        await context.addCookies(raw.cookies);
        appLog.log('info', 'playwright.storage_state_merged', { cookies: raw.cookies.length });
      }
    }
  } catch (e) {
    appLog.log('warn', 'playwright.storage_state_merge_fail', { error: String(e.message || e).slice(0, 120) });
  }
  persistentContexts.set(clientKey, context);
  appLog.log('info', 'playwright.persistent_context', { clientKey: clientKey.slice(0, 48), userDataDir: path.basename(userDataDir) });
  return { context, persistent: true, clientKey };
}


function detectChallengeSignals(url, data) {
  try {
    const u = new URL(url || 'about:blank');
    const host = u.hostname.toLowerCase();
    const path = u.pathname.toLowerCase();
    if (host.endsWith('google.com') && path.indexOf('/sorry') === 0) return { challenge: true, reason: 'google_sorry' };
    if (data && data.verificationChallenge) return { challenge: true, reason: 'verification_challenge' };
    if (data && data.hasPassword && /login|signin|oauth|accounts\./i.test(url || '')) {
      return { challenge: false, reason: 'login_form', authForm: true };
    }
  } catch (_) {}
  return { challenge: false, reason: '' };
}

async function forcePersist(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { ok: false, error: 'session_not_found' };
  try {
    await persistSessionState(s);
    const file = profileStatePath(s.opts || {});
    appLog.log('info', 'playwright.session_persisted', { id: sessionId, hasFile: !!(file && fs.existsSync(file)) });
    return { ok: true, path: file ? path.basename(file) : null };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 160) };
  }
}

function listPersistedProfiles() {
  if (!PERSIST_SESSIONS) return [];
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    return fs.readdirSync(STATE_DIR)
      .filter((name) => name.endsWith('.json'))
      .map((name) => {
        const full = path.join(STATE_DIR, name);
        let st = null;
        try { st = fs.statSync(full); } catch (_) {}
        return {
          id: name.replace(/\.json$/, ''),
          bytes: st ? st.size : 0,
          mtime: st ? st.mtime.toISOString() : null
        };
      });
  } catch (_) {
    return [];
  }
}

function clearPersistedProfile(clientKey) {
  const file = profileStatePath({ clientKey: clientKey || 'solohost-default-profile' });
  if (!file) return { ok: false, error: 'persist_disabled' };
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    appLog.log('info', 'playwright.session_cleared', { key: path.basename(file) });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 120) };
  }
}

const _persistTimers = new WeakMap();
function schedulePersist(s) {
  if (!s || (s.opts && s.opts.persist === false)) return;
  try {
    const prev = _persistTimers.get(s);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      persistSessionState(s).catch(() => {});
    }, Math.max(15000, Number(process.env.SOLOHOST_PERSIST_DEBOUNCE_MS) || 60000));
    if (t.unref) t.unref();
    _persistTimers.set(s, t);
  } catch (_) {}
}

async function persistSessionState(s) {
  if (!PERSIST_SESSIONS || !s || !s.context || (s.opts && s.opts.persist === false)) return;
  const file = profileStatePath(s.opts || {});
  if (!file) return;
  const key = file;
  const prior = storageSaveQueues.get(key) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    let current;
    try {
      // Playwright 1.51+ includes IndexedDB snapshots when requested. This complements
      // cookies and localStorage for sites that keep auth/session metadata in IndexedDB.
      try { current = await s.context.storageState({ indexedDB: false }); }
      catch (_) { current = await s.context.storageState(); }
    } catch (_) { return; }
    // The current context is authoritative so an explicit sign-out can remove cookies.
    // Do not merge old cookies back into a fresh state after logout.
    const merged = current;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const tmp = file + '.' + process.pid + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(merged), { mode: 0o600 });
      try { fs.chmodSync(tmp, 0o600); } catch (_) {}
      fs.renameSync(tmp, file);
      try { fs.chmodSync(file, 0o600); } catch (_) {}
    } catch (e) {
      appLog.log('warn', 'playwright.storage_persist_failed', { code: e.code || 'write_failed' });
    }
  });
  storageSaveQueues.set(key, task);
  try { await task; } finally { if (storageSaveQueues.get(key) === task) storageSaveQueues.delete(key); }
}

function attachPopupTracking(state) {
  if (!state || !state.page) return;
  // A popup belongs to its opener tab. Do not listen to context.on('page') here:
  // that event fires for every page in a shared profile and old per-session
  // listeners caused every SoloHost tab to navigate to the same popup URL.
  if (state._popupHookedPage === state.page) return;
  const openerPage = state.page;
  state._popupHookedPage = openerPage;
  openerPage.on('popup', async (popup) => {
    if (!popup) return;
    let popupUrl = '';
    try { popupUrl = popup.url() || ''; } catch (_) {}
    try {
      if (!popupUrl || popupUrl === 'about:blank') {
        await popup.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        try { popupUrl = popup.url() || ''; } catch (_) {}
      }
      const opener = openerPage;
      if (popupUrl && popupUrl !== 'about:blank' && /^https?:/i.test(popupUrl) &&
          opener && !(opener.isClosed && opener.isClosed())) {
        // Serialize popup absorption with navigation for this tab. Other tabs
        // in the same context are intentionally untouched.
        const previous = state.popupNavigationTail || Promise.resolve();
        const task = previous.catch(() => {}).then(async () => {
          if (!opener.isClosed()) {
            await opener.goto(popupUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(NAV_TIMEOUT, 20000) });
            if (state.page === opener) {
              state.url = opener.url();
              state.title = await opener.title().catch(() => state.title);
              state.loading = false;
            }
            appLog.log('info', 'playwright.popup_absorbed', { id: state.id, tabKey: state.tabKey, url: state.url });
          }
        });
        state.popupNavigationTail = task;
        await task.catch((e) => appLog.log('warn', 'playwright.popup_absorb_fail', { id: state.id, detail: String(e && e.message || e).slice(0, 180) }));
      }
    } catch (e) {
      appLog.log('warn', 'playwright.popup_absorb_fail', { id: state.id, detail: String(e && e.message || e).slice(0, 180) });
    } finally {
      try { await popup.close(); } catch (_) {}
    }
  });
}

function findUnownedPage(context, ownerState) {
  let pages = [];
  try { pages = context.pages() || []; } catch (_) {}
  const isOwned = (page) => {
    for (const other of sessions.values()) {
      if (other !== ownerState && other.context === context && other.page === page) return true;
    }
    return false;
  };
  // Reuse an unowned blank page first, then any unowned page. Never steal a
  // page from another SoloHost tab just because it is context.pages()[0].
  for (const page of pages) {
    try { if (!isOwned(page) && (page.url() === 'about:blank' || !page.url())) return page; } catch (_) {}
  }
  for (const page of pages) {
    try { if (!isOwned(page) && !(page.isClosed && page.isClosed())) return page; } catch (_) {}
  }
  return null;
}

async function recoverSession(s) {
  let contextGone = false;
  let pageGone = !s.page || s.suspended || (s.page.isClosed && s.page.isClosed());
  try {
    if (!s.context) contextGone = true;
    else if (s.persistent && persistentContexts.get(s.clientKey) !== s.context) contextGone = true;
  } catch (_) { contextGone = true; }
  try {
    if (s.page && s.page.isClosed && s.page.isClosed()) pageGone = true;
  } catch (_) { pageGone = true; }
  if (contextGone || pageGone) {
    await persistSessionState(s).catch(() => {});
    const lastUrl = s.url || (s.opts && s.opts.lastUrl) || 'about:blank';
    const got = await getSessionContext(s.opts || {});
    s.context = got.context;
    s.persistent = got.persistent;
    s.clientKey = got.clientKey;
    await ensureHotSlot(s.id);
    s.page = findUnownedPage(s.context, s) || await s.context.newPage();
    s.suspended = false;
    attachPopupTracking(s);
    s.page.setDefaultTimeout(NAV_TIMEOUT);
    s.page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    s.error = null;
    if (lastUrl && lastUrl !== 'about:blank' && /^https?:/i.test(lastUrl)) {
      try {
        const cur = s.page.url();
        if (!cur || cur === 'about:blank' || cur !== lastUrl) {
          await s.page.goto(lastUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT }).catch(() => {});
        }
      } catch (_) {}
    }
    appLog.log('warn', 'playwright.session_recovered', { id: s.id, persistent: !!s.persistent, engine: selectedEngine });
  }
  return s.page;
}

/**
 * Open a headed Chromium window on DISPLAY for noVNC login only.
 * Does NOT close or restart the Bridge engine (persistent contexts stay up).
 * Cookies are shared via storageState file so login can return to Bridge sessions.
 */
async function ensureHeadfulDisplay() {
  if (!process.env.DISPLAY) process.env.DISPLAY = ':99';
  const types = await getBrowserTypes();
  if (!types.chromium) return { ok: false, error: 'no_chromium' };

  // Keep Bridge engine running — only start a parallel headed browser for login UI.
  try {
    if (loginPage && loginBrowser) {
      return { ok: true, headful: true, display: process.env.DISPLAY, reused: true, bridgeAlive: true };
    }
  } catch (_) {}

  try {
    if (loginBrowser) { try { await loginBrowser.close(); } catch (_) {} loginBrowser = null; loginContext = null; loginPage = null; }
  } catch (_) {}

  const args = ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'].concat([
    '--window-position=0,0',
    '--window-size=1440,900',
    '--start-maximized'
  ]);

  loginBrowser = await types.chromium.launch({
    headless: false,
    args,
    env: { ...process.env, DISPLAY: process.env.DISPLAY }
  });
  loginBrowser.on('disconnected', () => {
    loginBrowser = null;
    loginContext = null;
    loginPage = null;
    appLog.log('info', 'playwright.login_browser_closed');
  });

  const stateOpts = { clientKey: 'solohost-default-profile', persist: true };
  const stateFile = profileStatePath(stateOpts);
  const ctxOpts = {
    viewport: { width: 1440, height: 900 },
    locale: process.env.SOLOHOST_BROWSER_LOCALE || 'en-US',
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    serviceWorkers: 'allow',
    acceptDownloads: true
  };
  if (stateFile && fs.existsSync(stateFile)) ctxOpts.storageState = stateFile;

  loginContext = await loginBrowser.newContext(ctxOpts);
  loginPage = await loginContext.newPage();
  // Neutral start page — user navigates to login; avoids stealing Bridge tabs.
  try {
    await loginPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
  } catch (_) {}

  // Periodically export cookies so Bridge engine can pick them up after login.
  const sync = async () => {
    try {
      if (!loginContext || !PERSIST_SESSIONS) return;
      const file = profileStatePath(stateOpts);
      if (!file) return;
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const st = await loginContext.storageState({ indexedDB: false }).catch(() => loginContext.storageState());
      fs.writeFileSync(file, JSON.stringify(st), { mode: 0o600 });
    } catch (_) {}
  };
  const timer = setInterval(sync, 15000);
  if (timer.unref) timer.unref();
  loginBrowser._soloSyncTimer = timer;

  appLog.log('info', 'playwright.login_headful_ready', {
    display: process.env.DISPLAY,
    bridgeSessions: sessions.size,
    bridgeContexts: persistentContexts.size
  });
  return {
    ok: true,
    headful: true,
    display: process.env.DISPLAY,
    bridgeAlive: true,
    bridgeSessions: sessions.size
  };
}

async function ensureBrowser() {
  if (browser && (!browser.isConnected || browser.isConnected())) return browser;
  if (launching) return launching;
  launching = (async () => {
    const types = await getBrowserTypes();
    const order = engineOrder(types);
    if (!order.length) {
      const err = new Error('playwright_not_installed');
      err.code = 'NO_PLAYWRIGHT';
      throw err;
    }
    try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (_) {}
    const failures = [];
    for (const name of order) {
      try {
        const args = name === 'chromium' ? fullChromiumArgs(['--disable-gpu']) : undefined;
        const launchedBrowser = await types[name].launch({ headless: true, ...(args ? { args } : {}) });
        browser = launchedBrowser;
        selectedEngine = name;
        launchedBrowser.on('disconnected', () => {
          if (browser === launchedBrowser) {
            engineCooldowns.set(name, Date.now() + 60000);
            browser = null;
            appLog.log('warn', 'playwright.engine_disconnected', { engine: name, fallbackAvailable: true });
          }
        });
        appLog.log('info', 'playwright.launched', { engine: name, fallback: name !== order[0] });
        return browser;
      } catch (e) {
        failures.push(name + ':' + String(e.message || e).slice(0, 140));
        engineCooldowns.set(name, Date.now() + 60000);
        browser = null;
      }
    }
    const err = new Error('browser_engines_unavailable:' + failures.join(' | '));
    err.code = 'NO_BROWSER_ENGINE';
    throw err;
  })();
  try { return await launching; } finally { launching = null; }
}

async function status() {
  if (!enabled()) {
    return { ok: true, ready: false, engine: 'playwright', reason: 'disabled' };
  }
  // Lazy engine: do not launch Chromium on health checks (saves multi-GB RAM when idle).
  const types = await getBrowserTypes();
  if (!Object.keys(types).length) {
    return { ok: true, ready: false, engine: 'playwright', reason: 'not_installed' };
  }
  try {
    const live = !!(browser && (!browser.isConnected || browser.isConnected())) || persistentContexts.size > 0;
    return {
      ok: true,
      ready: true,
      engineLive: live,
      engine: 'playwright-' + (selectedEngine || 'unknown'),
      availableEngines: Object.keys(types),
      engineCooldowns: Object.fromEntries([...engineCooldowns].map(([name, until]) => [name, Math.max(0, until - Date.now())])),
      sessions: sessions.size,
      hotPages: typeof countHotPages === 'function' ? countHotPages() : sessions.size,
      maxSessions: MAX_SESSIONS,
      maxHotPages: MAX_HOT_PAGES,
      cookies: true,
      fullJavascript: true,
      display: 'adaptive-dom-snapshot',
      contentMode: (String(process.env.SOLOHOST_BROWSER_CONTENT_MODE || 'adaptive') === '0') ? 'site-style' : String(process.env.SOLOHOST_BROWSER_CONTENT_MODE || 'adaptive'),
      mobileDefault: isMobileSession(),
      recovery: true,
      persistentSessions: PERSIST_SESSIONS,
      indexedDBPersistence: PERSIST_SESSIONS,
      sessionStateFormat: 'playwright-storage-state-v2',
      javaScriptEnabled: true,
      cookies: true,
      localStorage: true,
      serviceWorkers: true,
      adTrackerFiltering: BLOCK_ADS
    };
  } catch (e) {
    return { ok: true, ready: false, engine: 'playwright', error: String(e.message || e).slice(0, 200) };
  }
}


let _sweepTimer = null;
function isPinned(s) {
  return !!(s && (s.pinned || (s.leaseCount || 0) > 0 || s.agentPinned));
}
function acquireLease(s, owner) {
  if (!s) return false;
  s.leaseCount = (s.leaseCount || 0) + 1;
  s.leaseOwner = owner || s.leaseOwner || 'tab';
  s.pinned = true;
  s.touched = Date.now();
  return true;
}
function releaseLease(s) {
  if (!s) return;
  s.leaseCount = Math.max(0, (s.leaseCount || 1) - 1);
  if (s.leaseCount === 0) {
    s.pinned = false;
    s.leaseOwner = null;
  }
  s.touched = Date.now();
}
function touchSession(s) {
  if (s) s.touched = Date.now();
}
function getSession(id) {
  try { return sessions.get(String(id)) || null; } catch (_) { return null; }
}


async function closeOrphanPages(context) {
  if (!context) return 0;
  let pages = [];
  try { pages = context.pages() || []; } catch (_) { return 0; }
  let closed = 0;
  for (const page of pages) {
    let owned = false;
    for (const s of sessions.values()) {
      if (s.context === context && s.page === page) { owned = true; break; }
    }
    if (owned) continue;
    try {
      if (page.isClosed && page.isClosed()) continue;
      await page.close();
      closed += 1;
    } catch (_) {}
  }
  if (closed) appLog.log('info', 'playwright.orphan_pages_closed', { closed });
  return closed;
}

function countHotPages() {
  let n = 0;
  for (const s of sessions.values()) {
    try {
      if (s.page && !(s.page.isClosed && s.page.isClosed())) n += 1;
    } catch (_) {}
  }
  return n;
}


/** Pre-warm: keep one blank page ready for fast new-tab open. */
let prewarmPage = null;
let prewarmContextKey = null;

async function ensurePrewarm(context, clientKey) {
  try {
    if (prewarmPage && !(prewarmPage.isClosed && prewarmPage.isClosed()) && prewarmContextKey === clientKey) {
      return prewarmPage;
    }
    if (countHotPages() >= MAX_HOT_PAGES - 1) return null;
    prewarmPage = await context.newPage();
    prewarmContextKey = clientKey;
    prewarmPage.setDefaultTimeout(NAV_TIMEOUT);
    try { await prewarmPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 5000 }); } catch (_) {}
    appLog.log('info', 'playwright.prewarm_ready', { clientKey: String(clientKey || '').slice(0, 24) });
    return prewarmPage;
  } catch (e) {
    prewarmPage = null;
    return null;
  }
}

function takePrewarm(context, clientKey) {
  if (prewarmPage && !(prewarmPage.isClosed && prewarmPage.isClosed()) && prewarmContextKey === clientKey) {
    const p = prewarmPage;
    prewarmPage = null;
    prewarmContextKey = null;
    // refill async
    setImmediate(() => { ensurePrewarm(context, clientKey).catch(() => {}); });
    return p;
  }
  return null;
}

/** Drop the live Chromium page but keep session metadata (URL/title) for up to 50 tabs. */
async function parkSession(s, reason) {
  if (!s || s.suspended) return false;
  if (isPinned(s)) {
    appLog.log('info', 'playwright.session_park_skipped', { id: s.id, reason: 'pinned', owner: s.leaseOwner || s.agentPinned });
    return false;
  }
  try {
    if (s.page && !(s.page.isClosed && s.page.isClosed())) {
      try { s.url = s.page.url() || s.url; } catch (_) {}
      try { s.title = await s.page.title(); } catch (_) {}
      persistSessionState(s).catch(() => {});
      try { await s.page.close(); } catch (_) {}
    }
  } catch (_) {}
  s.page = null;
  s.suspended = true;
  s.parkedAt = Date.now();
  s.parkReason = reason || 'idle';
  if (s.persistTimer) {
    try { clearInterval(s.persistTimer); } catch (_) {}
    s.persistTimer = null;
  }
  appLog.log('info', 'playwright.session_parked', {
    id: s.id, tabKey: s.tabKey, url: String(s.url || '').slice(0, 120),
    reason: s.parkReason, idle_ms: Date.now() - (s.touched || s.createdAt || Date.now())
  });
  return true;
}

async function ensureHotSlot(preferKeepId) {
  while (countHotPages() >= MAX_HOT_PAGES) {
    const candidates = [];
    for (const s of sessions.values()) {
      if (preferKeepId && s.id === preferKeepId) continue;
      if (isPinned(s)) continue;
      try {
        if (s.page && !(s.page.isClosed && s.page.isClosed())) {
          candidates.push(s);
        }
      } catch (_) {}
    }
    if (!candidates.length) break;
    candidates.sort((a, b) => (a.touched || a.createdAt || 0) - (b.touched || b.createdAt || 0));
    await parkSession(candidates[0], 'hot_cap');
  }
}

async function releaseEngineIfIdle(force) {
  if (!force && sessions.size > 0) return { released: false, reason: 'sessions_active' };
  if (!force && (Date.now() - lastSessionActivity) < ENGINE_IDLE_MS) {
    return { released: false, reason: 'engine_grace' };
  }
  // Keep headful login browser only while noVNC desktop is up
  let novncUp = false;
  try {
    const novnc = require('../novnc-launcher');
    novncUp = !!(novnc.status && novnc.status().ready);
  } catch (_) {}

  let closedSessions = 0;
  for (const id of [...sessions.keys()]) {
    try { await closeSession(id); closedSessions += 1; } catch (_) {}
  }

  for (const [key, ctx] of [...persistentContexts.entries()]) {
    try {
      await closeOrphanPages(ctx);
      // Persist cookies to disk before killing process
      try {
        const st = await ctx.storageState({ indexedDB: false }).catch(() => ctx.storageState());
        const file = profileStatePath({ clientKey: key, persist: true });
        if (file && st) {
          fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
          fs.writeFileSync(file, JSON.stringify(st), { mode: 0o600 });
        }
      } catch (_) {}
      await ctx.close();
    } catch (_) {}
    persistentContexts.delete(key);
  }

  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
    selectedEngine = null;
  }

  if (!novncUp && loginBrowser) {
    try { if (loginBrowser._soloSyncTimer) clearInterval(loginBrowser._soloSyncTimer); } catch (_) {}
    try { await loginBrowser.close(); } catch (_) {}
    loginBrowser = null; loginContext = null; loginPage = null;
  }

  try {
    if (global.gc) global.gc();
  } catch (_) {}

  appLog.log('info', 'playwright.engine_released', {
    closedSessions,
    novncKept: novncUp,
    force: !!force
  });
  return { released: true, closedSessions, novncKept: novncUp };
}

function scheduleEngineRelease() {
  lastSessionActivity = Date.now();
  if (_engineReleaseTimer) clearTimeout(_engineReleaseTimer);
  _engineReleaseTimer = setTimeout(() => {
    releaseEngineIfIdle(false).catch(() => {});
  }, ENGINE_IDLE_MS);
  if (_engineReleaseTimer.unref) _engineReleaseTimer.unref();
}

async function sweepIdleSessions(forceAllIdle) {
  const now = Date.now();
  const idleLimit = forceAllIdle ? 0 : SESSION_IDLE_MS;
  const victims = [];
  for (const [id, s] of sessions.entries()) {
    if (isPinned(s)) continue; // never sweep leased/pinned (agent task, active tab)
    const touched = s.touched || s.createdAt || 0;
    if (now - touched >= idleLimit) victims.push([id, s, touched]);
  }
  victims.sort((a, b) => a[2] - b[2]);
  for (const [id, s, touched] of victims) {
    try {
      // Soft: park when idle. Hard-close ONLY if already parked AND idle ≥ 2× limit (or force).
      if (forceAllIdle) {
        await closeSession(id);
        continue;
      }
      if (!s.suspended && s.page) {
        await parkSession(s, 'idle');
        continue;
      }
      // Already parked: only close after 2× idle from last touch OR parkedAt
      const parkedAt = s.parkedAt || touched;
      if (s.suspended && (now - parkedAt >= idleLimit * 2)) {
        appLog.log('info', 'playwright.session_close', { id, reason: 'idle_2x', idle_ms: now - parkedAt });
        await closeSession(id);
      }
    } catch (_) {}
  }
  for (const ctx of persistentContexts.values()) {
    try { await closeOrphanPages(ctx); } catch (_) {}
  }
  if (victims.length) {
    appLog.log('info', 'playwright.idle_sweep', { closed: victims.length, remaining: sessions.size });
  }
  if (sessions.size === 0) scheduleEngineRelease();
  else lastSessionActivity = Date.now();
  return victims.length;
}

function ensureSweepTimer() {
  if (_sweepTimer) return;
  _sweepTimer = setInterval(() => {
    sweepIdleSessions(false).then(() => releaseEngineIfIdle(false)).catch(() => {});
  }, Math.max(20000, Number(process.env.SOLOHOST_SWEEP_INTERVAL_MS) || 45000));
  if (_sweepTimer.unref) _sweepTimer.unref();
}

async function createSession(opts = {}) {

  const sessionOpts = {
    ...opts,
    clientKey: String(opts.clientKey || 'solohost-default-profile'),
    persist: opts.persist !== false && !opts.privateMode,
    tabKey: opts.tabKey ? String(opts.tabKey).slice(0, 64) : ''
  };

  // Reuse existing Chromium page for the same SoloHost tab (stop reopen loops).
  if (sessionOpts.tabKey) {
    for (const [sid, st] of sessions.entries()) {
      if (st.tabKey === sessionOpts.tabKey && st.clientKey === sessionOpts.clientKey) {
        let alive = true;
        try {
          if (!st.page || (st.page.isClosed && st.page.isClosed())) alive = false;
        } catch (_) { alive = false; }
        if (alive) {
          st.touched = Date.now();
          appLog.log('info', 'playwright.session_reuse', { id: sid, tabKey: sessionOpts.tabKey });
          return { sessionId: sid, ready: true, reused: true, engine: 'playwright-' + (selectedEngine || 'chromium'), mobile: isMobileSession(opts), persistent: !!st.persistent };
        }
        try { await closeSession(sid); } catch (_) {}
      }
    }
  }

  ensureSweepTimer();
  // Free idle sessions before allocating; prefer least-recently-touched.
  if (sessions.size >= MAX_SESSIONS) {
    await sweepIdleSessions(false);
  }
  while (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => (a[1].touched || a[1].createdAt) - (b[1].touched || b[1].createdAt))[0];
    if (!oldest) break;
    await closeSession(oldest[0]);
  }
  const id = 'pw_' + crypto.randomBytes(6).toString('hex');
  let context, persistent, clientKey;
  try {
    ({ context, persistent, clientKey } = await getSessionContext(sessionOpts));
  } catch (e) {
    await sweepIdleSessions(true).catch(() => {});
    ({ context, persistent, clientKey } = await getSessionContext(sessionOpts));
  }

  // Prefer one page per SoloHost tab: prewarm → unowned blank → newPage.
  await ensureHotSlot(null);
  let page = takePrewarm(context, clientKey) || findUnownedPage(context, null);
  if (!page) {
    await closeOrphanPages(context);
    await ensureHotSlot(null);
    if (countHotPages() >= MAX_HOT_PAGES) {
      await ensureHotSlot(null);
    }
    page = await context.newPage();
  }
  // Keep a spare blank page for the next tab (non-blocking)
  setImmediate(() => { ensurePrewarm(context, clientKey).catch(() => {}); });
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  const state = {
    id,
    opts: sessionOpts,
    context,
    page,
    persistent,
    clientKey,
    tabKey: sessionOpts.tabKey || '',
    url: 'about:blank',
    title: '',
    loading: false,
    error: null,
    createdAt: Date.now(),
    touched: Date.now(),
    suspended: false
  };
  sessions.set(id, state);
  lastSessionActivity = Date.now();
  if (_engineReleaseTimer) { clearTimeout(_engineReleaseTimer); _engineReleaseTimer = null; }
  attachPopupTracking(state);
  if (PERSIST_SESSIONS && sessionOpts.persist !== false) {
    state.persistTimer = setInterval(() => {
      persistSessionState(state).catch(() => {});
    }, Math.max(30000, Number(process.env.SOLOHOST_BROWSER_STATE_SAVE_INTERVAL_MS) || 60000));
    if (state.persistTimer && typeof state.persistTimer.unref === 'function') state.persistTimer.unref();
    page.on('load', () => { state.touched = Date.now(); schedulePersist(state); });
  }
  appLog.log('info', 'playwright.session_create', { id, persistent: !!persistent, tabKey: state.tabKey, clientKey: String(clientKey).slice(0, 40) });
  return { sessionId: id, ready: true, engine: 'playwright-' + (selectedEngine || 'chromium'), mobile: isMobileSession(opts), persistent: !!persistent };
}

async function markInteractive(page) {
  const mode = String(process.env.SOLOHOST_BROWSER_CONTENT_MODE || 'adaptive');
  const pageType = classifyPageType(page.url());
  return page.evaluate(({ mode, pageType }) => {
    let n = 0;
    const sel = 'a,button,input,select,textarea,form,label,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="switch"],[role="option"],[role="menuitem"],[contenteditable="true"],[role="textbox"]';
    document.querySelectorAll(sel).forEach((el) => {
      n += 1;
      el.setAttribute('data-sh-id', 'e' + n);
    });
    const bodyText = (document.body && document.body.innerText) ? document.body.innerText.replace(/\s+/g, ' ').trim() : '';
    const clone = document.documentElement ? document.documentElement.cloneNode(true) : null;
    let optimized = false;
    let removed = 0;
    if (clone) {
      const drop = (selector) => clone.querySelectorAll(selector).forEach((node) => { node.remove(); removed += 1; });
      // Always remove active code from the display copy; the live Chromium page continues
      // running scripts, so links, forms and SPA actions still target the real page.
      drop('script, noscript, template');
      // Conservative, semantic ad markers only. Avoid broad selectors like [class*=ad].
      drop('[data-ad], [data-ad-slot], [data-ad-client], [data-adunit], [aria-label*="advertisement" i], [aria-label*="sponsored ad" i], [id^="google_ads"], [id^="div-gpt-ad"], [class*="advertisement" i], [class*="ad-container" i], [class*="ad-wrapper" i], [class*="sponsored-content" i], [class*="promoted-post" i], [data-testid*="advertisement" i], [data-testid*="sponsored" i]');
      // Keep genuine media embeds; discard arbitrary third-party frames and plugin objects.
      clone.querySelectorAll('iframe').forEach((frame) => {
        const src = frame.getAttribute('src') || '';
        let trusted = false;
        try {
          const u = new URL(src, location.href);
          const h = u.hostname.toLowerCase().replace(/^www\./, '');
          trusted = u.protocol === 'https:' && (h === 'youtube.com' || h.endsWith('.youtube.com') || h === 'youtube-nocookie.com' || h.endsWith('.youtube-nocookie.com') || h === 'player.vimeo.com' || h === 'open.spotify.com' || h === 'tiktok.com' || h.endsWith('.tiktok.com') || h === 'player.twitch.tv' || h === 'dailymotion.com' || h.endsWith('.dailymotion.com'));
        } catch (_) {}
        if (!trusted) { frame.remove(); removed += 1; }
        else { frame.setAttribute('data-sh-safe-media', '1'); frame.setAttribute('loading', 'lazy'); frame.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin'); }
      });
      drop('object, embed');
      // Remove invisible tracking pixels and animated GIF decoration without flattening content.
      clone.querySelectorAll('img').forEach((img) => {
        const src = (img.getAttribute('src') || img.getAttribute('data-src') || '').toLowerCase();
        const width = Number(img.getAttribute('width')) || 0;
        const height = Number(img.getAttribute('height')) || 0;
        if ((width > 0 && width <= 2) || (height > 0 && height <= 2) || /(?:^|[/.?=_-])(?:pixel|tracker|beacon)(?:[/.?=_-]|$)/i.test(src)) {
          img.remove(); removed += 1; return;
        }
        img.setAttribute('loading', 'lazy');
        img.setAttribute('decoding', 'async');
        // Keep srcset in adaptive mode so responsive product/search thumbnails still choose correctly.
        if (mode === 'focused') img.removeAttribute('srcset');
        if (mode === 'focused' && /\.gif(?:[?#]|$)/i.test(src)) {
          const link = img.closest('a');
          const alt = (img.getAttribute('alt') || '').trim();
          if (link && !String(link.textContent || '').trim()) link.append(document.createTextNode(alt || 'Animated image omitted'));
          else if (!link && alt) { const label = document.createElement('span'); label.textContent = alt; img.replaceWith(label); }
          else img.remove();
          removed += 1;
        }
      });
      // Adaptive is the safe default: preserve the site's classes, inline styles and stylesheets.
      // This avoids the old one-column/unstyled layout and keeps product grids and video controls.
      if (mode === 'focused') {
        clone.querySelectorAll('style, link[rel="stylesheet"], link[rel="preload"], link[rel="prefetch"]').forEach((node) => { node.remove(); removed += 1; });
        clone.querySelectorAll('[style]').forEach((node) => node.removeAttribute('style'));
        clone.querySelectorAll('[class]').forEach((node) => node.removeAttribute('class'));
        clone.querySelectorAll('video, audio').forEach((media) => {
          const holder = document.createElement('div');
          holder.setAttribute('data-sh-media-placeholder', '1');
          holder.textContent = 'Media available on original page: ' + (media.getAttribute('aria-label') || (media.tagName.toLowerCase() === 'video' ? 'Video content' : 'Audio content'));
          const poster = media.getAttribute('poster');
          if (poster && /^https?:/i.test(poster)) { const img = document.createElement('img'); img.src = poster; img.alt = holder.textContent; img.loading = 'lazy'; holder.prepend(img); }
          media.replaceWith(holder); removed += 1;
        });
      }
      const cleanHead = clone.querySelector('head');
      if (cleanHead) {
        const css = document.createElement('style');
        css.setAttribute('id', 'solohost-adaptive-layout');
        css.textContent = 'html{max-width:100%;overflow-x:auto;-webkit-text-size-adjust:100%}body{max-width:100%;overflow-wrap:anywhere}img,video,canvas,svg,iframe{max-width:100%}img,video{height:auto}table{max-width:100%}pre,code{overflow-wrap:anywhere}input,textarea,select,button{max-width:100%}@media(max-width:600px){html,body{min-width:0!important}body{overflow-x:auto}input,textarea,select{font-size:16px}pre{white-space:pre-wrap}table{display:block;overflow-x:auto}}' +
          (pageType === 'search' ? 'a{overflow-wrap:anywhere}' : '') +
          (pageType === 'commerce' ? 'img{object-fit:contain}' : '') +
          (pageType === 'video' ? 'video{max-height:75vh}iframe[data-sh-safe-media]{width:100%;aspect-ratio:16/9}' : '') +
          (pageType === 'article' ? 'article img{height:auto}' : '');
        cleanHead.appendChild(css);
      }
      // Sync live form control state into clone attributes (cloneNode skips property values)
      try {
        document.querySelectorAll('[data-sh-id]').forEach((el) => {
          const id = el.getAttribute('data-sh-id');
          if (!id || !clone) return;
          const c = clone.querySelector('[data-sh-id="' + id + '"]');
          if (!c) return;
          const tag = (el.tagName || '').toLowerCase();
          if (tag === 'input') {
            const ty = String(el.type || 'text').toLowerCase();
            if (ty === 'checkbox' || ty === 'radio') {
              if (el.checked) c.setAttribute('checked', 'checked'); else c.removeAttribute('checked');
            } else if (ty !== 'password') {
              c.setAttribute('value', el.value || '');
            }
          } else if (tag === 'textarea') {
            c.textContent = el.value || '';
          } else if (tag === 'select') {
            Array.from(el.options || []).forEach((o, i) => {
              const co = c.querySelectorAll('option')[i];
              if (!co) return;
              if (o.selected) co.setAttribute('selected', 'selected'); else co.removeAttribute('selected');
            });
          }
        });
      } catch (_) {}
      optimized = true;
    }
    return {
      html: clone ? clone.outerHTML : '', optimized, removedNodes: removed,
      url: location.href, title: document.title || '', pageType,
      mapCount: n, textLen: bodyText.length,
      hasPassword: !!document.querySelector('input[type="password"]'),
      hasEmail: !!document.querySelector('input[type="email"],input[type="text"][name*="user"],input[type="text"][name*="email"],input[name="identifier"]'),
      verificationChallenge: /(?:one last step|solve the challenge|verify (?:that )?you(?:'|’)re human|prove you(?:'|’)re not a robot|security check|complete the challenge|turing test)/i.test(bodyText) && /(^|\.)bing\.(com|net)$/i.test(location.hostname)
    };
  }, { mode: mode === '0' ? 'site-style' : mode, pageType });
}

async function navigate(sessionId, url, opts = {}) {
  const s = sessions.get(sessionId);
  if (s) touchSession(s);
  if (!s) throw new Error('session_not_found');
  if (!/^https?:\/\//i.test(url) && url !== 'about:blank') throw new Error('invalid_url');
  await recoverSession(s);
  // Keep the live Chromium page: do not re-goto the same URL unless forced.
  try {
    const cur = (s.page && !(s.page.isClosed && s.page.isClosed())) ? String(s.page.url() || '') : '';
    const norm = (u) => {
      try {
        const x = new URL(u);
        x.hash = '';
        let s = x.href;
        if (s.endsWith('/') && x.pathname !== '/') s = s.slice(0, -1);
        return s;
      } catch (_) { return String(u || ''); }
    };
    if (!opts.forceReload && cur && norm(cur) === norm(url)) {
      s.url = cur;
      s.title = await s.page.title().catch(() => s.title || '');
      s.loading = false;
      s.error = null;
      return { sessionId, url: s.url, title: s.title, loading: false, error: null, ready: true, reused: true };
    }
  } catch (_) {}
  s.loading = true;
  s.error = null;
  s._contentDirty = true;
  try {
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // Smart settle: mutation quiet or short timeout (no long fixed sleeps)
    const pageType = classifyPageType(s.page.url());
    try {
      await Promise.race([
        s.page.waitForLoadState('load', { timeout: 2500 }).catch(() => {}),
        s.page.waitForTimeout(pageType === 'video' || pageType === 'social' ? 320 : 180)
      ]);
    } catch (_) {}
    s.url = s.page.url();
    s.title = await s.page.title().catch(() => '');
    s.loading = false;
    // Debounced disk persist — never block navigation critical path
    persistSessionState(s).catch(() => {});
    return { sessionId, url: s.url, title: s.title, loading: false, error: null, ready: true };
  } catch (e) {
    s.loading = false;
    s.error = String(e.message || e).slice(0, 300);
    s.url = s.page && !(s.page.isClosed && s.page.isClosed()) ? s.page.url() : (s.url || url);
    const closed = /Target page, context or browser has been closed|has been closed/i.test(s.error);
    if (closed) appLog.log('warn', 'playwright.nav_closed_target', { id: sessionId, engine: selectedEngine });
    return { sessionId, url: s.url, title: s.title, loading: false, error: s.error, ready: true, recoverable: closed };
  }
}

async function goBack(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  await recoverSession(s);
  s._contentDirty = true;
  try {
    await s.page.goBack({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    s.url = s.page.url();
    s.title = await s.page.title().catch(() => s.title || '');
    return { sessionId, url: s.url, title: s.title, ok: true };
  } catch (e) {
    return { sessionId, url: s.url, ok: false, error: String(e.message || e).slice(0, 200) };
  }
}
async function goForward(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  await recoverSession(s);
  s._contentDirty = true;
  try {
    await s.page.goForward({ waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    s.url = s.page.url();
    s.title = await s.page.title().catch(() => s.title || '');
    return { sessionId, url: s.url, title: s.title, ok: true };
  } catch (e) {
    return { sessionId, url: s.url, ok: false, error: String(e.message || e).slice(0, 200) };
  }
}
async function captureThumbnail(sessionId, opts) {
  opts = opts || {};
  const s = sessions.get(sessionId);
  if (!s || !s.page || (s.page.isClosed && s.page.isClosed())) return null;
  try {
    const buf = await s.page.screenshot({
      type: 'jpeg',
      quality: Math.min(60, Math.max(25, Number(opts.quality) || 35)),
      scale: 'css',
      animations: 'disabled',
      timeout: 4000
    });
    if (!buf || buf.length > 120000) return null;
    s.thumbDataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
    s.thumbAt = Date.now();
    return s.thumbDataUrl;
  } catch (_) {
    return s.thumbDataUrl || null;
  }
}
async function getContent(sessionId, opts) {
  opts = opts || {};
  const s = sessions.get(sessionId);
  if (s) touchSession(s);
  if (!s) throw new Error('session_not_found');
  await recoverSession(s);
  // Resource optimization: reuse last snapshot when URL unchanged and not forced
  try {
    const liveUrl = s.page && !(s.page.isClosed && s.page.isClosed()) ? String(s.page.url() || '') : '';
    if (
      !opts.force &&
      s._contentCache &&
      s._contentCache.url === liveUrl &&
      s._contentCache.at &&
      (Date.now() - s._contentCache.at) < 2500 &&
      !s._contentDirty
    ) {
      return Object.assign({}, s._contentCache.payload, { cached: true });
    }
  } catch (_) {}
  // Keep native lazy-loading — do NOT force eager (was causing 100s of images to load).
  try {
    await s.page.evaluate(() => {
      document.querySelectorAll('img[data-src]:not([src])').forEach((img) => {
        try {
          const r = img.getBoundingClientRect();
          if (r.top < window.innerHeight * 1.5 && r.bottom > -100 && img.dataset.src) {
            img.src = img.dataset.src;
          }
        } catch (_) {}
      });
    });
  } catch (_) {}
  const data = await markInteractive(s.page);
  s.url = data.url || s.url;
  s.title = data.title || s.title;

  // Black-screen / SPA shell: capture viewport screenshot so UI is not empty
  let screenshot = null;
  const isAuth = /accounts\.google|login|signin|oauth/i.test(s.url || '') || data.hasPassword || data.hasEmail;
  const thin = !data.textLen || data.textLen < 40 || data.mapCount < 1;
  // Login pages must remain interactive DOM, not screenshot-only. The screenshot
  // fallback made Google sign-in controls impossible to focus/type into.
  if (thin && !isAuth && data.mapCount < 1) {
    try {
      const buf = await s.page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
      screenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch (_) {}
  }

  // Only use the video embed fallback for a specific watch URL. Scanning every
  // link on the YouTube home/feed converted the whole home page into a video-card list.
  let youtubeIds = [];
  try {
    const current = new URL(s.url || 'about:blank');
    if (/(^|\.)youtube\.com$/i.test(current.hostname) && /^\/watch\/?$/i.test(current.pathname)) {
      const id = current.searchParams.get('v') || '';
      if (/^[\w-]{11}$/.test(id)) youtubeIds = [id];
    } else if (/^youtu\.be$/i.test(current.hostname)) {
      const id = current.pathname.split('/').filter(Boolean)[0] || '';
      if (/^[\w-]{11}$/.test(id)) youtubeIds = [id];
    }
  } catch (_) {}

  let scrollX = 0;
  let scrollY = 0;
  try {
    const sc = await s.page.evaluate(() => ({
      x: window.scrollX || window.pageXOffset || 0,
      y: window.scrollY || window.pageYOffset || 0,
      w: document.documentElement.scrollWidth || 0,
      h: document.documentElement.scrollHeight || 0
    }));
    scrollX = Number(sc.x) || 0;
    scrollY = Number(sc.y) || 0;
    s.scrollX = scrollX;
    s.scrollY = scrollY;
    s.scrollW = Number(sc.w) || 0;
    s.scrollH = Number(sc.h) || 0;
  } catch (_) {}

  const payload = {
    sessionId,
    url: s.url,
    title: s.title,
    html: data.html || '',
    optimized: !!data.optimized,
    removedNodes: Number(data.removedNodes) || 0,
    mapCount: data.mapCount || 0,
    textLen: data.textLen || 0,
    pageType: data.pageType || classifyPageType(s.url),
    hasPassword: !!data.hasPassword,
    hasEmail: !!data.hasEmail,
    verificationChallenge: !!data.verificationChallenge,
    screenshot,
    youtubeIds,
    scrollX,
    scrollY,
    scrollW: s.scrollW || 0,
    scrollH: s.scrollH || 0,
    loading: s.loading,
    error: s.error,
    engine: 'playwright-' + selectedEngine,
    mobile: isMobileSession(s.opts || {})
  };
  try {
    s._contentCache = { url: s.url, at: Date.now(), payload: Object.assign({}, payload) };
    s._contentDirty = false;
  } catch (_) {}
  return payload;
}

async function getState(sessionId) {
  const s = sessions.get(sessionId);
  if (s) touchSession(s);
  if (!s) throw new Error('session_not_found');
  try {
    s.url = s.page.url();
    s.title = await s.page.title();
  } catch (_) {}
  return {
    sessionId,
    url: s.url,
    title: s.title,
    loading: s.loading,
    error: s.error,
    ready: true,
    engine: 'playwright-' + selectedEngine,
    mobile: isMobileSession(s.opts || {})
  };
}

async function dispatchEventInternal(sessionId, event) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  const type = String(event.type || '').toLowerCase();
  const targetId = String(event.targetId || '').replace(/[^a-zA-Z0-9]/g, '');
  await recoverSession(s);
  const page = s.page;
  if (type !== 'scroll') s._contentDirty = true;

  if (type === 'navigate' && event.url) {
    return navigate(sessionId, String(event.url));
  }
  if (type === 'scroll') {
    await page.evaluate(({ x, y }) => window.scrollTo(x || 0, y || 0), {
      x: Number(event.scrollX) || 0,
      y: Number(event.scrollY) || 0
    });
    return { sessionId, event: type, result: { ok: true }, url: page.url() };
  }
  if (type === 'click' && targetId) {
    const sel = `[data-sh-id="${targetId}"]`;
    await page.click(sel, { timeout: 8000 }).catch(async () => {
      await page.evaluate((id) => {
        const el = document.querySelector('[data-sh-id="' + id + '"]');
        if (el) el.click();
      }, targetId);
    });
    await page.waitForTimeout(180).catch(() => {});
    s.url = s.page.url();
    s.title = await s.page.title().catch(() => s.title);
    await persistSessionState(s);
    return { sessionId, event: type, result: { ok: true }, url: s.url, title: s.title };
  }
  if ((type === 'input' || type === 'change') && targetId) {
    // Values are applied in-engine only and are never written to logs.
    const sel = `[data-sh-id="${targetId}"]`;
    const val = event.value == null ? '' : String(event.value);
    const meta = await page.locator(sel).evaluate((el) => ({
      tag: (el.tagName || '').toLowerCase(), type: String(el.type || '').toLowerCase(),
      editable: el.isContentEditable || el.getAttribute('role') === 'textbox'
    })).catch(() => null);
    if (!meta) return { sessionId, event: type, result: { ok: false, reason: 'target_missing' }, url: page.url() };
    if (meta.tag === 'input' && ['checkbox', 'radio'].includes(meta.type)) {
      if (event.checked || meta.type === 'checkbox') {
        await page.locator(sel).setChecked(!!event.checked, { timeout: 8000 }).catch(() => {});
      }
    } else if (meta.tag === 'select') {
      let selected = false;
      if (event.value != null) selected = !!(await page.locator(sel).selectOption({ value: val }, { timeout: 8000 }).then(() => true).catch(() => false));
      if (!selected && Number.isInteger(Number(event.selectedIndex)) && Number(event.selectedIndex) >= 0) {
        await page.locator(sel).selectOption({ index: Number(event.selectedIndex) }, { timeout: 8000 }).catch(() => {});
      }
    } else {
      await page.locator(sel).fill(val, { timeout: 8000 }).catch(async () => {
        await page.evaluate(({ id, v }) => {
          const el = document.querySelector('[data-sh-id="' + id + '"]');
          if (!el) return;
          el.focus();
          if (el.isContentEditable || el.getAttribute('role') === 'textbox') el.textContent = v;
          else el.value = v;
          el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: v }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }, { id: targetId, v: val });
      });
    }
    return { sessionId, event: type, result: { ok: true }, url: page.url() };
  }
  if (type === 'submit' && targetId) {
    await page.evaluate((id) => {
      const el = document.querySelector('[data-sh-id="' + id + '"]');
      if (!el) return;
      const form = el.tagName === 'FORM' ? el : el.closest('form');
      if (form) {
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.submit();
      } else {
        el.focus();
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
      }
    }, targetId);
    try { await page.locator('[data-sh-id="' + targetId + '"]').press('Enter', { timeout: 2000 }); } catch (_) {}
    await s.page.waitForTimeout(350).catch(() => {});
    s.url = s.page.url();
    await persistSessionState(s);
    return { sessionId, event: type, result: { ok: true, submitted: true }, url: s.url };
  }
  if (type === 'press' || type === 'press_key') {
    const key = String(event.key || event.press || 'Enter');
    if (targetId) {
      try { await page.locator('[data-sh-id="' + targetId + '"]').press(key, { timeout: 5000 }); }
      catch (_) { await page.keyboard.press(key); }
    } else {
      await page.keyboard.press(key);
    }
    await s.page.waitForTimeout(200).catch(() => {});
    s.url = s.page.url();
    return { sessionId, event: type, result: { ok: true, key }, url: s.url };
  }
  if ((type === 'input' || type === 'type') && event.press_enter) {
    try { await page.keyboard.press('Enter'); } catch (_) {}
  }
  throw new Error('unsupported_event:' + type);
}

async function dispatchEvent(sessionId, event) {
  // Serialize events per session. Slow mobile devices and networked SPA controls can
  // otherwise apply text/select/checkbox updates out of order when taps arrive quickly.
  const prior = dispatchQueues.get(sessionId) || Promise.resolve();
  const task = prior.catch(() => {}).then(() => dispatchEventInternal(sessionId, event));
  dispatchQueues.set(sessionId, task);
  try { return await task; }
  finally { if (dispatchQueues.get(sessionId) === task) dispatchQueues.delete(sessionId); }
}

async function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { closed: false };
  if (!(s.opts && s.opts.persist === false)) await persistSessionState(s);
  if (s.persistTimer) clearInterval(s.persistTimer);
  sessions.delete(sessionId);
  try {
    if (s.page && typeof s.page.isClosed === 'function' && !s.page.isClosed()) await s.page.close();
  } catch (_) {}
  // Do not close launchPersistentContext — keeps cookies/login on disk for next session.
  if (!s.persistent) {
    try { await s.context.close(); } catch (_) {}
  }
  appLog.log('info', 'playwright.session_close', { id: sessionId, keptProfile: !!s.persistent });
  if (sessions.size === 0) scheduleEngineRelease();
  else lastSessionActivity = Date.now();
  return { closed: true, sessionId };
}

async function shutdown() {
  for (const id of [...sessions.keys()]) {
    await closeSession(id);
  }
  for (const [key, ctx] of [...persistentContexts.entries()]) {
    try { await ctx.close(); } catch (_) {}
    persistentContexts.delete(key);
  }
  if (loginBrowser) {
    try { if (loginBrowser._soloSyncTimer) clearInterval(loginBrowser._soloSyncTimer); } catch (_) {}
    try { await loginBrowser.close(); } catch (_) {}
    loginBrowser = null; loginContext = null; loginPage = null;
  }
  if (browser) {
    try { await browser.close(); } catch (_) {}
    browser = null;
  }
}

function installShutdownHooks() {
  const stop = () => { shutdown().catch(() => {}); };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

/** Compatible request() surface used by dom-bridge (webkit-style). */
async function request(cmd, args = {}) {
  switch (cmd) {
    case 'engine.status': return status();
    case 'session.create': return createSession(args);
    case 'session.navigate': return navigate(args.sessionId, args.url, args);
    case 'session.getContent': return getContent(args.sessionId);
    case 'session.getState': return getState(args.sessionId);
    case 'session.dispatchEvent': return dispatchEvent(args.sessionId, args);
    case 'session.close': return closeSession(args.sessionId);
    default: throw new Error('unknown_cmd:' + cmd);
  }
}

async function evaluate(sessionId, expression) {
  const s = sessions.get(sessionId);
  if (!s || !s.page) throw new Error('session_not_found');
  return s.page.evaluate(expression);
}


function __getSessionPage(sessionId) {
  const s = sessions.get(sessionId);
  return s && s.page ? s.page : null;
}
async function withPage(sessionId, fn) {
  const s = sessions.get(sessionId);
  if (!s || !s.page) throw new Error('session_not_found');
  return fn(s.page, s);
}

module.exports = {
  evaluate,
  enabled,
  status,
  createSession,
  ensureHeadfulDisplay,
  isAdOrTrackerRequest,
  classifyPageType,
  isTrustedMediaFrame,
  navigate,
  getContent,
  getState,
  dispatchEvent,
  closeSession,
  releaseEngineIfIdle,
  sweepIdleSessions,
  acquireLease,
  releaseLease,
  isPinned,
  getSession,
  touchSession,
  parkSession,
  shutdown,
  installShutdownHooks,
  request,
  forcePersist,
  listPersistedProfiles,
  clearPersistedProfile,
  detectChallengeSignals,
  // alias webkitManager shape
  ensureStarted: ensureBrowser,
  availableEngines: async () => Object.keys(await getBrowserTypes())
};
