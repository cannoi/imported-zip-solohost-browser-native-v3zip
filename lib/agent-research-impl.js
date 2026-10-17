'use strict';
/**
 * Lightweight research tools: RSS/Atom parse, article list extraction, readability-ish text.
 * No heavy dependencies — regex + basic DOM string parsing.
 */
const { assertPublicHttpUrl } = require('./net-guard');
const dns = require('dns').promises;
const net = require('net');

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

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
        'Accept-Language': 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7'
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

module.exports = {
  safeFetch, parseFeed, extractArticlesFromHtml, extractArticleMeta, discoverFeedLinks, assertSafeUrl, clip
};
