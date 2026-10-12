
'use strict';
/**
 * Extra read tools for the Browser Agent — text/PDF/media/link extraction.
 * Used by backend-agent observe/execute paths. Never executes arbitrary code from pages.
 */
const MAX_TEXT = 12000;
const MAX_LINKS = 40;
const MAX_MEDIA = 20;

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

/** Fetch plain-text / lightweight document over HTTP (no browser). SSRF must be checked by caller. */
async function fetchDocumentText(url, fetchFn, opts) {
  const u = String(url || '');
  if (!/^https?:/i.test(u)) return { ok: false, error: 'invalid_url' };
  const timeout = (opts && opts.timeout) || 15000;
  const ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = setTimeout(() => { try { ctrl && ctrl.abort(); } catch (_) {} }, timeout);
  try {
    const res = await fetchFn(u, {
      method: 'GET',
      redirect: 'follow',
      signal: ctrl && ctrl.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; SoloHostAgent/10; +https://solohost.local)',
        'Accept': 'text/plain,text/html,application/json,application/pdf,*/*'
      }
    });
    const ct = String(res.headers.get('content-type') || '');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > 2 * 1024 * 1024) return { ok: false, error: 'document_too_large' };
    // PDF: extract rough text between streams (best-effort, no full parser)
    if (/pdf/i.test(ct) || /\.pdf(\?|$)/i.test(u)) {
      const raw = buf.toString('latin1');
      const parts = [];
      const re = /stream([\s\S]*?)endstream/g;
      let m;
      while ((m = re.exec(raw)) && parts.length < 40) {
        const chunk = m[1].replace(/[^\x20-\x7E\n\r\t]/g, ' ').replace(/\s+/g, ' ').trim();
        if (chunk.length > 20) parts.push(chunk.slice(0, 500));
      }
      // Also grab literal parentheses strings
      const lit = raw.match(/\((?:\\.|[^\\)]){4,120}\)/g) || [];
      lit.slice(0, 80).forEach((s) => parts.push(s.slice(1, -1)));
      const text = parts.join('\\n').slice(0, MAX_TEXT);
      return { ok: true, kind: 'pdf', text: text || '(PDF binary — limited text extraction)', bytes: buf.length };
    }
    if (/json/i.test(ct)) {
      return { ok: true, kind: 'json', text: buf.toString('utf8').slice(0, MAX_TEXT) };
    }
    let text = buf.toString('utf8');
    if (/html/i.test(ct)) {
      text = text.replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ').replace(/\\s+/g, ' ').trim();
    }
    return { ok: true, kind: /html/i.test(ct) ? 'html' : 'text', text: text.slice(0, MAX_TEXT), bytes: buf.length };
  } catch (e) {
    return { ok: false, error: String(e.message || e).slice(0, 200) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  extractPagePayload,
  PAGE_EXTRACT_JS,
  extractFromPlaywrightSession,
  fetchDocumentText,
  MAX_TEXT
};
