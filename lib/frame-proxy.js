'use strict';

/**
 * Same-origin HTML frame proxy for SoloHost Browser.
 * - Strips frame-busting headers
 * - Rewrites links/forms to stay inside /api/proxy
 * - Special lightweight shells for Google (gbv=1), YouTube, TikTok homes
 * - SSRF guard on private hosts
 */

const { URL } = require('url');
const net = require('net');
const dns = require('dns').promises;

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 22000;
const UA =
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36';

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
  }
  return u;
}

function proxyHref(absUrl) {
  return '/api/proxy?url=' + encodeURIComponent(absUrl);
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Prefer Google HTML-lite (gbv=1) so search results work without their SPA. */
function normalizeTargetUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { return String(raw).trim(); }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  // Google — force basic HTML results
  if (host === 'google.com' || host.endsWith('.google.com')) {
    if (u.pathname === '/' || u.pathname === '') {
      // stay on home; shell may replace
      return u.href;
    }
    if (u.pathname.startsWith('/search')) {
      u.searchParams.set('gbv', '1');
      u.searchParams.delete('client');
      u.searchParams.delete('source');
      u.searchParams.delete('ie');
      return u.href;
    }
  }

  // YouTube mobile host → www for consistency
  if (host === 'm.youtube.com') {
    u.hostname = 'www.youtube.com';
    return u.href;
  }

  // TikTok — prefer www
  if (host === 'm.tiktok.com' || host === 'vm.tiktok.com') {
    u.hostname = 'www.tiktok.com';
    return u.href;
  }

  return u.href;
}

