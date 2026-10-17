'use strict';
/**
 * Agent web tools — single module (safeFetch, feeds, article extract, PDF/page extract).
 * All Browser Agent HTTP/extraction helpers live here.
 */
const { clip: utilClip } = require('./util');
const geoip = require('./geoip');
/**
 * Lightweight research tools: RSS/Atom parse, article list extraction, readability-ish text.
 * No heavy dependencies — regex + basic DOM string parsing.
 */
const { assertPublicHttpUrl } = require('./net-guard');
const dns = require('dns').promises;
const net = require('net');

function clip(s, n) { return utilClip(s, n == null ? 200 : n); }

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ');
}

async function assertSafeUrl(url) {
  await assertPublicHttpUrl(url);
  try {
    const host = new URL(url).hostname;
    const ips = await dns.lookup(host, { all: true });
    for (const { address } of ips) {
      const family = net.isIP(address);
      let privateAddress = false;
      if (family === 4) {
        const p = address.split('.').map(Number);
        privateAddress = p[0] === 10 || p[0] === 127 || (p[0] === 192 && p[1] === 168) || (p[0] === 169 && p[1] === 254) ||
          (p[0] === 172 && p[1] >= 16 && p[1] <= 31) || p[0] === 0 || p[0] >= 224;
      } else if (family === 6) {
        const a = address.toLowerCase();
        privateAddress = a === '::1' || a === '::' || a.startsWith('fc') || a.startsWith('fd') || a.startsWith('fe8') || a.startsWith('fe9') || a.startsWith('fea') || a.startsWith('feb') || a.startsWith('::ffff:127.') || a.startsWith('::ffff:10.') || a.startsWith('::ffff:192.168.') || a.startsWith('::ffff:169.254.');
      }
      if (privateAddress) { const e = new Error('Blocked private IP after DNS'); e.code = 'SSRF'; throw e; }
    }
  } catch (e) {
    if (e.code === 'SSRF') throw e;
  }
  return url;
}

/**
 * Fetch with manual redirects (max 5), re-check each hop for SSRF.
 */
async function safeFetch(url, { maxRedirects = 5, timeoutMs = 15000, headers: extraHeaders = null, signal: outerSignal = null } = {}) {
  let current = url;
  for (let i = 0; i <= maxRedirects; i++) {
    await assertSafeUrl(current);
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    if (outerSignal) {
      if (outerSignal.aborted) { clearTimeout(t); throw new Error('aborted'); }
      try { outerSignal.addEventListener('abort', () => ac.abort(), { once: true }); } catch (_) {}
    }
    try {
      const baseHeaders = {
        'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,text/xml,*/*',
        'Accept-Language': (geoip.getGeoProfileSync().acceptLanguage || 'en-US,en;q=0.9')
      };
      // Caller headers win (e.g. Brave X-Subscription-Token) — do not drop them
      const headers = Object.assign({}, baseHeaders, extraHeaders && typeof extraHeaders === 'object' ? extraHeaders : {});
      const res = await fetch(current, {
        method: 'GET',
        redirect: 'manual',
        signal: ac.signal,
        headers
      });
      clearTimeout(t);
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) throw new Error('redirect without location');
        current = new URL(loc, current).href;
        continue;
      }
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 2_500_000) throw new Error('response too large');
      const ct = res.headers.get('content-type') || '';
      return { ok: res.ok, status: res.status, url: current, contentType: ct, body: buf.toString('utf8') };
    } catch (e) {
      clearTimeout(t);
      throw e;
    }
  }
  throw new Error('too many redirects');
}

