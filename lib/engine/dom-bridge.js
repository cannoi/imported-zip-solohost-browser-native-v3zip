'use strict';

/**
 * Interactive DOM Bridge for SoloHost Browser.
 * - Prefer Playwright Chromium (full JS/cookies); WebKit optional; proxy fallback
 * - Fallback: sanitized HTML from frame-proxy fetch (no site JS in admin origin)
 * - Sessions isolated; token required for events/content
 */

const crypto = require('crypto');
const appLog = require('../app-log');
const { webkitManager } = require('./webkit-manager');
const playwrightEngine = require('./playwright-engine');
const contentRouter = require('./content-router');

const MAX_HTML_BYTES = Number(process.env.SOLOHOST_BRIDGE_MAX_HTML || 1_500_000);
const MAX_SESSIONS = Number(process.env.SOLOHOST_BRIDGE_MAX_SESSIONS || 6);
const SESSION_TTL_MS = Number(process.env.SOLOHOST_BRIDGE_TTL_MS || 30 * 60 * 1000);
const RATE_PER_MIN = Number(process.env.SOLOHOST_BRIDGE_RATE || 600);

const sessions = new Map(); // id -> session
const rateBuckets = new Map();
let webkitCooldownUntil = 0;
let webkitFailStreak = 0;

function token() {
  return crypto.randomBytes(24).toString('hex');
}

function sid() {
  return 'bs_' + crypto.randomBytes(8).toString('hex');
}

function rateOk(key) {
  const now = Date.now();
  let b = rateBuckets.get(key);
  if (!b || now - b.ts > 60000) {
    b = { ts: now, n: 0 };
    rateBuckets.set(key, b);
  }
  b.n += 1;
  return b.n <= RATE_PER_MIN;
}

function gc() {
  const now = Date.now();
  for (const [id, s] of sessions) {
    if (now - s.touched > SESSION_TTL_MS) {
      destroySession(id).catch(() => {});
    }
  }
}
setInterval(gc, 60000).unref?.();

/** Strip active content so HTML is safe in admin-origin viewport (srcdoc/iframe). */
function hasRenderableContent(html, audit = {}) {
  const source = String(html || '');
  if (!source.trim()) return false;
  // A CSS-only wrapper is not page content. Use worker audit metrics to preserve
  // legitimate media/control-only pages even when their visible text is short.
  const bodyMatch = source.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i);
  let body = bodyMatch ? bodyMatch[1] : source.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, '');
  body = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39);/gi, 'x')
    .replace(/\s+/g, ' ')
    .trim();
  if (body.length > 0) return true;
  const visibleMarkup = (bodyMatch ? bodyMatch[1] : source)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, '')
    .trim();
  if (/<(?:img|video|audio|canvas|svg|iframe|input|select|textarea|button|form|object|embed)\b/i.test(visibleMarkup)) return true;
  if (!visibleMarkup) return false;
  return Number(audit.textLength) > 0 || Number(audit.controls) > 0 || Number(audit.media) > 0 ||
    Number(audit.iframes) > 0 || Number(audit.links) > 0 || Number(audit.forms) > 0;
}

