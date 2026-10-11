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

const MAX_SESSIONS = Number(process.env.SOLOHOST_PW_MAX_SESSIONS || 4);
const NAV_TIMEOUT = Number(process.env.SOLOHOST_PW_NAV_TIMEOUT_MS || 25000);
const DATA = process.env.SOLOHOST_DATA_DIR || path.join(__dirname, '..', '..', 'data');
const PROFILE_DIR = path.join(DATA, 'pw-profiles');

let browser = null;
let launching = null;
const sessions = new Map(); // id -> { context, page, url, title, loading, error, createdAt }

function enabled() {
  return process.env.SOLOHOST_PLAYWRIGHT !== '0';
}

async function getChromium() {
  // Prefer full playwright, then playwright-core
  try { return require('playwright').chromium; } catch (_) {}
  try { return require('playwright-core').chromium; } catch (_) {}
  return null;
}

async function ensureBrowser() {
  if (browser) return browser;
  if (launching) return launching;
  launching = (async () => {
    const chromium = await getChromium();
    if (!chromium) {
      const err = new Error('playwright_not_installed');
      err.code = 'NO_PLAYWRIGHT';
      throw err;
    }
    try { fs.mkdirSync(PROFILE_DIR, { recursive: true }); } catch (_) {}
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer'
      ]
    });
    browser.on('disconnected', () => { browser = null; });
    appLog.log('info', 'playwright.launched', {});
    return browser;
  })();
  try {
    return await launching;
  } finally {
    launching = null;
  }
}

async function status() {
  if (!enabled()) {
    return { ok: true, ready: false, engine: 'playwright', reason: 'disabled' };
  }
  const chromium = await getChromium();
  if (!chromium) {
    return { ok: true, ready: false, engine: 'playwright', reason: 'not_installed' };
  }
  try {
    await ensureBrowser();
    return {
      ok: true,
      ready: !!browser,
      engine: 'playwright-chromium',
      sessions: sessions.size,
      maxSessions: MAX_SESSIONS,
      cookies: true,
      fullJavascript: true,
      display: 'dom-bridge-snapshot'
    };
  } catch (e) {
    return { ok: true, ready: false, engine: 'playwright', error: String(e.message || e).slice(0, 200) };
  }
}

async function createSession(opts = {}) {
  await ensureBrowser();
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) await closeSession(oldest[0]);
  }
  const id = 'pw_' + crypto.randomBytes(6).toString('hex');
  const userDir = path.join(PROFILE_DIR, id);
  try { fs.mkdirSync(userDir, { recursive: true }); } catch (_) {}

  const context = await browser.newContext({
    viewport: { width: 1280, height: 720 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    locale: opts.locale || 'en-US',
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    acceptDownloads: false
  });
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  const state = {
    id,
    context,
    page,
    url: 'about:blank',
    title: '',
    loading: false,
    error: null,
    createdAt: Date.now()
  };
  sessions.set(id, state);
  appLog.log('info', 'playwright.session_create', { id });
  return { sessionId: id, ready: true, engine: 'playwright' };
}

async function markInteractive(page) {
  return page.evaluate(() => {
    let n = 0;
    const sel = 'a,button,input,select,textarea,form,[role="button"],[contenteditable="true"],[role="textbox"]';
    document.querySelectorAll(sel).forEach((el) => {
      n += 1;
      el.setAttribute('data-sh-id', 'e' + n);
    });
    // Visible text length (helps detect "black shell" SPA)
    const bodyText = (document.body && document.body.innerText) ? document.body.innerText.replace(/\s+/g, ' ').trim() : '';
    // Keep structure; scripts removed only in transfer copy
    const clone = document.documentElement ? document.documentElement.cloneNode(true) : null;
    if (clone) {
      clone.querySelectorAll('script').forEach((s) => s.remove());
    }
    return {
      html: clone ? clone.outerHTML : '',
      url: location.href,
      title: document.title || '',
      mapCount: n,
      textLen: bodyText.length,
      hasPassword: !!document.querySelector('input[type="password"]'),
      hasEmail: !!document.querySelector('input[type="email"],input[type="text"][name*="user"],input[type="text"][name*="email"],input[name="identifier"]')
    };
  });
}

async function navigate(sessionId, url) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  if (!/^https?:\/\//i.test(url) && url !== 'about:blank') throw new Error('invalid_url');
  s.loading = true;
  s.error = null;
  try {
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // brief settle for SPA
    await s.page.waitForTimeout(1200).catch(() => {});
    try { await s.page.waitForLoadState('networkidle', { timeout: 8000 }); } catch (_) {}
    s.url = s.page.url();
    s.title = await s.page.title().catch(() => '');
    s.loading = false;
    return { sessionId, url: s.url, title: s.title, loading: false, error: null, ready: true };
  } catch (e) {
    s.loading = false;
    s.error = String(e.message || e).slice(0, 300);
    s.url = s.page.url();
    return { sessionId, url: s.url, title: s.title, loading: false, error: s.error, ready: true };
  }
}

