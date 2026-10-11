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
const STATE_DIR = path.join(DATA, 'browser-state');
const PERSIST_SESSIONS = String(process.env.SOLOHOST_BROWSER_PERSIST_SESSIONS || '1') !== '0';
const BLOCK_ADS = String(process.env.SOLOHOST_BROWSER_BLOCK_ADS || '1') !== '0';
const storageSaveQueues = new Map();
const dispatchQueues = new Map();
const filteredLogCounts = new Map();

let browser = null;
let selectedEngine = null;
const engineCooldowns = new Map();
let launching = null;
const sessions = new Map(); // id -> { context, page, url, title, loading, error, createdAt }

function enabled() {
  return process.env.SOLOHOST_PLAYWRIGHT !== '0';
}

async function getBrowserTypes() {
  // Playwright ships the three supported engines; Docker images may only install a subset.
  try {
    const pw = require('playwright');
    return { chromium: pw.chromium, firefox: pw.firefox, webkit: pw.webkit };
  } catch (_) {}
  try {
    const pw = require('playwright-core');
    return { chromium: pw.chromium, firefox: pw.firefox, webkit: pw.webkit };
  } catch (_) {}
  return {};
}

function engineOrder(types) {
  const preferred = String(process.env.SOLOHOST_BROWSER_ENGINE || 'chromium').toLowerCase();
  const all = [preferred, 'chromium', 'firefox', 'webkit'].filter((v, i, a) => ['chromium','firefox','webkit'].includes(v) && a.indexOf(v) === i);
  const installed = all.filter((name) => types[name]);
  const healthy = installed.filter((name) => (engineCooldowns.get(name) || 0) <= Date.now());
  return healthy.length ? healthy : installed;
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
  const width = Math.max(320, Number(opts.width) || (mobile ? 412 : 1280));
  const height = Math.max(480, Number(opts.height) || (mobile ? 915 : 800));
  const options = {
    viewport: { width, height },
    locale: opts.locale || process.env.SOLOHOST_BROWSER_LOCALE || 'vi-VN',
    timezoneId: process.env.SOLOHOST_BROWSER_TIMEZONE || 'Asia/Ho_Chi_Minh',
    ignoreHTTPSErrors: false,
    javaScriptEnabled: true,
    reducedMotion: 'reduce',
    acceptDownloads: true
  };
  const stateFile = profileStatePath(opts);
  if (stateFile && fs.existsSync(stateFile)) options.storageState = stateFile;
  if (mobile) {
    // Match the bundled Chromium 131 engine rather than spoofing an unrelated browser build.
    options.userAgent = opts.userAgent || 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
    if (engine === 'chromium') { options.isMobile = true; options.hasTouch = true; }
  } else {
    options.userAgent = opts.userAgent || 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
  }
  return options;
}

function isAdOrTrackerRequest(rawUrl) {
  if (!BLOCK_ADS) return false;
  try {
    const u = new URL(rawUrl);
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    const blockedHosts = [
      'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
      'adservice.google.com', 'adnxs.com', 'adsrvr.org', 'criteo.com',
      'taboola.com', 'outbrain.com', 'adroll.com', 'pubmatic.com',
      'openx.net', 'scorecardresearch.com', 'analytics.tiktok.com',
      'google-analytics.com', 'hotjar.com'
    ];
    return blockedHosts.some((domain) => host === domain || host.endsWith('.' + domain));
  } catch (_) { return false; }
}