function safeGoogleSearchQuery(sourceUrl, landedUrl) {
  for (const raw of [sourceUrl, landedUrl]) {
    try {
      const u = new URL(String(raw || ''));
      if (!/(^|\.)google\.[^/]+$/i.test(u.hostname)) continue;
      if (/^\/search\/?$/i.test(u.pathname)) {
        const q = String(u.searchParams.get('q') || '').trim();
        if (q && !/^EgQ[A-Za-z0-9_-]{12,}$/.test(q)) return q;
      }
      if (/^\/sorry(?:\/|$)/i.test(u.pathname)) {
        const continuation = u.searchParams.get('continue');
        if (continuation) {
          try {
            const c = new URL(continuation, 'https://www.google.com');
            if (/^\/search\/?$/i.test(c.pathname)) {
              const q = String(c.searchParams.get('q') || '').trim();
              if (q && !/^EgQ[A-Za-z0-9_-]{12,}$/.test(q)) return q;
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
  return '';
}

function isBingUrl(value) {
  try { const h = new URL(String(value || '')).hostname.toLowerCase(); return h === 'bing.com' || h.endsWith('.bing.com'); } catch (_) { return false; }
}

function sanitizeHtml(html, baseUrl) {
  let out = String(html || '');
  if (out.length > MAX_HTML_BYTES) {
    out = out.slice(0, MAX_HTML_BYTES) + '<!-- truncated -->';
  }
  // Remove scripts, iframes, objects, event handlers, javascript: URLs
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '');
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '');
  out = out.replace(/<object\b[^>]*>[\s\S]*?<\/object>/gi, '');
  out = out.replace(/<embed\b[^>]*>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*(['"]).*?\1/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '');
  out = out.replace(/(href|src|action)\s*=\s*(['"])\s*javascript:[^'"]*\2/gi, '$1=$2#$2');
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*['"]?refresh['"]?[^>]*>/gi, '');
  // Do not turn empty/blocked responses into a non-empty CSS-only document.
  if (!hasRenderableContent(out)) return '';
  // Ensure base for relative assets (images/css from origin — may still be blocked by mixed content)
  if (baseUrl && !/<base\s/i.test(out)) {
    const baseTag = '<base href="' + String(baseUrl).replace(/"/g, '&quot;') + '">';
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + baseTag);
    else out = baseTag + out;
  }
  // Ensure a mobile viewport and a conservative responsive layout in the Bridge.
  // This changes only the sanitized display copy, never the live engine DOM.
  if (!/<meta[^>]+name=[\"']viewport[\"']/i.test(out)) {
    const viewport = '<meta name=\"viewport\" content=\"width=device-width,initial-scale=1,viewport-fit=cover\">';
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, m => m + viewport);
    else out = viewport + out;
  }
  const bridgeCss = '<style id=\"sh-bridge-css\">'
    + '[data-sh-id]{cursor:pointer;}a[data-sh-id]{color:#1558d6}'
    + 'html{width:100%!important;max-width:100vw!important;-webkit-text-size-adjust:100%;overflow-wrap:anywhere}'
    + 'body{width:auto!important;min-width:0!important;max-width:100%!important;margin:0!important;overflow-x:auto!important}'
    + 'img,video,iframe,svg,canvas,table{max-width:100%!important}img,video,iframe{height:auto}iframe{width:100%;aspect-ratio:16/9}'
    + '*,*:before,*:after{box-sizing:border-box}input,select,textarea,button{max-width:100%;font-size:16px}'
    + '@media(max-width:600px){body{font-size:16px!important;line-height:1.45}main,article,section,[role=main],.container,.content,.wrapper{max-width:100%!important;min-width:0!important}pre,code{white-space:pre-wrap;overflow-wrap:anywhere}table{display:block;overflow-x:auto}}'
    + (isBingUrl(baseUrl) ? '#b_header,#b_content,#b_results,#b_context,#b_footer,#b_tween{max-width:100%!important;width:auto!important;min-width:0!important}#b_header{position:relative!important}#b_content{padding:8px 12px!important}#b_results{margin:0!important;padding:0!important}li.b_algo{padding:14px 0!important;margin:0!important;border-bottom:1px solid #d9e0e8!important;overflow-wrap:anywhere}.b_algo h2,.b_title{font-size:18px!important;line-height:1.35!important}.b_caption,.b_snippet,.b_algo p{font-size:14px!important;line-height:1.5!important;overflow-wrap:anywhere}#sb_form,#sb_form_q,#sb_form_go{max-width:100%!important}#sb_form_q{width:100%!important;min-width:0!important}#b_header .b_searchboxForm{width:100%!important;max-width:100%!important}#b_header .b_searchbox{font-size:16px!important}#b_results img,#b_context img{max-width:100%!important;height:auto!important}@media(max-width:600px){#b_header{padding:8px!important}#b_content{padding:8px 10px!important}#b_results{width:100%!important}li.b_algo{padding:12px 0!important}.b_algo h2,.b_title{font-size:17px!important}#b_context{display:none!important}}' : '')
    + '</style>';
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, bridgeCss + '</head>');
  else out = bridgeCss + out;
  return out;
}

/** Assign data-sh-id to interactive elements; build server-side map. */

/** When sanitized DOM is empty/black, show Playwright screenshot + login help + YouTube embeds. */
function buildHybridView(session, content) {
  const url = content.url || session.url || '';
  const title = content.title || session.title || 'Page';
  const shot = content.screenshot || session.screenshot || '';
  const yt = content.youtubeIds || session.youtubeIds || [];
  const textLen = content.textLen || 0;
  const mapCount = content.mapCount || 0;
  let body = content.html || session.html || '';
  // Re-sanitize raw Chromium snapshots before returning them to the same-origin
  // viewport; the generated YouTube wrapper below is the only intentional iframe.
  const safeBody = sanitizeHtml(body, url);
  if (safeBody) body = safeBody;
  const hasInteractiveDom = Number(content.mapCount || mapCount) > 0 && hasRenderableContent(body);
  const thin = !hasRenderableContent(body) || (textLen < 40 && !hasInteractiveDom);
  const isAuth = /accounts\.google|login|signin|oauth/i.test(url) || content.hasPassword || content.hasEmail;

  // Preserve the live DOM controls for sign-in. Screenshot-only views cannot
  // receive Playwright bridge input/click events and falsely suggest that login
  // is impossible inside this browser.
  if (isAuth && hasRenderableContent(body)) {
    const note = '<div class="sh-login-note" style="padding:10px 14px;background:#eef4ff;color:#172554;font:14px system-ui;border-bottom:1px solid #c7d2fe">Sign-in page · enter credentials only in the form below. The AI agent will not read or request passwords or OTP codes.</div>';
    return body.replace(/<body([^>]*)>/i, '<body$1>' + note);
  }

  if (yt.length) {
    const cards = yt.map((id) => {
      const emb = 'https://www.youtube.com/embed/' + id + '?rel=0';
      return '<div class="yt"><iframe src="' + emb + '" title="YouTube video player" referrerpolicy="strict-origin-when-cross-origin" allow="accelerometer;autoplay;clipboard-write;encrypted-media;gyroscope;picture-in-picture;web-share" allowfullscreen loading="lazy"></iframe>'
        + '<p><a href="https://www.youtube.com/watch?v=' + id + '" target="_blank" rel="noopener">Open video ↗</a></p></div>';
    }).join('');
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/</g,'')}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff}
.yt{margin:12px;max-width:720px} iframe{width:100%;aspect-ratio:16/9;border:0;border-radius:12px}
a{color:#3ea6ff}
.bar{padding:12px 16px;background:#212121;font-size:14px}
</style></head><body>
<div class="bar">YouTube via engine · ${yt.length} video(s) · <a href="${url.replace(/"/g,'&quot;')}" target="_blank" rel="noopener">Open page ↗</a></div>
${cards}
</body></html>`;
  }

  if (thin && shot) {
    const isLogin = /accounts\.google|\/login|signin|oauth/i.test(url) || content.hasPassword;
    const tip = isLogin
      ? '<p><strong>Sign-in page</strong> — type email/password in the fields on the image area if visible, or use <a href="' + url.replace(/"/g,'&quot;') + '" target="_blank" rel="noopener">Open ↗</a>. Never send passwords to AI.</p>'
      : '<p>Page shell is mostly script-driven. Screenshot from Chromium engine. Prefer <a href="' + url.replace(/"/g,'&quot;') + '" target="_blank" rel="noopener">Open ↗</a> for full UI.</p>';
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/</g,'')}</title>
<style>
body{margin:0;font-family:system-ui,sans-serif;background:#111;color:#e8eaed}
.bar{padding:12px 16px;background:#1a1a1a;border-bottom:1px solid #333;font-size:14px;line-height:1.45}
img{display:block;width:100%;height:auto}
a{color:#8eb6ff}
</style></head><body>
<div class="bar">${tip}<div style="opacity:.7;font-size:12px;margin-top:6px;word-break:break-all">${url.replace(/</g,'')}</div></div>
<img src="${shot}" alt="Engine screenshot"/>
</body></html>`;
  }

  if (thin) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title.replace(/</g,'')}</title>
<style>body{font-family:system-ui;background:#0f1115;color:#e8eaed;padding:24px}a{color:#8eb6ff}</style>
</head><body>
<h1>Page needs full browser UI</h1>
<p>Chromium loaded the page but the safe snapshot is empty (common for Google login / heavy SPAs).</p>
<p><a href="${url.replace(/"/g,'&quot;')}" target="_blank" rel="noopener">Open in system browser ↗</a></p>
</body></html>`;
  }
  return body;
}


function annotateInteractive(html) {
  const map = {};
  let n = 0;
  const out = String(html || '').replace(
    /<(a|button|input|select|textarea|form)(\s[^>]*)?>/gi,
    (full, tag, attrs = '') => {
      n += 1;
      const id = 'e' + n;
      let href = null;
      const hm = attrs.match(/\bhref\s*=\s*(['"])(.*?)\1/i);
      if (hm) href = hm[2];
      let type = null;
      const tm = attrs.match(/\btype\s*=\s*(['"])(.*?)\1/i);
      if (tm) type = tm[2];
      const existing = attrs.match(/\bdata-sh-id\s*=\s*(['"])(.*?)\1/i);
      const elementId = existing ? existing[2] : id;
      map[elementId] = { tag: tag.toLowerCase(), href, type };
      if (existing) return full;
      return '<' + tag + ' data-sh-id="' + elementId + '"' + attrs + '>';
    }
  );
  return { html: out, map, mapCount: n };
}

async function fetchProxyHtml(url) {
  const { assertPublicHttpUrl } = require('../frame-proxy');
  await assertPublicHttpUrl(url);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 25000);
  try {
    const res = await fetch(url, {
      signal: ac.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml'
      }
    });
    const ct = res.headers.get('content-type') || '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_HTML_BYTES) {
      return { ok: false, error: 'too_large', status: res.status };
    }
    let html = buf.toString('utf8');
    // charset best-effort
    return {
      ok: true,
      status: res.status,
      finalUrl: res.url || url,
      html,
      contentType: ct
    };
  } finally {
    clearTimeout(timer);
  }
}

async function destroySession(id) {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  if (s.pwSessionId) {
    try { await playwrightEngine.closeSession(s.pwSessionId); } catch (_) {}
  }
  if (s.webkitSessionId) {
    try { await webkitManager.closeSession(s.webkitSessionId); } catch (_) {}
  }
}

async function createSession(meta = {}) {
  gc();
  if (sessions.size >= MAX_SESSIONS) {
    // drop oldest
    const oldest = [...sessions.entries()].sort((a, b) => a[1].touched - b[1].touched)[0];
    if (oldest) await destroySession(oldest[0]);
  }
  const id = sid();
  const tok = token();
  const session = {
    id,
    token: tok,
    backend: 'none',
    webkitSessionId: null,
    url: '',
    title: '',
    loading: false,
    error: null,
    html: '',
    map: {},
    audit: {},
    created: Date.now(),
    touched: Date.now(),
    clientKey: meta.clientKey || 'anon'
  };

  // Explicitly enabled by the shipped Docker image. Keep opt-in semantics for direct/local test runs.
  // Proxy remains a fallback for worker failures and sites that cannot be represented safely.
  // Prefer Playwright Chromium (full JS + cookies). WebKit optional legacy.
  // PROXY used only when engines unavailable.
  session.pwSessionId = null;
  let engineReady = false;
  if (process.env.SOLOHOST_PLAYWRIGHT !== '0') {
    try {
      const st = await playwrightEngine.status();
      if (st && st.ready) {
        const created = await playwrightEngine.createSession();
        session.pwSessionId = created.sessionId;
        session.backend = 'playwright';
        engineReady = true;
        appLog.log('info', 'bridge.playwright_session', { id: created.sessionId });
      } else {
        appLog.log('info', 'bridge.playwright_unavailable', { reason: st && (st.reason || st.error) });
      }
    } catch (e) {
      appLog.log('warn', 'bridge.playwright_fail', { error: String(e.message || e).slice(0, 200) });
    }
  }
  if (!engineReady && process.env.SOLOHOST_WEBKIT_BRIDGE === '1' && Date.now() >= webkitCooldownUntil) {
    try {
      const st = await webkitManager.status();
      if (st && st.ready) {
        const created = await webkitManager.createSession();
        session.webkitSessionId = created.sessionId;
        session.backend = 'webkit';
        engineReady = true;
      }
    } catch (e) {
      webkitFailStreak += 1;
      webkitCooldownUntil = Date.now() + 10 * 60 * 1000;
      appLog.log('info', 'bridge.webkit_unavailable', { error: String(e.message || e).slice(0, 200) });
    }
  }
  if (session.backend === 'none') session.backend = 'proxy';

  sessions.set(id, session);
  appLog.log('info', 'bridge.session_create', { id, backend: session.backend });
  return {
    sessionId: id,
    token: tok,
    backend: session.backend,
    created: true
  };
}

function authSession(id, tok) {
  const s = sessions.get(id);
  if (!s) return null;
  if (!tok || typeof tok !== 'string' || !s.token) return null;
  try {
    const a = Buffer.from(tok);
    const b = Buffer.from(s.token);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  s.touched = Date.now();
  return s;
}

async function navigateInternal(session, url) {
  session.loading = true;
  session.error = null;
  session.url = url;
  // Never let stale content from the previous page masquerade as a successful load.
  session.html = '';
  session.map = {};
  session.audit = {};
  session.title = '';

  // Recover WebKit after a transient fallback instead of pinning this tab to
  // proxy mode forever. Create a fresh worker session if the old one was lost.
  if (process.env.SOLOHOST_WEBKIT_BRIDGE === '1' && session.backend === 'proxy' && Date.now() >= webkitCooldownUntil) {
    try {
      const st = await webkitManager.status();
      if (st && st.ready) {
        if (!session.webkitSessionId) {
          const fresh = await webkitManager.createSession();
          session.webkitSessionId = fresh.sessionId;
        }
        session.backend = 'webkit';
      }
    } catch (recoveryError) {
      appLog.log('info', 'bridge.webkit_recovery_deferred', { error: String(recoveryError.message || recoveryError).slice(0, 160) });
    }
  }

  if (session.backend === 'playwright' && session.pwSessionId) {
    try {
      const out = await playwrightEngine.navigate(session.pwSessionId, url);
      session.url = out.url || url;
      session.title = out.title || '';
      session.error = out.error || null;
      session.loading = false;
      const content = await playwrightEngine.getContent(session.pwSessionId);
      // A Google /sorry/ response is an upstream verification/block, not a renderer bug.
      // Do not try to defeat it with UA changes or engine cycling; offer transparent search fallback.
      const engineUrl = String(content.url || out.url || url);
      const engineHtml = String(content.html || '');
      const googleLoginRejected = /(^|\.)accounts\.google\.com$/i.test((() => { try { return new URL(engineUrl).hostname; } catch (_) { return ''; } })())
        && /\/signin\/rejected|couldn.t sign you in|couldn't sign you in|browser or app may not be secure/i.test(engineUrl + ' ' + engineHtml);
      if (googleLoginRejected) {
        appLog.log('warn', 'bridge.google_login_rejected', { host: 'accounts.google.com', guidance: 'use_system_browser_if_needed' });
      }
      const googleBlocked = /(^|\.)google\.[^/]+\/sorry(?:\/|$)/i.test(engineUrl)
        || /unusual traffic from your computer network|our systems have detected unusual traffic|sorry\s*\(/i.test(engineHtml);
      if (googleBlocked && /google\./i.test(engineUrl)) {
        const query = safeGoogleSearchQuery(url, engineUrl);
        if (query) {
          const fallbackUrl = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
          try {
            const alt = await fetchProxyHtml(fallbackUrl);
            if (alt.ok && alt.html) {
              const banner = '<div style=\"padding:10px 12px;background:#fff7d6;color:#654d00;border-bottom:1px solid #e8d58a;font:14px system-ui\">Google yêu cầu xác minh cho kết nối này. Đang hiển thị kết quả DuckDuckGo thay thế; đây không phải kết quả Google. <a href=\"' + fallbackUrl + '\">Mở DuckDuckGo</a></div>';
              const rawAlt = /<body[^>]*>/i.test(alt.html) ? alt.html.replace(/<body[^>]*>/i, m => m + banner) : banner + alt.html;
              const cleanedAlt = sanitizeHtml(rawAlt, alt.finalUrl || fallbackUrl);
              const annAlt = annotateInteractive(cleanedAlt);
              session.url = alt.finalUrl || fallbackUrl;
              session.title = 'Search results — DuckDuckGo fallback';
              session.html = annAlt.html;
              session.map = annAlt.map;
              session.loading = false;
              session.error = null;
              appLog.log('warn', 'bridge.google_search_fallback', { queryLength: query.length, source: 'google_verification', target: 'duckduckgo' });
              return publicState(session, true);
            }
          } catch (fallbackError) {
            appLog.log('warn', 'bridge.google_fallback_failed', { error: String(fallbackError.message || fallbackError).slice(0, 160) });
          }
        }
        session.url = engineUrl;
        session.title = 'Google verification required';
        session.html = '<!doctype html><html><head><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"></head><body style=\"font:16px system-ui;padding:16px\"><h2>Google yêu cầu xác minh</h2><p>Đây là phản hồi từ Google, không phải lỗi hiển thị của trình duyệt. Hãy thử lại sau hoặc dùng công cụ tìm kiếm thay thế.</p><p><a href=\"https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query) + '\">Tìm bằng DuckDuckGo</a></p><p><a href=\"' + engineUrl.replace(/\"/g, '&quot;') + '\">Mở trang Google ↗</a></p></body></html>';
        session.map = {};
        session.loading = false;
        appLog.log('warn', 'bridge.google_verification_required', { url: engineUrl.slice(0, 220) });
        return publicState(session, true);
      }
      session.screenshot = content.screenshot || null;
      session.youtubeIds = content.youtubeIds || [];
      session.textLen = content.textLen || 0;
      let html = content.html || '';
      const ann = annotateInteractive(sanitizeHtml(html, session.url) || html);
      session.html = ann.html;
      session.map = ann.map;
      session.title = content.title || session.title;
      session.url = content.url || session.url;
      // Prefer hybrid view (screenshot / youtube embeds) when DOM is thin — do NOT fall to proxy (black/wrong)
      if (!hasRenderableContent(session.html) || (content.textLen || 0) < 40 || session.screenshot || (session.youtubeIds && session.youtubeIds.length)) {
        session.html = buildHybridView(session, content);
        session.map = ann.map;
        appLog.log('info', 'bridge.playwright_hybrid', {
          url: String(session.url).slice(0, 200),
          textLen: content.textLen,
          shot: !!session.screenshot,
          yt: (session.youtubeIds || []).length
        });
        return publicState(session, true);
      }
      return publicState(session, true);
    } catch (e) {
      appLog.log('warn', 'bridge.playwright_nav_fail', { error: e.message });
      session.backend = 'proxy';
    }
  }

  if (session.backend === 'webkit' && session.webkitSessionId) {
    try {
      const out = await webkitManager.navigate(session.webkitSessionId, url);
      session.url = out.url || url;
      session.title = out.title || '';
      session.error = out.error || null;
      session.loading = false;
      // pull content
      const content = await webkitManager.request('session.getContent', { sessionId: session.webkitSessionId });
      let html = content.html || '';
      session.audit = content.audit || {};
      session.scrollX = Number(content.scrollX) || 0;
      session.scrollY = Number(content.scrollY) || 0;
      const cleaned = sanitizeHtml(html, session.url);
      if (!hasRenderableContent(cleaned, session.audit)) throw new Error('empty_content');
      const ann = annotateInteractive(cleaned);
      session.html = ann.html;
      session.map = ann.map;
      session.title = content.title || session.title;
      session.url = content.url || session.url;
      appLog.log('info', 'bridge.content_audit', { domain: (() => { try { return new URL(session.url).hostname; } catch (_) { return ''; } })(), backend: session.backend, ...(session.audit || {}), mapCount: Object.keys(session.map || {}).length });
      return publicState(session, true);
    } catch (e) {
      const failure = String(e && e.message || e);
      appLog.log('warn', 'bridge.webkit_nav_fail', { error: failure, url: (() => { try { return new URL(url).hostname; } catch (_) { return ''; } })() });
      session.backend = 'proxy';
      webkitFailStreak += 1;
      // A page-level failure must not disable WebKit for ten minutes. Only IPC
      // timeouts/worker loss get a short cooldown; navigation can recover later.
      const workerFailure = /ipc_timeout|worker_exited|worker_reset_after_timeout|worker_stdin_closed|engine_unavailable/i.test(failure);
      webkitCooldownUntil = workerFailure ? Date.now() + 45000 : Date.now() + 5000;
      if (/ipc_timeout|worker_exited|worker_reset_after_timeout/.test(failure)) {
        session.webkitSessionId = null; // worker may have been restarted; old IDs are stale
      }
    }
  }

  // Proxy-backed bridge
  try {
    const doc = await fetchProxyHtml(url);
    if (!doc.ok) {
      session.error = doc.error || 'fetch_failed';
      session.loading = false;
      return publicState(session, true);
    }
    session.url = doc.finalUrl || url;
    const cleaned = sanitizeHtml(doc.html, session.url);
    if (!hasRenderableContent(cleaned)) {
      session.error = 'empty_content';
      session.loading = false;
      appLog.log('warn', 'bridge.empty_content', {
        domain: (() => { try { return new URL(session.url).hostname; } catch (_) { return ''; } })(),
        status: doc.status, contentType: doc.contentType || '', bytes: Buffer.byteLength(String(doc.html || ''), 'utf8')
      });
      return publicState(session, true);
    }
    const ann = annotateInteractive(cleaned);
    session.html = ann.html;
    session.map = ann.map;
    // title from tags
    const tm = doc.html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    session.title = tm ? tm[1].replace(/\s+/g, ' ').trim().slice(0, 200) : session.url;
    session.loading = false;
    return publicState(session, true);
  } catch (e) {
    session.error = e.message || String(e);
    session.loading = false;
    return publicState(session, true);
  }
}

// One WebKit worker processes commands synchronously. Serialize navigations per
// browser session so rapid clicks/reloads cannot queue stale page loads behind
// one another. Identical in-flight navigations share the same result.
function navigate(session, url) {
  const target = String(url || '').trim();
  const inFlight = session.navigationInFlight;
  if (inFlight && inFlight.url === target) return inFlight.promise;
  const prior = session.navigationTail || Promise.resolve();
  const promise = prior.catch(() => {}).then(() => navigateInternal(session, target));
  session.navigationTail = promise;
  session.navigationInFlight = { url: target, promise };
  promise.finally(() => {
    if (session.navigationInFlight && session.navigationInFlight.promise === promise) {
      session.navigationInFlight = null;
    }
  }).catch(() => {});
  return promise;
}

function publicState(session, includeFlags) {
  const o = {
    sessionId: session.id,
    url: session.url,
    title: session.title,
    loading: session.loading,
    error: session.error,
    backend: session.backend,
    mapCount: Object.keys(session.map || {}).length,
    audit: session.audit || {}
  };
  if (includeFlags) {
    o.hasContent = hasRenderableContent(session.html, session.audit) || !!session.screenshot;
    o.hasScreenshot = !!session.screenshot;
  }
  return o;
}

function getContent(session) {
  return {
    sessionId: session.id,
    url: session.url,
    title: session.title,
    html: session.html || '',
    backend: session.backend,
    error: session.error,
    mapCount: Object.keys(session.map || {}).length,
    audit: session.audit || {}
  };
}

async function dispatchEvent(session, event) {
  const type = String(event.type || '').toLowerCase();
  const ALLOWED = new Set(['click', 'input', 'change', 'submit', 'scroll', 'navigate']);
  if (!ALLOWED.has(type)) return { ok: false, error: 'unsupported_event' };
  const targetId = event.targetId ? String(event.targetId).replace(/[^a-zA-Z0-9]/g, '') : '';

  if (session.backend === 'playwright' && session.pwSessionId) {
    try {
      const out = await playwrightEngine.dispatchEvent(session.pwSessionId, event);
      try {
        const content = await playwrightEngine.getContent(session.pwSessionId);
        session.screenshot = content.screenshot || null;
        session.youtubeIds = content.youtubeIds || [];
        const ann = annotateInteractive(sanitizeHtml(content.html || '', content.url || session.url) || content.html || '');
        session.html = ann.html;
        session.map = ann.map;
        session.url = content.url || out.url || session.url;
        session.title = content.title || out.title || session.title;
        if (!hasRenderableContent(session.html) || (content.textLen || 0) < 40 || session.screenshot || (session.youtubeIds || []).length) {
          session.html = buildHybridView(session, content);
        }
      } catch (_) {
        session.url = out.url || session.url;
      }
      return { ok: true, ...publicState(session, true), result: out.result };
    } catch (e) {
      appLog.log('warn', 'bridge.pw_event_fail', { error: e.message });
    }
  }

  if (session.backend === 'webkit' && session.webkitSessionId) {
    try {
      const out = await webkitManager.request('session.dispatchEvent', {
        sessionId: session.webkitSessionId,
        type,
        targetId,
        value: event.value,
        scrollX: event.scrollX,
        scrollY: event.scrollY,
        checked: event.checked,
        selectedIndex: event.selectedIndex,
        url: event.url
      });
      // refresh content after interaction
      try {
        const content = await webkitManager.request('session.getContent', { sessionId: session.webkitSessionId });
        const ann = annotateInteractive(sanitizeHtml(content.html || '', content.url || session.url));
        session.scrollX = Number(content.scrollX) || 0;
        session.scrollY = Number(content.scrollY) || 0;
        session.html = ann.html;
        session.map = ann.map;
        session.url = content.url || out.url || session.url;
        session.title = content.title || out.title || session.title;
      } catch (_) {
        session.url = out.url || session.url;
        session.title = out.title || session.title;
      }
      return { ok: true, ...publicState(session, true), result: out.result };
    } catch (e) {
      appLog.log('warn', 'bridge.wk_event_fail', { error: e.message });
      // fall through to map-based
    }
  }

  // Map-based interaction (proxy backend)
  if (type === 'click' && targetId) {
    const meta = session.map[targetId];
    if (!meta) return { ok: false, error: 'target_not_found' };
    if (meta.tag === 'a' && meta.href) {
      let next = meta.href;
      try { next = new URL(meta.href, session.url).href; } catch (_) {}
      return { ok: true, ...(await navigate(session, next)) };
    }
    // non-link click: no-op in proxy mode
    return { ok: true, ...publicState(session, true), result: { ok: true, limited: true } };
  }
  if (type === 'submit' && targetId) {
    // limited: cannot execute complex JS forms without WebKit
    return { ok: true, ...publicState(session, true), result: { ok: true, limited: true, note: 'form_needs_webkit' } };
  }
  if (type === 'navigate' && event.url) {
    return { ok: true, ...(await navigate(session, String(event.url))) };
  }
  if (type === 'scroll') {
    return { ok: true, ...publicState(session, true), result: { ok: true } };
  }
  if (type === 'input' || type === 'change') {
    return { ok: true, ...publicState(session, true), result: { ok: true, limited: session.backend !== 'webkit' && session.backend !== 'playwright' && session.backend !== 'playwright' } };
  }
  return { ok: false, error: 'unsupported_event' };
}

module.exports = {
  createSession,
  authSession,
  navigate,
  getContent,
  dispatchEvent,
  destroySession,
  publicState,
  rateOk,
  sanitizeHtml,
  hasRenderableContent,
  annotateInteractive,
  buildHybridView,
  MAX_HTML_BYTES
};
