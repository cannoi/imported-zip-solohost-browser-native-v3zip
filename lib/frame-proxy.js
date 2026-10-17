'use strict';
/**
 * HTML proxy fallback when Playwright is unavailable.
 * SSRF via lib/net-guard. YouTube special shells kept for usability.
 */
const http = require('http');
const https = require('https');
const { URL } = require('url');
const appLog = require('./app-log');
const netGuard = require('./net-guard');
const ytAdapter = require('./adapters/youtube');
const { errorCard, hasRenderableText } = require('./render-error');

const CACHE = new Map();
const CACHE_TTL = 30000;
const REPEAT = new Map();

function cacheGet(key) {
  const e = CACHE.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL) { CACHE.delete(key); return null; }
  return e;
}
function cacheSet(key, payload) {
  if (CACHE.size > 80) {
    const first = CACHE.keys().next().value;
    CACHE.delete(first);
  }
  CACHE.set(key, Object.assign({ ts: Date.now() }, payload));
}
function trackRepeat(url) {
  const k = String(url || '').slice(0, 300);
  const n = (REPEAT.get(k) || 0) + 1;
  REPEAT.set(k, n);
  if (REPEAT.size > 200) REPEAT.clear();
  return n;
}

const assertPublicHttpUrl = netGuard.assertPublicHttpUrl;
const isPrivateIp = netGuard.isPrivateIp;

function isLoopbackHost(host) {
  const h = String(host || '').toLowerCase();
  return h === 'localhost' || h.endsWith('.localhost') || h === '127.0.0.1' || h === '::1';
}

function proxyHref(absUrl) {
  try {
    return '/api/proxy?url=' + encodeURIComponent(String(absUrl));
  } catch (_) { return '#'; }
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function unwrapProxyUrl(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (u.pathname === '/api/proxy' && u.searchParams.get('url')) {
      return u.searchParams.get('url');
    }
  } catch (_) {}
  return String(raw || '').trim();
}

function normalizeTargetUrl(raw) {
  let s = unwrapProxyUrl(raw);
  if (!s) throw new Error('missing_url');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!/^https?:$/i.test(u.protocol)) throw new Error('scheme_not_allowed');
  return u.href;
}

function youtubeVideoId(u) {
  try {
    const url = new URL(u);
    if (/youtu\.be$/i.test(url.hostname)) return url.pathname.split('/').filter(Boolean)[0] || '';
    if (/youtube\.com$/i.test(url.hostname.replace(/^www\./, ''))) {
      if (url.pathname === '/watch') return url.searchParams.get('v') || '';
      const m = url.pathname.match(/\/(?:embed|shorts)\/([\w-]{6,})/);
      if (m) return m[1];
    }
  } catch (_) {}
  return '';
}

function isLoginLikeUrl(raw) {
  try {
    const u = new URL(String(raw));
    const p = (u.hostname + u.pathname).toLowerCase();
    return /accounts\.google|login|signin|oauth|auth\.|passport|session\/new/.test(p);
  } catch (_) { return false; }
}

