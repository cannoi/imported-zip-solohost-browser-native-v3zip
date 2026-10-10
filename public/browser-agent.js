'use strict';
/**
 * SoloHost Browser Agent (client side).
 *
 * Observes the page in the same-origin proxy iframe, asks the server planner
 * (POST /api/browser/agent/step) for ONE next action, executes it in the page, repeats until done.
 *
 * Limits (by design, see docs/AGENT.md):
 *  - Can only act on pages the proxy renders same-origin (cross-origin embeds/DIRECT iframes are unreadable).
 *  - Never types into password / card / OTP fields; sensitive clicks need explicit user confirmation.
 *  - Hard step cap, Stop button, repeat-loop detection.
 */
(function () {
  const MAX_STEPS_DEFAULT = 15;
  const TEXT_CHUNK = 3000;
  const MAX_ELEMENTS = 70;
  const SELECTOR = 'a[href],button,input:not([type=hidden]),textarea,select,summary,[role=button],[role=link],[role=tab],[role=menuitem],[onclick]';
  const SENSITIVE_CLICK = /\b(buy|purchase|pay|payment|checkout|place order|order now|delete|remove|unsubscribe|log ?out|sign ?out|send|post|publish|confirm|subscribe|donate|transfer|withdraw)\b|mua ngay|mua hàng|thanh toán|đặt hàng|xóa|xoá|đăng xuất|gửi|đăng bài|xác nhận|chuyển khoản|ủng hộ|đăng ký/i;
  const SECRET_FIELD = /pass(word)?|pwd|otp|one[- ]?time|cvv|cvc|card|credit|iban|ssn|secret|pin\b|mật khẩu|mat khau/i;

  const S = { running: false, stop: false, loads: 0, readOffset: 0, pendingConfirm: null };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frameEl = () => document.getElementById('main-webview');
  const browser = () => window.SoloBrowser || {};

  function installLoadCounter() {
    const f = frameEl();
    if (f && !f.__soloAgentLoad) {
      f.__soloAgentLoad = true;
      f.addEventListener('load', () => { S.loads += 1; });
    }
  }

  /** Same-origin document of the page frame, or null (about:blank / cross-origin). */
  function getDoc() {
    const f = frameEl();
    try {
      const d = f && f.contentDocument;
      if (d && d.body && d.location && d.location.href !== 'about:blank') return d;
    } catch (_) { /* cross-origin */ }
    return null;
  }

  function realUrlOf(href) {
    try {
      const u = new URL(href, location.href);
      if (u.pathname === '/api/proxy' && u.searchParams.get('url')) return u.searchParams.get('url');
      return u.href;
    } catch (_) { return String(href || ''); }
  }

  function currentUrl() {
    const st = browser().state || {};
    if (st.url) return st.url;
    const d = getDoc();
    return d ? realUrlOf(d.location.href) : '';
  }

  function isVisible(el, win) {
    try {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const cs = win.getComputedStyle(el);
      return cs.visibility !== 'hidden' && cs.display !== 'none' && cs.opacity !== '0';
    } catch (_) { return false; }
  }

  function clean(s, n) {
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
    return s.length > n ? s.slice(0, n - 1) + '…' : s;
  }

  function labelOf(el, doc) {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute('type') || '').toLowerCase();
    let txt = '';
    if (tag === 'input' && /^(submit|button|reset)$/.test(type)) txt = el.value || '';
    else if (tag === 'input' || tag === 'textarea' || tag === 'select') {
      txt = el.getAttribute('aria-label') || el.getAttribute('placeholder') || '';
      if (!txt && el.id) {
        try {
          const lab = doc.querySelector('label[for="' + String(el.id).replace(/"/g, '') + '"]');
          if (lab) txt = lab.innerText || lab.textContent || '';
        } catch (_) { /* ignore */ }
      }
      if (!txt) txt = el.getAttribute('title') || el.name || '';
    } else {
      txt = el.innerText || el.textContent || '';
      if (!clean(txt, 5)) {
        txt = el.getAttribute('aria-label') || el.getAttribute('title') || '';
        if (!txt) { const img = el.querySelector && el.querySelector('img[alt]'); if (img) txt = img.getAttribute('alt'); }
      }
    }
    return clean(txt, 90);
  }

  function isSecretField(el) {
    const type = (el.getAttribute('type') || '').toLowerCase();
    if (type === 'password') return true;
    const ac = (el.getAttribute('autocomplete') || '').toLowerCase();
    if (/^(cc-|one-time-code|current-password|new-password)/.test(ac)) return true;
    return SECRET_FIELD.test(String(el.name || '') + ' ' + String(el.id || '') + ' ' + String(el.getAttribute('placeholder') || ''));
  }

  function pageText(doc) {
    let t = '';
    try { t = doc.body.innerText || doc.body.textContent || ''; } catch (_) { /* ignore */ }
    return t.replace(/[ \t\f\v\u00a0]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  }

  /** Build the compact observation sent to the planner. Marks elements with data-sh-agent="id". */
  function observe() {
    installLoadCounter();
    const doc = getDoc();
    if (!doc) return { readable: false, url: currentUrl(), title: '', text: '', elements: [] };
    const win = doc.defaultView;
    doc.querySelectorAll('[data-sh-agent]').forEach((n) => n.removeAttribute('data-sh-agent'));
    const vh = win.innerHeight || 700;
    const vis = [];
    doc.querySelectorAll(SELECTOR).forEach((el) => {
      if (el.disabled && el.tagName !== 'BUTTON') return;
      if (!isVisible(el, win)) return;
      const tag = el.tagName.toLowerCase();
      const label = labelOf(el, doc);
      const hasHref = tag === 'a' && el.getAttribute('href');
      if (!label && tag !== 'input' && tag !== 'textarea' && tag !== 'select') return;
      if (hasHref && /^\s*(javascript:|#\s*$)/i.test(el.getAttribute('href')) && !label) return;
      const r = el.getBoundingClientRect();
      vis.push({ el, tag, label, inView: r.bottom > 0 && r.top < vh });
    });
    const ordered = vis.filter((v) => v.inView).concat(vis.filter((v) => !v.inView)).slice(0, MAX_ELEMENTS);
    const elements = ordered.map((v, i) => {
      const id = i + 1;
      v.el.setAttribute('data-sh-agent', String(id));
      const e = { id, tag: v.tag, label: v.label };
      const type = (v.el.getAttribute('type') || '').toLowerCase();
      if (v.tag === 'input') e.type = type || 'text';
      if (v.tag === 'a') e.href = realUrlOf(v.el.getAttribute('href'));
      if (v.tag === 'input' || v.tag === 'textarea') {
        e.value = isSecretField(v.el) ? '' : clean(v.el.value, 60);
        if (isSecretField(v.el)) e.label = (e.label ? e.label + ' ' : '') + '[secret field - never fill]';
        if (type === 'checkbox' || type === 'radio') e.checked = !!v.el.checked;
      }
      if (v.tag === 'select') {
        e.options = Array.from(v.el.options || []).slice(0, 12).map((o) => clean(o.text || o.value, 40));
        e.value = clean(v.el.value, 60);
      }
      if (v.el.disabled) e.disabled = true;
      return e;
    });
    const full = pageText(doc);
    const off = Math.min(S.readOffset, Math.max(0, full.length - 1));
    let doc_h = 0;
    try { doc_h = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight); } catch (_) { /* ignore */ }
    return {
      readable: true,
      url: currentUrl(),
      title: clean(doc.title, 200),
      text: full.slice(off, off + TEXT_CHUNK),
      textOffset: off,
      textTotal: full.length,
      scroll: { y: Math.round(win.scrollY || 0), height: doc_h, viewport: vh },
      elements
    };
  }

  function elById(id) {
    const doc = getDoc();
    if (!doc) return null;
    return doc.querySelector('[data-sh-agent="' + String(Number(id)) + '"]');
  }

  function setNativeValue(el, value, win) {
    const proto = el.tagName === 'TEXTAREA' ? win.HTMLTextAreaElement.prototype : win.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, value); else el.value = value;
    el.dispatchEvent(new win.Event('input', { bubbles: true }));
    el.dispatchEvent(new win.Event('change', { bubbles: true }));
  }

  function pressEnter(el, win) {
    ['keydown', 'keypress', 'keyup'].forEach((t) => {
      el.dispatchEvent(new win.KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
    });
  }

  function formHasSecret(form) {
    if (!form) return false;
    return Array.from(form.querySelectorAll('input')).some((i) => isSecretField(i));
  }

  /** Does this click/submit need explicit user confirmation? Returns a description or ''. */
  function needsConfirmation(a, el) {
    if (!el) return '';
    const label = labelOf(el, el.ownerDocument);
    const href = el.tagName === 'A' ? realUrlOf(el.getAttribute('href')) : '';
    const form = el.form || (el.closest && el.closest('form'));
    if (a.type === 'click') {
      if (SENSITIVE_CLICK.test(label) || SENSITIVE_CLICK.test(href)) return 'click "' + label + '"';
      const type = (el.getAttribute('type') || '').toLowerCase();
      const submits = (el.tagName === 'BUTTON' && type !== 'button') || (el.tagName === 'INPUT' && type === 'submit');
      if (submits && formHasSecret(form)) return 'submit a form that contains login/payment fields ("' + label + '")';
    }
    if (a.type === 'type' && a.submit && formHasSecret(form)) return 'submit a form that contains login/payment fields';
    return '';
  }

  function describe(a, obs) {
    const byId = {};
    ((obs && obs.elements) || []).forEach((e) => { byId[e.id] = e; });
    const lab = (id) => (byId[id] ? ' "' + byId[id].label + '"' : '');
    switch (a.type) {
      case 'navigate': return 'navigate ' + a.url;
      case 'search': return 'search ' + a.engine + ' "' + a.query + '"';
      case 'click': return 'click [' + a.id + ']' + lab(a.id);
      case 'type': return 'type [' + a.id + ']' + lab(a.id) + ' "' + a.text + '"' + (a.submit ? ' +submit' : '');
      case 'select': return 'select [' + a.id + ']' + lab(a.id) + ' = ' + a.value;
      case 'scroll': return 'scroll ' + a.direction;
      case 'read': return 'read offset ' + a.offset;
      default: return a.type + (a.ms ? ' ' + a.ms + 'ms' : '');
    }
  }

  async function settle(loadsBefore, expectNav) {
    const maxWait = expectNav ? 8000 : 900;
    const t0 = Date.now();
    while (Date.now() - t0 < maxWait && !S.stop) {
      if (S.loads > loadsBefore) break;
      await sleep(100);
    }
    await sleep(S.loads > loadsBefore ? 700 : 250);
  }

  function searchUrl(engine, q) {
    const e = encodeURIComponent(q);
    if (engine === 'youtube') return 'https://www.youtube.com/results?search_query=' + e;
    if (engine === 'ddg') return 'https://html.duckduckgo.com/html/?q=' + e;
    return 'https://www.google.com/search?q=' + e;
  }

  function confirmWith(hooks, text) {
    return new Promise((resolve) => {
      S.pendingConfirm = resolve;
      try {
        hooks.onConfirm(text, (v) => { S.pendingConfirm = null; resolve(!!v); });
      } catch (_) { S.pendingConfirm = null; resolve(false); }
    });
  }

  /** Execute one validated action. Returns { ok, result, navigated }. */
  async function execute(a, hooks) {
    installLoadCounter();
    const before = S.loads;
    const b = browser();
    const doc0 = getDoc();
    const win = doc0 && doc0.defaultView;
    try {
      switch (a.type) {
        case 'navigate': {
          if (!/^https?:\/\//i.test(a.url)) return { ok: false, result: 'FAILED: only http(s) URLs' };
          S.readOffset = 0;
          await b.navigate(a.url, { force: true });
          await settle(before, true);
          return { ok: true, result: 'opened ' + a.url };
        }
        case 'search': {
          S.readOffset = 0;
          await b.navigate(searchUrl(a.engine, a.query), { force: true });
          await settle(before, true);
          return { ok: true, result: 'searched ' + a.engine };
        }
        case 'back':
        case 'forward': {
          S.readOffset = 0;
          const btn = document.getElementById(a.type === 'back' ? 'btn-back' : 'btn-fwd');
          if (!btn) return { ok: false, result: 'FAILED: no ' + a.type + ' button' };
          btn.click();
          await settle(before, true);
          return { ok: true, result: a.type };
        }
        case 'wait': await sleep(Math.min(3000, Math.max(200, a.ms || 1000))); return { ok: true, result: 'waited' };
        case 'read': S.readOffset = Math.max(0, a.offset || 0); return { ok: true, result: 'text window moved to offset ' + S.readOffset };
        case 'scroll': {
          if (!win) return { ok: false, result: 'FAILED: page not readable' };
          const vh = win.innerHeight || 700;
          if (a.direction === 'top') win.scrollTo(0, 0);
          else if (a.direction === 'bottom') win.scrollTo(0, 1e7);
          else win.scrollBy(0, a.direction === 'up' ? -Math.round(vh * 0.8) : Math.round(vh * 0.8));
          await sleep(350);
          return { ok: true, result: 'scrolled to y=' + Math.round(win.scrollY) };
        }
        case 'click': case 'type': case 'select': {
          const el = elById(a.id);
          if (!el) return { ok: false, result: 'FAILED: element ' + a.id + ' not found (page changed; use ids from the newest observation)' };
          try { el.scrollIntoView({ block: 'center' }); } catch (_) { /* ignore */ }
          const why = needsConfirmation(a, el);
          if (why) {
            const yes = await confirmWith(hooks, why);
            if (!yes || S.stop) return { ok: false, result: 'USER DENIED: ' + why + '. Do not retry; ask_user or choose another approach.' };
          }
          if (a.type === 'click') {
            const tag = el.tagName;
            const isLink = tag === 'A' && el.getAttribute('href') && !/^#/.test(el.getAttribute('href'));
            if (tag === 'A') el.removeAttribute('target'); // never spawn a window
            S.readOffset = 0;
            el.click();
            await settle(before, !!isLink || (tag === 'INPUT' && el.type === 'submit') || (tag === 'BUTTON' && el.type !== 'button' && !!el.form));
            return { ok: true, result: 'clicked' };
          }
          if (a.type === 'select') {
            if (el.tagName !== 'SELECT') return { ok: false, result: 'FAILED: element is not a <select>' };
            const want = String(a.value).toLowerCase();
            const opt = Array.from(el.options).find((o) => String(o.value).toLowerCase() === want || String(o.text).trim().toLowerCase() === want)
              || Array.from(el.options).find((o) => String(o.text).toLowerCase().includes(want));
            if (!opt) return { ok: false, result: 'FAILED: option not found' };
            el.value = opt.value;
            el.dispatchEvent(new win.Event('input', { bubbles: true }));
            el.dispatchEvent(new win.Event('change', { bubbles: true }));
            await settle(before, false);
            return { ok: true, result: 'selected ' + clean(opt.text, 40) };
          }
          // type
          if (el.tagName !== 'INPUT' && el.tagName !== 'TEXTAREA' && !el.isContentEditable) return { ok: false, result: 'FAILED: element is not a text field' };
          if (isSecretField(el)) return { ok: false, result: 'BLOCKED: secret/password/card field. Never fill it. Use ask_user so the user does it themselves.' };
          el.focus();
          if (el.isContentEditable) el.textContent = a.text; else setNativeValue(el, a.text, win);
          let note = '';
          if (a.submit) {
            S.readOffset = 0;
            const form = el.form;
            if (form) {
              if ((form.method || 'get').toLowerCase() === 'post') note = ' (warning: POST form; the proxy only supports GET navigation, result may not load)';
              if (typeof form.requestSubmit === 'function') form.requestSubmit(); else form.submit();
            } else {
              pressEnter(el, win);
            }
            await settle(before, true);
          } else {
            await sleep(250);
          }
          return { ok: true, result: 'typed' + (a.submit ? ' and submitted' : '') + note };
        }
        default: return { ok: false, result: 'FAILED: unsupported action ' + a.type };
      }
    } catch (e) {
      return { ok: false, result: 'FAILED: ' + clean(e && e.message, 160) };
    }
  }

  async function postStep(body) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 90000);
    try {
      const r = await fetch('/api/browser/agent/step', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ac.signal
      });
      const j = await r.json().catch(() => null);
      if (!j) return { ok: false, error: 'HTTP ' + r.status };
      return j;
    } catch (e) {
      return { ok: false, error: e && e.name === 'AbortError' ? 'AI timed out' : String((e && e.message) || e) };
    } finally { clearTimeout(timer); }
  }

  /**
   * Run a task. hooks: onStatus(text), onStep({n,thought,action,text}), onConfirm(text, answer(bool)),
   * Returns { status: 'done'|'ask'|'fail'|'stopped'|'limit'|'error', message, history }
   */
  async function run(task, hooks, opts) {
    if (S.running) return { status: 'error', message: 'Agent already running', history: [] };
    hooks = Object.assign({ onStatus() {}, onStep() {}, onConfirm(_t, answer) { answer(false); } }, hooks || {});
    opts = opts || {};
    const history = Array.isArray(opts.history) ? opts.history.slice() : [];
    const maxSteps = Math.min(25, Math.max(1, Number(opts.maxSteps) || MAX_STEPS_DEFAULT));
    const lang = (browser().state && browser().state.lang) || 'en';
    S.running = true; S.stop = false; S.readOffset = 0;
    let n = history.length;
    const recent = [];
    try {
      for (let i = 0; i < maxSteps; i++) {
        if (S.stop) return { status: 'stopped', message: '', history };
        n += 1;
        hooks.onStatus('Step ' + n + ': ' + (lang === 'vi' ? 'đang xem trang…' : 'looking at the page…'));
        const obs = observe();
        hooks.onStatus('Step ' + n + ': ' + (lang === 'vi' ? 'AI đang suy nghĩ…' : 'AI is thinking…'));
        const plan = await postStep({ task, lang, step: n, maxSteps, history: history.slice(-14), observation: obs });
        if (S.stop) return { status: 'stopped', message: '', history };
        if (!plan || !plan.ok || !plan.action) {
          return { status: 'error', message: (plan && plan.error) || 'AI failed', code: plan && plan.code, history };
        }
        const a = plan.action;
        const text = describe(a, obs);
        hooks.onStep({ n, thought: plan.thought || '', action: a, text });
        if (a.type === 'done') return { status: 'done', message: a.summary || '', history };
        if (a.type === 'ask_user') return { status: 'ask', message: a.question || '', history };
        if (a.type === 'fail') return { status: 'fail', message: a.reason || '', history };
        const key = JSON.stringify(a) + '|' + obs.url;
        recent.push(key);
        if (recent.length > 3) recent.shift();
        if (recent.length === 3 && recent.every((k) => k === key)) {
          return { status: 'fail', message: lang === 'vi' ? 'AI lặp lại cùng một thao tác 3 lần, đã dừng.' : 'The AI repeated the same action 3 times; stopped.', history };
        }
        hooks.onStatus('Step ' + n + ': ' + text);
        const out = await execute(a, hooks);
        history.push({ n, action: text, result: out.result + ' | now: ' + clean(currentUrl(), 120) });
        if (S.stop) return { status: 'stopped', message: '', history };
      }
      return { status: 'limit', message: lang === 'vi' ? 'Đạt giới hạn ' + maxSteps + ' bước.' : 'Reached the ' + maxSteps + '-step limit.', history };
    } catch (e) {
      return { status: 'error', message: String((e && e.message) || e), history };
    } finally {
      S.running = false;
      if (S.pendingConfirm) { S.pendingConfirm(false); S.pendingConfirm = null; }
    }
  }

  function stop() {
    S.stop = true;
    if (S.pendingConfirm) { const r = S.pendingConfirm; S.pendingConfirm = null; r(false); }
  }

  installLoadCounter();
  window.SoloAgent = {
    run, stop, observe, execute, isRunning: () => S.running,
    _internals: { isSecretField, needsConfirmation, labelOf, searchUrl, describe }
  };
})();
