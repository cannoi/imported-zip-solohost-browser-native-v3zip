'use strict';
const { safeFetch } = require('./agent-research-tools');
const links = require('./agent-links');

function decode(s) {
  return String(s || '')
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function parseResults(html, baseUrl, limit = 10) {
  const out = [], seen = new Set();
  const source = String(html || '');
  const anchors = /<a\b([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchors.exec(source)) && out.length < limit * 3) {
    let url;
    try { url = new URL(m[2], baseUrl).href; } catch (_) { continue; }
    const title = decode(m[3]);
    const host = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
    if (!title || title.length < 3 || !/^https?:/.test(url)) continue;
    if (['search_results', 'captcha', 'invalid'].includes(links.classifyUrl(url))) continue;
    if (/^(?:javascript:|#)/i.test(m[2])) continue;
    url = links.unwrapSearchRedirect(url);
    if (!url || ['search_results', 'captcha', 'redirector', 'invalid'].includes(links.classifyUrl(url))) continue;
    if (/^(?:bing\.com|duckduckgo\.com|google\.[^/]+|search\.brave\.com)$/i.test(host)) continue;
    url = links.canonicalizeUrl(url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ title: title.slice(0, 240), url, snippet: '', site: host.replace(/^www\./, ''), date: null, rank: out.length + 1 });
  }
  return out.slice(0, limit);
}

function isBlockedHtml(html, url) {
  return /captcha|verify you are human|unusual traffic|consent required|robot check|one last step|solve the challenge/i.test(
    String(html || '').slice(0, 50000)
  ) || links.classifyUrl(url) === 'captcha';
}

const ENGINE_URLS = {
  bing: (q) => 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&setlang=en-us',
  ddg: (q) => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q),
  brave: (q) => 'https://search.brave.com/search?q=' + encodeURIComponent(q)
};

function isEngineBlocked(blockedMap, engine) {
  if (!blockedMap) return false;
  const until = blockedMap[engine];
  return typeof until === 'number' && Date.now() < until;
}

function markBlocked(blockedMap, engine, minutes) {
  if (!blockedMap) return;
  blockedMap[engine] = Date.now() + (minutes || 15) * 60 * 1000;
}

async function searchWeb(query, { engines, timeoutMs = 3200, limit = 10, blockedMap = null } = {}) {
  const q = String(query || '').trim();
  if (!q) return { outcome: 'error', results: [], engine: null, blocked: [], error: 'query_required', ms: 0 };
  const t0 = Date.now();
  const order = (engines && engines.length ? engines : ['bing', 'ddg', 'brave']).filter((x) => ['bing', 'ddg', 'brave'].includes(x));
  const active = order.filter((e) => !isEngineBlocked(blockedMap, e));
  if (!active.length) {
    return { outcome: 'blocked', results: [], engine: null, blocked: order.slice(), error: 'all_engines_circuit_open', ms: Date.now() - t0 };
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

module.exports = { searchWeb, parseResults, isEngineBlocked, markBlocked };
