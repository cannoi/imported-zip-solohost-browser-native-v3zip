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
const { STEALTH, buildInitScript } = require('./stealth');
const { getPublicIpGeoData, acceptLanguageFor } = require('./geoip');
const {
  normalizeText, countWords, escapeHtml, htmlToText, textToHtml, toIsoDate, safeUrl, cleanAuthor
} = require('./text-utils');
const tiers = require('./extraction-tiers');

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
    // Slow path only (fast path never waits): how long to let a SPA hydrate before re-parsing.
    settleMs: envInt('SOLOHOST_EXTRACT_SETTLE_MS', 1500, 0, 20000),
    maxConcurrent: envInt('SOLOHOST_EXTRACT_CONCURRENCY', 3, 1, 8),
    maxQueue: envInt('SOLOHOST_EXTRACT_QUEUE', 20, 0, 200),
    maxHtmlChars: envInt('SOLOHOST_EXTRACT_MAX_HTML', 10000000, 100000, 50000000),
    maxTextChars: envInt('SOLOHOST_EXTRACT_MAX_TEXT', 400000, 1000, 5000000),
    maxMedia: 50,
    // Resource types aborted at the network layer (images, video/audio, fonts, CSS).
    blockedResourceTypes: String(process.env.SOLOHOST_EXTRACT_BLOCK || 'image,media,font,stylesheet')
      .split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    blockTrackers: process.env.SOLOHOST_EXTRACT_BLOCK_TRACKERS !== '0',
    // Result cache (lru-cache): same URL is served from memory for 20 minutes.
    cacheTtlMs: envInt('SOLOHOST_CACHE_TTL_MS', 20 * 60 * 1000, 0, 24 * 3600 * 1000),
    cacheMax: envInt('SOLOHOST_CACHE_MAX', 300, 1, 5000),
    cacheMaxBytes: envInt('SOLOHOST_CACHE_MAX_BYTES', 64 * 1024 * 1024, 1024 * 1024, 1024 * 1024 * 1024),
    viewport: { width: 1280, height: 720 },
    stealth: STEALTH,
    locale: STEALTH.locale,
    acceptLanguage: STEALTH.acceptLanguage,
    userAgent: process.env.SOLOHOST_USER_AGENT || STEALTH.userAgent
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

/** Minimum words a JSON-LD articleBody needs before Tier 1 is trusted (teasers/paywall stubs are shorter). */
const TIER1_MIN_WORDS = 80;

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

