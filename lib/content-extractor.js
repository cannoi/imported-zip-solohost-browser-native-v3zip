'use strict';

/**
 * ContentExtractor — SoloHost Browser v8 Phase 1.
 *
 * Opens a URL in headless Chromium (Playwright), waits for JavaScript to render,
 * sniffs media streams (.m3u8 / .mp4) from the network, then turns the rendered
 * HTML into a clean article with @mozilla/readability + jsdom.
 *
 * Heavy dependencies (playwright-core, jsdom, @mozilla/readability) are loaded
 * lazily so the rest of the app (and unit tests) can load this file without them.
 * Every dependency can also be injected through `options.deps` for testing.
 */

const dns = require('dns').promises;
const net = require('net');
const { URL } = require('url');
const security = require('./security-policy');
const navigationPolicy = require('./navigation-policy');

/* ------------------------------------------------------------------ */
/* Configuration                                                       */
/* ------------------------------------------------------------------ */

function envInt(name, fallback, min, max) {
  const n = Number(process.env[name]);
  const v = Number.isFinite(n) && process.env[name] !== '' && process.env[name] != null ? n : fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

function defaultOptions() {
  return {
    headless: true,
    executablePath: process.env.SOLOHOST_CHROMIUM_PATH || undefined,
    timeoutMs: envInt('SOLOHOST_NAV_TIMEOUT_MS', 30000, 5000, 120000),
    settleMs: envInt('SOLOHOST_EXTRACT_SETTLE_MS', 4500, 0, 20000),
    maxConcurrent: envInt('SOLOHOST_EXTRACT_CONCURRENCY', 3, 1, 8),
    maxQueue: envInt('SOLOHOST_EXTRACT_QUEUE', 20, 0, 200),
    maxHtmlChars: envInt('SOLOHOST_EXTRACT_MAX_HTML', 10000000, 100000, 50000000),
    maxTextChars: envInt('SOLOHOST_EXTRACT_MAX_TEXT', 400000, 1000, 5000000),
    maxMedia: 50,
    // Resource types aborted at the network layer to save bandwidth/CPU.
    blockedResourceTypes: String(process.env.SOLOHOST_EXTRACT_BLOCK || 'font')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    viewport: { width: 1280, height: 720 },
    locale: 'en-US',
    userAgent: process.env.SOLOHOST_USER_AGENT || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  };
}

const CHROMIUM_ARGS = [
  // Required in most Docker/SoloHost containers (no CAP_SYS_ADMIN for Chrome sandbox).
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-component-update',
  '--no-first-run',
  '--no-default-browser-check',
  '--mute-audio',
  '--autoplay-policy=user-gesture-required',
  '--ignore-certificate-errors'
];


/* ------------------------------------------------------------------ */
/* Hybrid URL intent classifier (READER | EMBED | WEBVIEW)            */
/* ------------------------------------------------------------------ */

const WEBVIEW_HOSTS = [
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com',
  'instagram.com', 'www.instagram.com',
  'shopee.vn', 'shopee.com', 'www.shopee.vn',
  'mail.google.com', 'accounts.google.com',
  'www.google.com', 'google.com', 'google.com.vn',
  'chatgpt.com', 'chat.openai.com',
  'twitter.com', 'x.com', 'www.x.com',
  'linkedin.com', 'www.linkedin.com',
  'zalo.me', 'chat.zalo.me'
];

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase().replace(/^www\./, ''); } catch { return ''; }
}

function matchesHost(hostname, list) {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  return list.some(x => {
    const n = x.toLowerCase().replace(/^www\./, '');
    return h === n || h.endsWith('.' + n);
  });
}

/**
 * Classify URL into READER | EMBED | WEBVIEW.
 * EMBED = media players (no Playwright fetch of binary streams).
 * WEBVIEW = login / anti-bot / complex apps (client-side session).
 * READER = default article extraction.
 */