async function newContext(opts = {}) {
  if (!browser || (browser.isConnected && !browser.isConnected())) await ensureBrowser();
  if (PERSIST_SESSIONS) {
    try { fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 }); fs.chmodSync(STATE_DIR, 0o700); } catch (_) {}
  }
  const context = await browser.newContext(contextOptions(opts, selectedEngine));
  if (BLOCK_ADS) {
    try {
      await context.route('**/*', async (route) => {
        const request = route.request();
        const requestUrl = request.url();
        // Do not filter resources requested by Bing pages: verification widgets and
        // challenge telemetry must be allowed to run normally. This is compatibility,
        // not a CAPTCHA bypass; the user still completes the site's own challenge.
        let initiatorHost = '';
        try { initiatorHost = new URL(request.frame().url()).hostname.toLowerCase(); } catch (_) {}
        const bingInitiated = initiatorHost === 'bing.com' || initiatorHost.endsWith('.bing.com') ||
          initiatorHost === 'bing.net' || initiatorHost.endsWith('.bing.net');
        if (!bingInitiated && isAdOrTrackerRequest(requestUrl)) {
          let host = 'unknown';
          try { host = new URL(requestUrl).hostname.toLowerCase(); } catch (_) {}
          const count = filteredLogCounts.get(host) || 0;
          // Keep logs useful: record first three blocked requests per host per process.
          if (count < 3) appLog.log('debug', 'playwright.request_filtered', { host, sample: count + 1 });
          filteredLogCounts.set(host, count + 1);
          return route.abort('blockedbyclient').catch(() => {});
        }
        return route.continue().catch(() => {});
      });
    } catch (e) {
      appLog.log('warn', 'playwright.request_filter_unavailable', { code: e.code || 'route_setup_failed' });
    }
  }
  return context;
}

