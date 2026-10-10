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
const appLog = require('./app-log');

const MAX_BYTES = 5 * 1024 * 1024;
/** Set per-request so rewritten links stay on SoloHost origin (base tag must not resolve /api/proxy against remote host). */
let proxyOrigin = '';
/** Short-lived HTML cache to break client reload loops (same URL hammering). */
const responseCache = new Map();
const CACHE_TTL_MS = 12000;
const recentHits = new Map();

function cacheGet(key) {
  const e = responseCache.get(key);
  if (!e) return null;
  if (Date.now() - e.ts > CACHE_TTL_MS) { responseCache.delete(key); return null; }
  return e;
}
function cacheSet(key, payload) {
  responseCache.set(key, { ts: Date.now(), ...payload });
  if (responseCache.size > 40) {
    const first = responseCache.keys().next().value;
    responseCache.delete(first);
  }
}
function trackRepeat(url) {
  const now = Date.now();
  const k = String(url || '');
  let e = recentHits.get(k);
  if (!e || now - e.ts > 3000) e = { ts: now, n: 0 };
  e.n += 1; e.ts = now;
  recentHits.set(k, e);
  if (recentHits.size > 80) {
    const first = recentHits.keys().next().value;
    recentHits.delete(first);
  }
  return e.n;
}


const TIMEOUT_MS = 22000;
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

