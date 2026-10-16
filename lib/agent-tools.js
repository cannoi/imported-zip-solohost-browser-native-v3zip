
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

function clip(s, n) {
  const t = String(s == null ? '' : s);
  return t.length > n ? t.slice(0, n) + '…' : t;
}

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
  const { assertPublicHttpUrl } = require('./frame-proxy');
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
  extractPagePayload,
  PAGE_EXTRACT_JS,
  extractFromPlaywrightSession,
  fetchDocumentText,
  MAX_TEXT
};