function specialShell(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  const path = u.pathname || '/';

  // Google homepage → lightweight search that goes through proxy with gbv=1
  if ((host === 'google.com' || host.endsWith('.google.com')) && (path === '/' || path === '/webhp')) {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Google</title>
<style>
html,body{margin:0;min-height:100%;background:#fff;color:#202124;font-family:system-ui,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:12vh 16px 32px;text-align:center}
logo{font-size:48px;font-weight:700;letter-spacing:-1px;background:linear-gradient(90deg,#4285f4,#ea4335,#fbbc05,#34a853);-webkit-background-clip:text;color:transparent}
form{display:flex;gap:8px;margin-top:28px}
input{flex:1;padding:12px 16px;border:1px solid #dfe1e5;border-radius:24px;font-size:16px;outline:none}
input:focus{border-color:#4285f4;box-shadow:0 0 0 3px rgba(66,133,244,.25)}
button{padding:12px 18px;border:0;border-radius:24px;background:#4285f4;color:#fff;font-weight:600;cursor:pointer}
.hint{margin-top:16px;font-size:13px;color:#5f6368}
</style></head><body><div class="wrap">
<div class="logo">Google</div>
<form id="f" action="#" method="get">
<input id="q" name="q" type="search" placeholder="Search Google" autofocus enterkeyhint="search">
<button type="submit">Search</button>
</form>
<p class="hint">Results open in SoloHost Reader proxy (HTML mode).</p>
</div>
<script>
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();
  var q=document.getElementById('q').value.trim();
  if(!q)return;
  var target='https://www.google.com/search?gbv=1&q='+encodeURIComponent(q);
  location.href='/api/proxy?url='+encodeURIComponent(target);
});
</script></body></html>`;
  }

  // YouTube home / feed — SPA cannot run in HTML proxy; give usable search + open
  if ((host === 'youtube.com' || host === 'm.youtube.com' || host === 'youtu.be') &&
      (path === '/' || path === '/feed' || path === '/feed/explore')) {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube</title>
<style>
html,body{margin:0;background:#0f0f0f;color:#fff;font-family:system-ui,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:10vh 16px}
h1{font-size:28px;margin:0 0 8px}
p{color:#aaa;margin:0 0 20px;line-height:1.5}
form{display:flex;gap:8px}
input{flex:1;padding:12px 14px;border-radius:12px;border:1px solid #333;background:#212121;color:#fff;font-size:16px}
button,a.btn{padding:12px 16px;border-radius:12px;border:0;background:#ff0033;color:#fff;font-weight:600;text-decoration:none;display:inline-block}
.row{margin-top:16px;display:flex;flex-wrap:wrap;gap:10px}
</style></head><body><div class="wrap">
<h1>YouTube</h1>
<p>Home feed needs the full YouTube app. Search a video or open YouTube in a new tab.</p>
<form id="f"><input id="q" type="search" placeholder="Search videos" enterkeyhint="search"><button type="submit">Search</button></form>
<div class="row">
<a class="btn" href="https://www.youtube.com/" target="_blank" rel="noopener">Open YouTube ↗</a>
</div>
<script>
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();
  var q=document.getElementById('q').value.trim();
  if(!q)return;
  // YouTube results page is still SPA-heavy; open search via google video or yt search URL in proxy
  var target='https://www.youtube.com/results?search_query='+encodeURIComponent(q);
  location.href='/api/proxy?url='+encodeURIComponent(target);
});
</script></div></body></html>`;
  }

  // TikTok home
  if (host === 'tiktok.com' && (path === '/' || path === '/foryou' || path === '/following')) {
    return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>TikTok</title>
<style>
html,body{margin:0;background:#000;color:#fff;font-family:system-ui,sans-serif}
.wrap{max-width:640px;margin:0 auto;padding:10vh 16px}
h1{margin:0 0 8px}
p{color:#aaa;line-height:1.5}
a.btn{display:inline-block;margin-top:16px;padding:12px 18px;border-radius:12px;background:#fe2c55;color:#fff;text-decoration:none;font-weight:600}
</style></head><body><div class="wrap">
<h1>TikTok</h1>
<p>TikTok For You is a live app (not a static page). Open the official site or paste a video link (<code>/@user/video/…</code>) in the address bar to play the embed.</p>
<a class="btn" href="https://www.tiktok.com/" target="_blank" rel="noopener">Open TikTok ↗</a>
</div></body></html>`;
  }

  return null;
}

function injectViewport(html) {
  if (/<meta[^>]+name=["']viewport["']/i.test(html)) return html;
  const tag = '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

function rewriteHtml(html, baseUrl) {
  let out = String(html || '');
  out = out.replace(/<meta[^>]+http-equiv=["']?Content-Security-Policy["']?[^>]*>/gi, '');
  out = out.replace(/<meta[^>]+http-equiv=["']?X-Frame-Options["']?[^>]*>/gi, '');
  // Remove frame-busting patterns that jump out of iframe
  out = out.replace(/if\s*\(\s*(?:window\.)?top\s*[!=]==?\s*(?:window\.)?(?:self|this)\s*\)\s*\{?[^}]*top\.location[^}]*\}?/gi, '');
  out = out.replace(/<script[^>]*>\s*if\s*\(\s*top\s*!==\s*self\s*\)[^<]*<\/script>/gi, '');

  if (!/<base\s/i.test(out)) {
    const baseTag = `<base href="${esc(baseUrl)}">`;
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + baseTag);
    else out = baseTag + out;
  }
  out = injectViewport(out);

  // Rewrite absolute http(s) anchors to proxy (best-effort)
  out = out.replace(/\bhref=(["'])(https?:\/\/[^"']+)\1/gi, (m, q, href) => {
    try {
      const abs = new URL(href, baseUrl).href;
      if (!/^https?:/i.test(abs)) return m;
      return 'href=' + q + proxyHref(abs) + q;
    } catch { return m; }
  });
  // Relative href="/..." 
  out = out.replace(/\bhref=(["'])(\/[^"']*)\1/gi, (m, q, path) => {
    try {
      const abs = new URL(path, baseUrl).href;
      return 'href=' + q + proxyHref(abs) + q;
    } catch { return m; }
  });
  // form action
  out = out.replace(/\baction=(["'])(https?:\/\/[^"']+)\1/gi, (m, q, href) => {
    try {
      return 'action=' + q + proxyHref(new URL(href, baseUrl).href) + q;
    } catch { return m; }
  });
  out = out.replace(/\baction=(["'])(\/[^"']*)\1/gi, (m, q, path) => {
    try {
      return 'action=' + q + proxyHref(new URL(path, baseUrl).href) + q;
    } catch { return m; }
  });
  // empty form action → current proxied URL
  out = out.replace(/\baction=(["'])\1/gi, 'action="' + proxyHref(baseUrl) + '"');

  const bridge = `<script>(function(){
var BASE=${JSON.stringify(baseUrl)};
function abs(h){try{return new URL(h,BASE).href}catch(e){return null}}
function go(u){if(!u||!/^https?:/i.test(u))return;location.href='/api/proxy?url='+encodeURIComponent(u)}
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest&&e.target.closest('a');
  if(!a)return;
  var href=a.getAttribute('href');
  if(!href||href.charAt(0)==='#'||/^(javascript|mailto|tel):/i.test(href))return;
  if(href.indexOf('/api/proxy?')===0)return;
  var u=abs(href); if(!u)return;
  e.preventDefault(); e.stopPropagation(); go(u);
},true);
document.addEventListener('submit',function(e){
  var f=e.target; if(!f||!f.tagName||f.tagName.toLowerCase()!=='form')return;
  try{
    var method=(f.method||'get').toLowerCase();
    if(method!=='get')return; // POST forms: let rewritten action handle if present
    e.preventDefault();
    var action=f.getAttribute('action')||BASE;
    var u;
    if(action.indexOf('/api/proxy?')===0){
      var m=action.match(/[?&]url=([^&]+)/);
      u=m?decodeURIComponent(m[1]):BASE;
    } else { u=abs(action)||BASE; }
    var fd=new FormData(f);
    var nu=new URL(u);
    fd.forEach(function(v,k){nu.searchParams.set(k,v)});
    // Google lite
    if(/google\\./i.test(nu.hostname)&&nu.pathname.indexOf('/search')===0) nu.searchParams.set('gbv','1');
    go(nu.href);
  }catch(err){}
},true);
})();</script>`;

  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, bridge + '</body>');
  else out += bridge;
  return out;
}

async function fetchDocument(targetUrl, reqHeaders = {}) {
  const normalized = normalizeTargetUrl(targetUrl);
  const u = await assertPublicHttpUrl(normalized);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': reqHeaders['accept-language'] || 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Cache-Control': 'no-cache',
      'Upgrade-Insecure-Requests': '1'
    };
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
    const normalized = normalizeTargetUrl(raw);
    const shell = specialShell(normalized);
    if (shell) {
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', 'frame-ancestors *');
      res.status(200).type('html').send(shell);
      return;
    }

    const doc = await fetchDocument(normalized, req.headers || {});
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    res.setHeader('Cache-Control', 'private, max-age=60');

    if (/text\/html|application\/xhtml/i.test(doc.contentType) || doc.body.slice(0, 64).toString().toLowerCase().includes('<!doctype') || doc.body.slice(0, 64).toString().includes('<html')) {
      let html = doc.body.toString('utf8');
      html = rewriteHtml(html, doc.finalUrl);
      res.status(doc.status >= 400 && doc.status !== 404 ? doc.status : 200).type('html').send(html);
      return;
    }
    res.status(doc.status).type(doc.contentType || 'application/octet-stream').send(doc.body);
  } catch (err) {
    const code = err && err.code;
    const status = code === 'INVALID_URL' || code === 'BAD_SCHEME' ? 400
      : code === 'BLOCKED_HOST' ? 403
      : code === 'TOO_LARGE' ? 502
      : 502;
    const msg = esc(String((err && err.message) || err));
    res.status(status).type('html').send(
      `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Unavailable</title>
<style>body{margin:0;font-family:system-ui;padding:24px;background:#111;color:#eee}a{color:#8eb6ff}</style></head>
<body><h1>Page unavailable</h1><p>${msg}</p>
<p><a href="${esc(raw)}" target="_blank" rel="noopener">Open original ↗</a></p></body></html>`
    );
  }
}

module.exports = {
  handleProxy,
  assertPublicHttpUrl,
  fetchDocument,
  rewriteHtml,
  normalizeTargetUrl,
  specialShell
};