function parseFeed(xml, baseUrl) {
  const items = [];
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  for (const b of blocks.slice(0, 40)) {
    const title = decodeEntities((b.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<[^>]+>/g, '').trim();
    let link = (b.match(/<link[^>]*href=["']([^"']+)["']/i) || [])[1] ||
      (b.match(/<link[^>]*>([\s\S]*?)<\/link>/i) || [])[1] || '';
    link = decodeEntities(link).replace(/<[^>]+>/g, '').trim();
    try { if (link) link = new URL(link, baseUrl).href; } catch (_) {}
    const published = (b.match(/<(?:pubDate|published|updated|dc:date)[^>]*>([\s\S]*?)<\//i) || [])[1] || '';
    const summary = decodeEntities((b.match(/<(?:description|summary|content)[^>]*>([\s\S]*?)<\//i) || [])[1] || '')
      .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (title || link) {
      items.push({
        title: clip(title, 300),
        url: link,
        publishedAt: published ? new Date(published).toISOString() : null,
        summary: clip(summary, 400),
        category: null
      });
    }
  }
  return items.filter((x) => x.url);
}

function extractArticlesFromHtml(html, pageUrl) {
  const out = [];
  const seen = new Set();
  // JSON-LD NewsArticle / ItemList
  const ld = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const block of ld) {
    try {
      const json = JSON.parse(block.replace(/^[\s\S]*?>/, '').replace(/<\/script>.*/i, ''));
      const nodes = Array.isArray(json) ? json : [json];
      for (const n of nodes) {
        if (!n) continue;
        if (n['@type'] === 'NewsArticle' || n['@type'] === 'Article') {
          const u = n.url || n.mainEntityOfPage?.['@id'] || n.mainEntityOfPage;
          if (u) {
            out.push({ title: n.headline || n.name, url: new URL(u, pageUrl).href, time: n.datePublished || null, section: n.articleSection || null });
          }
        }
        if (n['@type'] === 'ItemList' && Array.isArray(n.itemListElement)) {
          for (const el of n.itemListElement) {
            const it = el.item || el;
            const u = it.url || it['@id'];
            if (u) out.push({ title: it.name || it.headline, url: new URL(u, pageUrl).href, time: it.datePublished || null });
          }
        }
      }
    } catch (_) {}
  }
  // Heuristic: anchors near headings / article cards
  const re = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) && out.length < 40) {
    let href = m[1];
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    try { href = new URL(href, pageUrl).href; } catch { continue; }
    if (seen.has(href)) continue;
    const label = decodeEntities(m[2]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (label.length < 18 || label.length > 200) continue;
    if (/^(home|trang chủ|login|đăng nhập|menu|facebook|youtube|twitter)/i.test(label)) continue;
    // Prefer paths that look like articles
    if (!/\/\d{4}\/|\/tin-|-p\d+\.html|article|bai-viet|\d{6,}/i.test(href) && label.length < 30) continue;
    seen.add(href);
    out.push({ title: label, url: href, time: null, section: null });
  }
  return out.slice(0, 30);
}

function extractArticleMeta(html, pageUrl) {
  const title = decodeEntities(
    (html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || ''
  ).replace(/<[^>]+>/g, '').trim();
  let publishedAt =
    (html.match(/property=["']article:published_time["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (html.match(/itemprop=["']datePublished["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (html.match(/<time[^>]+datetime=["']([^"']+)/i) || [])[1] ||
    null;
  if (publishedAt) {
    try { publishedAt = new Date(publishedAt).toISOString(); } catch { publishedAt = null; }
  }
  const byline =
    (html.match(/property=["']author["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    (html.match(/name=["']author["'][^>]+content=["']([^"']+)/i) || [])[1] ||
    '';
  // Strip scripts/styles and tags for text
  let text = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title: clip(title, 300),
    byline: clip(byline, 120),
    publishedAt,
    modifiedAt: null,
    text: clip(text, 15000),
    canonical: pageUrl,
    lang: (html.match(/<html[^>]+lang=["']([^"']+)/i) || [])[1] || null
  };
}

function discoverFeedLinks(html, pageUrl) {
  const links = [];
  const re = /<link[^>]+type=["']application\/(?:rss|atom)\+xml["'][^>]*>/gi;
  let m;
  while ((m = re.exec(html))) {
    const href = (m[0].match(/href=["']([^"']+)/i) || [])[1];
    if (!href) continue;
    try { links.push(new URL(href, pageUrl).href); } catch (_) {}
  }
  // Common paths
  try {
    const u = new URL(pageUrl);
    ['/rss', '/feed', '/rss.xml', '/atom.xml', '/feeds/news'].forEach((p) => links.push(u.origin + p));
  } catch (_) {}
  return [...new Set(links)].slice(0, 6);
}



'use strict';
/**
 * Extra read tools for the Browser Agent — text/PDF/media/link extraction.
 * Used by backend-agent observe/execute paths. Never executes arbitrary code from pages.
 */
const MAX_TEXT = 12000;
const MAX_LINKS = 40;
const MAX_MEDIA = 20;


function extractPdfText(buf) {
  try {
    const zlib = require('zlib');
    const raw = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (raw.length > 8 * 1024 * 1024) return '(PDF too large)';
    let text = '';
    // literal strings between parentheses (simple PDF)
    const s = raw.toString('latin1');
    const re = /\((?:\\.|[^\\)]){2,200}\)/g;
    let m;
    const parts = [];
    while ((m = re.exec(s)) && parts.length < 2000) {
      let chunk = m[0].slice(1, -1)
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '')
        .replace(/\\t/g, ' ')
        .replace(/\\\(/g, '(')
        .replace(/\\\)/g, ')')
        .replace(/\\\\/g, '\\');
      if (/[\x20-\x7E\u00A0-\uFFFF]{3,}/.test(chunk)) parts.push(chunk);
    }
    // FlateDecode streams
    const streamRe = /stream\r?\n([\s\S]*?)endstream/g;
    while ((m = streamRe.exec(s)) && parts.length < 4000) {
      try {
        const inner = Buffer.from(m[1], 'latin1');
        const inflated = zlib.inflateSync(inner);
        const u = inflated.toString('utf8');
        const readable = u.replace(/[^\x09\x0A\x0D\x20-\x7E\u00A0-\uFFFF]+/g, ' ').replace(/\s+/g, ' ').trim();
        if (readable.length > 20) parts.push(readable.slice(0, 4000));
      } catch (_) {}
    }
    text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return text.slice(0, 12000) || '(PDF has no extractable text)';
  } catch (e) {
    return '(PDF extract error: ' + String(e.message || e).slice(0, 80) + ')';
  }
}

function clip(s, n) { return utilClip(s, n == null ? 200 : n); }

/** Extract structured page data from Playwright page evaluation result or HTML string. */
function extractPagePayload(raw) {
  const o = raw && typeof raw === 'object' ? raw : {};
  return {
    url: clip(o.url, 500),
    title: clip(o.title, 200),
    text: clip(o.text, MAX_TEXT),
    links: Array.isArray(o.links) ? o.links.slice(0, MAX_LINKS).map((l) => ({
      href: clip(l.href, 500),
      text: clip(l.text, 120)
    })) : [],
    media: Array.isArray(o.media) ? o.media.slice(0, MAX_MEDIA).map((m) => ({
      type: clip(m.type, 20),
      src: clip(m.src, 500),
      alt: clip(m.alt, 80)
    })) : [],
    tables: Array.isArray(o.tables) ? o.tables.slice(0, 5).map((t) => clip(t, 2000)) : [],
    headings: Array.isArray(o.headings) ? o.headings.slice(0, 30).map((h) => clip(h, 160)) : [],
    docs: Array.isArray(o.docs) ? o.docs.slice(0, 15).map((d) => ({
      href: clip(d.href, 500),
      text: clip(d.text, 120),
      kind: clip(d.kind, 20)
    })) : []
  };
}

const PAGE_EXTRACT_JS = `(() => {
  const abs = (h) => { try { return new URL(h, location.href).href; } catch { return ''; } };
  const text = (document.body && (document.body.innerText || document.body.textContent) || '').replace(/\\s+/g, ' ').trim();
  const links = [];
  document.querySelectorAll('a[href]').forEach((a, i) => {
    if (links.length >= 40) return;
    const href = abs(a.getAttribute('href') || '');
    if (!href || /^(javascript|mailto|tel):/i.test(href)) return;
    links.push({ href, text: (a.innerText || a.textContent || '').trim().slice(0, 120) });
  });
  const media = [];
  document.querySelectorAll('img[src],video[src],audio[src],source[src]').forEach((el) => {
    if (media.length >= 20) return;
    const src = abs(el.getAttribute('src') || el.currentSrc || '');
    if (!src) return;
    media.push({ type: (el.tagName || '').toLowerCase(), src, alt: (el.getAttribute('alt') || '').slice(0, 80) });
  });
  const headings = [];
  document.querySelectorAll('h1,h2,h3').forEach((h) => {
    if (headings.length >= 30) return;
    const t = (h.innerText || '').trim();
    if (t) headings.push(t.slice(0, 160));
  });
  const tables = [];
  document.querySelectorAll('table').forEach((table, ti) => {
    if (tables.length >= 5) return;
    const rows = [];
    table.querySelectorAll('tr').forEach((tr, ri) => {
      if (ri > 12) return;
      const cells = Array.from(tr.querySelectorAll('th,td')).map((c) => (c.innerText || '').trim().slice(0, 80));
      if (cells.length) rows.push(cells.join(' | '));
    });
    if (rows.length) tables.push(rows.join('\\n'));
  });
  const docs = [];
  document.querySelectorAll('a[href]').forEach((a) => {
    if (docs.length >= 15) return;
    const href = abs(a.getAttribute('href') || '');
    if (/\\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|json|xml|zip)(\\?|$)/i.test(href)) {
      docs.push({ href, text: (a.innerText || '').trim().slice(0, 120), kind: (href.match(/\\.([a-z0-9]+)(?:\\?|$)/i) || [])[1] || 'file' });
    }
  });
  return {
    url: location.href,
    title: document.title || '',
    text: text.slice(0, 12000),
    links, media, headings, tables, docs
  };
})()`;

async function extractFromPlaywrightSession(playwrightEngine, sessionId) {
  if (!playwrightEngine || !sessionId) return null;
  try {
    if (typeof playwrightEngine.evaluate === 'function') {
      const raw = await playwrightEngine.evaluate(sessionId, PAGE_EXTRACT_JS);
      return extractPagePayload(raw);
    }
    if (typeof playwrightEngine.getContent === 'function') {
      // Fallback: content only
      const c = await playwrightEngine.getContent(sessionId);
      return extractPagePayload({
        url: c && c.url,
        title: c && c.title,
        text: c && (c.text || c.html || '')
      });
    }
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
  return null;
}

/** Fetch document with manual redirects; each hop re-validated for SSRF. */
async function fetchDocumentText(url, fetchFn, opts) {
  const { assertPublicHttpUrl } = require('./net-guard');
  let u = String(url || '');
  if (!/^https?:/i.test(u)) return { ok: false, error: 'invalid_url' };
  const timeout = (opts && opts.timeout) || 15000;
  const maxRedirects = 5;
  try {
    let res = null;
    for (let hop = 0; hop <= maxRedirects; hop++) {
      await assertPublicHttpUrl(u);
      const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (_) {} }, timeout);
      try {
        res = await fetchFn(u, {
          method: 'GET',
          redirect: 'manual',
          signal: ctrl && ctrl.signal,
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; SoloHostAgent/10.29; +research)',
            'Accept': 'text/plain,text/html,application/json,application/pdf,*/*'
          }
        });
      } finally {
        clearTimeout(timer);
      }
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        const loc = res.headers.get('location');
        if (!loc) return { ok: false, error: 'redirect_no_location' };
        u = new URL(loc, u).href;
        continue;
      }
      break;
    }
    if (!res) return { ok: false, error: 'no_response' };
    const ct = String(res.headers.get('content-type') || '');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) return { ok: false, error: 'document_too_large' };
    if (/pdf/i.test(ct) || /\.pdf(\?|$)/i.test(u)) {
      return { ok: true, kind: 'pdf', text: extractPdfText(buf), bytes: buf.length, finalUrl: u };
    }
    if (/json/i.test(ct)) {
      return { ok: true, kind: 'json', text: buf.toString('utf8').slice(0, MAX_TEXT), finalUrl: u };
    }
    let text = buf.toString('utf8');
    if (/html/i.test(ct)) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    }
    return { ok: true, kind: /html/i.test(ct) ? 'html' : 'text', text: text.slice(0, MAX_TEXT), bytes: buf.length, finalUrl: u };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  }
}


module.exports = {
  safeFetch,
  parseFeed,
  extractArticlesFromHtml,
  extractArticleMeta,
  discoverFeedLinks,
  assertSafeUrl,
  clip,
  extractPagePayload,
  PAGE_EXTRACT_JS,
  extractFromPlaywrightSession,
  fetchDocumentText,
  MAX_TEXT,
  extractPdfText
};
