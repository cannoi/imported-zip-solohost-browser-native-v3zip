'use strict';
const { safeFetch } = require('./agent-research-tools');

function canonicalizeUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^https?:$/.test(u.protocol)) return '';
    u.hash = '';
    for (const key of [...u.searchParams.keys()]) {
      if (/^(utm_.+|gclid|fbclid|yclid|mc_cid|mc_eid|ref_src)$/i.test(key)) u.searchParams.delete(key);
    }
    return u.href;
  } catch (_) { return ''; }
}
function classifyUrl(raw) {
  let u; try { u = new URL(raw); } catch (_) { return 'invalid'; }
  if (!/^https?:$/.test(u.protocol)) return 'invalid';
  const h = u.hostname.toLowerCase(), p = u.pathname.toLowerCase();
  if (/google\.[^.]*(?:\.[a-z.]+)?$/.test(h) && (/\/sorry(?:\/|$)/.test(p) || /\/recaptcha/.test(p)) || /captcha|verify you are human|unusual traffic/i.test(u.href)) return 'captcha';
  if ((/google\./.test(h) && p === '/url') || (/bing\.com/.test(h) && /\/ck\//.test(p)) || /duckduckgo\.com/.test(h) && p === '/l/' || /r\.search\.yahoo\./.test(h)) return 'redirector';
  if ((/google\./.test(h) && p.startsWith('/search')) || (/bing\.com/.test(h) && p === '/search') || /duckduckgo\.com/.test(h) && /\/html\/?$/.test(p) || /search\.brave\.com/.test(h) && p === '/search') return 'search_results';
  if (/\.(png|jpe?g|gif|webp|svg|mp4|webm|m3u8|mp3|ogg)(?:$|\?)/i.test(u.href)) return 'media';
  if (/\.pdf$/i.test(p) || /docs?\./i.test(h) || /\/docs?\//i.test(p)) return 'doc';
  if (/\/product|\/products|\/p\//i.test(p) || /shop|store|fptshop|thegioididong|viettelstore/i.test(h)) return 'product';
  if (p === '/' || /^\/(?:home|index(?:\.html?)?)\/?$/.test(p)) return 'home';
  return 'article';
}
function unwrapSearchRedirect(raw) {
  try {
    const u = new URL(String(raw || ''));
    const host = u.hostname.toLowerCase();
    let candidate = '';
    if (/google\./.test(host) && u.pathname === '/url') candidate = u.searchParams.get('q') || u.searchParams.get('url') || '';
    else if (/duckduckgo\.com/.test(host) && u.pathname === '/l/') candidate = u.searchParams.get('uddg') || '';
    else if (/bing\.com/.test(host) && /\/ck\//.test(u.pathname)) {
      const encoded = u.searchParams.get('u') || '';
      if (/^a1/i.test(encoded)) { try { candidate = Buffer.from(encoded.slice(2).replace(/-/g,'+').replace(/_/g,'/'), 'base64').toString('utf8'); } catch (_) {} }
      if (!candidate) candidate = u.searchParams.get('url') || '';
    } else if (/r\.search\.yahoo\./.test(host)) candidate = u.searchParams.get('url') || u.searchParams.get('RU') || '';
    if (candidate) { try { candidate = decodeURIComponent(candidate); } catch (_) {} }
    return canonicalizeUrl(candidate) || canonicalizeUrl(raw);
  } catch (_) { return canonicalizeUrl(raw); }
}
function trimUrlToken(token) {
  let s = String(token || '').replace(/[.,;:!?]+$/u, '');
  // Strip unmatched closing punctuation while preserving balanced parentheses/brackets in URLs.
  for (const [open, close] of [['(', ')'], ['[', ']']]) {
    while (s.endsWith(close) && (s.split(close).length - 1) > (s.split(open).length - 1)) s = s.slice(0, -1);
  }
  return s;
}
function extractUrls(text) {
  const s = String(text || '');
  const out = [];
  // One scanner handles Markdown destinations and plain text. Balanced-parenthesis
  // trimming distinguishes a URL's own parentheses from the Markdown/citation close.
  const re = /https?:\/\/[^\s<>"']+/giu;
  let m;
  while ((m = re.exec(s))) {
    const u = trimUrlToken(m[0]);
    if (u) out.push(u);
  }
  return [...new Set(out.map(canonicalizeUrl).filter(Boolean))];
}

async function verifyLinks(urls, { cache = new Map(), timeoutMs = 6000, concurrency = 6 } = {}) {
  const input = [...new Set((urls || []).map(canonicalizeUrl).filter(Boolean))];
  const results = new Array(input.length); let next = 0;
  async function worker() {
    while (true) {
      const i = next++; if (i >= input.length) return;
      const url = input[i];
      if (cache.has(url)) { results[i] = cache.get(url); continue; }
      const kind = classifyUrl(url);
      if (['captcha', 'search_results', 'redirector', 'invalid'].includes(kind)) {
        results[i] = { url, ok: false, status: null, finalUrl: url, reason: kind, checkedAt: new Date().toISOString() }; cache.set(url, results[i]); continue;
      }
      try {
        // safeFetch validates each redirect target (SSRF guard); bounded GET is more reliable than HEAD-only hosts.
        const r = await safeFetch(url, { maxRedirects: 5, timeoutMs });
        const body = String(r.body || '').slice(0, 150000).toLowerCase();
        const captcha = /captcha|verify you are human|unusual traffic|google\.com\/sorry/.test(body);
        const soft404 = /page not found|404 not found|product not found|this page doesn't exist/.test(body) && body.length < 12000;
        const finalKind = classifyUrl(r.url || url);
        const ok = !!r.ok && !captcha && !soft404 && !['captcha','search_results','redirector','invalid'].includes(finalKind);
        const title = ((String(r.body || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180);
        results[i] = { url, ok, status: r.status, finalUrl: canonicalizeUrl(r.url || url), title, reason: captcha ? 'captcha' : soft404 ? 'soft_404' : (!r.ok ? 'http_error' : ''), checkedAt: new Date().toISOString() };
      } catch (e) { results[i] = { url, ok: false, status: null, finalUrl: url, reason: String(e.code || e.message || 'fetch_failed').slice(0, 100), checkedAt: new Date().toISOString() }; }
      cache.set(url, results[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length, 6) }, worker));
  return results;
}
module.exports = { canonicalizeUrl, classifyUrl, extractUrls, verifyLinks, trimUrlToken, unwrapSearchRedirect };