async function getContent(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  const data = await markInteractive(s.page);
  s.url = data.url || s.url;
  s.title = data.title || s.title;

  // Black-screen / SPA shell: capture viewport screenshot so UI is not empty
  let screenshot = null;
  const thin = !data.textLen || data.textLen < 40 || data.mapCount < 1;
  const isAuth = /accounts\.google|login|signin|oauth/i.test(s.url || '');
  if (thin || isAuth || data.hasPassword) {
    try {
      const buf = await s.page.screenshot({ type: 'jpeg', quality: 72, fullPage: false });
      screenshot = 'data:image/jpeg;base64,' + buf.toString('base64');
    } catch (_) {}
  }

  // YouTube: extract watch IDs for embed fallback in bridge HTML
  let youtubeIds = [];
  try {
    if (/youtube\.com|youtu\.be/i.test(s.url || '')) {
      youtubeIds = await s.page.evaluate(() => {
        const ids = new Set();
        document.querySelectorAll('a[href*="watch"],a[href*="youtu.be"]').forEach((a) => {
          try {
            const u = new URL(a.href, location.href);
            const v = u.searchParams.get('v');
            if (v) ids.add(v);
            const m = u.pathname.match(/\/([\w-]{11})/);
            if (u.hostname.includes('youtu.be') && m) ids.add(m[1]);
          } catch (_) {}
        });
        const m2 = location.href.match(/[?&]v=([\w-]{11})/);
        if (m2) ids.add(m2[1]);
        return Array.from(ids).slice(0, 12);
      });
    }
  } catch (_) {}

  return {
    sessionId,
    url: s.url,
    title: s.title,
    html: data.html || '',
    mapCount: data.mapCount || 0,
    textLen: data.textLen || 0,
    hasPassword: !!data.hasPassword,
    hasEmail: !!data.hasEmail,
    screenshot,
    youtubeIds,
    loading: s.loading,
    error: s.error,
    engine: 'playwright'
  };
}

async function getState(sessionId) {
  const s = sessions.get(sessionId);
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
    engine: 'playwright'
  };
}

async function dispatchEvent(sessionId, event) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  const type = String(event.type || '').toLowerCase();
  const targetId = String(event.targetId || '').replace(/[^a-zA-Z0-9]/g, '');
  const page = s.page;

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
    await page.waitForTimeout(300).catch(() => {});
    s.url = page.url();
    s.title = await page.title().catch(() => s.title);
    return { sessionId, event: type, result: { ok: true }, url: s.url, title: s.title };
  }
  if ((type === 'input' || type === 'change') && targetId) {
    // Value is applied in-engine only — never write to logs
    const sel = `[data-sh-id="${targetId}"]`;
    const val = event.value == null ? '' : String(event.value);
    await page.fill(sel, val, { timeout: 8000 }).catch(async () => {
      await page.evaluate(({ id, v }) => {
        const el = document.querySelector('[data-sh-id="' + id + '"]');
        if (!el) return;
        el.focus();
        el.value = v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }, { id: targetId, v: val });
    });
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
      }
    }, targetId);
    await page.waitForTimeout(500).catch(() => {});
    s.url = page.url();
    return { sessionId, event: type, result: { ok: true, submitted: true }, url: s.url };
  }
  throw new Error('unsupported_event:' + type);
}

async function closeSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { closed: false };
  sessions.delete(sessionId);
  try { await s.context.close(); } catch (_) {}
  appLog.log('info', 'playwright.session_close', { id: sessionId });
  return { closed: true, sessionId };
}

async function shutdown() {
  for (const id of [...sessions.keys()]) {
    await closeSession(id);
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
    case 'session.navigate': return navigate(args.sessionId, args.url);
    case 'session.getContent': return getContent(args.sessionId);
    case 'session.getState': return getState(args.sessionId);
    case 'session.dispatchEvent': return dispatchEvent(args.sessionId, args);
    case 'session.close': return closeSession(args.sessionId);
    default: throw new Error('unknown_cmd:' + cmd);
  }
}

module.exports = {
  enabled,
  status,
  createSession,
  navigate,
  getContent,
  getState,
  dispatchEvent,
  closeSession,
  shutdown,
  installShutdownHooks,
  request,
  // alias webkitManager shape
  ensureStarted: ensureBrowser
};
