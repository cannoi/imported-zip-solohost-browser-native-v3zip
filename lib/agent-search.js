'use strict';
const { safeFetch } = require('./agent-research-tools');
const links = require('./agent-links');
function decode(s) { return String(s || '').replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').trim(); }
function parseResults(html, baseUrl, limit = 10) {
  const out = [], seen = new Set();
  const source = String(html || '');
  // Extract conventional result cards and avoid engine/navigation links.
  const anchors = /<a\b([^>]*href=["']([^"']+)["'][^>]*)>([\s\S]*?)<\/a>/gi; let m;
  while ((m = anchors.exec(source)) && out.length < limit * 3) {
    let url; try { url = new URL(m[2], baseUrl).href; } catch (_) { continue; }
    const title = decode(m[3]);
    const host = (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })();
    if (!title || title.length < 3 || !/^https?:/.test(url) || ['search_results','captcha','invalid'].includes(links.classifyUrl(url)) || /^(?:javascript:|#)/i.test(m[2])) continue;
    url = links.unwrapSearchRedirect(url);
    if (!url || ['search_results','captcha','redirector','invalid'].includes(links.classifyUrl(url))) continue;
    if (/^(?:bing\.com|duckduckgo\.com|google\.[^/]+|search\.brave\.com)$/i.test(host)) continue;
    url = links.canonicalizeUrl(url); if (!url || seen.has(url)) continue; seen.add(url);
    const before = source.slice(Math.max(0, m.index - 1400), m.index);
    const snippet = decode((before.match(/<(?:p|div)[^>]*(?:snippet|caption|description|b_algo)[^>]*>([\s\S]{0,900})$/i) || [])[1] || '');
    out.push({ title: title.slice(0, 240), url, snippet: snippet.slice(-500), site: host.replace(/^www\./,''), date: null, rank: out.length + 1 });
  }
  return out.slice(0, limit);
}
function blocked(html, url) { return /captcha|verify you are human|unusual traffic|consent required|robot check/i.test(String(html || '').slice(0, 50000)) || links.classifyUrl(url) === 'captcha'; }
async function searchWeb(query, { engines, timeoutMs = 9000, limit = 10, cache = new Map() } = {}) {
  const q = String(query || '').trim(); if (!q) return { results: [], engine: null, blocked: [], error: 'query_required' };
  const order = (engines && engines.length ? engines : ['bing','ddg','brave']).filter(x => ['bing','ddg','brave'].includes(x));
  const blockedEngines = [], errors = [];
  // Optional official Brave API path; keys are read only from server environment.
  if (process.env.BRAVE_SEARCH_API_KEY) {
    try {
      const url = 'https://api.search.brave.com/res/v1/web/search?q=' + encodeURIComponent(q) + '&count=' + Math.min(20, limit);
      const r = await fetch(url, { headers: { 'X-Subscription-Token': process.env.BRAVE_SEARCH_API_KEY, Accept: 'application/json', 'User-Agent': 'SoloHostBrowserAgent/10.31 (+public research)' }, signal: AbortSignal.timeout(timeoutMs) });
      if (r.ok) {
        const j = await r.json(); const results = (j.web && j.web.results || []).slice(0,limit).map((x,i)=>({title:String(x.title||''),url:links.canonicalizeUrl(x.url),snippet:String(x.description||''),site:(()=>{try{return new URL(x.url).hostname.replace(/^www\./,'')}catch(_){return ''}})(),date:x.page_age||null,rank:i+1})).filter(x=>x.url);
        if (results.length) return { results, engine:'brave_api', blocked:[], error:null };
      }
    } catch (e) { errors.push('brave_api:'+String(e.message||e).slice(0,80)); }
  }
  for (const engine of order) {
    const key = engine + ':' + q.toLowerCase(); if (cache.has(key)) return cache.get(key);
    let url;
    if (engine === 'bing') url = 'https://www.bing.com/search?q=' + encodeURIComponent(q);
    else if (engine === 'ddg') url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q);
    else url = 'https://search.brave.com/search?q=' + encodeURIComponent(q);
    try {
      const r = await safeFetch(url, { timeoutMs, maxRedirects: 4 });
      if (!r.ok || blocked(r.body, r.url)) { blockedEngines.push(engine); continue; }
      const results = parseResults(r.body, r.url, limit);
      if (results.length) { const result = { results, engine, blocked: blockedEngines, error:null }; cache.set(key,result); return result; }
      errors.push(engine+':no_structured_results');
    } catch (e) { errors.push(engine+':'+String(e.code||e.message||'fetch_failed').slice(0,80)); }
  }
  return { results:[], engine:null, blocked:blockedEngines, error:errors.join(';') || 'all_search_engines_unavailable' };
}
module.exports = { searchWeb, parseResults, blocked };