function loginExternalShell(url, reason) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Open externally</title><style>body{font-family:system-ui;padding:2rem;max-width:32rem;margin:auto;background:#0f1115;color:#e8eaed}
a{color:#8ab4f8}</style></head><body>
<p>This page needs an external browser.</p>
<p>Reason: <code>${esc(reason)}</code></p>
<p><a href="${esc(url)}" target="_blank" rel="noopener">Open tab ↗</a></p>
</body></html>`;
}

function specialShell(url) {
  try {
    if (!ytAdapter.isYouTubeHost(url)) return null;
    const kind = ytAdapter.classifyYouTube(url);
    // watch/home can be fully local without fetch
    if (kind.kind === 'watch' || kind.kind === 'home') {
      const r = ytAdapter.renderYouTube(url, null, {});
      return r && r.html;
    }
  } catch (_) {}
  return null;
}

function youtubePlayerPage(videoId, title, origin) {
  return ytAdapter.playerPage(videoId, title, origin);
}

function injectViewport(html) {
  if (/<meta[^>]+viewport/i.test(html)) return html;
  return html.replace(/<head([^>]*)>/i, '<head$1><meta name="viewport" content="width=device-width,initial-scale=1">');
}

function rewriteCss(css, baseUrl) {
  return String(css || '').replace(/url\(\s*(['"]?)([^)'"]+)\1\s*\)/gi, (m, q, ref) => {
    try {
      if (/^data:/i.test(ref)) return m;
      const abs = new URL(ref, baseUrl).href;
      return 'url(' + q + proxyHref(abs) + q + ')';
    } catch (_) { return m; }
  });
}

function rewriteHtml(html, baseUrl) {
  let out = String(html || '');
  out = injectViewport(out);
  // strip scripts for safer iframe embedding
  out = out.replace(/<script\b[\s\S]*?<\/script>/gi, '');
  out = out.replace(/\s(href|src|action)=["']([^"']+)["']/gi, (m, attr, ref) => {
    try {
      if (/^(#|javascript:|mailto:|tel:|data:)/i.test(ref)) return m;
      const abs = new URL(ref, baseUrl).href;
      if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|mp4|webm|mp3)(\?|$)/i.test(abs)) {
        return ' ' + attr + '="' + abs.replace(/"/g, '&quot;') + '"';
      }
      return ' ' + attr + '="' + proxyHref(abs).replace(/"/g, '&quot;') + '"';
    } catch (_) { return m; }
  });
  return out;
}

function decodeBody(buffer, contentType) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  let text = buf.toString('utf8');
  if (/charset\s*=\s*['"]?utf-8/i.test(String(contentType || '')) || /^\s*</.test(text)) return text;
  try { return buf.toString('latin1'); } catch (_) { return text; }
}

function fetchDocument(targetUrl, reqHeaders = {}) {
  return new Promise(async (resolve, reject) => {
    try {
      await assertPublicHttpUrl(targetUrl);
    } catch (e) { return reject(e); }
    let u;
    try { u = new URL(targetUrl); } catch (e) { return reject(e); }
    const lib = u.protocol === 'http:' ? http : https;
    const headers = Object.assign({
      'User-Agent': 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36',
      Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9,vi;q=0.8'
    }, reqHeaders || {});
    delete headers.host; delete headers.Host; delete headers.connection;
    const req = lib.request(u, { method: 'GET', headers, timeout: 20000 }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buffer = Buffer.concat(chunks);
        const ct = String(res.headers['content-type'] || '');
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          buffer,
          body: decodeBody(buffer, ct),
          finalUrl: u.href,
          contentType: ct
        });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { try { req.destroy(); } catch (_) {} reject(new Error('timeout')); });
    req.end();
  });
}

async function handleProxy(req, res) {
  const raw = (req.query && req.query.url) || '';
  let proxyOrigin = '';
  try {
    const host = req.headers['x-forwarded-host'] || req.headers.host || '';
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    if (host) proxyOrigin = proto + '://' + host;
  } catch (_) {}

  if (!raw) {
    appLog.log('warn', 'proxy.missing_url', {});
    res.status(400).type('html').send('<!doctype html><p>Missing url</p>');
    return;
  }

  let normalized;
  try {
    normalized = normalizeTargetUrl(raw);
  } catch (e) {
    res.status(400).type('html').send('<!doctype html><p>' + esc(e.message || 'bad url') + '</p>');
    return;
  }

  try {
    const pathOnly = new URL(normalized).pathname.toLowerCase();
    if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|mp4|webm|mp3|pdf|m3u8)(\?|$)/i.test(pathOnly)) {
      res.redirect(302, normalized);
      return;
    }
  } catch (_) {}

  const cached = cacheGet(normalized);
  if (cached && cached.body != null) {
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    res.status(cached.status || 200).type(cached.type || 'html').send(cached.body);
    return;
  }

  appLog.log('info', 'proxy.request', { url: normalized.slice(0, 300) });

  if (isLoginLikeUrl(normalized)) {
    res.status(200).type('html').send(loginExternalShell(normalized, 'login_required'));
    return;
  }

  const shell = specialShell(normalized);
  if (shell) {
    appLog.log('info', 'proxy.shell', { url: normalized.slice(0, 200) });
    res.status(200).type('html').send(shell);
    return;
  }

  const id = youtubeVideoId(normalized);
  if (id && /youtube\.com\/watch|youtu\.be\//i.test(normalized)) {
    const page = youtubePlayerPage(id, 'YouTube', proxyOrigin);
    cacheSet(normalized, { body: page, status: 200, type: 'html' });
    res.status(200).type('html').send(page);
    return;
  }

  try {
    await assertPublicHttpUrl(normalized);
    const doc = await fetchDocument(normalized, {});
    let body = doc.body || '';
    const ct = doc.contentType || '';
    // YouTube: never show stripped SPA shell — native list/player cards
    if (ytAdapter.isYouTubeHost(normalized) && (/html/i.test(ct) || /^\s*</.test(body))) {
      const y = ytAdapter.renderYouTube(doc.finalUrl || normalized, body, { origin: proxyOrigin });
      body = y.html;
      appLog.log('info', 'proxy.youtube_adapter', { tier: y.tier, kind: y.kind, count: y.count || 0, url: normalized.slice(0, 180) });
    } else if (/html/i.test(ct) || /^\s*</.test(body)) {
      body = rewriteHtml(body, doc.finalUrl || normalized);
      if (!hasRenderableText(body)) {
        body = errorCard({
          title: 'Little content to show',
          url: normalized,
          reason: 'empty_after_sanitize',
          message: 'This page is mostly scripts or was stripped for safety. Open it externally for the full experience.',
          actions: [
            { label: 'Open ↗', href: normalized, external: true }
          ]
        });
      }
    } else if (/css/i.test(ct)) {
      body = rewriteCss(body, doc.finalUrl || normalized);
    }
    if (!body || (typeof body === 'string' && body.length < 20)) {
      body = errorCard({ title: 'Empty response', url: normalized, reason: 'empty', message: 'Server returned no usable content.' });
    }
    cacheSet(normalized, { body, status: doc.status || 200, type: /html/i.test(ct) ? 'html' : 'text' });
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    res.status(doc.status && doc.status < 400 ? doc.status : 200).type(/html/i.test(ct) ? 'html' : 'text').send(body);
    appLog.log('info', 'proxy.ok', { status: doc.status, url: normalized.slice(0, 200) });
  } catch (e) {
    appLog.log('error', 'proxy.fail', { error: String(e.message || e).slice(0, 200), url: normalized.slice(0, 200) });
    res.status(502).type('html').send(errorCard({
      title: 'Proxy error',
      url: normalized,
      reason: 'proxy_fail',
      message: String(e.message || e).slice(0, 300),
      actions: [{ label: 'Open ↗', href: normalized, external: true }]
    }));
  }
}

module.exports = {
  isLoginLikeUrl,
  handleProxy,
  assertPublicHttpUrl,
  fetchDocument,
  rewriteHtml,
  rewriteCss,
  decodeBody,
  isPrivateIp,
  isLoopbackHost,
  normalizeTargetUrl,
  specialShell,
  youtubeVideoId,
  youtubePlayerPage,
  detectBlockedPage: () => null,
  googleFallbackHtml: () => '',
  isGoogleInterstitial: () => false,
  safeGoogleSearchQuery: (u) => u,
  parseYoutubeResults: ytAdapter.parseSearchResults,
  youtubeResultsPage: ytAdapter.searchResultsPage,
  extractYtInitialData: ytAdapter.extractYtInitialData,
  ytAdapter
};