async function persistSessionState(s) {
  if (!PERSIST_SESSIONS || !s || !s.context || (s.opts && s.opts.persist === false)) return;
  const file = profileStatePath(s.opts || {});
  if (!file) return;
  const key = file;
  const prior = storageSaveQueues.get(key) || Promise.resolve();
  const task = prior.catch(() => {}).then(async () => {
    let current;
    try { current = await s.context.storageState(); } catch (_) { return; }
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
  if (!state || !state.context) return;
  state.context.on('page', (nextPage) => {
    if (!nextPage || nextPage === state.page) return;
    state.page = nextPage;
    nextPage.setDefaultTimeout(NAV_TIMEOUT);
    nextPage.setDefaultNavigationTimeout(NAV_TIMEOUT);
    appLog.log('info', 'playwright.popup_attached', { id: state.id, engine: selectedEngine });
  });
}

async function recoverSession(s) {
  const browserGone = !browser || (browser.isConnected && !browser.isConnected());
  const contextGone = !s.context || (s.context.pages && s.context.pages().length === 0 && (!s.page || s.page.isClosed()));
  const pageGone = !s.page || (s.page.isClosed && s.page.isClosed());
  if (browserGone) await ensureBrowser();
  if (contextGone || pageGone) {
    await persistSessionState(s);
    try { if (s.context) await s.context.close(); } catch (_) {}
    s.context = await newContext(s.opts || {});
    s.page = await s.context.newPage();
    attachPopupTracking(s);
    s.page.setDefaultTimeout(NAV_TIMEOUT);
    s.page.setDefaultNavigationTimeout(NAV_TIMEOUT);
    s.error = null;
    appLog.log('warn', 'playwright.session_recovered', { id: s.id, engine: selectedEngine });
  }
  return s.page;
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
        const args = name === 'chromium' ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] : undefined;
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
  const types = await getBrowserTypes();
  if (!Object.keys(types).length) {
    return { ok: true, ready: false, engine: 'playwright', reason: 'not_installed' };
  }
  try {
    await ensureBrowser();
    return {
      ok: true,
      ready: !!browser,
      engine: 'playwright-' + (selectedEngine || 'unknown'),
      availableEngines: Object.keys(types),
      engineCooldowns: Object.fromEntries([...engineCooldowns].map(([name, until]) => [name, Math.max(0, until - Date.now())])),
      sessions: sessions.size,
      maxSessions: MAX_SESSIONS,
      cookies: true,
      fullJavascript: true,
      display: 'adaptive-dom-snapshot',
      contentMode: (String(process.env.SOLOHOST_BROWSER_CONTENT_MODE || 'adaptive') === '0') ? 'site-style' : String(process.env.SOLOHOST_BROWSER_CONTENT_MODE || 'adaptive'),
      mobileDefault: isMobileSession(),
      recovery: true,
      persistentSessions: PERSIST_SESSIONS,
      adTrackerFiltering: BLOCK_ADS
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

  const sessionOpts = { ...opts, clientKey: String(opts.clientKey || 'solohost-default-profile') };
  const context = await newContext(sessionOpts);
  const page = await context.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);
  page.setDefaultNavigationTimeout(NAV_TIMEOUT);

  const state = {
    id,
    opts: sessionOpts,
    context,
    page,
    url: 'about:blank',
    title: '',
    loading: false,
    error: null,
    createdAt: Date.now()
  };
  sessions.set(id, state);
  attachPopupTracking(state);
  appLog.log('info', 'playwright.session_create', { id, persistent: PERSIST_SESSIONS });
  return { sessionId: id, ready: true, engine: 'playwright-' + selectedEngine, mobile: isMobileSession(opts) };
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
        css.textContent = 'html{max-width:100%;overflow-x:auto;-webkit-text-size-adjust:100%;scroll-behavior:auto}body{max-width:100%;overflow-wrap:anywhere}img,video,canvas,svg,iframe{max-width:100%}img,video{height:auto}table{max-width:100%}pre,code{overflow-wrap:anywhere}input,textarea,select,button{max-width:100%;font-size:16px}*,*:before,*:after{animation:none!important;transition:none!important;scroll-behavior:auto!important}@media(max-width:600px){html,body{min-width:0!important}body{overflow-x:auto}pre{white-space:pre-wrap}table{display:block;overflow-x:auto}}' +
          (pageType === 'search' ? 'a{overflow-wrap:anywhere}' : '') +
          (pageType === 'commerce' ? 'img{object-fit:contain}' : '') +
          (pageType === 'video' ? 'video{max-height:75vh}iframe[data-sh-safe-media]{width:100%;aspect-ratio:16/9}' : '') +
          (pageType === 'article' ? 'article img{height:auto}' : '');
        cleanHead.appendChild(css);
      }
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

async function navigate(sessionId, url) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  if (!/^https?:\/\//i.test(url) && url !== 'about:blank') throw new Error('invalid_url');
  await recoverSession(s);
  s.loading = true;
  s.error = null;
  try {
    await s.page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    // A short, page-sensitive settle keeps dynamic sites responsive without waiting
    // for networkidle (which can hang on feeds and long-lived media connections).
    const pageType = classifyPageType(s.page.url());
    await s.page.waitForTimeout(pageType === 'video' || pageType === 'social' || pageType === 'search' ? 420 : 260).catch(() => {});
    s.url = s.page.url();
    s.title = await s.page.title().catch(() => '');
    s.loading = false;
    await persistSessionState(s);
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

async function getContent(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) throw new Error('session_not_found');
  await recoverSession(s);
  try {
    await s.page.evaluate(() => {
      document.querySelectorAll('img').forEach((img) => {
        try {
          if (img.dataset && img.dataset.src && !img.getAttribute('src')) img.src = img.dataset.src;
          if (img.loading === 'lazy') img.loading = 'eager';
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

  return {
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
      }
    }, targetId);
    await s.page.waitForTimeout(350).catch(() => {});
    s.url = s.page.url();
    await persistSessionState(s);
    return { sessionId, event: type, result: { ok: true, submitted: true }, url: s.url };
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
  isAdOrTrackerRequest,
  classifyPageType,
  isTrustedMediaFrame,
  navigate,
  getContent,
  getState,
  dispatchEvent,
  closeSession,
  shutdown,
  installShutdownHooks,
  request,
  // alias webkitManager shape
  ensureStarted: ensureBrowser,
  availableEngines: async () => Object.keys(await getBrowserTypes())
};
