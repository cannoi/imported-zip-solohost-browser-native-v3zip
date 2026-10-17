'use strict';
const { safeFetch } = require('./agent-research-tools');
const links = require('./agent-links');

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function hostBare(h) {
  return String(h || '').toLowerCase().replace(/^www\./, '');
}

const ENGINE_HOSTS = new Set(['bing.com', 'duckduckgo.com', 'google.com', 'search.brave.com', 'brave.com', 'yahoo.com', 'yandex.com', 'coccoc.com']);
const NAV_TITLE_RE = /^(images?|videos?|maps?|news|shopping|privacy|terms|help|settings|sign in|log in|trợ giúp|đăng nhập|hình ảnh|video|bản đồ|tin tức)$/i;

function pushResult(out, seen, item, limit) {
  if (!item || !item.url || out.length >= limit) return;
  let url = item.url;
  try { url = links.unwrapSearchRedirect(url) || url; } catch (_) {}
  try { url = links.canonicalizeUrl(url) || url; } catch (_) {}
  if (!url || !/^https?:/i.test(url) || seen.has(url)) return;
  if (['search_results', 'captcha', 'redirector', 'invalid'].includes(links.classifyUrl(url))) return;
  let host = '';
  try { host = hostBare(new URL(url).hostname); } catch (_) { return; }
  if (ENGINE_HOSTS.has(host) || ENGINE_HOSTS.has(host.replace(/^[\w-]+\./, ''))) {
    // allow only if path is not another search UI
    try {
      const p = new URL(url).pathname || '';
      if (/\/(search|images|videos|maps|news)/i.test(p)) return;
    } catch (_) { return; }
  }
  const title = String(item.title || '').replace(/\s+/g, ' ').trim();
  if (!title || title.length < 3 || NAV_TITLE_RE.test(title)) return;
  seen.add(url);
  out.push({
    title: title.slice(0, 240),
    url,
    snippet: String(item.snippet || '').replace(/\s+/g, ' ').trim().slice(0, 280),
    site: host,
    date: item.date || null,
    rank: out.length + 1
  });
}

