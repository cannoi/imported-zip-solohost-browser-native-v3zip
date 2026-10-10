'use strict';

/**
 * Same-origin HTML frame proxy for SoloHost Browser.
 * - Strips frame-busting headers
 * - Rewrites links/forms to stay inside /api/proxy
 * - Lightweight fallback shells for Google, YouTube and TikTok home pages
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
/** After Google serves an interstitial, skip straight to DuckDuckGo for 10 minutes. */
let googleBlockedUntil = 0;

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
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36 SoloHostProxy/10';

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

/** Ports commonly abused for SSRF against admin/metadata services */
const BLOCKED_PORTS = new Set([
  22, 23, 25, 53, 110, 143, 445, 1433, 1521, 3306, 3389, 5432, 5900, 5901,
  6379, 7001, 8000, 8080, 8443, 9200, 9300, 11211, 27017,
  2375, 2376, 2377, 4243, 6443, 10250, 10255, 50000
]);
// Note: 80/443 always allowed. App may run on 8080 but remote targets on 8080 are blocked as high-risk LAN services.

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
  if (u.username || u.password) {
    const err = new Error('URLs containing credentials are not allowed');
    err.code = 'INVALID_URL';
    throw err;
  }
  if (!host ||
      host === 'localhost' ||
      host.endsWith('.local') ||
      host.endsWith('.internal') ||
      host.endsWith('.localhost') ||
      host.endsWith('.lan') ||
      host === 'metadata.google.internal' ||
      host === 'metadata' ||
      host === 'kubernetes.default' ||
      host === 'kubernetes.default.svc') {
    const err = new Error('Host not allowed');
    err.code = 'BLOCKED_HOST';
    throw err;
  }

  const port = u.port ? Number(u.port) : (u.protocol === 'https:' ? 443 : 80);
  if (port !== 80 && port !== 443 && BLOCKED_PORTS.has(port)) {
    const err = new Error('Port not allowed');
    err.code = 'BLOCKED_PORT';
    throw err;
  }
  if (port === 0 || port > 65535) {
    const err = new Error('Invalid port');
    err.code = 'BLOCKED_PORT';
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

  let resolved;
  try {
    resolved = await dns.lookup(host, { all: true, verbatim: true });
  } catch (e) {
    const err = new Error('DNS resolution failed');
    err.code = 'DNS_FAIL';
    throw err;
  }
  if (!resolved || !resolved.length) {
    const err = new Error('DNS resolution failed');
    err.code = 'DNS_FAIL';
    throw err;
  }
  for (const r of resolved) {
    if (isPrivateIp(r.address)) {
      const err = new Error('Private address blocked');
      err.code = 'BLOCKED_HOST';
      throw err;
    }
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


/** DuckDuckGo result links go through /l/?uddg=<real-url>&rut=… — proxying that endpoint returns 400. Unwrap to the real target. */
function unwrapDuckRedirect(raw) {
  let cur = String(raw || '').trim();
  for (let i = 0; i < 3; i++) {
    let u;
    try { u = new URL(cur); } catch { return cur; }
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    // /l/?uddg=https%3A%2F%2F...
    if ((host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) && (u.pathname === '/l/' || u.pathname === '/l')) {
      const uddg = u.searchParams.get('uddg') || u.searchParams.get('u');
      if (uddg) {
        // URL.searchParams.get() already performs one percent-decoding pass.
        // A second decode corrupts legitimate percent-encoded destination URLs.
        cur = uddg;
        continue;
      }
    }
    // Some DDG links: //duckduckgo.com/l/?kh=-1&uddg=
    break;
  }
  return cur;
}

function normalizeTargetUrl(raw) {
  raw = unwrapProxyUrl(raw);
  raw = unwrapDuckRedirect(raw);
  let u;
  try { u = new URL(String(raw).trim()); } catch { return String(raw).trim(); }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();

  // Google mobile / SPA paths → HTML search that works without page JS in proxy
  if (host === 'google.com' || host.endsWith('.google.com')) {
    const path = u.pathname || '/';
    // /m?q=… or /search?… → force classic HTML results (gbv=1)
    if (path === '/m' || path === '/m/' || path.startsWith('/search') || path === '/webhp') {
      const q = u.searchParams.get('q') || u.searchParams.get('query') || '';
      const nu = new URL('https://www.google.com/search');
      if (q) nu.searchParams.set('q', q);
      // copy other harmless params
      for (const key of ['start', 'tbm', 'tbs', 'hl', 'lr']) {
        if (u.searchParams.has(key)) nu.searchParams.set(key, u.searchParams.get(key));
      }
      nu.searchParams.set('gbv', '1');
      nu.searchParams.set('hl', nu.searchParams.get('hl') || 'en');
      return nu.toString();
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
<form id="f" method="get" action="/api/browser/go">
<input type="hidden" name="engine" value="google">
<input id="q" name="q" type="search" placeholder="Search Google" autofocus enterkeyhint="search" required>
<button type="submit">Search</button>
</form>
<p class="hint">Works without JavaScript. Full Google app: use Open ↗.</p>
<p class="hint"><a href="https://www.google.com/" target="_blank" rel="noopener">Open Google ↗</a></p>
</div>
</body></html>`;
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
<form method="get" action="/api/browser/go" id="f">
<input type="hidden" name="engine" value="youtube">
<input id="q" name="q" type="search" placeholder="Search videos" enterkeyhint="search" required>
<button type="submit">Search</button>
</form>
<div class="row">
<a class="btn" href="https://www.youtube.com/" target="_blank" rel="noopener">Open YouTube ↗</a>
</div>
<p style="color:#888;font-size:13px;margin-top:12px">No JavaScript required. Or paste a <code>watch?v=</code> link in the address bar.</p>
</div></body></html>`;
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


  // Streaming and music sites are no longer replaced by a fake shell.
  // Try their real document first. Complex SPA players, login, DRM and CORS may still
  // require the existing ↗ Open-original action because this proxy is not a full browser engine.

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
function isYoutubeSpaShell(html) {
  const s = String(html || '');
  // YouTube pages are typically 300KB+; the old 120KB cap meant this never matched in production.
  if (!/ytcfg|ytInitialData|var yt/.test(s)) return false;
  return (s.match(/watch\?v=/g) || []).length < 2;
}

function youtubeResultsFallback(query, proxyOrigin) {
  const q = String(query || '').trim();
  const ddg = (proxyOrigin || '') + '/api/proxy?url=' + encodeURIComponent('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q + ' site:youtube.com'));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YouTube search</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;background:#0f0f0f;color:#fff;padding:24px}
a{color:#3ea6ff} .box{max-width:640px;margin:0 auto}
input,button{font-size:16px;padding:12px;border-radius:10px;border:0}
input{width:100%;box-sizing:border-box;margin:12px 0;background:#212121;color:#fff}
button{background:#ff0033;color:#fff;font-weight:600;cursor:pointer}
</style></head><body><div class="box">
<h1>YouTube search</h1>
<p>YouTube results page needs the full app (JavaScript). Search via DuckDuckGo HTML, or paste a <code>watch?v=</code> link.</p>
<form method="get" action="/api/browser/go">
<input type="hidden" name="engine" value="youtube">
<input name="q" value="${String(q).replace(/"/g,'&quot;')}" placeholder="Search videos" required>
<button type="submit">Search</button>
</form>
<p><a href="${ddg}">Open results via DuckDuckGo</a> · <a href="https://www.youtube.com/results?search_query=${encodeURIComponent(q)}" target="_blank" rel="noopener">Open YouTube ↗</a></p>
</div></body></html>`;
}


/* ---------- YouTube: native player + native results (no page JS needed) ---------- */
function youtubeVideoId(u) {
  try {
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    const p = u.pathname || '';
    let id = null;
    if (host === 'youtu.be') id = p.split('/').filter(Boolean)[0];
    else if (host === 'youtube.com' || host === 'm.youtube.com' || host === 'music.youtube.com' || host === 'youtube-nocookie.com') {
      if (p === '/watch' || p.startsWith('/watch')) id = u.searchParams.get('v');
      else { const m = p.match(/^\/(?:shorts|live|v)\/([\w-]{6,15})/); if (m) id = m[1]; }
    }
    return id && /^[\w-]{6,15}$/.test(id) ? id : null;
  } catch { return null; }
}

function youtubePlayerPage(videoId, title, origin) {
  const t = esc(title || 'YouTube');
  const o = origin || '';
  const id = esc(videoId);
  const watch = 'https://www.youtube.com/watch?v=' + encodeURIComponent(videoId);
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t}</title>
<style>
html,body{margin:0;background:#0f0f0f;color:#fff;font-family:system-ui,sans-serif}
.wrap{max-width:900px;margin:0 auto;padding:10px}
.player{position:relative;width:100%;aspect-ratio:16/9;background:#000;border-radius:12px;overflow:hidden}
.player iframe{position:absolute;inset:0;width:100%;height:100%;border:0}
h1{font-size:17px;line-height:1.35;margin:12px 2px 8px}
form{display:flex;gap:8px;margin:12px 0}
input{flex:1;min-width:0;padding:11px 14px;border-radius:12px;border:1px solid #333;background:#212121;color:#fff;font-size:16px}
button,a.btn{padding:11px 14px;border-radius:12px;border:0;background:#ff0033;color:#fff;font-weight:600;text-decoration:none;display:inline-block;font-size:15px}
a.btn2{background:#272727}
.row{display:flex;flex-wrap:wrap;gap:8px}
p.n{color:#999;font-size:13px;line-height:1.5}
</style></head><body><div class="wrap">
<div class="player"><iframe id="yt" src="https://www.youtube.com/embed/${id}?rel=0&modestbranding=1&playsinline=1" title="${t}"
 referrerpolicy="strict-origin-when-cross-origin"
 allow="autoplay; encrypted-media; fullscreen; picture-in-picture; accelerometer; gyroscope" allowfullscreen></iframe></div>
<h1>${t}</h1>
<div class="row"><a class="btn btn2" href="javascript:history.back()">← Back</a>
<a class="btn" href="${esc(watch)}" target="_blank" rel="noopener noreferrer">Open on YouTube ↗</a></div>
<form method="get" action="${esc(o)}/api/browser/go"><input type="hidden" name="engine" value="youtube">
<input name="q" type="search" placeholder="Search videos" enterkeyhint="search" required><button type="submit">Search</button></form>
<p class="n">If the player shows an error (video blocked from embedding), use “Open on YouTube”.</p>
</div></body></html>`;
}

/** Fetch title via oEmbed (tiny JSON, best-effort, 3s). */
async function youtubeTitle(videoId) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 3000);
  try {
    const r = await fetch('https://www.youtube.com/oembed?format=json&url=' +
      encodeURIComponent('https://www.youtube.com/watch?v=' + videoId), { signal: ctl.signal, headers: { 'User-Agent': UA } });
    if (!r.ok) return '';
    const j = await r.json();
    return String((j && j.title) || '').slice(0, 200);
  } catch { return ''; } finally { clearTimeout(timer); }
}

/** Extract the JSON object assigned to ytInitialData by balanced-brace scan. */
function extractYtInitialData(html) {
  const s = String(html || '');
  const m = /(?:var\s+ytInitialData|window\["ytInitialData"\]|ytInitialData)\s*=\s*/.exec(s);
  if (!m) return null;
  let i = s.indexOf('{', m.index + m[0].length - 1);
  if (i < 0) return null;
  const start = i;
  let depth = 0, inStr = false, esc_ = false;
  for (; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc_) esc_ = false;
      else if (c === '\\') esc_ = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  if (depth !== 0) return null;
  try { return JSON.parse(s.slice(start, i)); } catch { return null; }
}

function ytText(x) {
  if (!x) return '';
  if (typeof x === 'string') return x;
  if (x.simpleText) return String(x.simpleText);
  if (Array.isArray(x.runs)) return x.runs.map(r => r.text || '').join('');
  return '';
}

function parseYoutubeResults(html) {
  const data = extractYtInitialData(html);
  const out = [];
  const seen = new Set();
  if (!data) return out;
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 40 || out.length >= 40) return;
    if (Array.isArray(o)) { for (const v of o) walk(v, depth + 1); return; }
    const v = o.videoRenderer || o.compactVideoRenderer || o.gridVideoRenderer;
    if (v && v.videoId && /^[\w-]{6,15}$/.test(v.videoId) && !seen.has(v.videoId)) {
      seen.add(v.videoId);
      out.push({
        id: v.videoId,
        title: ytText(v.title) || v.videoId,
        channel: ytText(v.ownerText) || ytText(v.longBylineText) || ytText(v.shortBylineText),
        meta: [ytText(v.viewCountText), ytText(v.publishedTimeText)].filter(Boolean).join(' · '),
        length: ytText(v.lengthText)
      });
      return;
    }
    for (const k of Object.keys(o)) walk(o[k], depth + 1);
  })(data, 0);
  return out;
}

function youtubeResultsPage(query, items, origin) {
  const o = origin || '';
  const q = String(query || '');
  const cards = items.map(it => {
    const href = esc(o + '/api/proxy?url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + it.id));
    const thumb = esc('https://i.ytimg.com/vi/' + it.id + '/mqdefault.jpg');
    return `<a class="card" href="${href}"><span class="th"><img loading="lazy" src="${thumb}" alt="">${it.length ? `<em>${esc(it.length)}</em>` : ''}</span>
<span class="tx"><b>${esc(it.title)}</b><small>${esc(it.channel)}</small><small>${esc(it.meta)}</small></span></a>`;
  }).join('\n');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(q)} - YouTube</title>
<style>
html,body{margin:0;background:#0f0f0f;color:#fff;font-family:system-ui,sans-serif}
.wrap{max-width:760px;margin:0 auto;padding:10px}
form{display:flex;gap:8px;margin:4px 0 12px}
input{flex:1;min-width:0;padding:11px 14px;border-radius:12px;border:1px solid #333;background:#212121;color:#fff;font-size:16px}
button{padding:11px 14px;border-radius:12px;border:0;background:#ff0033;color:#fff;font-weight:600;font-size:15px}
.card{display:flex;gap:10px;margin:0 0 12px;text-decoration:none;color:inherit}
.th{position:relative;flex:0 0 42%;max-width:240px;aspect-ratio:16/9;background:#222;border-radius:10px;overflow:hidden}
.th img{width:100%;height:100%;object-fit:cover;display:block}
.th em{position:absolute;right:4px;bottom:4px;background:rgba(0,0,0,.8);font-style:normal;font-size:11px;padding:1px 5px;border-radius:4px}
.tx{display:flex;flex-direction:column;gap:3px;min-width:0}
.tx b{font-size:14px;line-height:1.3;font-weight:600;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.tx small{color:#aaa;font-size:12px}
</style></head><body><div class="wrap">
<form method="get" action="${esc(o)}/api/browser/go"><input type="hidden" name="engine" value="youtube">
<input name="q" type="search" value="${esc(q)}" enterkeyhint="search" required><button type="submit">Search</button></form>
${cards}
</div></body></html>`;
}

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
  const o = proxyOrigin || '';
  const ddg = esc(o + '/api/proxy?url=' + encodeURIComponent('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query || '')));
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Search</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f1115;color:#e8eaed;padding:20px;line-height:1.45}
a.btn,button{display:inline-block;margin:8px 8px 0 0;padding:12px 16px;border-radius:12px;background:#3b82f6;color:#fff;text-decoration:none;font-weight:600;border:0;font-size:15px}
p{opacity:.85;max-width:520px}
input{width:100%;max-width:420px;padding:12px;border-radius:10px;border:1px solid #333;background:#1a1d24;color:#fff;font-size:16px;box-sizing:border-box}
</style></head><body>
<h1>Search</h1>
<p>Google asked for a verification step that this proxy cannot complete. Use DuckDuckGo results instead:</p>
<p><a class="btn" href="${ddg}">Search with DuckDuckGo</a></p>
<form method="get" action="${esc(o)}/api/browser/go">
<input type="hidden" name="engine" value="ddg">
<input type="search" name="q" value="${q}" placeholder="Search…" required>
<button type="submit">Search</button>
</form>
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
    // srcset entries are images, not navigations: keep them on the source origin.
    // Proxying them caused repeated redirect_asset logs and wasted requests.
    const rewritten = value.split(',').map(part => {
      const bits = part.trim().split(/\s+/); if (!bits[0]) return part;
      const raw = bits[0];
      if (!/^(data:|blob:|https?:)/i.test(raw)) {
        try { bits[0] = new URL(raw, baseUrl).href; } catch (_) {}
      }
      return bits.join(' ');
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
      abs = unwrapDuckRedirect(abs);
      abs = normalizeTargetUrl(abs);
      return '<a' + before + 'href=' + q + esc(proxyHref(abs)) + q + after + '>';
    } catch { return m; }
  });
  out = out.replace(/<a\b([^>]*?)href=(['"])(\/[^'"]*)\2([^>]*)>/gi, (m, before, q, path, after) => {
    try {
      let abs = new URL(path, baseUrl).href;
      if (abs.includes('/api/proxy?url=')) abs = unwrapProxyUrl(abs);
      abs = unwrapDuckRedirect(abs);
      abs = normalizeTargetUrl(abs);
      return '<a' + before + 'href=' + q + esc(proxyHref(abs)) + q + after + '>';
    } catch { return m; }
  });
  try {
    if (/(^|\.)duckduckgo\.com$/i.test(new URL(baseUrl).hostname)) {
      out = out.replace(/(<form\b[^>]*?)\bmethod\s*=\s*(['"]?)post\2/gi, '$1method="get"');
    }
  } catch (_) {}
  out = out.replace(/\baction=(['"])(.*?)\1/gi, (m, q, action) => {
    if (proxyOrigin && String(action || '').trim().startsWith(proxyOrigin + '/api/browser/go')) return m; // app-native form
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
 e.preventDefault();try{var action=f.getAttribute('action')||BASE;var u=decodeProxy(action);if(!/^https?:/i.test(u))u=abs(action)||BASE;var fd=new FormData(f);var nu=new URL(u);fd.forEach(function(v,k){if(typeof v==='string')nu.searchParams.set(k,v)});if(false){}go(nu.href)}catch(err){}
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
      const hdrs = Object.assign({}, headers);
      if (/(^|\.)youtube\.com$/i.test(safeUrl.hostname)) hdrs.Cookie = 'SOCS=CAI; CONSENT=YES+1'; // skip EU consent wall; only sent to youtube.com
      res = await fetch(safeUrl.href, { method: 'GET', headers: hdrs, redirect: 'manual', signal: controller.signal });
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
      if (/\.(png|jpe?g|gif|webp|avif|jxl|svg|ico|woff2?|ttf|otf|eot|mp4|m4v|webm|mov|avi|mkv|3gp|mp3|m4a|m4b|aac|ogg|oga|opus|wav|flac|m3u8|mpd|m4s|ts|pdf)(\?|$)/i.test(pathOnly)) {
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

    // YouTube watch/shorts/youtu.be: the real page is a JS-only SPA (scripts are stripped => grey skeleton forever).
    // Serve a native page with the official embed player instead.
    try {
      const vu = new URL(normalized);
      const vid = youtubeVideoId(vu);
      if (vid) {
        const title = await youtubeTitle(vid);
        res.removeHeader('X-Frame-Options');
        res.setHeader('Content-Security-Policy', 'frame-ancestors *');
        res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
        res.setHeader('Cache-Control', 'no-store');
        appLog.log('info', 'proxy.youtube_player', { id: vid, title: title.slice(0, 80), ms: Date.now() - started });
        res.status(200).type('html').send(youtubePlayerPage(vid, title, proxyOrigin));
        return;
      }
    } catch (_) {}

    // Google search known-blocked recently: go straight to DuckDuckGo results (saves a ~0.5s round trip).
    try {
      const gu = new URL(normalized);
      if (Date.now() < googleBlockedUntil && /(^|\.)google\.[a-z.]+$/i.test(gu.hostname) && gu.pathname.startsWith('/search') && gu.searchParams.get('q')) {
        const q = gu.searchParams.get('q');
        const dd = await fetchDocument('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), req.headers || {});
        if (dd.status === 200) {
          let ddHtml = rewriteHtml(decodeBody(dd.body, dd.contentType), dd.finalUrl);
          const banner = '<div style="padding:8px 12px;background:#1a1a1a;color:#fbbf24;font:13px system-ui">Showing DuckDuckGo results for “' + esc(q) + '” (Google blocks this server).</div>';
          ddHtml = /<body[^>]*>/i.test(ddHtml) ? ddHtml.replace(/<body[^>]*>/i, m => m + banner) : banner + ddHtml;
          appLog.log('info', 'proxy.google_ddg_direct', { q: q.slice(0, 80), ms: Date.now() - started });
          res.removeHeader('X-Frame-Options');
          res.setHeader('Content-Security-Policy', 'frame-ancestors *');
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).type('html').send(ddHtml);
          return;
        }
      }
    } catch (_) { /* fall through to normal fetch */ }

    let doc = await fetchDocument(normalized, req.headers || {});
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
        
        // YouTube /results: parse ytInitialData (server-rendered JSON) into a native list.
        if (/youtube\.com$/i.test(host) && /\/results/.test((() => { try { return new URL(doc.finalUrl || normalized).pathname; } catch { return ''; } })())) {
          let q = '';
          try { q = new URL(doc.finalUrl || normalized).searchParams.get('search_query') || ''; } catch (_) {}
          const items = parseYoutubeResults(html);
          if (items.length) {
            appLog.log('info', 'proxy.youtube_results', { q: String(q).slice(0, 80), n: items.length, ms: Date.now() - started });
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).type('html').send(youtubeResultsPage(q, items, proxyOrigin));
            return;
          }
          if (isYoutubeSpaShell(html)) {
            appLog.log('warn', 'proxy.youtube_spa_shell', { q: String(q).slice(0, 80) });
            res.setHeader('Cache-Control', 'no-store');
            res.status(200).type('html').send(youtubeResultsFallback(q, proxyOrigin));
            return;
          }
        }

        if (/google\./i.test(host) && isGoogleInterstitial(html)) {
          const q = (() => {
            try { return new URL(doc.finalUrl || normalized).searchParams.get('q') || ''; } catch { return ''; }
          })();
          appLog.log('warn', 'proxy.google_interstitial', { url: String(doc.finalUrl || normalized).slice(0, 300) });
          googleBlockedUntil = Date.now() + 10 * 60 * 1000;
          // Auto-serve DuckDuckGo HTML results instead of a dead-end page.
          let served = false;
          if (q) {
            try {
              const dd = await fetchDocument('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q), req.headers || {});
              if (dd.status === 200) {
                let ddHtml = rewriteHtml(decodeBody(dd.body, dd.contentType), dd.finalUrl);
                const banner = '<div style="padding:8px 12px;background:#1a1a1a;color:#fbbf24;font:13px system-ui">Google needs verification from this server, showing DuckDuckGo results for “' + esc(q) + '”.</div>';
                ddHtml = /<body[^>]*>/i.test(ddHtml) ? ddHtml.replace(/<body[^>]*>/i, m => m + banner) : banner + ddHtml;
                appLog.log('warn', 'proxy.google_ddg_auto', { q: q.slice(0, 80), ms: Date.now() - started });
                res.setHeader('Cache-Control', 'no-store');
                res.status(200).type('html').send(ddHtml);
                served = true;
              }
            } catch (e) {
              appLog.log('warn', 'proxy.google_ddg_fail', { error: String(e.message || e).slice(0, 200) });
            }
          }
          if (served) return;
          res.setHeader('Cache-Control', 'no-store');
          res.status(200).type('html').send(googleFallbackHtml(q, doc.finalUrl || normalized, proxyOrigin));
          appLog.log('warn', 'proxy.google_fallback', { q: String(q).slice(0, 80) });
          return;
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
      // Avoid pinning transient bot checks, access-denied pages, and HTTP errors in memory cache.
      if (!blocked && doc.status >= 200 && doc.status < 400 && !/captcha|unusual traffic|access denied|temporarily unavailable/i.test(plain)) {
        cacheSet(normalized, { body: html, status: statusOut, type: 'html' });
      }
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
  specialShell,
  youtubeVideoId,
  youtubePlayerPage,
  parseYoutubeResults,
  youtubeResultsPage,
  extractYtInitialData,
  googleFallbackHtml,
  isGoogleInterstitial
};
