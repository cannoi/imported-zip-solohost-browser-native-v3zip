'use strict';

/**
 * Interactive DOM Bridge for SoloHost Browser.
 * - Prefer WebKitGTK worker for live DOM + events
 * - Fallback: sanitized HTML from frame-proxy fetch (no site JS in admin origin)
 * - Sessions isolated; token required for events/content
 */

const crypto = require('crypto');
const appLog = require('../app-log');
const { webkitManager } = require('./webkit-manager');

const MAX_HTML_BYTES = Number(process.env.SOLOHOST_BRIDGE_MAX_HTML || 1_500_000);
const MAX_SESSIONS = Number(process.env.SOLOHOST_BRIDGE_MAX_SESSIONS || 6);
const SESSION_TTL_MS = Number(process.env.SOLOHOST_BRIDGE_TTL_MS || 30 * 60 * 1000);
const RATE_PER_MIN = Number(process.env.SOLOHOST_BRIDGE_RATE || 120);

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
  // Ensure base for relative assets (images/css from origin — may still be blocked by mixed content)
  if (baseUrl && !/<base\s/i.test(out)) {
    const baseTag = '<base href="' + String(baseUrl).replace(/"/g, '&quot;') + '">';
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => m + baseTag);
    else out = baseTag + out;
  }
  // Bridge CSS: highlight interactive nodes lightly
  const bridgeCss = '<style id="sh-bridge-css">[data-sh-id]{cursor:pointer;}a[data-sh-id]{color:#1558d6}</style>';
  if (/<\/head>/i.test(out)) out = out.replace(/<\/head>/i, bridgeCss + '</head>');
  else out = bridgeCss + out;
  return out;
}

/** Assign data-sh-id to interactive elements; build server-side map. */
function annotateInteractive(html) {
  const map = {};
  let n = 0;
  const out = String(html || '').replace(
    /<(a|button|input|select|textarea|form)(\s[^>]*)?>/gi,
    (full, tag, attrs = '') => {
      n += 1;
      const id = 'e' + n;
      // skip if already marked
      if (/\bdata-sh-id\s*=/i.test(attrs)) return full;
      let href = null;
      const hm = attrs.match(/\bhref\s*=\s*(['"])(.*?)\1/i);
      if (hm) href = hm[2];
      let type = null;
      const tm = attrs.match(/\btype\s*=\s*(['"])(.*?)\1/i);
      if (tm) type = tm[2];
      map[id] = { tag: tag.toLowerCase(), href, type };
      return '<' + tag + ' data-sh-id="' + id + '"' + attrs + '>';
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
    created: Date.now(),
    touched: Date.now(),
    clientKey: meta.clientKey || 'anon'
  };

  // WebKit bridge is OPT-IN (SOLOHOST_WEBKIT_BRIDGE=1). Default proxy avoids 20–40s hangs.
  const allowWk = process.env.SOLOHOST_WEBKIT_BRIDGE === '1';
  if (!allowWk) {
    session.backend = 'proxy';
  } else if (Date.now() < webkitCooldownUntil) {
    session.backend = 'proxy';
    appLog.log('info', 'bridge.webkit_cooldown', { until: webkitCooldownUntil });
  } else {
    try {
      const st = await webkitManager.status();
      if (st && st.ready) {
        const created = await webkitManager.createSession();
        session.webkitSessionId = created.sessionId;
        session.backend = 'webkit';
        webkitFailStreak = 0;
      }
    } catch (e) {
      webkitFailStreak += 1;
      const msg = String(e.message || e).slice(0, 200);
      appLog.log('info', 'bridge.webkit_unavailable', { error: msg, streak: webkitFailStreak });
      if (webkitFailStreak >= 1 || /max_sessions|engine_unavailable|no_display|timeout/i.test(msg)) {
        webkitCooldownUntil = Date.now() + 10 * 60 * 1000;
        appLog.log('warn', 'bridge.webkit_cooldown_set', { ms: 600000 });
      }
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

async function navigate(session, url) {
  session.loading = true;
  session.error = null;
  session.url = url;

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
      const ann = annotateInteractive(sanitizeHtml(html, session.url));
      session.html = ann.html;
      session.map = ann.map;
      session.title = content.title || session.title;
      session.url = content.url || session.url;
      return publicState(session, true);
    } catch (e) {
      appLog.log('warn', 'bridge.webkit_nav_fail', { error: e.message });
      session.backend = 'proxy';
      webkitFailStreak += 1;
      webkitCooldownUntil = Date.now() + 10 * 60 * 1000;
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
    const ann = annotateInteractive(sanitizeHtml(doc.html, session.url));
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

function publicState(session, includeFlags) {
  const o = {
    sessionId: session.id,
    url: session.url,
    title: session.title,
    loading: session.loading,
    error: session.error,
    backend: session.backend,
    mapCount: Object.keys(session.map || {}).length
  };
  if (includeFlags) o.hasContent = !!(session.html && session.html.length);
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
    mapCount: Object.keys(session.map || {}).length
  };
}

async function dispatchEvent(session, event) {
  const type = String(event.type || '').toLowerCase();
  const ALLOWED = new Set(['click', 'input', 'change', 'submit', 'scroll', 'navigate']);
  if (!ALLOWED.has(type)) return { ok: false, error: 'unsupported_event' };
  const targetId = event.targetId ? String(event.targetId).replace(/[^a-zA-Z0-9]/g, '') : '';

  if (session.backend === 'webkit' && session.webkitSessionId) {
    try {
      const out = await webkitManager.request('session.dispatchEvent', {
        sessionId: session.webkitSessionId,
        type,
        targetId,
        value: event.value,
        scrollX: event.scrollX,
        scrollY: event.scrollY,
        url: event.url
      });
      // refresh content after interaction
      try {
        const content = await webkitManager.request('session.getContent', { sessionId: session.webkitSessionId });
        const ann = annotateInteractive(sanitizeHtml(content.html || '', content.url || session.url));
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
    return { ok: true, ...publicState(session, true), result: { ok: true, limited: session.backend !== 'webkit' } };
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
  annotateInteractive,
  MAX_HTML_BYTES
};
