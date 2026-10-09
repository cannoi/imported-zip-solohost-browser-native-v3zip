'use strict';

/**
 * Pure building blocks for the 3-tier extraction cascade.
 *
 *   Tier 1  JSON-LD / Schema.org   (findJsonLdArticle)           — regex only, no jsdom
 *   Tier 2  Readability.js DOM     (implemented in ContentExtractor.parseHtml)
 *   Tier 3  Hydration / fallback   (extractHydrationFromHtml + findBodyInHydration,
 *                                   densest-block fallback lives in content-extractor.js)
 *
 * Everything here works on plain strings/objects so it is fast (Tier 1 never builds a DOM)
 * and unit-testable without Playwright or jsdom.
 */

const { countWords, normalizeText, decodeEntities, safeUrl, cleanAuthor, toIsoDate } = require('./text-utils');

/* ------------------------------------------------------------------ */
/* Tracker / ad hosts (aborted at the network layer)                   */
/* ------------------------------------------------------------------ */

const TRACKER_HOSTS = [
  'google-analytics.com', 'googletagmanager.com', 'googletagservices.com', 'googlesyndication.com',
  'googleadservices.com', 'doubleclick.net', 'adservice.google.com', 'pagead2.googlesyndication.com',
  'facebook.net', 'connect.facebook.net', 'scorecardresearch.com', 'hotjar.com', 'hotjar.io',
  'clarity.ms', 'taboola.com', 'outbrain.com', 'criteo.com', 'criteo.net', 'adnxs.com',
  'amazon-adsystem.com', 'quantserve.com', 'chartbeat.com', 'chartbeat.net', 'mixpanel.com',
  'segment.io', 'segment.com', 'nr-data.net', 'newrelic.com', 'moatads.com', 'adsrvr.org',
  'rubiconproject.com', 'pubmatic.com', 'openx.net', 'casalemedia.com', 'smartadserver.com',
  // Vietnamese ad networks commonly embedded in news sites
  'adtima.vn', 'admicro.vn', 'eclick.vn', 'ants.vn'
];

/** True for analytics / advertising hosts (exact or sub-domain match, or an "analytics." label). */
function isTrackerHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h) return false;
  if (/(^|\.)analytics\./.test(h)) return true;
  return TRACKER_HOSTS.some(t => h === t || h.endsWith('.' + t));
}

/* ------------------------------------------------------------------ */
/* Tier 1 — JSON-LD                                                    */
/* ------------------------------------------------------------------ */

const ARTICLE_TYPES = new Set([
  'article', 'newsarticle', 'blogposting', 'reportagenewsarticle', 'analysisnewsarticle',
  'opinionnewsarticle', 'backgroundnewsarticle', 'reviewnewsarticle', 'techarticle', 'socialmediaposting'
]);

const LD_SCRIPT_RE = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script>/gi;

/** Escape raw control characters that appear INSIDE JSON strings (invalid JSON, common in CMS output). */
function escapeControlCharsInStrings(s) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) { esc = false; out += ch; continue; }
      if (ch === '\\') { esc = true; out += ch; continue; }
      if (ch === '"') { inStr = false; out += ch; continue; }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t' : ' ';
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') inStr = true;
      out += ch;
    }
  }
  return out;
}

function parseJsonLenient(raw) {
  const s = String(raw || '').trim().replace(/^<!--|-->$/g, '').trim();
  if (!s) return null;
  try { return JSON.parse(s); } catch { /* fall through to the repair attempt */ }
  try { return JSON.parse(escapeControlCharsInStrings(s)); } catch { return null; }
}

