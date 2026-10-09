'use strict';

/**
 * Pure text/URL helpers shared by content-extractor.js and extraction-tiers.js.
 * No DOM, no Playwright — safe to unit-test anywhere.
 */

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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

/** Minimal entity decoder (enough for JSON-LD / hydration strings). */
function decodeEntities(s) {
  return String(s == null ? '' : s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return m;
      try { return String.fromCodePoint(code); } catch { return m; }
    }
    const v = NAMED_ENTITIES[e.toLowerCase()];
    return v == null ? m : v;
  });
}

/** Markup → plain text with paragraph breaks (no DOM; used for already-sanitised fragments). */
function htmlToText(html) {
  return normalizeText(decodeEntities(String(html || '')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/blockquote|\/tr)\b[^>]*>/gi, '\n\n')
    .replace(/<[^>]*>/g, ' ')));
}

/** Plain text → paragraphs. Blank-line separated; falls back to one paragraph per line. */
function textToHtml(text) {
  const t = normalizeText(text);
  let parts = t.split(/\n{2,}/);
  if (parts.length === 1 && t.includes('\n')) parts = t.split('\n');
  return parts.filter(Boolean).slice(0, 500)
    .map(p => '<p>' + escapeHtml(p).replace(/\n/g, '<br>') + '</p>').join('\n');
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

module.exports = {
  normalizeText, countWords, escapeHtml, decodeEntities, htmlToText, textToHtml,
  toIsoDate, safeUrl, cleanAuthor
};