function parseBing(html, limit) {
  const out = [], seen = new Set();
  const blocks = String(html || '').match(/<li[^>]*class="[^"]*\bb_algo\b[^"]*"[\s\S]*?<\/li>/gi) || [];
  for (const b of blocks) {
    const hm = b.match(/<h2[^>]*>\s*<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!hm) continue;
    const cap = (b.match(/<div[^>]*class="[^"]*\bb_caption\b[^"]*"[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    pushResult(out, seen, { url: hm[1], title: decode(hm[2]), snippet: decode(cap) }, limit);
  }
  return out;
}

function parseDdg(html, limit) {
  const out = [], seen = new Set();
  const blocks = String(html || '').match(/<div[^>]*class="[^"]*\bresult\b[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*\bresult\b|<\/body>|$)/gi) || [];
  for (const b of blocks) {
    const am = b.match(/<a[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i)
      || b.match(/<a[^>]*href=["']([^"']+)["'][^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    if (!am) continue;
    let href = am[1];
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      if (u.searchParams.get('uddg')) href = u.searchParams.get('uddg');
    } catch (_) {}
    const sn = (b.match(/class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\//i) || [])[1] || '';
    pushResult(out, seen, { url: href, title: decode(am[2]), snippet: decode(sn) }, limit);
  }
  return out;
}

function parseBrave(html, limit) {
  const out = [], seen = new Set();
  const blocks = String(html || '').match(/<div[^>]*class="[^"]*\bsnippet\b[^"]*"[\s\S]*?(?=<div[^>]*class="[^"]*\bsnippet\b|<\/main>|$)/gi) || [];
  for (const b of blocks) {
    const am = b.match(/<a[^>]*href=["'](https?:[^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!am) continue;
    const sn = (b.match(/class="[^"]*\bsnippet-description\b[^"]*"[^>]*>([\s\S]*?)<\//i) || b.match(/<p[^>]*>([\s\S]*?)<\/p>/i) || [])[1] || '';
    pushResult(out, seen, { url: am[1], title: decode(am[2]), snippet: decode(sn) }, limit);
  }
  return out;
}

function parseResultsGeneric(html, baseUrl, limit = 10) {
  const out = [], seen = new Set();
  const source = String(html || '');
  const anchors = /<a\b([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchors.exec(source)) && out.length < limit * 4) {
    let url;
    try { url = new URL(m[2], baseUrl).href; } catch (_) { continue; }
    pushResult(out, seen, { url, title: decode(m[3]), snippet: '' }, limit);
  }
  return out;
}

function parseResults(html, baseUrl, limit = 10) {
  let host = '';
  try { host = hostBare(new URL(baseUrl || 'https://example.com').hostname); } catch (_) {}
  let out = [];
  if (host.includes('bing.')) out = parseBing(html, limit);
  else if (host.includes('duckduckgo')) out = parseDdg(html, limit);
  else if (host.includes('brave')) out = parseBrave(html, limit);
  if (!out.length) out = parseResultsGeneric(html, baseUrl, limit);
  return out.slice(0, limit);
}

function visibleTextForBlockCheck(html) {
  return String(html || '')
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 12000)
    .toLowerCase();
}

function isBlockedHtml(html, url) {
  if (links.classifyUrl(url) === 'captcha') return true;
  const text = visibleTextForBlockCheck(html);
  const title = ((String(html || '').match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '').toLowerCase();
  const blob = title + ' ' + text.slice(0, 4000);
  return /unusual traffic from your computer network|are you a robot|verify you are human|complete the captcha|please solve this puzzle|enable javascript and cookies to continue|one more step|attention required|sorry, you have been blocked|access denied.*cloudflare/i.test(blob);
}




const ENGINE_URLS = {
  bing: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=vi-vn&cc=VN',
  ddg: (q) => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + '&kl=vn-vi',
  brave: (q) => 'https://search.brave.com/search?q=' + encodeURIComponent(q)
};


function normalizeQuery(q) {
  return String(q || '')
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/** In-process SERP cache: key → { at, result }. TTL default 10 min. */
const SEARCH_CACHE = new Map();
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
const SEARCH_CACHE_MAX = 80;

function cacheKey(query, engines) {
  return normalizeQuery(query) + '|' + (engines || []).join(',');
}

function getCachedSearch(query, engines) {
  const k = cacheKey(query, engines);
  const hit = SEARCH_CACHE.get(k);
  if (!hit) return null;
  if (Date.now() - hit.at > SEARCH_CACHE_TTL_MS) {
    SEARCH_CACHE.delete(k);
    return null;
  }
  return hit.result;
}

function setCachedSearch(query, engines, result) {
  if (SEARCH_CACHE.size >= SEARCH_CACHE_MAX) {
    const first = SEARCH_CACHE.keys().next().value;
    SEARCH_CACHE.delete(first);
  }
  SEARCH_CACHE.set(cacheKey(query, engines), { at: Date.now(), result });
}

function isEngineBlocked(blockedMap, engine) {
  if (!blockedMap) return false;
  const until = blockedMap[engine];
  return typeof until === 'number' && Date.now() < until;
}

function markBlocked(blockedMap, engine, minutes) {
  if (!blockedMap) return;
  blockedMap[engine] = Date.now() + (minutes || 15) * 60 * 1000;
}

async function searchWeb(query, { engines, timeoutMs = 3200, limit = 10, blockedMap = null, skipCache = false } = {}) {
  const q = String(query || '').trim();
  if (!q) return { outcome: 'error', results: [], engine: null, blocked: [], blockedEngines: [], error: 'query_required', durationMs: 0, ms: 0 };
  const t0 = Date.now();
  const order = (engines && engines.length ? engines : ['bing', 'ddg', 'brave']).filter((x) => ['bing', 'ddg', 'brave'].includes(x));
  const active = order.filter((e) => !isEngineBlocked(blockedMap, e));
  if (!active.length) {
    return { outcome: 'blocked', results: [], engine: null, blocked: order.slice(), blockedEngines: order.slice(), error: 'all_engines_circuit_open', durationMs: Date.now() - t0, ms: Date.now() - t0 };
  }
  if (!skipCache) {
    const cached = getCachedSearch(q, active);
    if (cached && cached.outcome === 'ok' && (cached.results || []).length) {
      return Object.assign({}, cached, { cached: true, durationMs: Date.now() - t0, ms: Date.now() - t0 });
    }
  }

  if (process.env.BRAVE_SEARCH_API_KEY && active.includes('brave')) {
    try {
      const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=' + limit;
      const res = await safeFetch(url, {
        timeoutMs,
        headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY, Accept: 'application/json' }
      });
      if (res.ok && res.body) {
        let j; try { j = JSON.parse(res.body); } catch (_) { j = null; }
        const web = (j && j.web && j.web.results) || [];
        const results = web.slice(0, limit).map((r, i) => ({
          title: String(r.title || '').slice(0, 240),
          url: r.url,
          snippet: String(r.description || '').slice(0, 400),
          site: (() => { try { return new URL(r.url).hostname.replace(/^www\./, ''); } catch { return ''; } })(),
          rank: i + 1
        })).filter((r) => r.url);
        if (results.length) {
          return { outcome: 'ok', results, engine: 'brave_api', blocked: [], error: null, ms: Date.now() - t0 };
        }
      }
    } catch (_) {}
  }

  const jobs = active.map(async (engine) => {
    const url = ENGINE_URLS[engine](q);
    try {
      const res = await safeFetch(url, { timeoutMs });
      if (isBlockedHtml(res.body, res.url || url)) {
        markBlocked(blockedMap, engine, 20);
        return { engine, outcome: 'blocked', results: [] };
      }
      const results = parseResults(res.body, res.url || url, limit);
      if (results.length) return { engine, outcome: 'ok', results };
      return { engine, outcome: 'empty', results: [] };
    } catch (e) {
      return { engine, outcome: 'error', results: [], error: String(e.message || e).slice(0, 80) };
    }
  });

  const settled = await Promise.all(jobs);
  const ok = settled.find((x) => x.outcome === 'ok' && x.results.length);
  if (ok) {
    return {
      outcome: 'ok',
      results: ok.results,
      engine: ok.engine,
      blocked: settled.filter((x) => x.outcome === 'blocked').map((x) => x.engine),
      error: null,
      ms: Date.now() - t0
    };
  }
  const onlyBlocked = settled.every((x) => x.outcome === 'blocked' || x.outcome === 'error');
  if (onlyBlocked) {
    return {
      outcome: 'blocked',
      results: [],
      engine: null,
      blocked: settled.filter((x) => x.outcome === 'blocked').map((x) => x.engine),
      error: 'search_blocked',
      ms: Date.now() - t0
    };
  }
  return {
    outcome: 'empty',
    results: [],
    engine: null,
    blocked: settled.filter((x) => x.outcome === 'blocked').map((x) => x.engine),
    error: null,
    ms: Date.now() - t0
  };
}

// Stamp durationMs + blockedEngines aliases on every return path via thin wrapper
const _searchWebImpl = searchWeb;
async function searchWebWrapped(query, opts) {
  const r = await _searchWebImpl(query, opts || {});
  const durationMs = r.durationMs != null ? r.durationMs : (r.ms || 0);
  const blockedEngines = Array.isArray(r.blocked) ? r.blocked : (r.blockedEngines || []);
  const out = Object.assign({}, r, { durationMs, ms: durationMs, blockedEngines, blocked: blockedEngines });
  if (out.outcome === 'ok' && (out.results || []).length && !(opts && opts.skipCache)) {
    try { setCachedSearch(query, (opts && opts.engines) || ['bing', 'ddg', 'brave'], out); } catch (_) {}
  }
  return out;
}

module.exports = {
  searchWeb: searchWebWrapped,
  parseResults,
  parseBing,
  parseDdg,
  parseBrave,
  isBlockedHtml,
  isEngineBlocked,
  markBlocked,
  normalizeQuery,
  getCachedSearch,
  setCachedSearch
};

