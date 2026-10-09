'use strict';

/**
 * Same-origin HTML frame proxy.
 * Purpose: strip frame-busting headers so the SoloHost iframe can display public pages.
 * - Does NOT rewrite login cookies across domains (no session phishing kit behavior).
 * - Only proxies http(s). Blocks private/link-local targets (SSRF guard).
 */

const { URL } = require('url');
const net = require('net');
const dns = require('dns').promises;

const MAX_BYTES = 4 * 1024 * 1024; // 4 MB HTML
const TIMEOUT_MS = 20000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function isPrivateIp(ip) {
  if (!ip) return true;
  const v = String(ip).toLowerCase();
  if (v === '::1' || v === '0.0.0.0') return true;
  if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
  if (v.startsWith('127.') || v.startsWith('10.') || v.startsWith('192.168.') || v.startsWith('169.254.')) return true;
  const m = v.match(/^172\.(\d+)\./);
  if (m) {
    const n = Number(m[1]);
    if (n >= 16 && n <= 31) return true;
  }
  return false;
}

async function assertPublicHttpUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || '').trim());
  } catch {
    const err = new Error('Invalid URL');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    const err = new Error('Only http/https allowed');
    err.code = 'BAD_SCHEME';
    throw err;
  }
  const host = u.hostname;
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    const err = new Error('Host not allowed');
    err.code = 'BLOCKED_HOST';
    throw err;
  }
  // Literal IP?
  if (net.isIP(host)) {
    if (isPrivateIp(host)) {
      const err = new Error('Private address blocked');
      err.code = 'BLOCKED_HOST';
      throw err;
    }
    return u;
  }
  try {
    const resolved = await dns.lookup(host, { all: true });
    for (const r of resolved) {
      if (isPrivateIp(r.address)) {
        const err = new Error('Private address blocked');
        err.code = 'BLOCKED_HOST';
        throw err;
      }
    }
  } catch (e) {
    if (e.code === 'BLOCKED_HOST') throw e;
    // DNS failure — still attempt fetch; fetch will fail cleanly
  }
  return u;
}

function stripFrameBusters(html, baseUrl) {
  let out = String(html || '');
  // Remove meta refresh / CSP meta that can break framing
  out = out.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
  out = out.replace(/<meta[^>]+http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, '');
  // Inject <base> so relative assets resolve to the real site
  if (!/<base\s/i.test(out)) {
    const baseTag = `<base href="${baseUrl.replace(/"/g, '&quot;')}">`;
    if (/<head[^>]*>/i.test(out)) {
      out = out.replace(/<head[^>]*>/i, (m) => m + baseTag);
    } else {
      out = baseTag + out;
    }
  }
  // Soften target=_top / parent navigations slightly by not stripping JS — keep page functional
  return out;
}

function filterResponseHeaders(headers) {
  const out = {};
  const allow = new Set([
    'content-type',
    'content-language',
    'cache-control',
    'expires',
    'last-modified',
    'etag'
  ]);
  for (const [k, v] of Object.entries(headers || {})) {
    const key = k.toLowerCase();
    if (allow.has(key)) out[key] = v;
  }
  // Force embeddable
  out['x-frame-options'] = 'ALLOWALL';
  out['content-security-policy'] = "frame-ancestors *";
  // Prevent MIME sniffing issues
  if (!out['content-type']) out['content-type'] = 'text/html; charset=utf-8';
  return out;
}

/**
 * Fetch remote document and return { status, headers, body Buffer|string, finalUrl }
 */
async function fetchDocument(targetUrl, reqHeaders = {}) {
  const u = await assertPublicHttpUrl(targetUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': reqHeaders['accept-language'] || 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cache-Control': 'no-cache'
    };
    // Optional: forward client cookies only for this hop (user opted-in via header) — skip by default
    const res = await fetch(u.href, {
      method: 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    });
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) {
      const err = new Error('Response too large');
      err.code = 'TOO_LARGE';
      throw err;
    }
    return {
      status: res.status,
      contentType: ct,
      body: buf,
      finalUrl: res.url || u.href
    };
  } finally {
    clearTimeout(timer);
  }
}

async function handleProxy(req, res) {
  const raw = String((req.query && req.query.url) || '').trim();
  if (!raw) {
    res.status(400).type('html').send('<!doctype html><title>Error</title><p>Missing url</p>');
    return;
  }
  try {
    const doc = await fetchDocument(raw, req.headers || {});
    const headers = filterResponseHeaders({
      'content-type': doc.contentType || 'text/html; charset=utf-8'
    });
    for (const [k, v] of Object.entries(headers)) {
      if (k === 'x-frame-options') continue; // express may block ALLOWALL — omit
      try { res.setHeader(k, v); } catch { /* ignore */ }
    }
    // Explicitly allow embedding in our UI
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');

    if (/text\/html|application\/xhtml/i.test(doc.contentType) || doc.body.slice(0, 32).toString().includes('<')) {
      let html = doc.body.toString('utf8');
      // charset fix
      html = stripFrameBusters(html, doc.finalUrl);
      // Rewrite top-level navigations: make our chrome intercept — inject small script
      const bridge = `<script>(function(){try{document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a');if(!a)return;var href=a.getAttribute('href');if(!href||href.charAt(0)==='#'||/^(javascript|mailto|tel):/i.test(href))return;try{var abs=new URL(href,${JSON.stringify(doc.finalUrl)}).href;if(!/^https?:/i.test(abs))return;e.preventDefault();if(window.top)window.top.postMessage({type:'solohost-navigate',url:abs},'*');}catch(err){}},true);}catch(e){}})();</script>`;
      if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, bridge + '</body>');
      else html += bridge;
      res.status(doc.status >= 400 ? doc.status : 200).type('html').send(html);
      return;
    }
    // Non-HTML: pass through bytes
    res.status(doc.status).type(doc.contentType || 'application/octet-stream').send(doc.body);
  } catch (err) {
    const code = err && err.code;
    const status = code === 'INVALID_URL' || code === 'BAD_SCHEME' ? 400
      : code === 'BLOCKED_HOST' ? 403
      : code === 'TOO_LARGE' ? 502
      : 502;
    const msg = String((err && err.message) || err);
    res.status(status).type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><title>Unavailable</title>
      <style>body{font-family:system-ui;padding:2rem;background:#111;color:#eee}</style></head>
      <body><h1>Page unavailable</h1><p>${msg.replace(/[<>&]/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;'}[c]))}</p>
      <p><a href="${String(raw).replace(/"/g, '')}" target="_blank" rel="noopener" style="color:#8eb6ff">Open original</a></p></body></html>`
    );
  }
}

module.exports = { handleProxy, assertPublicHttpUrl, fetchDocument, stripFrameBusters };