function classifyUrlIntent(url) {
  let u;
  try { u = new URL(String(url || '').trim()); } catch {
    return { mode: 'READER', reason: 'INVALID_OR_RELATIVE', platform: null, videoId: null, embed_url: null };
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { mode: 'READER', reason: 'UNSUPPORTED_SCHEME', platform: null, videoId: null, embed_url: null };
  }
  const host = u.hostname.toLowerCase();
  const path = u.pathname || '';
  const full = u.href;

  // --- EMBED: YouTube ---
  if (/(^|\.)youtube\.com$/i.test(host) || host === 'm.youtube.com' || host === 'music.youtube.com') {
    let videoId = u.searchParams.get('v');
    if (!videoId && path.startsWith('/shorts/')) videoId = path.split('/')[2];
    if (!videoId && path.startsWith('/embed/')) videoId = path.split('/')[2];
    if (videoId) {
      return {
        mode: 'EMBED',
        reason: 'YOUTUBE_VIDEO',
        platform: 'youtube',
        videoId,
        embed_url: 'https://www.youtube.com/embed/' + encodeURIComponent(videoId) + '?rel=0'
      };
    }
    // channel / home → WEBVIEW (interactive)
    return { mode: 'WEBVIEW', reason: 'YOUTUBE_APP_SHELL', platform: 'youtube', videoId: null, embed_url: null };
  }
  if (host === 'youtu.be') {
    const videoId = path.replace(/^\//, '').split('/')[0];
    if (videoId) {
      return {
        mode: 'EMBED',
        reason: 'YOUTUBE_SHORTLINK',
        platform: 'youtube',
        videoId,
        embed_url: 'https://www.youtube.com/embed/' + encodeURIComponent(videoId) + '?rel=0'
      };
    }
  }

  // --- EMBED: TikTok ---
  if (/(^|\.)tiktok\.com$/i.test(host)) {
    const m = path.match(/\/@[^/]+\/video\/(\d+)/);
    if (m) {
      return {
        mode: 'EMBED',
        reason: 'TIKTOK_VIDEO',
        platform: 'tiktok',
        videoId: m[1],
        embed_url: 'https://www.tiktok.com/embed/v2/' + m[1]
      };
    }
    return { mode: 'WEBVIEW', reason: 'TIKTOK_APP', platform: 'tiktok', videoId: null, embed_url: null };
  }

  // --- EMBED: Facebook video only ---
  if (/(^|\.)facebook\.com$/i.test(host) || host === 'fb.watch' || host === 'fb.com') {
    if (/\/watch\/?/i.test(path) || /\/videos\//i.test(path) || host === 'fb.watch') {
      const embed = 'https://www.facebook.com/plugins/video.php?href=' + encodeURIComponent(full) + '&show_text=false';
      return {
        mode: 'EMBED',
        reason: 'FACEBOOK_VIDEO',
        platform: 'facebook',
        videoId: null,
        embed_url: embed
      };
    }
    return { mode: 'WEBVIEW', reason: 'FACEBOOK_APP', platform: 'facebook', videoId: null, embed_url: null };
  }

  // --- WEBVIEW: known interactive / login / search walls ---
  if (matchesHost(host, WEBVIEW_HOSTS)) {
    // Wikipedia etc. not in list
    // Google Search always WEBVIEW (CAPTCHA wall for headless)
    if (host.includes('google.') && (path.startsWith('/search') || path === '/' || path.startsWith('/webhp'))) {
      return { mode: 'WEBVIEW', reason: 'GOOGLE_SEARCH_OR_APP', platform: 'google', videoId: null, embed_url: null };
    }
    if (host.includes('google.') && path.startsWith('/maps')) {
      return { mode: 'WEBVIEW', reason: 'GOOGLE_MAPS', platform: 'google', videoId: null, embed_url: null };
    }
    if (!host.includes('google.')) {
      return { mode: 'WEBVIEW', reason: 'LOGIN_OR_COMPLEX_APP', platform: hostOf(full) || host, videoId: null, embed_url: null };
    }
  }

  // Vimeo embed
  if (/(^|\.)vimeo\.com$/i.test(host)) {
    const m = path.match(/\/(\d+)/);
    if (m) {
      return {
        mode: 'EMBED',
        reason: 'VIMEO_VIDEO',
        platform: 'vimeo',
        videoId: m[1],
        embed_url: 'https://player.vimeo.com/video/' + m[1]
      };
    }
  }

  return { mode: 'READER', reason: 'DEFAULT_ARTICLE', platform: null, videoId: null, embed_url: null };
}

function detectLangFromText(text, htmlLang) {
  if (htmlLang && /^(vi|en)/i.test(htmlLang)) return htmlLang.slice(0, 2).toLowerCase();
  const sample = String(text || '').slice(0, 2000);
  if (/[àáạảãăâèéêìíòóôơùúưỳýđ]/i.test(sample)) return 'vi';
  return 'en';
}


/* ------------------------------------------------------------------ */
/* Errors                                                              */
/* ------------------------------------------------------------------ */

class ExtractorError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'ExtractorError';
    this.code = code;
    if (extra.httpStatus) this.httpStatus = extra.httpStatus;
  }
}

/* ------------------------------------------------------------------ */
/* Pure helpers (no DOM, easy to unit-test)                            */
/* ------------------------------------------------------------------ */

const HLS_TYPES = new Set(['application/vnd.apple.mpegurl', 'application/x-mpegurl', 'audio/mpegurl', 'audio/x-mpegurl']);

/** Returns 'm3u8' | 'mp4' | null for a network response. */
function classifyMedia(rawUrl, contentType = '') {
  let pathname;
  try { pathname = new URL(String(rawUrl)).pathname.toLowerCase(); } catch { return null; }
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (pathname.endsWith('.m3u8') || HLS_TYPES.has(ct)) return 'm3u8';
  if (pathname.endsWith('.mp4') || ct === 'video/mp4') return 'mp4';
  return null;
}

function normalizeText(input) {
  return String(input == null ? '' : input)
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t\f\v\u00a0\u200b]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function countWords(text) {
  const t = String(text || '').trim();
  return t ? t.split(/\s+/).length : 0;
}