function typeMatches(t) {
  const list = Array.isArray(t) ? t : [t];
  return list.some(x => typeof x === 'string' && ARTICLE_TYPES.has(x.replace(/^.*[/#:]/, '').toLowerCase()));
}

function ldName(v) {
  if (!v) return null;
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) {
    const names = v.map(ldName).filter(Boolean).slice(0, 3);
    return names.length ? names.join(', ') : null;
  }
  if (typeof v === 'object') {
    if (typeof v.name === 'string') return v.name;
    if (typeof v['@id'] === 'string' && !/^https?:/i.test(v['@id'])) return null;
  }
  return null;
}

/**
 * Scan every <script type="application/ld+json"> and return the best Article-like node:
 * { type, headline, body, description, author, publisher, datePublished } or null.
 * "Best" = longest articleBody; when none has a body, the first typed node (metadata only).
 */
function findJsonLdArticle(html) {
  const source = String(html || '');
  if (!/ld\+json/i.test(source)) return null;
  let best = null;
  let bestLen = -1;

  const consider = (node) => {
    const body = typeof node.articleBody === 'string' ? decodeEntities(node.articleBody).trim() : '';
    const cand = {
      type: Array.isArray(node['@type']) ? node['@type'][0] : node['@type'],
      headline: typeof node.headline === 'string' ? decodeEntities(node.headline).trim() : (typeof node.name === 'string' ? decodeEntities(node.name).trim() : null),
      body,
      description: typeof node.description === 'string' ? decodeEntities(node.description).trim() : '',
      author: cleanAuthor(ldName(node.author)),
      publisher: ldName(node.publisher),
      datePublished: toIsoDate(node.datePublished) || toIsoDate(node.dateCreated)
    };
    if (cand.body.length > bestLen) { best = cand; bestLen = cand.body.length; }
  };

  const walk = (node, depth) => {
    if (!node || depth > 8) return;
    if (Array.isArray(node)) { node.slice(0, 60).forEach(n => walk(n, depth + 1)); return; }
    if (typeof node !== 'object') return;
    if (typeof node['@type'] !== 'undefined' && typeOk(node)) consider(node);
    if (node['@graph']) walk(node['@graph'], depth + 1);
    if (node.mainEntity) walk(node.mainEntity, depth + 1);
    if (node.mainEntityOfPage && typeof node.mainEntityOfPage === 'object') walk(node.mainEntityOfPage, depth + 1);
  };
  const typeOk = n => typeMatches(n['@type']);

  LD_SCRIPT_RE.lastIndex = 0;
  let m;
  let guard = 0;
  while ((m = LD_SCRIPT_RE.exec(source)) && guard++ < 40) {
    const data = parseJsonLenient(m[1]);
    if (data) walk(data, 0);
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Tier 3 — hydration state (Next.js / Nuxt)                           */
/* ------------------------------------------------------------------ */

const HYDRATION_SCRIPTS = [
  { source: '__NEXT_DATA__', re: /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i },
  { source: '__NUXT_DATA__', re: /<script\b[^>]*\bid\s*=\s*["']__NUXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i }
];
const MAX_HYDRATION_CHARS = 6000000;

/** Static hydration payloads that are plain JSON inside <script id="…"> tags. */
function extractHydrationFromHtml(html) {
  const out = [];
  const source = String(html || '');
  for (const { source: name, re } of HYDRATION_SCRIPTS) {
    const m = re.exec(source);
    if (!m || !m[1] || m[1].length > MAX_HYDRATION_CHARS) continue;
    const data = parseJsonLenient(m[1]);
    if (data) out.push({ source: name, data });
  }
  return out;
}

const BODY_KEY_RE = /^(articlebody|article_body|body|bodyhtml|body_html|content|contenthtml|content_html|fullcontent|full_content|html|text|story|storybody|post_content|maincontent|main_content|detail|richtext)$/i;
const TITLE_KEY_RE = /^(headline|title|name)$/i;
const AUTHOR_KEY_RE = /^(author|authorname|author_name|byline|writer|creator)$/i;
const DATE_KEY_RE = /^(datepublished|date_published|publishedat|published_at|publishdate|publish_date|createdat|created_at|date)$/i;

function visibleLength(s) { return String(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().length; }
function looksLikeCodeOrJson(s) {
  const t = s.trimStart();
  if (/^[\[{]/.test(t)) return true;
  if (/^(function\b|\(function|var |const |let |import |export |!function)/.test(t)) return true;
  if (/^data:/i.test(t) || /^https?:\/\/\S+$/i.test(t)) return true;
  return false;
}

/**
 * Walk a hydration object and return the most article-like body string:
 * { body, isHtml, title, author, published } or null.
 */
function findBodyInHydration(root, { minChars = 400 } = {}) {
  let best = null;
  let bestScore = 0;
  let visited = 0;

  const walk = (node, depth) => {
    if (node == null || depth > 14 || visited++ > 120000) return;
    if (Array.isArray(node)) {
      // Nuxt 3 payloads are flat arrays of values: long keyless strings are candidates too.
      for (const v of node) {
        if (typeof v === 'string' && v.length >= minChars * 2) consider(v, null, false);
        else if (v && typeof v === 'object') walk(v, depth + 1);
      }
      return;
    }
    if (typeof node !== 'object') return;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === 'string') { if (BODY_KEY_RE.test(k) && v.length >= minChars) consider(v, node, true); }
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  };

  const consider = (value, owner, keyed) => {
    if (looksLikeCodeOrJson(value)) return;
    const isHtml = /<(p|div|br|h[1-6]|ul|ol|li|blockquote)\b/i.test(value);
    const len = visibleLength(value);
    if (len < minChars) return;
    // Prefer prose: penalise strings with very few sentence breaks (ids, minified blobs).
    const spaces = (value.match(/\s/g) || []).length;
    if (spaces < len / 12) return;
    const score = len * (keyed ? 1 : 0.7);
    if (score <= bestScore) return;
    bestScore = score;
    const pick = (re) => {
      if (!owner) return null;
      for (const [k, v] of Object.entries(owner)) if (re.test(k)) return v;
      return null;
    };
    const title = pick(TITLE_KEY_RE);
    best = {
      body: value,
      isHtml,
      title: typeof title === 'string' ? decodeEntities(title).trim() : null,
      author: cleanAuthor(ldName(pick(AUTHOR_KEY_RE))),
      published: toIsoDate(pick(DATE_KEY_RE))
    };
  };

  walk(root, 0);
  return best;
}

/* ------------------------------------------------------------------ */
/* Cheap metadata + static video scan (no DOM)                         */
/* ------------------------------------------------------------------ */

function parseAttrs(tag) {
  const attrs = {};
  const re = /([a-zA-Z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let m;
  while ((m = re.exec(tag))) attrs[m[1].toLowerCase()] = decodeEntities(m[2] != null ? m[2] : (m[3] != null ? m[3] : m[4]));
  return attrs;
}

/** Title / site name / favicon / lang / author / date straight from the markup. */
function quickMeta(html, pageUrl) {
  const source = String(html || '');
  const head = source.slice(0, 400000);
  const meta = new Map();
  for (const m of head.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const content = (a.content || '').trim();
    if (!content) continue;
    for (const key of [a.property, a.name, a.itemprop]) {
      const k = (key || '').trim().toLowerCase();
      if (k && !meta.has(k)) meta.set(k, content);
    }
  }
  const first = keys => { for (const k of keys) if (meta.has(k)) return meta.get(k); return null; };

  let favicon = null;
  let apple = null;
  for (const m of head.matchAll(/<link\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    const rels = (a.rel || '').toLowerCase().split(/\s+/);
    const href = safeUrl(a.href, pageUrl, ['http:', 'https:', 'data:']);
    if (!href) continue;
    if (!favicon && rels.includes('icon')) favicon = href;
    else if (!apple && rels.includes('apple-touch-icon')) apple = href;
  }
  if (!favicon) favicon = apple;
  if (!favicon) { try { favicon = new URL('/favicon.ico', pageUrl).href; } catch { favicon = null; } }

  const langMatch = /<html\b[^>]*\blang\s*=\s*["']?([A-Za-z-]{2,10})/i.exec(head);
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head);
  let host = '';
  try { host = new URL(pageUrl).hostname.replace(/^www\./i, ''); } catch { /* ignore */ }

  return {
    title: first(['og:title', 'twitter:title']) || (titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : null),
    author: cleanAuthor(first(['author', 'article:author', 'parsely-author', 'dc.creator', 'twitter:creator'])),
    site_name: first(['og:site_name', 'application-name']) || null,
    host: host || null,
    favicon,
    published_at: toIsoDate(first(['article:published_time', 'og:article:published_time', 'datepublished', 'pubdate', 'publishdate', 'parsely-pub-date', 'dc.date.issued', 'date'])),
    lang: langMatch ? langMatch[1] : (first(['og:locale', 'content-language']) || null)
  };
}

/**
 * Videos referenced directly in the markup (<video>, <source>, og:video). Needed because the
 * network layer now aborts `media` requests, so .mp4 files never show up as responses.
 */
function scanVideoSources(html, pageUrl, limit = 20) {
  const found = new Map();
  const add = (raw) => {
    const url = safeUrl(raw, pageUrl);
    if (!url || found.size >= limit) return;
    let pathname = '';
    try { pathname = new URL(url).pathname.toLowerCase(); } catch { return; }
    const type = pathname.endsWith('.m3u8') ? 'm3u8' : (pathname.endsWith('.mp4') ? 'mp4' : null);
    if (!type) return;
    const key = url.split('#')[0];
    if (!found.has(key)) found.set(key, { url: key, type, content_type: type === 'mp4' ? 'video/mp4' : 'application/vnd.apple.mpegurl', status: 200, size: null });
  };
  const source = String(html || '');
  for (const m of source.matchAll(/<(?:video|source)\b[^>]*>/gi)) add(parseAttrs(m[0]).src);
  for (const m of source.matchAll(/<meta\b[^>]*>/gi)) {
    const a = parseAttrs(m[0]);
    if (/^og:video(:url|:secure_url)?$/i.test(a.property || '')) add(a.content);
  }
  return Array.from(found.values());
}

/** Plain-text body (JSON-LD / hydration) → { text, hasMarkup } */
function bodyKind(body) {
  const hasMarkup = /<\/?(p|div|br|h[1-6]|ul|ol|li|blockquote|a|strong|em|span|img)\b/i.test(body);
  return { hasMarkup, words: countWords(normalizeText(hasMarkup ? body.replace(/<[^>]*>/g, ' ') : body)) };
}

module.exports = {
  TRACKER_HOSTS,
  ARTICLE_TYPES,
  isTrackerHost,
  findJsonLdArticle,
  extractHydrationFromHtml,
  findBodyInHydration,
  quickMeta,
  scanVideoSources,
  bodyKind,
  parseJsonLenient
};