function pickLocale(acceptLanguage, fallback = 'en-US') {
  const first = String(acceptLanguage || '').split(',')[0].split(';')[0].trim();
  if (/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(first)) return first;
  return fallback;
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

/**
 * Detect CAPTCHA / bot interstitial pages (Google, Cloudflare, etc.).
 *
 * "Strong" phrases only ever appear on interstitials. "Weak" ones (reCAPTCHA / hCaptcha) are
 * embedded by ordinary comment/login forms, so they only count when the page has almost no
 * readable text — otherwise every article with a comment form was reported as a challenge.
 */
function detectChallenge(html, text, finalUrl) {
  const blob = (String(html || '') + '\n' + String(text || '')).toLowerCase();
  const strong = [
    'unusual traffic from your computer network',
    'our systems have detected unusual traffic',
    'please verify you are a human',
    'checking your browser before accessing',
    'cf-browser-verification',
    'attention required! | cloudflare',
    'enable javascript and cookies to continue',
    '/sorry/index'
  ];
  const weak = ['recaptcha', 'hcaptcha', 'captcha-form'];
  const strongHit = strong.some(sg => blob.includes(sg));
  const weakHit = !strongHit && weak.some(sg => blob.includes(sg)) && countWords(normalizeText(text)) < 120;
  if (!strongHit && !weakHit) return null;
  let reason = 'bot_challenge';
  if (blob.includes('unusual traffic') || blob.includes('/sorry/index')) reason = 'google_traffic_check';
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




/** Minimal TTL + LRU map, used only when the lru-cache package is unavailable. */
class TtlLru {
  constructor(max, ttl) { this.max = max; this.ttl = ttl; this.map = new Map(); }
  get size() { return this.map.size; }
  get(key) {
    const e = this.map.get(key);
    if (!e) return undefined;
    if (Date.now() > e.exp) { this.map.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e); // refresh recency
    return e.v;
  }
  set(key, v) {
    this.map.delete(key);
    this.map.set(key, { v, exp: Date.now() + this.ttl });
    while (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
  clear() { this.map.clear(); }
}

/* ------------------------------------------------------------------ */
/* ContentExtractor                                                    */
/* ------------------------------------------------------------------ */


/**
 * Detect login / paywall walls that headless Chromium cannot usefully scrape.
 * Returns { auth_required, reason } when the page is a credential form or
 * the URL path looks like an auth endpoint.
 */
async function checkAuthRequired(page, url) {
  try {
    const path = (() => { try { return new URL(String(url || '')).pathname.toLowerCase(); } catch { return ''; } })();
    // Only path-based auth when the path itself is an auth endpoint (not /article/login-tips).
    if (/\/(login|signin|sign-in|auth|authenticate|signup|sign-up|register|oauth|sso)(\/|$)/i.test(path)
        && !/\/(wiki|blog|news|article|post|story)\//i.test(path)) {
      return { auth_required: true, reason: 'AUTH_URL_PATH' };
    }
    if (!page) return { auth_required: false, reason: null };
    const hit = await page.evaluate(() => {
      const bodyText = (document.body && document.body.innerText || '').trim();
      const words = bodyText.split(/\s+/).filter(Boolean).length;
      const pwds = document.querySelectorAll('input[type="password"]');
      // Login page heuristic: password field is central AND little article text
      if (pwds.length) {
        const main = document.querySelector('main, [role="main"], article, .content, #content');
        const mainWords = main ? (main.innerText || '').trim().split(/\s+/).filter(Boolean).length : words;
        // True login/paywall wall: short page focused on credentials
        if (mainWords < 120 || words < 150) return 'PASSWORD_INPUT';
        // Long article with a sidebar login widget — keep as reader, do not force WEBVIEW
      }
      const text = bodyText.slice(0, 4000).toLowerCase();
      if (words < 200 && /(sign in to continue|log in to continue|subscribers only|this content is for subscribers|create an account to read)/i.test(text)
          && document.querySelector('input[type="email"], input[type="password"], input[name*="user"], input[name*="email"]')) {
        return 'PAYWALL_OR_LOGIN_COPY';
      }
      return null;
    }).catch(() => null);
    if (hit) return { auth_required: true, reason: hit };
  } catch { /* ignore */ }
  return { auth_required: false, reason: null };
}

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
    this._inflight = new Map();
    this._cache = this._createCache();
    this._stats = {
      launches: 0, extractions: 0, failures: 0, lastError: null, lastExtractMs: null,
      cacheHits: 0, cacheMisses: 0, slowPath: 0
    };
  }

  /* ---------- result cache (lru-cache, 20 min TTL) ---------- */

  _createCache() {
    const o = this.opts;
    if (!(o.cacheTtlMs > 0)) { this._cacheImpl = 'off'; return null; }
    let LRU = null;
    try { const m = require('lru-cache'); LRU = m.LRUCache || m; } catch { LRU = null; }
    if (LRU) {
      this._cacheImpl = 'lru-cache';
      return new LRU({
        max: o.cacheMax,
        ttl: o.cacheTtlMs,
        maxSize: o.cacheMaxBytes,
        sizeCalculation: v => Math.max(1, ((v.clean_html || '').length + (v.raw_text || '').length) * 2 + 2048),
        allowStale: false,
        updateAgeOnGet: false
      });
    }
    // lru-cache missing (dependencies not installed): keep working with a tiny TTL-LRU.
    this._cacheImpl = 'fallback';
    return new TtlLru(o.cacheMax, o.cacheTtlMs);
  }

  clearCache() { if (this._cache) this._cache.clear(); }

  static cacheKey(target) {
    try { const u = new URL(target); u.hash = ''; return u.href; } catch { return String(target); }
  }

  static isCacheable(r) {
    return !!(r && r.ok && r.mode === 'READER' && r.kind === 'html' && r.readable && !r.challenge);
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
          args: [...CHROMIUM_ARGS, ...((this.opts.stealth && this.opts.stealth.launchArgs) || [])]
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
    this.clearCache();
    if (browser) { try { await browser.close(); } catch { /* already gone */ } }
  }

  stats() {
    return {
      ...this._stats,
      alive: this.isAlive(),
      active: this._active,
      queued: this._queue.length,
      maxConcurrent: this.opts.maxConcurrent,
      cache: {
        impl: this._cacheImpl,
        entries: this._cache ? this._cache.size : 0,
        ttlMs: this.opts.cacheTtlMs,
        hits: this._stats.cacheHits,
        misses: this._stats.cacheMisses
      }
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


  /**
   * Inject client-supplied session cookies into a Playwright context.
   * Accepts Playwright cookie objects or a raw Cookie header string.
   */
  async _injectCookies(context, cookies, pageUrl) {
    if (!cookies || !context) return 0;
    let list = [];
    if (typeof cookies === 'string') {
      const base = (() => { try { return new URL(pageUrl); } catch { return null; } })();
      if (!base) return 0;
      for (const part of cookies.split(';')) {
        const i = part.indexOf('=');
        if (i < 1) continue;
        const name = part.slice(0, i).trim();
        const value = part.slice(i + 1).trim();
        if (!name) continue;
        list.push({ name, value, domain: base.hostname, path: '/', url: base.origin });
      }
    } else if (Array.isArray(cookies)) {
      list = cookies.filter(c => c && c.name && c.value != null);
    }
    if (!list.length) return 0;
    try {
      await context.addCookies(list);
      return list.length;
    } catch {
      return 0;
    }
  }

  async _installRoutes(context, policy) {
    const blockedTypes = new Set(this.opts.blockedResourceTypes);
    const blockTrackers = this.opts.blockTrackers;
    const cache = new Map();
    await context.route('**/*', async (route) => {
      try {
        const req = route.request();
        let parsed;
        try { parsed = new URL(req.url()); } catch { return await route.abort('blockedbyclient'); }
        if (['data:', 'blob:', 'about:'].includes(parsed.protocol)) return await route.continue();
        if (!['http:', 'https:'].includes(parsed.protocol)) return await route.abort('blockedbyclient');
        const type = req.resourceType();
        // Cheapest checks first — none of these touch DNS.
        if (blockedTypes.has(type)) return await route.abort('blockedbyclient');
        if (blockTrackers && type !== 'document' && tiers.isTrackerHost(parsed.hostname)) return await route.abort('blockedbyclient');
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

  /* ---------- HTML → article (3-tier cascade) ---------- */

  /** Drop everything jsdom would parse for nothing: scripts (except ld+json), styles, comments. */
  _stripHeavy(html) {
    return String(html || '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
      .replace(/<script\b([^>]*)>[\s\S]*?<\/script\s*>/gi, (m, attrs) => (/ld\+json/i.test(attrs) ? m : ''));
  }

  /** Body string (plain text or markup) → { text, cleanHtml } with active content removed. */
  _bodyToClean(body, pageUrl) {
    const raw = String(body || '');
    if (!tiers.bodyKind(raw).hasMarkup) {
      const text = normalizeText(raw);
      return { text, cleanHtml: textToHtml(text) };
    }
    try {
      const { JSDOM, VirtualConsole } = this._jsdom();
      const cleanHtml = sanitizeHtml(raw, JSDOM, VirtualConsole, pageUrl);
      return { text: htmlToText(cleanHtml), cleanHtml };
    } catch {
      const text = htmlToText(raw);
      return { text, cleanHtml: textToHtml(text) };
    }
  }

  _finish(f) {
    let text = f.text;
    let truncated = false;
    if (text.length > this.opts.maxTextChars) { text = text.slice(0, this.opts.maxTextChars); truncated = true; }
    const words = countWords(text);
    const excerpt = f.excerpt ? normalizeText(f.excerpt) : text.replace(/\s+/g, ' ');
    const m = f.meta;
    return {
      title: (m.title || '').trim().slice(0, 300) || null,
      author: m.author || null,
      site_name: m.site_name || null,
      favicon: m.favicon || null,
      published_at: m.published_at || null,
      lang: m.lang || null,
      excerpt: excerpt.slice(0, 300),
      clean_html: f.cleanHtml ? '<article>' + f.cleanHtml + '</article>' : '',
      raw_text: text,
      word_count: words,
      reading_minutes: words ? Math.max(1, Math.ceil(words / 200)) : 0,
      readable: f.readable !== undefined ? f.readable : words >= 40,
      truncated,
      used_fallback: f.tier === 3,
      tier: f.tier,
      extraction_method: f.method,
      // Tells the caller a re-parse after hydration is worth the extra wait.
      needs_hydration: !!f.needsHydration,
      videos: f.videos || [],
      challenge: detectChallenge(f.htmlForChallenge || '', text, f.pageUrl) || null
    };
  }

  /**
   * Turn rendered HTML into { title, author, site_name, favicon, published_at, lang, excerpt,
   * clean_html, raw_text, word_count, reading_minutes, readable, truncated, tier, ... }.
   *
   *   Tier 1  JSON-LD Article / NewsArticle / BlogPosting  → articleBody (no DOM built at all)
   *   Tier 2  @mozilla/readability on jsdom (charThreshold 100)
   *   Tier 3  hydration state (__NEXT_DATA__ / __NUXT__), densest block, body text
   *
   * Synchronous and independent from Playwright, so it can be tested with plain HTML.
   * @param {object} [extra] { hydration: [{source,data}], innerText } gathered from the live page
   */
  parseHtml(html, pageUrl, extra = {}) {
    const source = String(html || '');
    const challengeSlice = source.slice(0, 300000);
    const videos = tiers.scanVideoSources(source, pageUrl, this.opts.maxMedia);
    let host = '';
    try { host = new URL(pageUrl).hostname.replace(/^www\./i, ''); } catch { /* ignore */ }

    /* ---- Tier 1: JSON-LD ---- */
    const ld = tiers.findJsonLdArticle(source);
    if (ld && ld.body && tiers.bodyKind(ld.body).words >= TIER1_MIN_WORDS) {
      const quick = tiers.quickMeta(source, pageUrl);
      const { text, cleanHtml } = this._bodyToClean(ld.body, pageUrl);
      const out = this._finish({
        tier: 1, method: 'json-ld', text, cleanHtml, videos, pageUrl, htmlForChallenge: challengeSlice,
        excerpt: ld.description && ld.description.length >= 40 ? ld.description : '',
        meta: {
          title: ld.headline || quick.title,
          author: ld.author || quick.author,
          site_name: quick.site_name || ld.publisher || quick.host || host,
          favicon: quick.favicon,
          published_at: ld.datePublished || quick.published_at,
          lang: quick.lang
        }
      });
      if (!out.challenge) return out;
    }

    /* ---- Tier 2: Readability ---- */
    const hydrationSources = [...tiers.extractHydrationFromHtml(source), ...((extra && extra.hydration) || [])];
    const slim = this._stripHeavy(source);
    const { JSDOM, VirtualConsole } = this._jsdom();
    const Readability = this._readability();
    const newDom = () => new JSDOM(slim, { url: pageUrl, contentType: 'text/html', virtualConsole: VirtualConsole ? new VirtualConsole() : undefined });
    const dom = newDom();
    try {
      const doc = dom.window.document;
      const meta = readMetadata(doc, pageUrl); // before Readability mutates the document
      if (ld) {
        if (!meta.title && ld.headline) meta.title = ld.headline;
        if (!meta.author && ld.author) meta.author = ld.author;
        if (!meta.published_at && ld.datePublished) meta.published_at = ld.datePublished;
      }

      let article = null;
      try { article = new Readability(doc, { charThreshold: 100, keepClasses: false, maxElemsToParse: 100000 }).parse(); } catch { article = null; }

      let t2 = null;
      if (article && article.content && normalizeText(article.textContent).length > 0) {
        t2 = {
          text: normalizeText(article.textContent),
          cleanHtml: sanitizeHtml(article.content, JSDOM, VirtualConsole, pageUrl),
          title: article.title || null,
          excerpt: article.excerpt || '',
          byline: article.byline ? cleanAuthor(article.byline) : null,
          published: toIsoDate(article.publishedTime),
          siteName: article.siteName || null
        };
      }

      const finishWith = (tier, method, c, needsHydration) => this._finish({
        tier, method, text: c.text, cleanHtml: c.cleanHtml, excerpt: c.excerpt, videos, pageUrl,
        htmlForChallenge: challengeSlice, needsHydration,
        readable: countWords(c.text) >= 40,
        meta: {
          title: c.title || meta.title,
          author: meta.author || c.byline || c.author || null,
          site_name: meta.site_name || c.siteName || null,
          favicon: meta.favicon,
          published_at: meta.published_at || c.published || null,
          lang: meta.lang
        }
      });

      if (t2 && !isThinArticle(t2.text, t2.cleanHtml)) return finishWith(2, 'readability', t2, false);

      /* ---- Tier 3: hydration state → densest block → body text ---- */
      const candidates = [];
      if (t2) candidates.push({ tier: 2, method: 'readability-thin', ...t2 });

      for (const h of hydrationSources) {
        const found = tiers.findBodyInHydration(h.data);
        if (!found) continue;
        const { text, cleanHtml } = this._bodyToClean(found.body, pageUrl);
        candidates.push({
          tier: 3, method: 'hydration:' + h.source, text, cleanHtml, title: found.title,
          author: found.author, published: found.published, excerpt: ''
        });
      }

      try {
        const fresh = newDom();
        try {
          const fb = fallbackMainContent(fresh.window.document);
          if (fb && fb.text) {
            candidates.push({
              tier: 3, method: fb.weak ? 'body-text' : 'densest-block', text: fb.text,
              cleanHtml: sanitizeHtml(fb.html, JSDOM, VirtualConsole, pageUrl), excerpt: ''
            });
          }
        } finally { try { fresh.window.close(); } catch { /* ignore */ } }
      } catch { /* keep what we have */ }

      if (extra && extra.innerText) {
        const text = normalizeText(extra.innerText);
        if (text) candidates.push({ tier: 3, method: 'inner-text', text, cleanHtml: textToHtml(text), excerpt: '' });
      }

      // Hydration data is the most structured Tier-3 source; otherwise the longest text wins.
      const hydrated = candidates.find(c => c.method.startsWith('hydration:') && countWords(c.text) >= 80);
      const best = hydrated || candidates.reduce((a, b) => (!a || countWords(b.text) > countWords(a.text) ? b : a), null);
      if (!best) {
        return finishWith(3, 'empty', { text: '', cleanHtml: '', excerpt: '' }, true);
      }
      const weak = countWords(best.text) < 80;
      // Last resort for very short pages: the JSON-LD description beats a few lines of chrome.
      if (weak && ld && ld.description && countWords(ld.description) > countWords(best.text)) {
        const text = normalizeText(ld.description);
        return finishWith(3, 'json-ld-description', { text, cleanHtml: textToHtml(text), excerpt: '' }, true);
      }
      return finishWith(best.tier, best.method, best, weak);
    } finally {
      try { dom.window.close(); } catch { /* ignore */ }
    }
  }

  /* ---------- main entry ---------- */

  /**
   * @param {string} url http(s) URL
   * @param {object} [options] { locale, timeoutMs, settleMs, noCache }
   * @returns {Promise<object>} extraction result; `cached` is true when served from the LRU cache
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
    if (intent.mode === 'EMBED') return this._embedResult(target, intent, started);
    if (intent.mode === 'WEBVIEW') return this._webviewResult(target, intent, started);

    const key = ContentExtractor.cacheKey(target);
    const useCache = !options.noCache;
    if (useCache && this._cache) {
      const hit = this._cache.get(key);
      if (hit) {
        this._stats.cacheHits += 1;
        return { ...hit, media: hit.media.slice(), cached: true, duration_ms: Date.now() - started };
      }
    }
    this._stats.cacheMisses += 1;

    // Identical concurrent requests share one scrape instead of opening N pages.
    if (useCache && this._inflight.has(key)) {
      const shared = await this._inflight.get(key);
      return { ...shared, media: shared.media.slice(), cached: false, duration_ms: Date.now() - started };
    }

    const job = this._scrape(target, options, started);
    if (useCache) this._inflight.set(key, job);
    try {
      const result = await job;
      if (this._cache && ContentExtractor.isCacheable(result)) this._cache.set(key, { ...result, media: result.media.slice() });
      return result;
    } finally {
      if (useCache) this._inflight.delete(key);
    }
  }

  async _scrape(target, options, started) {
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

  _embedResult(target, intent, started) {
    return {
      ok: true, mode: 'EMBED', cached: false, auth_required: false, url: target, final_url: target, http_status: 200,
      content_type: 'text/html', kind: 'embed',
      title: (intent.platform || 'video') + (intent.videoId ? ' ' + intent.videoId : ''),
      author: null, site_name: intent.platform, favicon: null, published_at: null, lang: 'en',
      excerpt: '', clean_html: '', raw_text: '', word_count: 0, reading_minutes: 0,
      readable: false, truncated: false, media: [],
      embed_url: intent.embed_url, platform: intent.platform, videoId: intent.videoId,
      intent_reason: intent.reason, extracted_at: new Date().toISOString(), duration_ms: Date.now() - started
    };
  }

  _webviewResult(target, intent, started) {
    return {
      ok: true, mode: 'WEBVIEW', cached: false, auth_required: true, url: target, final_url: target, http_status: 200,
      content_type: 'text/html', kind: 'webview',
      title: intent.platform || hostOf(target) || target,
      author: null, site_name: intent.platform || hostOf(target), favicon: null, published_at: null, lang: 'en',
      excerpt: '', clean_html: '', raw_text: '', word_count: 0, reading_minutes: 0,
      readable: false, truncated: false, media: [], webview_required: true,
      intent_reason: intent.reason, extracted_at: new Date().toISOString(), duration_ms: Date.now() - started
    };
  }

  /* ---------- live-page helpers ---------- */

  async _readHtml(page) {
    let html;
    try { html = await page.content(); } catch {
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      html = await page.content();
    }
    return html.length > this.opts.maxHtmlChars ? html.slice(0, this.opts.maxHtmlChars) : html;
  }

  /** Slow path: wait (bounded) for client-side rendering to put real text into the DOM. */
  async _awaitHydration(page, settle) {
    await page.waitForFunction(
      () => !!document.body && document.body.innerText.trim().length > 600,
      null,
      { timeout: settle }
    ).catch(() => {});
    await page.waitForLoadState('networkidle', { timeout: Math.min(800, settle) }).catch(() => {});
  }

  /** window.__NEXT_DATA__ / window.__NUXT__ and body.innerText from the live page. */
  async _collectHydration(page) {
    const limit = this.opts.maxTextChars;
    let raw = null;
    try {
      raw = await page.evaluate((max) => {
        const out = { globals: [], innerText: '' };
        const grab = (name) => {
          try {
            const v = window[name];
            if (!v) return;
            const s = JSON.stringify(v);
            if (s && s.length <= 6000000) out.globals.push({ source: 'window.' + name, json: s });
          } catch (e) { /* cyclic or non-serialisable state */ }
        };
        grab('__NEXT_DATA__');
        grab('__NUXT__');
        try { out.innerText = (document.body && document.body.innerText || '').slice(0, max); } catch (e) { /* ignore */ }
        return out;
      }, limit);
    } catch { return { hydration: [], innerText: '' }; }
    const hydration = [];
    for (const g of (raw && raw.globals) || []) {
      const data = tiers.parseJsonLenient(g.json);
      if (data) hydration.push({ source: g.source, data });
    }
    return { hydration, innerText: (raw && raw.innerText) || '' };
  }

  /** Last-chance nudge for lazy pages: dismiss a cookie wall and scroll two screens (bounded ~0.6s). */
  async _nudgePage(page) {
    try {
      await page.evaluate(async () => {
        const re = /^(accept( all)?|agree|allow all|i agree|đồng ý|chấp nhận|tôi đồng ý)$/i;
        for (const b of document.querySelectorAll('button, [role="button"]')) {
          if (re.test((b.innerText || '').trim())) { b.click(); break; }
        }
        for (let i = 0; i < 2; i++) {
          window.scrollBy(0, window.innerHeight);
          await new Promise(r => setTimeout(r, 150));
        }
        window.scrollTo(0, 0);
      });
    } catch { /* ignore */ }
  }

  async _extractLocked(target, options, started, setContext) {
    const timeout = options.timeoutMs || this.opts.timeoutMs;
    const settle = options.settleMs != null ? options.settleMs : this.opts.settleMs;
    const settings = security.load();
    const policy = { blockPrivate: !!(settings.safeNavigation && settings.blockPrivateNetwork) };
    const stealth = this.opts.stealth || {};

    const browser = await this._ensureBrowser();
    // Dynamic GeoIP: timezone + locale match public egress IP (not a hard-coded region).
    // Per-request options.locale / options.timezoneId still win when provided.
    let geo = { timezoneId: 'UTC', locale: 'en-US', countryCode: null, source: 'fallback' };
    try { geo = await getPublicIpGeoData(); } catch { /* keep fallback */ }
    const locale = options.locale || geo.locale || this.opts.locale || 'en-US';
    const timezoneId = options.timezoneId || geo.timezoneId || (stealth && stealth.timezoneId) || 'UTC';
    const acceptLanguage = options.acceptLanguage || acceptLanguageFor(locale);
    const langList = [locale, locale.split('-')[0], 'en-US', 'en'].filter((v, i, a) => v && a.indexOf(v) === i);
    const context = await browser.newContext({
      userAgent: this.opts.userAgent,
      viewport: this.opts.viewport,
      locale,
      timezoneId,
      acceptDownloads: false,
      extraHTTPHeaders: { 'Accept-Language': acceptLanguage, 'Upgrade-Insecure-Requests': '1' },
      colorScheme: 'light',
      deviceScaleFactor: 1,
      serviceWorkers: 'block',
      ignoreHTTPSErrors: false
    });
    setContext(context);
    context.setDefaultTimeout(timeout);
    context.setDefaultNavigationTimeout(timeout);
    const initScript = (typeof buildInitScript === 'function')
      ? buildInitScript(langList)
      : (stealth && stealth.initScript);
    if (initScript) await context.addInitScript(initScript);
    await this._installRoutes(context, policy);
    await this._injectCookies(context, options.cookies, target);

    const page = await context.newPage();
    // The page is always closed here (even on error/timeout) so Chromium frees its renderer
    // process immediately; extract() then closes the context.
    try {
      const media = new Map();
      page.on('response', response => this._collectMedia(response, media));

      let response = null;
      const tNav = Date.now();
      try {
        response = await page.goto(target, { waitUntil: 'domcontentloaded', timeout });
      } catch (err) {
        if (/Download is starting/i.test(String(err && err.message))) {
          return this._nonHtmlResult(target, target, null, 'application/octet-stream', media, started);
        }
        throw friendlyNavError(err);
      }
      const navigateMs = Date.now() - tNav;

      const httpStatus = response ? response.status() : null;
      const contentType = response ? String((response.headers() || {})['content-type'] || '') : '';
      if (httpStatus && httpStatus >= 400) {
        throw new ExtractorError('HTTP_ERROR', `The site responded with HTTP ${httpStatus}`, { httpStatus });
      }
      const finalUrl = page.url() || target;
      if (contentType && !/html|xml|^text\//i.test(contentType)) {
        return this._nonHtmlResult(target, finalUrl, httpStatus, contentType, media, started);
      }

      // Auth / paywall gate — prefer WEBVIEW over empty reader scrape
      const auth = await checkAuthRequired(page, finalUrl || target);
      if (auth.auth_required) {
        return {
          ok: true,
          mode: 'WEBVIEW',
          cached: false,
          auth_required: true,
          url: target,
          final_url: finalUrl || target,
          http_status: httpStatus || 200,
          content_type: 'text/html',
          kind: 'webview',
          title: hostOf(finalUrl || target) || target,
          author: null,
          site_name: hostOf(finalUrl || target),
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
          intent_reason: auth.reason || 'AUTH_REQUIRED',
          extracted_at: new Date().toISOString(),
          duration_ms: Date.now() - started
        };
      }

      // FAST PATH — parse the server-rendered document immediately. Tier 1 (JSON-LD) and
      // Tier 2 (Readability) succeed on most news/blog pages without waiting for the network.
      const tParse = Date.now();
      let html = await this._readHtml(page);
      let parsed = this.parseHtml(html, finalUrl);
      let slowPath = false;

      // SLOW PATH — only for pages whose first parse was weak (client-rendered SPAs).
      if (parsed.needs_hydration && settle > 0) {
        slowPath = true;
        this._stats.slowPath += 1;
        await this._awaitHydration(page, settle);
        let extra = await this._collectHydration(page);
        html = await this._readHtml(page);
        parsed = this.parseHtml(html, finalUrl, extra);
        if (parsed.needs_hydration) {
          await this._nudgePage(page);
          await page.waitForTimeout(250).catch(() => {});
          extra = await this._collectHydration(page);
          html = await this._readHtml(page);
          parsed = this.parseHtml(html, finalUrl, extra);
        }
      }
      const parseMs = Date.now() - tParse;

      if (!parsed.title) {
        try { parsed.title = (await page.title()) || null; } catch { /* ignore */ }
      }
      // <video>/<source>/og:video found in markup (media requests are blocked, so they never hit the network).
      for (const v of parsed.videos || []) if (!media.has(v.url) && media.size < this.opts.maxMedia) media.set(v.url, v);

      const challenge = parsed.challenge || detectChallenge(html.slice(0, 300000), parsed.raw_text || parsed.excerpt, finalUrl);
      return {
        ok: true,
        url: target,
        final_url: finalUrl,
        http_status: httpStatus,
        content_type: contentType.split(';')[0].trim() || 'text/html',
        mode: 'READER',
        cached: false,
        auth_required: false,
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
        used_fallback: !!parsed.used_fallback,
        tier: parsed.tier || null,
        extraction_method: parsed.extraction_method || null,
        media: Array.from(media.values()),
        timing: { navigate_ms: navigateMs, parse_ms: parseMs, slow_path: slowPath },
        geo: { timezoneId, locale, source: geo.source, countryCode: geo.countryCode || null },
        extracted_at: new Date().toISOString(),
        duration_ms: Date.now() - started
      };
    } finally {
      try { await page.close({ runBeforeUnload: false }); } catch { /* already closed */ }
    }
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
  checkAuthRequired,
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
  detectLangFromText,
  TIER1_MIN_WORDS
};