/** Returns an ISO-8601 string or null. Only accepts plausible publication dates. */
function toIsoDate(value) {
  if (value == null) return null;
  const s = String(value).trim();
  if (s.length < 8 || !/\d/.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const year = d.getUTCFullYear();
  if (year < 1990 || year > new Date().getUTCFullYear() + 1) return null;
  return d.toISOString();
}

/** Resolve href against base; only allow the given protocols. Returns string or null. */
function safeUrl(href, base, protocols = ['http:', 'https:']) {
  if (href == null) return null;
  const raw = String(href).trim();
  if (!raw || /[\u0000-\u001f]/.test(raw)) return null;
  try {
    const u = new URL(raw, base);
    return protocols.includes(u.protocol) ? u.href : null;
  } catch { return null; }
}

function cleanAuthor(value) {
  if (!value) return null;
  let s = String(value).replace(/\s+/g, ' ').trim();
  s = s.replace(/^(by|bởi|tác giả|author|written by)\s*[:\-–]?\s+/i, '').trim();
  if (!s || /^https?:\/\//i.test(s)) return null;
  return s.slice(0, 200);
}

function pickLocale(acceptLanguage, fallback = 'en-US') {
  const first = String(acceptLanguage || '').split(',')[0].split(';')[0].trim();
  if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(first)) return first;
  return fallback;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function friendlyNavError(err) {
  const raw = String((err && err.message) || err || 'Navigation failed');
  const line = raw.split('\n')[0].replace(/^page\.goto:\s*/i, '').trim().slice(0, 300);
  if (/Timeout/i.test(raw)) return new ExtractorError('NAVIGATION_TIMEOUT', 'The page took too long to load');
  if (/ERR_BLOCKED_BY_CLIENT/.test(raw)) return new ExtractorError('BLOCKED', 'Blocked by security policy');
  if (/ERR_NAME_NOT_RESOLVED|ERR_NAME_RESOLUTION_FAILED/.test(raw)) return new ExtractorError('DNS_FAILED', 'Address could not be resolved');
  if (/ERR_CERT|ERR_SSL|SSL_PROTOCOL/.test(raw)) return new ExtractorError('TLS_ERROR', 'Secure connection failed');
  if (/ERR_CONNECTION|ERR_INTERNET_DISCONNECTED|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE/.test(raw)) return new ExtractorError('CONNECTION_FAILED', 'Could not connect to the site');
  return new ExtractorError('NAVIGATION_FAILED', line || 'Navigation failed');
}

/* ------------------------------------------------------------------ */
/* DOM helpers (take a jsdom Document)                                 */
/* ------------------------------------------------------------------ */

function collectMeta(doc) {
  const map = new Map();
  for (const m of doc.querySelectorAll('meta')) {
    const content = m.getAttribute('content');
    if (!content || !content.trim()) continue;
    for (const attr of ['property', 'name', 'itemprop']) {
      const key = (m.getAttribute(attr) || '').trim().toLowerCase();
      if (key && !map.has(key)) map.set(key, content.trim());
    }
  }
  return map;
}

function firstMeta(map, keys) {
  for (const k of keys) if (map.has(k)) return map.get(k);
  return null;
}

function jsonLdName(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const names = v.map(jsonLdName).filter(Boolean).slice(0, 3);
    return names.length ? names.join(', ') : null;
  }
  if (typeof v === 'object' && typeof v.name === 'string') return v.name;
  return null;
}

function readJsonLd(doc) {
  const out = {};
  const walk = (node, depth) => {
    if (!node || depth > 6) return;
    if (Array.isArray(node)) { node.slice(0, 30).forEach(n => walk(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    if (!out.datePublished && typeof node.datePublished === 'string') out.datePublished = node.datePublished;
    if (!out.author && node.author) out.author = jsonLdName(node.author);
    if (!out.publisher && node.publisher) out.publisher = jsonLdName(node.publisher);
    if (!out.headline && typeof node.headline === 'string') out.headline = node.headline;
    if (node['@graph']) walk(node['@graph'], depth + 1);
    if (node.mainEntity) walk(node.mainEntity, depth + 1);
  };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    let data;
    try { data = JSON.parse(s.textContent || ''); } catch { continue; }
    walk(data, 0);
  }
  return out;
}

function readFavicon(doc, pageUrl) {
  const found = { icon: null, apple: null };
  for (const link of doc.querySelectorAll('link[rel][href]')) {
    const rels = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
    const href = safeUrl(link.getAttribute('href'), pageUrl, ['http:', 'https:', 'data:']);
    if (!href) continue;
    if (!found.icon && rels.includes('icon')) found.icon = href;
    else if (!found.apple && rels.includes('apple-touch-icon')) found.apple = href;
  }
  if (found.icon) return found.icon;
  if (found.apple) return found.apple;
  try { return new URL('/favicon.ico', pageUrl).href; } catch { return null; }
}

function readMetadata(doc, pageUrl) {
  const meta = collectMeta(doc);
  const ld = readJsonLd(doc);
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./i, ''); } catch { /* ignore */ }

  const title = firstMeta(meta, ['og:title', 'twitter:title']) || ld.headline || (doc.title || '').trim() || null;

  let author = cleanAuthor(firstMeta(meta, ['author', 'article:author', 'og:article:author', 'parsely-author', 'sailthru.author', 'dc.creator', 'twitter:creator']))
    || cleanAuthor(ld.author);
  if (!author) {
    const rel = doc.querySelector('[rel~="author"], [itemprop="author"], .byline, .author');
    if (rel) author = cleanAuthor(rel.textContent);
  }

  const siteName = firstMeta(meta, ['og:site_name', 'application-name', 'apple-mobile-web-app-title']) || ld.publisher || host || null;

  let published = toIsoDate(firstMeta(meta, [
    'article:published_time', 'og:article:published_time', 'datepublished', 'pubdate', 'publishdate',
    'publish_date', 'parsely-pub-date', 'sailthru.date', 'dc.date.issued', 'dc.date', 'dcterms.created', 'date'
  ])) || toIsoDate(ld.datePublished);
  if (!published) {
    const t = doc.querySelector('time[datetime], [itemprop="datePublished"]');
    if (t) published = toIsoDate(t.getAttribute('datetime') || t.getAttribute('content') || t.textContent);
  }

  const htmlLang = doc.documentElement ? (doc.documentElement.getAttribute('lang') || '').trim() : '';
  const lang = htmlLang || firstMeta(meta, ['og:locale', 'content-language']) || null;

  return {
    title: title ? String(title).trim().slice(0, 300) : null,
    author,
    site_name: siteName ? String(siteName).trim().slice(0, 120) : null,
    favicon: readFavicon(doc, pageUrl),
    published_at: published,
    lang: lang ? String(lang).slice(0, 20) : null
  };
}

const STRIP_SELECTOR = [
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base',
  'form', 'input', 'button', 'select', 'textarea', 'noscript', 'template', 'svg', 'math',
  'audio', 'video', 'source', 'track', 'canvas'
].join(',');
const URL_ATTRS = ['href', 'src', 'poster', 'cite', 'action', 'formaction', 'background', 'xlink:href'];

/** Remove active content from Readability output so it is safe to embed. */
function sanitizeHtml(html, JSDOM, VirtualConsole, baseUrl) {
  const dom = new JSDOM('<!doctype html><html><body>' + String(html || '') + '</body></html>', {
    url: baseUrl,
    virtualConsole: VirtualConsole ? new VirtualConsole() : undefined
  });
  try {
    const doc = dom.window.document;
    doc.querySelectorAll(STRIP_SELECTOR).forEach(el => el.remove());
    for (const el of doc.body.querySelectorAll('*')) {
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        if (name.startsWith('on') || name === 'style' || name === 'srcdoc') { el.removeAttribute(attr.name); continue; }
        if (URL_ATTRS.includes(name)) {
          const value = String(attr.value || '').trim();
          const isImageData = /^data:image\/(png|jpe?g|gif|webp|avif);/i.test(value);
          const ok = isImageData || safeUrl(value, baseUrl, ['http:', 'https:', 'mailto:', 'tel:']);
          if (!ok) el.removeAttribute(attr.name);
          else if (!isImageData && typeof ok === 'string' && name !== 'href') el.setAttribute(attr.name, ok);
        }
      }
      if (el.tagName === 'A' && el.getAttribute('href')) el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
    return doc.body.innerHTML.trim();
  } finally {
    try { dom.window.close(); } catch { /* ignore */ }
  }
}

/** Detect CAPTCHA / bot interstitial pages (Google, Cloudflare, etc.). */
function detectChallenge(html, text, finalUrl) {
  const blob = (String(html || '') + '\n' + String(text || '')).toLowerCase();
  const signals = [
    'unusual traffic from your computer network',
    'our systems have detected unusual traffic',
    'please verify you are a human',
    'checking your browser before accessing',
    'cf-browser-verification',
    'attention required! | cloudflare',
    'enable javascript and cookies to continue',
    'recaptcha',
    'hcaptcha',
    '/sorry/index',
    'captcha-form'
  ];
  const hit = signals.some(s => blob.includes(s));
  if (!hit) return null;
  let reason = 'bot_challenge';
  if (blob.includes('unusual traffic') || blob.includes('sorry')) reason = 'google_traffic_check';
  if (blob.includes('cloudflare')) reason = 'cloudflare_challenge';
  return { kind: 'challenge', reason, message: 'The site asked for a human check (CAPTCHA / traffic challenge). Headless extract cannot complete this page.' };
}

/**
 * When Readability returns thin chrome (footer/masthead), pick the densest content block.
 */
function fallbackMainContent(doc) {
  const kill = 'script,style,noscript,template,svg,iframe,nav,footer,header,aside,form,[role="navigation"],[role="banner"],[role="contentinfo"]';
  try { doc.querySelectorAll(kill).forEach(el => el.remove()); } catch { /* ignore */ }
  const candidates = [];
  const nodes = doc.querySelectorAll('article, main, [role="main"], .detail-content, .article-content, .story-content, .content-detail, .news-content, #content, .post-content, .entry-content, .c-news-body, .detail__cmain, .afcbc-body');
  nodes.forEach(n => candidates.push(n));
  if (!candidates.length && doc.body) {
    doc.body.querySelectorAll('div,section').forEach(n => {
      const t = normalizeText(n.textContent || '');
      if (t.length > 400) candidates.push(n);
    });
  }
  let best = null;
  let bestScore = 0;
  for (const n of candidates) {
    const t = normalizeText(n.textContent || '');
    const links = (n.querySelectorAll && n.querySelectorAll('a')) ? n.querySelectorAll('a').length : 0;
    const words = countWords(t);
    // Prefer text-heavy, link-light blocks (articles vs link farms)
    const score = words - links * 8;
    if (score > bestScore) {
      bestScore = score;
      best = n;
    }
  }
  if (!best || bestScore < 40) {
    const bodyText = normalizeText(doc.body ? doc.body.textContent : '');
    return { text: bodyText, html: textToHtml(bodyText), weak: true };
  }
  const text = normalizeText(best.textContent || '');
  let html = '';
  try { html = best.innerHTML || ''; } catch { html = textToHtml(text); }
  return { text, html, weak: false };
}

function isThinArticle(text, cleanHtml) {
  const t = normalizeText(text || '');
  const words = countWords(t);
  // Masthead-only pages are short and often list editor names / license lines
  if (words < 80) return true;
  const chromeHints = /(tổng biên tập|phó tổng biên tập|giấy phép xuất bản|bản quyền thuộc|all rights reserved|cookie policy)/i;
  if (words < 200 && chromeHints.test(t)) return true;
  return false;
}




function textToHtml(text) {
  return normalizeText(text).split(/\n{2,}/).slice(0, 300)
    .map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('\n');
}

/* ------------------------------------------------------------------ */
/* ContentExtractor                                                    */
/* ------------------------------------------------------------------ */

class ContentExtractor {
  /**
   * @param {object} [options] overrides for defaultOptions()
   * @param {object} [options.deps] { chromium, JSDOM, VirtualConsole, Readability } for tests
   */
  constructor(options = {}) {
    const { deps, ...rest } = options;
    this.opts = { ...defaultOptions(), ...rest };
    this._injected = deps || {};
    this._browser = null;
    this._launching = null;
    this._active = 0;
    this._queue = [];
    this._closed = false;
    this._stats = { launches: 0, extractions: 0, failures: 0, lastError: null, lastExtractMs: null };
  }

  /* ---------- dependency loading ---------- */

  _load(key, moduleName, pick) {
    if (this._injected[key]) return this._injected[key];
    try {
      const mod = require(moduleName);
      return pick ? pick(mod) : mod;
    } catch (err) {
      throw new ExtractorError('DEPENDENCY_MISSING', `Missing dependency "${moduleName}" (${err.code || err.message}). Run "npm install".`);
    }
  }
  _chromium() { return this._load('chromium', 'playwright-core', m => m.chromium); }
  _jsdom() {
    return {
      JSDOM: this._load('JSDOM', 'jsdom', m => m.JSDOM),
      VirtualConsole: this._injected.VirtualConsole || (() => { try { return require('jsdom').VirtualConsole; } catch { return undefined; } })()
    };
  }
  _readability() { return this._load('Readability', '@mozilla/readability', m => m.Readability); }

  /* ---------- browser lifecycle ---------- */

  isAlive() {
    try { return !!(this._browser && this._browser.isConnected()); } catch { return false; }
  }

  async warmUp() { return this._ensureBrowser(); }

  async _ensureBrowser() {
    if (this._closed) throw new ExtractorError('CLOSED', 'Extractor is shut down');
    if (this.isAlive()) return this._browser;
    if (this._launching) return this._launching;
    this._launching = (async () => {
      const chromium = this._chromium();
      let browser;
      try {
        browser = await chromium.launch({
          headless: this.opts.headless,
          executablePath: this.opts.executablePath,
          args: CHROMIUM_ARGS
        });
      } catch (err) {
        throw new ExtractorError(
          'DEPENDENCY_MISSING',
          'Chromium launch failed: ' + String(err && err.message || err) +
          ' (Docker needs --no-sandbox; ensure Playwright image ships matching Chromium)'
        );
      }
      browser.on('disconnected', () => { if (this._browser === browser) this._browser = null; });
      this._browser = browser;
      this._stats.launches += 1;
      return browser;
    })().finally(() => { this._launching = null; });
    return this._launching;
  }

  async close() {
    this._closed = true;
    const waiting = this._queue.splice(0);
    waiting.forEach(resolve => resolve());
    const browser = this._browser;
    this._browser = null;
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  }

  stats() {
    return {
      ...this._stats,
      alive: this.isAlive(),
      active: this._active,
      queued: this._queue.length,
      maxConcurrent: this.opts.maxConcurrent
    };
  }

  /* ---------- concurrency ---------- */

  _acquire() {
    if (this._active < this.opts.maxConcurrent) { this._active += 1; return Promise.resolve(); }
    if (this._queue.length >= this.opts.maxQueue) {
      return Promise.reject(new ExtractorError('BUSY', 'Extractor is busy; try again shortly'));
    }
    return new Promise(resolve => this._queue.push(resolve));
  }
  _release() {
    const next = this._queue.shift();
    if (next) next(); else this._active = Math.max(0, this._active - 1);
  }

  /* ---------- network policy ---------- */

  async _isBlockedHost(hostname, policy, cache) {
    if (!policy.blockPrivate) return false;
    if (security.isPrivateHost(hostname)) return true;
    if (net.isIP(hostname)) return false;
    if (cache.has(hostname)) return cache.get(hostname);
    let blocked = false;
    try {
      const addresses = await dns.lookup(hostname, { all: true });
      blocked = addresses.some(a => security.isPrivateHost(a.address));
    } catch { blocked = false; /* let Chromium report the DNS failure */ }
    cache.set(hostname, blocked);
    return blocked;
  }

  async _installRoutes(context, policy) {
    const blockedTypes = new Set(this.opts.blockedResourceTypes);
    const cache = new Map();
    await context.route('**/*', async (route) => {
      try {
        const req = route.request();
        let parsed;
        try { parsed = new URL(req.url()); } catch { return await route.abort('blockedbyclient'); }
        if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return await route.continue();
        if (!['http:', 'https:'].includes(parsed.protocol)) return await route.abort('blockedbyclient');
        if (blockedTypes.has(req.resourceType())) return await route.abort('blockedbyclient');
        if (await this._isBlockedHost(parsed.hostname, policy, cache)) return await route.abort('blockedbyclient');
        return await route.continue();
      } catch { /* page/context already closed */ }
    });
  }

  /* ---------- media sniffing ---------- */

  _collectMedia(response, bucket) {
    try {
      if (bucket.size >= this.opts.maxMedia) return;
      const status = response.status();
      if (!((status >= 200 && status < 300) || status === 304)) return;
      const url = response.url();
      const headers = response.headers() || {};
      const contentType = headers['content-type'] || '';
      const type = classifyMedia(url, contentType);
      if (!type) return;
      const key = url.split('#')[0];
      if (bucket.has(key)) return;
      const length = Number(headers['content-length']);
      bucket.set(key, {
        url: key,
        type,
        content_type: String(contentType).split(';')[0].trim() || null,
        status,
        size: Number.isFinite(length) && length > 0 ? length : null
      });
    } catch { /* never let sniffing break extraction */ }
  }

  /* ---------- HTML → article ---------- */

  /**
   * Turn rendered HTML into { title, author, site_name, favicon, published_at, lang,
   * excerpt, clean_html, raw_text, word_count, reading_minutes, readable, truncated }.
   * Synchronous and independent from Playwright, so it can be tested with plain HTML.
   */

  parseHtml(html, pageUrl) {
    const { JSDOM, VirtualConsole } = this._jsdom();
    const Readability = this._readability();
    const dom = new JSDOM(String(html || ''), {
      url: pageUrl,
      contentType: 'text/html',
      virtualConsole: VirtualConsole ? new VirtualConsole() : undefined
    });
    try {
      const doc = dom.window.document;
      const meta = readMetadata(doc, pageUrl); // before Readability mutates the document

      let article = null;
      try {
        article = new Readability(doc, { charThreshold: 250, keepClasses: false, maxElemsToParse: 100000 }).parse();
      } catch { article = null; }

      let readable = !!(article && article.content && normalizeText(article.textContent).length > 0);
      let text;
      let cleanHtml;
      let usedFallback = false;
      if (readable) {
        text = normalizeText(article.textContent);
        cleanHtml = sanitizeHtml(article.content, JSDOM, VirtualConsole, pageUrl);
        if (isThinArticle(text, cleanHtml)) {
          // Re-parse original HTML — Readability has already mutated `doc`.
          try {
            const fresh = new JSDOM(String(html || ''), {
              url: pageUrl,
              contentType: 'text/html',
              virtualConsole: VirtualConsole ? new VirtualConsole() : undefined
            });
            try {
              const fb = fallbackMainContent(fresh.window.document);
              if (fb && countWords(fb.text) > countWords(text)) {
                text = fb.text;
                cleanHtml = sanitizeHtml(fb.html, JSDOM, VirtualConsole, pageUrl);
                usedFallback = true;
                readable = countWords(text) >= 40;
              }
            } finally {
              try { fresh.window.close(); } catch { /* ignore */ }
            }
          } catch { /* keep readability result */ }
        }
      } else {
        const fb = fallbackMainContent(doc);
        text = fb.text;
        cleanHtml = sanitizeHtml(fb.html, JSDOM, VirtualConsole, pageUrl);
        readable = countWords(text) >= 40;
        usedFallback = true;
      }

      const challenge = detectChallenge(html, text, pageUrl);

      let truncated = false;
      if (text.length > this.opts.maxTextChars) { text = text.slice(0, this.opts.maxTextChars); truncated = true; }

      const words = countWords(text);
      const excerptSource = (article && article.excerpt) ? normalizeText(article.excerpt) : text.replace(/\s+/g, ' ');
      const byline = article && article.byline ? cleanAuthor(article.byline) : null;

      return {
        title: ((article && article.title) || meta.title || '').trim().slice(0, 300) || null,
        author: meta.author || byline,
        site_name: meta.site_name || (article && article.siteName) || null,
        favicon: meta.favicon,
        published_at: meta.published_at || toIsoDate(article && article.publishedTime),
        lang: meta.lang || (article && article.lang) || null,
        excerpt: excerptSource.slice(0, 300),
        clean_html: cleanHtml,
        raw_text: text,
        word_count: words,
        reading_minutes: words ? Math.max(1, Math.ceil(words / 200)) : 0,
        readable,
        truncated,
        used_fallback: usedFallback,
        challenge: challenge || null
      };
    } finally {
      try { dom.window.close(); } catch { /* ignore */ }
    }
  }

  /* ---------- main entry ---------- */

  /**
   * @param {string} url http(s) URL
   * @param {object} [options] { locale, acceptLanguage, timeoutMs, settleMs }
   */
  async extract(url, options = {}) {
    const started = Date.now();
    let target;
    try {
      target = navigationPolicy.validateNavigation(String(url || '').trim());
    } catch (err) {
      throw new ExtractorError(/private-network|restricted/i.test(err.message) ? 'BLOCKED' : 'INVALID_URL', err.message);
    }
    const proto = new URL(target).protocol;
    if (proto !== 'http:' && proto !== 'https:') {
      throw new ExtractorError('UNSUPPORTED_SCHEME', 'Only http and https pages can be extracted');
    }

    // Hybrid routing — never spin Chromium for EMBED / WEBVIEW
    const intent = classifyUrlIntent(target);
    if (intent.mode === 'EMBED') {
      return {
        ok: true,
        mode: 'EMBED',
        url: target,
        final_url: target,
        http_status: 200,
        content_type: 'text/html',
        kind: 'embed',
        title: (intent.platform || 'video') + (intent.videoId ? ' ' + intent.videoId : ''),
        author: null,
        site_name: intent.platform,
        favicon: null,
        published_at: null,
        lang: 'en',
        excerpt: '',
        clean_html: '',
        raw_text: '',
        word_count: 0,
        reading_minutes: 0,
        readable: false,
        truncated: false,
        media: [],
        embed_url: intent.embed_url,
        platform: intent.platform,
        videoId: intent.videoId,
        intent_reason: intent.reason,
        extracted_at: new Date().toISOString(),
        duration_ms: Date.now() - started
      };
    }
    if (intent.mode === 'WEBVIEW') {
      return {
        ok: true,
        mode: 'WEBVIEW',
        url: target,
        final_url: target,
        http_status: 200,
        content_type: 'text/html',
        kind: 'webview',
        title: intent.platform || hostOf(target) || target,
        author: null,
        site_name: intent.platform || hostOf(target),
        favicon: null,
        published_at: null,
        lang: 'en',
        excerpt: '',
        clean_html: '',
        raw_text: '',
        word_count: 0,
        reading_minutes: 0,
        readable: false,
        truncated: false,
        media: [],
        webview_required: true,
        intent_reason: intent.reason,
        extracted_at: new Date().toISOString(),
        duration_ms: Date.now() - started
      };
    }

    await this._acquire();
    let context = null;
    try {
      if (this._closed) throw new ExtractorError('CLOSED', 'Extractor is shut down');
      const result = await this._extractLocked(target, options, started, c => { context = c; });
      this._stats.extractions += 1;
      this._stats.lastExtractMs = Date.now() - started;
      return result;
    } catch (err) {
      this._stats.failures += 1;
      const wrapped = err instanceof ExtractorError ? err : friendlyNavError(err);
      this._stats.lastError = `${wrapped.code}: ${wrapped.message}`;
      throw wrapped;
    } finally {
      if (context) { try { await context.close(); } catch { /* ignore */ } }
      this._release();
    }
  }

  async _extractLocked(target, options, started, setContext) {
    const timeout = options.timeoutMs || this.opts.timeoutMs;
    const settle = options.settleMs != null ? options.settleMs : this.opts.settleMs;
    const settings = security.load();
    const policy = { blockPrivate: !!(settings.safeNavigation && settings.blockPrivateNetwork) };

    const browser = await this._ensureBrowser();
    const userAgent = this.opts.userAgent
      || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    const context = await browser.newContext({
      userAgent,
      viewport: this.opts.viewport,
      locale: options.locale || pickLocale(options.acceptLanguage, this.opts.locale),
      acceptDownloads: false,
      // Lightweight fingerprint hints (Playwright-native; no puppeteer-extra dependency)
      extraHTTPHeaders: {
        'Accept-Language': options.acceptLanguage || 'en-US,en;q=0.9,vi;q=0.8',
        'Upgrade-Insecure-Requests': '1'
      },
      colorScheme: 'light',
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false
    });
    setContext(context);
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    await this._installRoutes(context, policy);

    const page = await context.newPage();
    const media = new Map();
    page.on('response', response => this._collectMedia(response, media));

    let response = null;
    try {
      response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
    } catch (err) {
      if (/Download is starting/i.test(String(err && err.message))) {
        return this._nonHtmlResult(target, target, null, 'application/octet-stream', media, started);
      }
      throw friendlyNavError(err);
    }

    const httpStatus = response ? response.status() : null;
    const contentType = response ? String((response.headers() || {})['content-type'] || '') : '';
    if (httpStatus && httpStatus >= 400) {
      throw new ExtractorError('HTTP_ERROR', `The site responded with HTTP ${httpStatus}`, { httpStatus });
    }

    // Allow SPA / news sites time to hydrate; networkidle is best-effort.
    if (settle > 0) await page.waitForLoadState('networkidle', { timeout: settle }).catch(() => {});
    await page.waitForTimeout(Math.min(1200, Math.max(0, settle))).catch(() => {});

    // Scroll to trigger lazy content (bounded).
    try {
      await page.evaluate(async () => {
        await new Promise(r => {
          let y = 0;
          const step = () => {
            y += Math.max(400, Math.floor(window.innerHeight * 0.85));
            window.scrollTo(0, y);
            if (y < document.body.scrollHeight && y < 4000) setTimeout(step, 120);
            else r();
          };
          step();
        });
        window.scrollTo(0, 0);
      });
    } catch { /* ignore */ }

    // Dismiss common cookie banners (best-effort, never throw).
    try {
      const labels = ['accept', 'agree', 'đồng ý', 'chấp nhận', 'allow all', 'accept all', 'tôi đồng ý'];
      for (const label of labels) {
        const btn = page.getByRole('button', { name: new RegExp(label, 'i') });
        if (await btn.count().catch(() => 0)) {
          await btn.first().click({ timeout: 800 }).catch(() => {});
          break;
        }
      }
    } catch { /* ignore */ }

    const finalUrl = page.url() || target;
    if (contentType && !/html|xml|^text\//i.test(contentType)) {
      return this._nonHtmlResult(target, finalUrl, httpStatus, contentType, media, started);
    }

    let html;
    try { html = await page.content(); } catch {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      html = await page.content();
    }
    if (html.length > this.opts.maxHtmlChars) html = html.slice(0, this.opts.maxHtmlChars);

    const parsed = this.parseHtml(html, finalUrl);
    if (!parsed.title) {
      try { parsed.title = (await page.title()) || null; } catch { /* ignore */ }
    }

    const challenge = parsed.challenge || detectChallenge(html, parsed.raw_text || parsed.excerpt, finalUrl);
    return {
      ok: true,
      url: target,
      final_url: finalUrl,
      http_status: httpStatus,
      content_type: contentType.split(';')[0].trim() || 'text/html',
      mode: 'READER',
      kind: challenge ? 'challenge' : 'html',
      challenge: challenge || null,
      title: parsed.title,
      author: parsed.author,
      site_name: parsed.site_name,
      favicon: parsed.favicon,
      published_at: parsed.published_at,
      lang: detectLangFromText(parsed.raw_text, parsed.lang),
      excerpt: parsed.excerpt,
      clean_html: parsed.clean_html,
      raw_text: parsed.raw_text,
      word_count: parsed.word_count,
      reading_minutes: parsed.reading_minutes,
      readable: parsed.readable,
      truncated: parsed.truncated,
      media: Array.from(media.values()),
      extracted_at: new Date().toISOString(),
      duration_ms: Date.now() - started
    };
  }

  _nonHtmlResult(target, finalUrl, httpStatus, contentType, media, started) {
    let host = '';
    try { host = new URL(finalUrl).hostname.replace(/^www\./i, ''); } catch { /* ignore */ }
    const kind = navigationPolicy.classifyResourceType(finalUrl);
    let favicon = null;
    try { favicon = new URL('/favicon.ico', finalUrl).href; } catch { /* ignore */ }
    let name = '';
    try { name = decodeURIComponent(new URL(finalUrl).pathname.split('/').filter(Boolean).pop() || ''); } catch { /* ignore */ }
    return {
      ok: true,
      url: target,
      final_url: finalUrl,
      http_status: httpStatus,
      content_type: String(contentType).split(';')[0].trim() || 'application/octet-stream',
      kind: kind === 'web' ? 'file' : kind,
      title: name || host || null,
      author: null,
      site_name: host || null,
      favicon,
      published_at: null,
      lang: null,
      excerpt: '',
      clean_html: '',
      raw_text: '',
      word_count: 0,
      reading_minutes: 0,
      readable: false,
      truncated: false,
      media: Array.from(media.values()),
      extracted_at: new Date().toISOString(),
      duration_ms: Date.now() - started
    };
  }
}

module.exports = {
  ContentExtractor,
  ExtractorError,
  classifyMedia,
  normalizeText,
  countWords,
  toIsoDate,
  safeUrl,
  cleanAuthor,
  pickLocale,
  sanitizeHtml,
  friendlyNavError,
  detectChallenge,
  fallbackMainContent,
  isThinArticle,
  classifyUrlIntent,
  detectLangFromText
};
