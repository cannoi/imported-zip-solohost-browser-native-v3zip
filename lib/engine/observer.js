'use strict';
/**
 * Live Chromium observation for Browser Agent (page.evaluate / CDP).
 * Does NOT parse sanitized Bridge HTML.
 */

const crypto = require('crypto');

const OBSERVE_JS = `(() => {
  const MAX = 120;
  const SECRET_RE = /password|passcode|otp|cvv|cvc|credit.?card|mật khẩu|mat khau|mã xác minh/i;
  const abs = (h) => { try { return new URL(h, location.href).href; } catch { return ''; } };
  const vis = (el) => {
    try {
      if (!el || el.nodeType !== 1) return false;
      if (typeof el.checkVisibility === 'function') {
        return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
      }
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) return false;
      const r = el.getBoundingClientRect();
      return r.width > 1 && r.height > 1;
    } catch { return false; }
  };
  const inView = (el) => {
    try {
      const r = el.getBoundingClientRect();
      const vh = window.innerHeight || 800, vw = window.innerWidth || 1200;
      return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    } catch { return false; }
  };
  const accName = (el) => {
    const a = el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') ||
      el.getAttribute('name') || el.getAttribute('alt') || '';
    let t = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim();
    if (t.length > 90) t = t.slice(0, 90);
    return (a || t || el.getAttribute('value') || '').toString().slice(0, 120);
  };
  const isSecret = (el) => {
    const bits = [el.type, el.name, el.id, el.placeholder, el.autocomplete, el.getAttribute('aria-label')].join(' ');
    return SECRET_RE.test(bits) || String(el.type || '').toLowerCase() === 'password';
  };
  const isInteractive = (el) => {
    if (!el || el.nodeType !== 1) return false;
    const tag = (el.tagName || '').toLowerCase();
    if (['script','style','noscript','meta','link','head'].includes(tag)) return false;
    if (tag === 'a' && el.hasAttribute('href')) return true;
    if (['button','input','textarea','select','summary'].includes(tag)) return true;
    if (el.isContentEditable) return true;
    const role = (el.getAttribute('role') || '').toLowerCase();
    if (['button','link','tab','checkbox','radio','switch','option','menuitem','textbox','combobox','searchbox'].includes(role)) return true;
    try {
      const st = getComputedStyle(el);
      if (st.cursor === 'pointer' && (el.onclick || el.getAttribute('onclick') || role)) return true;
    } catch {}
    return false;
  };
  const walk = (root, out, depth) => {
    if (!root || depth > 24 || out.length >= MAX * 2) return;
    const nodes = root.querySelectorAll ? root.querySelectorAll('*') : [];
    for (const el of nodes) {
      if (out.length >= MAX * 2) break;
      try {
        if (el.shadowRoot) walk(el.shadowRoot, out, depth + 1);
      } catch {}
      if (!isInteractive(el)) continue;
      if (!vis(el)) continue;
      out.push(el);
    }
  };
  const collected = [];
  walk(document, collected, 0);
  // same-origin iframes
  try {
    document.querySelectorAll('iframe').forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc) walk(doc, collected, 1);
      } catch {}
    });
  } catch {}

  // rank: in viewport + main first
  const main = document.querySelector('main,[role=main],article,#content,.content') || document.body;
  const scored = collected.map((el, i) => {
    let score = 0;
    if (inView(el)) score += 100;
    try { if (main && main.contains(el)) score += 40; } catch {}
    const tag = (el.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea') score += 20;
    if (tag === 'button' || (el.getAttribute('role') || '') === 'button') score += 10;
    const r = el.getBoundingClientRect();
    return { el, score, top: r.top, i };
  });
  scored.sort((a, b) => b.score - a.score || a.top - b.top || a.i - b.i);

  // clear old ids then assign
  document.querySelectorAll('[data-sh-id]').forEach((el) => { try { el.removeAttribute('data-sh-id'); } catch {} });
  const elements = [];
  const targets = {};
  let n = 0;
  for (const item of scored) {
    if (n >= MAX) break;
    const el = item.el;
    n += 1;
    const id = 'e' + n;
    try { el.setAttribute('data-sh-id', id); } catch {}
    const tag = (el.tagName || '').toLowerCase();
    const type = String(el.type || (tag === 'input' ? 'text' : '')).toLowerCase();
    if (type === 'hidden') { n -= 1; continue; }
    const r = el.getBoundingClientRect();
    const secret = isSecret(el);
    const e = {
      id: n,
      tag,
      role: (el.getAttribute('role') || '') || undefined,
      label: (secret ? '[secret field - never fill] ' : '') + accName(el),
      visible: true,
      inViewport: inView(el),
      bbox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true')
    };
    if (tag === 'input') e.type = type;
    if (tag === 'a') e.href = abs(el.getAttribute('href') || '');
    if (tag === 'input' || tag === 'textarea' || el.isContentEditable) {
      e.value = secret ? '' : String(el.value != null ? el.value : (el.textContent || '')).slice(0, 80);
    }
    if (type === 'checkbox' || type === 'radio') e.checked = !!el.checked;
    if (tag === 'select') {
      e.value = String(el.value || '').slice(0, 80);
      e.options = Array.from(el.options || []).slice(0, 12).map((o) => String(o.text || o.value || '').slice(0, 40));
    }
    elements.push(e);
    targets[n] = id;
  }

  // readable text without nav/footer noise
  let textRoot = document.querySelector('article,main,[role=main]') || document.body;
  let text = '';
  try {
    const clone = textRoot.cloneNode(true);
    clone.querySelectorAll('nav,footer,script,style,noscript,svg,iframe,[role=navigation]').forEach((n) => n.remove());
    text = (clone.innerText || '').replace(/\\s+/g, ' ').trim();
  } catch {
    text = (document.body && document.body.innerText || '').replace(/\\s+/g, ' ').trim();
  }

  const pageState = [];
  const bodyText = (document.body && document.body.innerText || '').toLowerCase();
  if (/captcha|recaptcha|hcaptcha|verify you are human|unusual traffic/.test(bodyText)) pageState.push('captcha_or_challenge');
  if (/accept (all )?cookies|cookie (policy|consent)|we use cookies/.test(bodyText)) pageState.push('cookie_banner');
  if (document.querySelector('[role=dialog],dialog,.modal')) pageState.push('dialog');
  if (!text || text.length < 40) pageState.push('sparse_or_empty');

  return {
    url: location.href,
    title: document.title || '',
    text: text.slice(0, 12000),
    textTotal: text.length,
    elements,
    targets,
    scroll: {
      y: Math.round(window.scrollY || document.documentElement.scrollTop || 0),
      height: Math.round(Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement ? document.documentElement.scrollHeight : 0)),
      viewport: Math.round(window.innerHeight || 0)
    },
    pageState,
    remainingBelow: Math.max(0, collected.length - elements.length)
  };
})()`;