function isPrivateIp(ip) {
  if (!ip) return true;
  const v = String(ip).toLowerCase().replace(/^\[|\]$/g, '');
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  if (net.isIPv4(v)) {
    const a = v.split('.').map(Number);
    return a[0] === 0 || a[0] === 10 || a[0] === 127 || a[0] >= 224 ||
      (a[0] === 169 && a[1] === 254) || (a[0] === 172 && a[1] >= 16 && a[1] <= 31) ||
      (a[0] === 192 && a[1] === 168) || (a[0] === 100 && a[1] >= 64 && a[1] <= 127) ||
      (a[0] === 192 && a[1] === 0 && a[2] === 0) || (a[0] === 198 && (a[1] === 18 || a[1] === 19)) ||
      (a[0] === 198 && a[1] === 51 && a[2] === 100) || (a[0] === 203 && a[1] === 0 && a[2] === 113);
  }
  if (net.isIPv6(v)) {
    return v === '::' || v === '::1' || v.startsWith('fe8') || v.startsWith('fe9') ||
      v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd') ||
      v.startsWith('ff') || v.startsWith('2001:db8:');
  }
  return true;
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
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (u.username || u.password) { const err = new Error('URLs containing credentials are not allowed'); err.code = 'INVALID_URL'; throw err; }
  if (!host || host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal') || host.endsWith('.localhost')) {
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
  const path = '/api/proxy?url=' + encodeURIComponent(absUrl);
  // Absolute URL prevents <base href="https://remote.site"> from rewriting /api/proxy → https://remote.site/api/proxy
  if (proxyOrigin) return proxyOrigin + path;
  return path;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** Prefer Google HTML-lite (gbv=1) so search results work without their SPA. */

/** Unwrap nested /api/proxy?url=… (and accidental absolute proxy links) to the real target. */
function unwrapProxyUrl(raw) {
  let cur = String(raw || '').trim();
  for (let i = 0; i < 5; i++) {
    let u;
    try { u = new URL(cur); } catch { return cur; }
    // path /api/proxy with ?url=
    if (u.pathname === '/api/proxy' || u.pathname.endsWith('/api/proxy')) {
      const inner = u.searchParams.get('url');
      if (inner) { cur = inner; continue; }
    }
    // sometimes url= is itself percent-encoded proxy
    if (/[?&]url=https?%3A%2F%2F/i.test(cur) && cur.includes('/api/proxy')) {
      try {
        const q = cur.split('url=').pop();
        if (q) { cur = decodeURIComponent(q.split('&')[0]); continue; }
      } catch (_) {}
    }
    break;
  }
  return cur;
}

function normalizeTargetUrl(raw) {
  raw = unwrapProxyUrl(raw);
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
  const origin = proxyOrigin || '';
  const px = (u) => (origin || '') + '/api/proxy?url=' + encodeURIComponent(u);
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
<p class="hint">HTML mode (gbv=1). Full Google app may block proxy.</p><p id="st" class="hint"></p><p class="hint"><a href="https://www.google.com/" target="_blank" rel="noopener">Open Google ↗</a></p>
</div>
<script>
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();
  var q=document.getElementById('q').value.trim();
  if(!q)return;
  var st=document.getElementById('st'); if(st) st.textContent='Loading… / Đang tải…';
  var btn=e.target.querySelector('button'); if(btn) btn.disabled=true;
  var target='https://www.google.com/search?gbv=1&hl=en&q='+encodeURIComponent(q);
  var o=window.__SOLO_PROXY_ORIGIN||'';
  var dest=(o||'')+'/api/proxy?url='+encodeURIComponent(target);
  // Hard navigation with visible feedback (avoids "hang" with no UI change)
  setTimeout(function(){ location.href=dest; }, 50);
  setTimeout(function(){ if(st) st.textContent='Still loading… If this takes too long, use Open ↗'; }, 8000);
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
<p>Home feed needs the full YouTube app. Search finds videos via HTML results, or paste a <code>youtube.com/watch?v=…</code> link for embed.</p><p id="st" style="color:#f59e0b"></p>
<form id="f"><input id="q" type="search" placeholder="Search videos" enterkeyhint="search"><button type="submit">Search</button></form>
<div class="row">
<a class="btn" href="https://www.youtube.com/" target="_blank" rel="noopener">Open YouTube ↗</a>
</div>
<script>
document.getElementById('f').addEventListener('submit',function(e){
  e.preventDefault();
  var q=document.getElementById('q').value.trim();
  if(!q)return;
  var st=document.getElementById('st'); if(st) st.textContent='Loading… Paste a watch URL for embed playback.';
  // Prefer Google video search HTML over YouTube SPA results (which hang/empty in proxy)
  var target='https://www.google.com/search?gbv=1&tbm=vid&q='+encodeURIComponent(q+' site:youtube.com');
  var o=window.__SOLO_PROXY_ORIGIN||'';
  setTimeout(function(){ location.href=(o||'')+'/api/proxy?url='+encodeURIComponent(target); }, 50);
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


  // Streaming / SPA video sites — HTML proxy cannot run their players (DRM/JS).
  const videoHosts = [
    'vieon.vn', 'iq.com', 'iqiyi.com', 'motchillm.io', 'motchill', 'netflix.com',
    'disneyplus.com', 'hulu.com', 'vimeo.com', 'twitch.tv', 'bilibili.com',
    'spotify.com', 'soundcloud.com'
  ];
  if (videoHosts.some(h => host === h || host.endsWith('.' + h) || host.includes(h))) {
    const open = esc(url);
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Video site</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaed;padding:10vh 20px;text-align:center}
a.btn{display:inline-block;margin-top:16px;padding:12px 20px;border-radius:12px;background:#3b82f6;color:#fff;text-decoration:none;font-weight:600}
p{opacity:.85;line-height:1.5;max-width:420px;margin:8px auto}
</style></head><body>
<h1>Video player needs a full browser</h1>
<p>This site uses a protected streaming player. SoloHost proxy can show the page shell but cannot play the video inside the frame.</p>
<p><a class="btn" href="${open}" target="_blank" rel="noopener">Open site ↗</a></p>
<p style="font-size:13px;opacity:.6">YouTube watch links still play via embed when you paste a full watch URL.</p>
</body></html>`;
  }

  return null;
}

function injectViewport(html) {
  if (/<meta[^>]+name=["']viewport["']/i.test(html)) return html;
  const tag = '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">';
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => m + tag);
  return tag + html;
}

function rewriteCss(css, baseUrl) {
  // Absolutize relative URLs against the CSS document URL — do NOT wrap in /api/proxy.
  // Proxying every font/image through SoloHost caused nested proxy URLs and log floods.
  let out = String(css || '');
  out = out.replace(/@import\s+(?:url\()?\s*(["']?)([^"')\s;]+)\1\s*\)?/gi, (m, q, ref) => {
    if (/^(data:|blob:)/i.test(ref)) return m;
    try {
      const abs = new URL(ref, baseUrl).href;
      if (abs.includes('/api/proxy?url=')) return '@import url("' + unwrapProxyUrl(abs) + '")';
      return '@import url("' + abs + '")';
    } catch { return m; }
  });
  out = out.replace(/url\(\s*(["']?)(.*?)\1\s*\)/gi, (m, q, ref) => {
    const value = String(ref || '').trim();
    if (!value || /^(data:|blob:|#|javascript:)/i.test(value)) return m;
    try {
      let abs = new URL(value, baseUrl).href;
      if (abs.includes('/api/proxy?url=')) abs = unwrapProxyUrl(abs);
      return 'url("' + abs + '")';
    } catch { return m; }
  });
  return out;
}


function detectBlockedPage(html, text, finalUrl) {
  const blob = (String(html || '') + '\n' + String(text || '')).toLowerCase();
  const checks = [
    { id: 'META_ERROR', re: /sorry, something went wrong/i },
    { id: 'META_ERROR', re: /we're working on getting this fixed/i },
    { id: 'FB_BLOCK', re: /facebook\.com\/sorry|checkpoint\/block/i },
    { id: 'GOOGLE_CAPTCHA', re: /unusual traffic from your computer network|about this page.*robot/i },
    { id: 'CLOUDFLARE', re: /attention required!|cf-browser-verification|just a moment\.\.\./i },
    { id: 'ACCESS_DENIED', re: /access denied|request blocked|403 forbidden/i }
  ];
  for (const c of checks) {
    if (c.re.test(blob) || c.re.test(String(finalUrl || ''))) return c.id;
  }
  return null;
}

function layoutFixCss() {
  // Mobile-first readability inside the SoloHost frame (fixes clipped desktop layouts).
  return `<style id="solohost-layout-fix">
html{width:100%!important;max-width:100vw!important;overflow-x:auto!important;-webkit-text-size-adjust:100%}
body{width:100%!important;max-width:100%!important;min-width:0!important;overflow-x:auto!important;margin:0 auto!important}
img,video,iframe,svg,table{max-width:100%!important;height:auto!important}
*{box-sizing:border-box}
/* Common desktop fixed widths that clip on phones */
[style*="width:"]{max-width:100%!important}
.container,.wrap,.wrapper,.content,.main,.page,#content,#main{max-width:100%!important;width:auto!important}
/* Google basic HTML */
#main,#center_col,#searchform,form{max-width:100%!important}
input[type="text"],input[type="search"]{max-width:100%!important;font-size:16px!important}
a{word-break:break-word}
</style>`;
}


/** Detect Google "please click here / enable JS" interstitial that becomes a white screen once scripts are stripped. */
function isGoogleInterstitial(html) {
  const s = String(html || '');
  if (/please click here if you are not redirected/i.test(s)) return true;
  if (/n[eế]u bạn không được chuyển/i.test(s)) return true;
  if (/httpservice\/retry\/enablejs/i.test(s)) return true;
  if (/id=["']yvlrue["'][^>]*display\s*:\s*none/i.test(s)) return true;
  // Very small Google shell with almost no result markers
  if (/google\./i.test(s) && /<title>\s*Google Search\s*<\/title>/i.test(s) && !/<div[^>]*id=["']main["']/i.test(s) && s.length < 12000) {
    if (/not redirected|enablejs|yvlrue/i.test(s)) return true;
  }
  return false;
}

function extractGoogleContinueUrl(html, baseUrl) {
  const s = String(html || '').replace(/&amp;/g, '&');
  const hrefs = [];
  const re = /href=["']([^"']+)["']/gi;
  let m;
  while ((m = re.exec(s))) hrefs.push(m[1]);
  // Prefer real /search? results links over enablejs
  const scored = [];
  for (const h of hrefs) {
    try {
      let abs = new URL(h, baseUrl).href;
      if (abs.includes('/api/proxy?url=')) abs = unwrapProxyUrl(abs);
      const u = new URL(abs);
      if (!/google\./i.test(u.hostname)) continue;
      if (/enablejs|support\.google/i.test(u.href)) continue;
      let score = 0;
      if (u.pathname.indexOf('/search') === 0) score += 5;
      if (u.searchParams.get('gbv') === '1') score += 3;
      if (u.searchParams.has('q')) score += 2;
      if (u.searchParams.has('sca_esv') || u.searchParams.has('sei')) score += 2;
      if (score > 0) scored.push({ score, href: u.href });
    } catch (_) {}
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.length ? scored[0].href : null;
}

function googleFallbackHtml(query, continueUrl, proxyOrigin) {
  const q = esc(query || '');
  const cont = continueUrl ? esc(proxyOrigin + '/api/proxy?url=' + encodeURIComponent(continueUrl)) : '';
  const ddg = esc((proxyOrigin || '') + '/api/proxy?url=' + encodeURIComponent('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query || '')));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Search</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaed;padding:20px;line-height:1.45}
a.btn{display:inline-block;margin:8px 8px 0 0;padding:12px 16px;border-radius:12px;background:#3b82f6;color:#fff;text-decoration:none;font-weight:600}
a.btn2{background:#334155}
p{opacity:.85;max-width:520px}
input{width:100%;max-width:420px;padding:12px;border-radius:10px;border:1px solid #333;background:#1a1d24;color:#fff;font-size:16px}
</style></head><body>
<h1>Google search</h1>
<p>Google returned an intermediate page that needs full browser JavaScript. SoloHost proxy cannot complete that step, so the frame looked blank.</p>
${cont ? `<p><a class="btn" href="${cont}">Try Google results link</a></p>` : ''}
<p><a class="btn btn2" href="${ddg}">Search with DuckDuckGo HTML</a></p>
<form method="get" action="${esc((proxyOrigin||'') + '/api/proxy')}" onsubmit="return true">
<input type="hidden" name="url" id="du">
<input type="search" id="qq" value="${q}" placeholder="Search…">
<button class="btn" type="submit">Search DDG</button>
</form>
<script>
document.querySelector('form').addEventListener('submit',function(e){
  e.preventDefault();
  var q=document.getElementById('qq').value.trim();
  if(!q)return;
  location.href=${JSON.stringify((proxyOrigin || '') + '/api/proxy?url=')} + encodeURIComponent('https://html.duckduckgo.com/html/?q='+encodeURIComponent(q));
});
</script>
</body></html>`;
}


function rewriteHtml(html, baseUrl) {
  let out = String(html || '');
  // Remove policy meta tags that prevent display inside our controlled same-origin frame.
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*(["']?)content-security-policy\1[^>]*>/gi, '');
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*(["']?)x-frame-options\1[^>]*>/gi, '');
  // Kill meta-refresh loops (anti-bot / legacy Google HTML).
  out = out.replace(/<meta\b[^>]*http-equiv\s*=\s*(["']?)refresh\1[^>]*>/gi, '');
  // Google search HTML (gbv=1) works without page JS. Inline scripts often force location
  // reloads which re-hit /api/proxy in a tight loop (see logs: same URL every ~200ms).
  try {
    const host = new URL(baseUrl).hostname.replace(/^www\./, '');
    if (/google\./i.test(host) || /youtube\./i.test(host) || /youtube-nocookie\./i.test(host)) {
      out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
      out = out.replace(/\son[a-z]+\s*=\s*(["'])[\s\S]*?\1/gi, '');
    }
  } catch (_) {}
  // Replace existing base so every relative URL is resolved against the real document URL.
  out = out.replace(/<base\b[^>]*>/gi, '');
  const baseMarker = '<!--SOLOHOST_BASE_MARKER-->';
  if (/<head\b[^>]*>/i.test(out)) out = out.replace(/<head\b[^>]*>/i, m => m + baseMarker);
  else out = '<head>' + baseMarker + '</head>' + out;
  if (!/<meta\b[^>]*charset=/i.test(out)) out = out.replace(/<head\b[^>]*>/i, m => m + '<meta charset="utf-8">');
  out = injectViewport(out);

  function proxied(value) {
    const raw = String(value || '').trim();
    if (!raw || /^(data:|blob:|javascript:|mailto:|tel:|#)/i.test(raw)) return value;
    try {
      const abs = new URL(raw, baseUrl);
      if (!/^https?:$/.test(abs.protocol)) return value;
      if (abs.pathname === '/api/proxy' && abs.origin === new URL(baseUrl).origin) return value;
      return proxyHref(abs.href);
    } catch { return value; }
  }
  // Images/media → absolute original URL (not proxy) to cut log spam and avoid layout thrash.
  // Scripts → absolute original URL only (proxying JS breaks SPAs and causes overlap/reflow bugs).
  // CSS still proxied via <link rel=stylesheet> rewrite below.
  out = out.replace(/<script\b([^>]*?)\bsrc=(['"])(.*?)\2([^>]*)>/gi, (m, before, q, value, after) => {
    try {
      const abs = new URL(String(value || '').trim(), baseUrl).href;
      if (!/^https?:/i.test(abs)) return m;
      return '<script' + before + 'src=' + q + esc(abs) + q + after + '>';
    } catch { return m; }
  });
  out = out.replace(/\b(poster|data-src|data-lazy-src|data-original|data-background-image)=(['"])(.*?)\2/gi,
    (m, attr, q, value) => {
      try {
        const abs = new URL(String(value || '').trim(), baseUrl).href;
        if (!/^https?:/i.test(abs)) return m;
        return attr + '=' + q + esc(abs) + q;
      } catch { return m; }
    });
  out = out.replace(/\bsrc=(['"])(.*?)\1/gi, (m, q, value) => {
    // skip if already handled in script tag context roughly: leave absolute; absolutize relative
    const raw = String(value || '').trim();
    if (!raw || /^(data:|blob:|javascript:)/i.test(raw)) return m;
    try {
      const abs = new URL(raw, baseUrl).href;
      if (!/^https?:/i.test(abs)) return m;
      return 'src=' + q + esc(abs) + q;
    } catch { return m; }
  });
  out = out.replace(/\bsrcset=(['"])(.*?)\1/gi, (m, q, value) => {
    const rewritten = value.split(',').map(part => {
      const bits = part.trim().split(/\s+/); if (!bits[0]) return part;
      bits[0] = proxied(bits[0]); return bits.join(' ');
    }).join(', ');
    return 'srcset=' + q + rewritten + q;
  });
  // Stylesheet, icon, preload, and modulepreload links are resources; ordinary anchors are handled below.
  out = out.replace(/<link\b([^>]*?)href=(['"])(.*?)\2([^>]*)>/gi, (m, before, q, href, after) => {
    const relMatch = (before + ' ' + after).match(/\brel\s*=\s*(['"]?)([^'"\s>]+)\1/i);
    const rel = relMatch ? relMatch[2].toLowerCase() : '';
    if (/stylesheet|icon|preload|modulepreload|manifest|apple-touch-icon/.test(rel)) {
      try {
        let abs = new URL(String(href || '').trim(), baseUrl).href;
        if (abs.includes('/api/proxy?url=')) abs = unwrapProxyUrl(abs);
        return '<link' + before + 'href=' + q + esc(abs) + q + after + '>';
      } catch { return m; }
    }
    return m;
  });
  // Only navigation anchors/forms go through the proxy — never re-wrap stylesheet/icon hrefs.
  out = out.replace(/<a\b([^>]*?)href=(['"])(https?:\/\/[^'"]+)\2([^>]*)>/gi, (m, before, q, href, after) => {
    try {
      let abs = new URL(href, baseUrl).href;
      if (abs.includes('/api/proxy?url=')) abs = unwrapProxyUrl(abs);
      return '<a' + before + 'href=' + q + esc(proxyHref(abs)) + q + after + '>';
    } catch { return m; }
  });
  out = out.replace(/<a\b([^>]*?)href=(['"])(\/[^'"]*)\2([^>]*)>/gi, (m, before, q, path, after) => {
    try {
      let abs = new URL(path, baseUrl).href;
      if (abs.includes('/api/proxy?url=')) abs = unwrapProxyUrl(abs);
      return '<a' + before + 'href=' + q + esc(proxyHref(abs)) + q + after + '>';
    } catch { return m; }
  });
  out = out.replace(/\baction=(['"])(.*?)\1/gi, (m, q, action) => {
    try {
      let abs = new URL(String(action || baseUrl).trim() || baseUrl, baseUrl).href;
      if (abs.includes('/api/proxy?url=')) abs = unwrapProxyUrl(abs);
      return 'action=' + q + esc(proxyHref(abs)) + q;
    } catch { return m; }
  });
  // Avoid stale target=_top/_parent escaping the browser shell.
  out = out.replace(/\btarget=(['"])(?:_top|_parent)\1/gi, 'target="_self"');

  const blockId = detectBlockedPage(out, out.replace(/<[^>]+>/g, ' ').slice(0, 4000), baseUrl);
  if (blockId) {
    const banner = '<div id="solohost-block-banner" style="position:sticky;top:0;z-index:99999;padding:12px 16px;background:#1a1a1a;color:#fff;font:14px system-ui;border-bottom:2px solid #f59e0b">'
      + '<strong>Site blocked the proxy view</strong> (' + blockId + '). '
      + '<a href="' + esc(baseUrl) + '" target="_blank" rel="noopener" style="color:#8eb6ff">Open original ↗</a></div>';
    if (/<body[^>]*>/i.test(out)) out = out.replace(/<body[^>]*>/i, (m) => m + banner);
    else out = banner + out;
  }
  if (!/solohost-layout-fix/.test(out)) {
    if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, layoutFixCss() + '</head>');
    else out = layoutFixCss() + out;
  }

  const bridge = `<script>(function(){
var BASE=${JSON.stringify(baseUrl)};
function abs(h){try{return new URL(h,BASE).href}catch(e){return null}}
function go(u){if(!u||!/^https?:/i.test(u))return;var o=${JSON.stringify(proxyOrigin||'')};location.href=(o?o:'')+'/api/proxy?url='+encodeURIComponent(u)}
function decodeProxy(h){try{var u=new URL(h,location.href);if(u.pathname==='/api/proxy'){return u.searchParams.get('url')||BASE}}catch(e){}return h}
document.addEventListener('click',function(e){
  var a=e.target&&e.target.closest&&e.target.closest('a'); if(!a)return;
  var href=a.getAttribute('href'); if(!href||href.charAt(0)==='#'||/^(javascript|mailto|tel):/i.test(href))return;
  if(a.target==='_blank'){a.rel='noopener noreferrer';return}
  e.preventDefault();e.stopPropagation();var u=decodeProxy(href);if(!/^https?:/i.test(u))u=abs(href);go(u);
},true);
document.addEventListener('submit',function(e){
 var f=e.target;if(!f||!f.tagName||f.tagName.toLowerCase()!=='form')return;
 var method=(f.method||'get').toLowerCase();if(method!=='get')return;
 e.preventDefault();try{var action=f.getAttribute('action')||BASE;var u=decodeProxy(action);if(!/^https?:/i.test(u))u=abs(action)||BASE;var fd=new FormData(f);var nu=new URL(u);fd.forEach(function(v,k){if(typeof v==='string')nu.searchParams.set(k,v)});if(/google\\./i.test(nu.hostname)&&nu.pathname.indexOf('/search')===0)nu.searchParams.set('gbv','1');go(nu.href)}catch(err){}
},true);
})();</script>`;
  out = out.replace('<!--SOLOHOST_BASE_MARKER-->', '<base href="' + esc(baseUrl) + '">');
  if (/<\/body>/i.test(out)) out = out.replace(/<\/body>/i, bridge + '</body>'); else out += bridge;
  return out;
}

function decodeBody(buffer, contentType) {
  const match = String(contentType || '').match(/charset\s*=\s*["']?([^;"'\s]+)/i);
  const charset = match ? match[1].trim() : 'utf-8';
  try { return new TextDecoder(charset, { fatal: false }).decode(buffer); }
  catch (_) { return buffer.toString('utf8'); }
}

async function fetchDocument(targetUrl, reqHeaders = {}) {
  let current = normalizeTargetUrl(targetUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers = {
      'User-Agent': UA,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/css,*/*;q=0.8',
      'Accept-Language': reqHeaders['accept-language'] || 'vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7',
      'Upgrade-Insecure-Requests': '1'
    };
    let res;
    for (let hop = 0; hop <= 5; hop++) {
      const safeUrl = await assertPublicHttpUrl(current);
      res = await fetch(safeUrl.href, { method: 'GET', headers, redirect: 'manual', signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(res.status)) { current = safeUrl.href; break; }
      const location = res.headers.get('location');
      if (!location || hop === 5) { const err = new Error('Too many or invalid redirects'); err.code = 'BAD_REDIRECT'; throw err; }
      current = new URL(location, safeUrl.href).href;
      // Validate every redirect target before requesting it, preventing redirect-based SSRF.
      await assertPublicHttpUrl(current);
      try { await res.body?.cancel(); } catch (_) {}
    }
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const length = Number(res.headers.get('content-length') || 0);
    if (length > MAX_BYTES) { const err = new Error('Response too large'); err.code = 'TOO_LARGE'; throw err; }
    const chunks = []; let total = 0;
    if (res.body) {
      const reader = res.body.getReader();
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) { await reader.cancel(); const err = new Error('Response too large'); err.code = 'TOO_LARGE'; throw err; }
        chunks.push(Buffer.from(value));
      }
    }
    return { status: res.status, contentType: ct, body: Buffer.concat(chunks, total), finalUrl: res.url || current };
  } finally { clearTimeout(timer); }
}

async function handleProxy(req, res) {
  const raw = String((req.query && req.query.url) || '').trim();
  const started = Date.now();
  // Prefer forwarded host when behind SoloHost reverse proxy
  try {
    const xfProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
    const xfHost = (req.headers['x-forwarded-host'] || '').toString().split(',')[0].trim();
    const host = xfHost || req.headers.host || '127.0.0.1';
    const proto = xfProto || req.protocol || 'http';
    proxyOrigin = proto + '://' + host;
  } catch {
    proxyOrigin = '';
  }
  if (!raw) {
    appLog.log('warn', 'proxy.missing_url', {});
    res.status(400).type('html').send('<!doctype html><title>Error</title><p>Missing url</p>');
    return;
  }
  try {
    const normalized = normalizeTargetUrl(raw);
    if (String(raw).includes('/api/proxy') && unwrapProxyUrl(raw) !== String(raw).trim()) {
      appLog.log('warn', 'proxy.unwrap', { from: String(raw).slice(0, 200), to: normalized.slice(0, 200) });
    }
    
    // Do not pipeline images/fonts/media through the HTML proxy — redirect to origin.
    try {
      const pathOnly = new URL(normalized).pathname.toLowerCase();
      if (/\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|m4a|m3u8)(\?|$)/i.test(pathOnly)) {
        appLog.log('debug', 'proxy.redirect_asset', { url: normalized.slice(0, 200) });
        res.removeHeader('X-Frame-Options');
        res.redirect(302, normalized);
        return;
      }
    } catch (_) {}

    const repeats = trackRepeat(normalized);
    if (repeats >= 5) {
      appLog.log('warn', 'proxy.loop', { url: normalized.slice(0, 300), hits: repeats, note: 'same URL requested repeatedly — likely client reload loop' });
    }
    const cached = cacheGet(normalized);
    if (cached && cached.body != null) {
      appLog.log('info', 'proxy.cache', { url: normalized.slice(0, 300), hits: repeats, age_ms: Date.now() - cached.ts });
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', 'frame-ancestors *');
      res.setHeader('Cache-Control', 'private, max-age=30');
      res.status(cached.status || 200).type(cached.type || 'html').send(cached.body);
      return;
    }
    appLog.log('info', 'proxy.request', { url: normalized.slice(0, 300), origin: proxyOrigin || undefined, hits: repeats });
    const shell = specialShell(normalized);
    if (shell) {
      res.removeHeader('X-Frame-Options');
      res.setHeader('Content-Security-Policy', 'frame-ancestors *');
      appLog.log('info', 'proxy.shell', { url: normalized.slice(0, 300), ms: Date.now() - started });
      const inject = '<script>window.__SOLO_PROXY_ORIGIN=' + JSON.stringify(proxyOrigin || '') + ';</script>';
      const outShell = shell.includes('<head>') ? shell.replace('<head>', '<head>' + inject) : inject + shell;
      res.status(200).type('html').send(outShell);
      return;
    }

    const doc = await fetchDocument(normalized, req.headers || {});
    res.removeHeader('X-Frame-Options');
    res.setHeader('Content-Security-Policy', 'frame-ancestors *');
    res.setHeader('Cache-Control', 'private, max-age=60');

    if (/text\/css/i.test(doc.contentType)) {
      const css = rewriteCss(decodeBody(doc.body, doc.contentType), doc.finalUrl);
      appLog.log('info', 'proxy.css', { url: normalized.slice(0, 200), status: doc.status, bytes: doc.body.length, ms: Date.now() - started });
      res.status(doc.status).type('text/css').send(css);
      return;
    }
    if (/text\/html|application\/xhtml/i.test(doc.contentType) || doc.body.slice(0, 128).toString().toLowerCase().includes('<!doctype') || /<html[\s>]/i.test(doc.body.slice(0, 128).toString())) {
      let html = decodeBody(doc.body, doc.contentType);
      // Google interstitial → follow continue URL once (scripts stripped would white-screen otherwise)
      try {
        const host = new URL(doc.finalUrl || normalized).hostname.replace(/^www\./, '');
        if (/google\./i.test(host) && isGoogleInterstitial(html)) {
          const cont = extractGoogleContinueUrl(html, doc.finalUrl || normalized);
          appLog.log('warn', 'proxy.google_interstitial', {
            url: String(doc.finalUrl || normalized).slice(0, 300),
            continue: cont ? cont.slice(0, 300) : null
          });
          if (cont && cont !== doc.finalUrl && cont !== normalized) {
            try {
              const doc2 = await fetchDocument(cont, req.headers || {});
              if (doc2 && doc2.body && !isGoogleInterstitial(decodeBody(doc2.body, doc2.contentType))) {
                doc = doc2;
                html = decodeBody(doc2.body, doc2.contentType);
              } else if (doc2 && doc2.body) {
                html = decodeBody(doc2.body, doc2.contentType);
              }
            } catch (e2) {
              appLog.log('warn', 'proxy.google_follow_fail', { error: String(e2.message || e2).slice(0, 200) });
            }
          }
          if (isGoogleInterstitial(html)) {
            let q = '';
            try { q = new URL(normalized).searchParams.get('q') || ''; } catch (_) {}
            const cont2 = extractGoogleContinueUrl(html, doc.finalUrl || normalized);
            html = googleFallbackHtml(q, cont2, proxyOrigin);
            appLog.log('warn', 'proxy.google_fallback', { q: q.slice(0, 80) });
            const statusOut = 200;
            cacheSet(normalized, { body: html, status: statusOut, type: 'html' });
            res.removeHeader('X-Frame-Options');
            res.setHeader('Content-Security-Policy', 'frame-ancestors *');
            res.status(statusOut).type('html').send(html);
            return;
          }
        }
      } catch (_) {}
      html = rewriteHtml(html, doc.finalUrl);
      const plain = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 2000);
      const blocked = detectBlockedPage(html, plain, doc.finalUrl);
      const logLevel = blocked ? 'warn' : 'info';
      const logMsg = blocked ? 'proxy.blocked' : 'proxy.ok';
      appLog.log(logLevel, logMsg, {
        url: normalized.slice(0, 300),
        final: String(doc.finalUrl || '').slice(0, 300),
        status: doc.status,
        bytes: doc.body.length,
        ms: Date.now() - started,
        blocked: blocked || undefined,
        title: (html.match(/<title[^>]*>([^<]*)</i) || [])[1] || undefined,
        snippet: plain.slice(0, 160)
      });
      const statusOut = doc.status >= 400 && doc.status !== 404 ? doc.status : 200;
      cacheSet(normalized, { body: html, status: statusOut, type: 'html' });
      res.status(statusOut).type('html').send(html);
      return;
    }
    res.status(doc.status).type(doc.contentType || 'application/octet-stream').send(doc.body);
  } catch (err) {
    let code = err && err.code;
    if (err && err.name === 'AbortError') { code = 'TIMEOUT'; err.message = err.message || 'Proxy fetch timed out'; }
    const status = code === 'INVALID_URL' || code === 'BAD_SCHEME' ? 400
      : code === 'BLOCKED_HOST' ? 403
      : code === 'TOO_LARGE' ? 502
      : 502;
    const msg = esc(String((err && err.message) || err));
    appLog.log('error', 'proxy.fail', {
      url: raw.slice(0, 300),
      code: code || 'ERROR',
      error: String((err && err.message) || err).slice(0, 500),
      name: err && err.name,
      ms: Date.now() - started,
      origin: proxyOrigin || undefined
    });
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
  rewriteCss,
  decodeBody,
  isPrivateIp,
  normalizeTargetUrl,
  specialShell
};
