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
      let html = content.html || '';
      const ann = annotateInteractive(sanitizeHtml(html, session.url));
      // For ENGINE mode keep more interactive markup (already executed in Chromium)
      session.html = ann.html;
      session.map = ann.map;
      session.title = content.title || session.title;
      session.url = content.url || session.url;
      if (!hasRenderableContent(session.html)) {
        appLog.log('warn', 'bridge.playwright_empty', { url: session.url });
        session.backend = 'proxy';
      } else {
        return publicState(session, true);
      }
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
  if (includeFlags) o.hasContent = hasRenderableContent(session.html, session.audit);
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
        const ann = annotateInteractive(sanitizeHtml(content.html || '', content.url || session.url));
        session.html = ann.html;
        session.map = ann.map;
        session.url = content.url || out.url || session.url;
        session.title = content.title || out.title || session.title;
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
  MAX_HTML_BYTES
};