async function observeLive(playwrightEngine, pwSessionId, opts = {}) {
  if (!playwrightEngine || !pwSessionId) return null;
  const observationId = crypto.randomBytes(8).toString('hex');
  const offset = Math.max(0, Number(opts.textOffset) || 0);
  try {
    const raw = await playwrightEngine.evaluate(pwSessionId, OBSERVE_JS);
    if (!raw || typeof raw !== 'object') return null;
    const budget = Math.max(2000, Number(process.env.AGENT_OBS_TOKENS) || 6000);
    // rough token budget: ~4 chars per token
    let text = String(raw.text || '');
    const maxChars = Math.min(text.length, Math.floor(budget * 3));
    text = text.slice(offset, offset + maxChars);
    const elements = Array.isArray(raw.elements) ? raw.elements : [];
    // keep elements within budget (~80 chars each)
    const maxEl = Math.min(elements.length, Math.floor(budget / 50));
    const els = elements.slice(0, maxEl);
    return {
      observationId,
      readable: true,
      live: true,
      url: raw.url || '',
      title: raw.title || '',
      text,
      textOffset: offset,
      textTotal: Number(raw.textTotal) || text.length,
      elements: els,
      targets: raw.targets || {},
      scroll: raw.scroll || { y: 0, height: 0, viewport: 0 },
      pageState: raw.pageState || [],
      remainingBelow: Number(raw.remainingBelow) || 0,
      audit: { controls: els.length, textLength: text.length, media: 0 }
    };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200), observationId };
  }
}

function hashObservation(obs) {
  const key = [
    obs && obs.url,
    obs && obs.title,
    (obs && obs.elements || []).map((e) => e.id + ':' + e.tag + ':' + (e.label || '').slice(0, 40)).join('|'),
    obs && obs.scroll && obs.scroll.y
  ].join('::');
  return crypto.createHash('sha1').update(key).digest('hex').slice(0, 16);
}

module.exports = { observeLive, hashObservation, OBSERVE_JS };
