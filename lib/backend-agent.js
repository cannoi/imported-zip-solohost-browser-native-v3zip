'use strict';

// Server-owned browser agent: AI plans and executes against the authenticated backend
// session. The UI only polls progress and displays results; it never reads/clicks the page.
const crypto = require('crypto');
const domBridge = require('./engine/dom-bridge');
const agentProgress = require('./agent-progress');
const planner = require('./browser-agent');
const appLog = require('./app-log');

const tasks = new Map();
const MAX_TASKS = 100;
const TASK_TTL_MS = 20 * 60 * 1000;
const SENSITIVE = /\b(buy|purchase|pay|payment|checkout|place order|delete|remove|unsubscribe|log ?out|sign ?out|send|post|publish|confirm|subscribe|donate|transfer|withdraw)\b|mua ngay|mua hàng|thanh toán|đặt hàng|xóa|xoá|đăng xuất|gửi|đăng bài|xác nhận|chuyển khoản|ủng hộ|đăng ký/i;
const SECRET = /password|passcode|one[- ]?time|otp|cvv|cvc|credit.?card|mật khẩu|mat khau|mã xác minh/i;
const sleep = ms => new Promise(r => setTimeout(r, ms));
function clip(v, n = 500) { const s = String(v == null ? '' : v); return s.length > n ? s.slice(0, n) + '…' : s; }
function decode(s) { return String(s || '').replace(/&nbsp;|&#160;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;|&apos;/gi, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Math.min(0x10ffff, Number(n) || 0))); }
function stripText(s) { return decode(String(s || '').replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function attrs(s) {
  const out = {};
  String(s || '').replace(/([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, (_, k, a, b, c) => { out[k.toLowerCase()] = decode(a ?? b ?? c ?? ''); return ''; });
  return out;
}
function isLiveEngine(session) {
  return session && (session.backend === 'playwright' || session.backend === 'webkit');
}

function observeSession(session, textOffset = 0) {
  const html = String(session.html || '');
  const body = (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [null, html])[1];
  const fullText = stripText(body);
  const offset = Math.min(Math.max(0, Number(textOffset) || 0), Math.max(0, fullText.length - 1));
  const text = fullText.slice(offset, offset + 3500);
  const elements = [], targets = {};
  const re = /<(a|button|input|textarea|select|form|summary)\b([^>]*)>([\s\S]*?)<\/\1\s*>|<(input|button|select|textarea)\b([^>]*)\/?>/gi;
  let m;
  while ((m = re.exec(body)) && elements.length < 80) {
    const tag = (m[1] || m[4] || '').toLowerCase();
    if (!['a','button','input','textarea','select','form','summary'].includes(tag)) continue;
    const at = attrs(m[2] || m[5] || '');
    const targetId = at['data-sh-id'] || '';
    if (!targetId) continue;
    const type = String(at.type || (tag === 'input' ? 'text' : '')).toLowerCase();
    if (type === 'hidden' || at.disabled !== undefined) continue;
    let label = stripText(m[3] || '') || at['aria-label'] || at.title || at.placeholder || at.name || at.value || '';
    if (tag === 'input' && SECRET.test([type, at.name, at.id, at.placeholder, at.autocomplete].join(' '))) label = (label ? label + ' ' : '') + '[secret field - never fill]';
    const id = elements.length + 1;
    const e = { id, tag, label: clip(label, 90) };
    if (tag === 'input') e.type = type;
    if (tag === 'a' && at.href) { try { e.href = new URL(at.href, session.url).href; } catch { e.href = at.href; } }
    if (tag === 'input' || tag === 'textarea') { e.value = SECRET.test([type, at.name, at.id, at.placeholder, at.autocomplete].join(' ')) ? '' : clip(at.value || '', 60); if (type === 'checkbox' || type === 'radio') e.checked = at.checked !== undefined; }
    if (tag === 'select') { e.value = clip(at.value || '', 60); e.options = Array.from((m[3] || '').matchAll(/<option\b[^>]*>([\s\S]*?)<\/option>/gi)).slice(0,12).map(o => clip(stripText(o[1]),40)); }
    if (at.disabled !== undefined) e.disabled = true;
    elements.push(e); targets[id] = targetId;
  }
  const audit = session.audit || {};
  return { readable: !!html, url: session.url || '', title: session.title || '', text, textOffset: offset, textTotal: fullText.length, elements, targets,
    scroll: { y: 0, height: 0, viewport: 0 }, audit: { textLength: Number(audit.textLength)||text.length, controls: Number(audit.controls)||0, media: Number(audit.media)||0 } };
}
function push(task, type, data = {}) {
  const event = { id: ++task.eventSeq, type, at: new Date().toISOString(), ...data };
  task.events.push(event); if (task.events.length > 100) task.events.shift();
  task.updatedAt = Date.now();
  // Broadcast to AI panel / SSE (never include password values)
  try {
    const safe = Object.assign({}, data);
    delete safe.password; delete safe.secret; delete safe.value;
    agentProgress.push({
      taskId: task.id,
      sessionId: task.sessionId,
      type,
      status: task.status,
      message: task.message || safe.message || '',
      url: (task.session && task.session.url) || safe.url || '',
      n: safe.n,
      action: safe.action && safe.action.type,
      loginForm: type === 'login_form' ? { fields: safe.fields, url: safe.url } : undefined
    });
  } catch (_) {}
  if (type === 'step') appLog.log('info', 'agent.task.step', { taskId: task.id, n: data.n, action: data.action && data.action.type });
  else if (type === 'error' || type === 'failed') appLog.log('warn', 'agent.task.' + type, { taskId: task.id, message: clip(data.message || task.error || task.message, 180) });
  else if (type === 'done') appLog.log('info', 'agent.task.done', { taskId: task.id });
  else if (type === 'login_form') appLog.log('info', 'agent.task.login_form', { taskId: task.id, url: String(data.url || '').slice(0, 200) });
  return event;
}
function publicTask(task, after = 0) {
  return { ok: true, taskId: task.id, status: task.status, message: task.message || '', error: task.error || '',
    confirmation: task.confirmation ? { id: task.confirmation.id, text: task.confirmation.text } : null,
    events: task.events.filter(e => e.id > after), cursor: task.eventSeq, history: task.history.slice(-14), updatedAt: task.updatedAt };
}
function getTask(id, sessionId) { const t = tasks.get(String(id)); return t && t.sessionId === sessionId ? t : null; }
async function start({ ai, session, task: taskText, lang, history, maxSteps }) {
  for (const [id, old] of tasks) if (Date.now() - old.updatedAt > TASK_TTL_MS) tasks.delete(id);
  for (const active of tasks.values()) {
    if (active.sessionId === session.id && ['running', 'waiting_confirmation', 'stopping'].includes(active.status)) throw new Error('task_already_running');
  }
  const taskTextClean = clip(taskText, 1500).trim();
  if (!taskTextClean) throw new Error('task_required');
  while (tasks.size >= MAX_TASKS) tasks.delete(tasks.keys().next().value);
  const task = { id: crypto.randomBytes(16).toString('hex'), sessionId: session.id, session, task: taskTextClean,
    lang: lang === 'vi' ? 'vi' : 'en', history: Array.isArray(history) ? history.slice(-14) : [], maxSteps: Math.min(20, Math.max(1, Number(maxSteps)||15)),
    status: 'running', message: '', error: '', events: [], eventSeq: 0, updatedAt: Date.now(), stop: false, confirmation: null, confirmationResolve: null, urlStack: session.url ? [session.url] : [], urlIndex: 0, readOffset: 0 };
  tasks.set(task.id, task);
  push(task, 'status', { message: task.lang === 'vi' ? 'Backend đang khởi động tác vụ trình duyệt.' : 'Backend browser task started.' });
  runTask(ai, task).catch(e => { task.status = 'error'; task.error = clip(e.message || e); push(task, 'error', { message: task.error }); });
  return publicTask(task, 0);
}
async function askConfirmation(task, text) {
  task.status = 'waiting_confirmation';
  task.confirmation = { id: crypto.randomBytes(8).toString('hex'), text: clip(text, 400) };
  push(task, 'confirmation_required', { text: task.confirmation.text, confirmationId: task.confirmation.id });
  return new Promise(resolve => { task.confirmationResolve = resolve; });
}
async function execute(task, action, obs) {
  const session = task.session;
  if (task.stop) return { ok: false, result: 'stopped' };
  const id = Number(action.id);
  switch (action.type) {
    case 'navigate': {
      if (/^https?:\/\/(accounts\.google\.com|[^/]+\/(?:login|signin|sign-in|oauth|authorize))/i.test(action.url) && !isLiveEngine(session)) {
        // Still navigate with ENGINE if possible — otherwise ask UI to open login surface
        return { ok: false, result: 'login_requires_engine' };
      }
      if (/^https?:\/\/(accounts\.google\.com|[^/]+\/(?:login|signin|sign-in|oauth|authorize))/i.test(action.url) && isLiveEngine(session)) {
        // Navigate into login page with Playwright; UI will show password fields for user
        const nav = await domBridge.navigate(session, action.url);
        push(task, 'login_form', {
          message: task.lang === 'vi'
            ? 'Đã mở trang đăng nhập trên engine Chromium. Điền mật khẩu trên khung trình duyệt (không gửi cho AI).'
            : 'Login page opened in Chromium engine. Enter credentials in the browser viewport (not to AI).',
          url: session.url,
          fields: []
        });
        return { ok: true, result: 'opened_login_page', login: true, url: session.url };
      }
      const { assertPublicHttpUrl } = require('./frame-proxy');
      await assertPublicHttpUrl(action.url);
      const r = await domBridge.navigate(session, action.url);
      return { ok: !r.error && r.hasContent !== false, result: 'opened ' + (r.url || action.url), state: r };
    }
    case 'search': {
      const q = encodeURIComponent(action.query);
      const url = action.engine === 'youtube' ? 'https://www.youtube.com/results?search_query=' + q : action.engine === 'ddg' || action.engine === 'duckduckgo' ? 'https://html.duckduckgo.com/html/?q=' + q : action.engine === 'google' ? 'https://www.google.com/search?q=' + q : 'https://www.bing.com/search?q=' + q;
      const { assertPublicHttpUrl } = require('./frame-proxy'); await assertPublicHttpUrl(url);
      const r = await domBridge.navigate(session, url); return { ok: !r.error && r.hasContent !== false, result: 'searched ' + action.engine, state: r };
    }
    case 'click': {
      const el = obs.elements.find(e => e.id === id); if (!el) return { ok: false, result: 'element_not_found' };
      if (SENSITIVE.test((el.label || '') + ' ' + (el.href || ''))) {
        const yes = await askConfirmation(task, 'Click ' + (el.label || el.href || 'sensitive action'));
        if (!yes || task.stop) return { ok: false, result: 'user_denied_sensitive_action' };
      }
      const out = await domBridge.dispatchEvent(session, { type: 'click', targetId: obs.targets[id] });
      if (out.result && out.result.limited) return { ok: false, result: 'engine_required_for_click' };
      return { ok: !!out.ok, result: out.ok ? 'clicked ' + (el.label || id) : (out.error || 'click_failed'), state: out };
    }
    case 'type': {
      const el = obs.elements.find(e => e.id === id); if (!el) return { ok: false, result: 'element_not_found' };
      if (SECRET.test([el.type, el.label].join(' '))) return { ok: false, result: 'blocked_secret_field_use_ask_user' };
      const out = await domBridge.dispatchEvent(session, { type: 'input', targetId: obs.targets[id], value: action.text });
      if (!out.ok) return { ok: false, result: out.error || 'input_failed' };
      if (out.result && out.result.limited) return { ok: false, result: 'engine_required_for_input' };
      if (action.submit) {
        const hasSecret = obs.elements.some(e => e.type === 'password' || SECRET.test(e.label || ''));
      if (hasSecret) {
        const fields = obs.elements.filter(e => e.type === 'password' || e.type === 'email' || e.type === 'text' || /user|email|phone|login/i.test(e.label || '')).slice(0, 8);
        push(task, 'login_form', {
          message: task.lang === 'vi'
            ? 'Trang yêu cầu đăng nhập. Hãy điền trên khung trình duyệt (engine) — AI không nhận mật khẩu.'
            : 'Sign-in form detected. Fill it in the browser viewport (engine) — AI never accepts passwords.',
          url: session.url,
          fields: fields.map(f => ({ id: f.id, type: f.type, label: f.label }))
        });
      }
        if (hasSecret) { const yes = await askConfirmation(task, 'Submit a form containing a login or sensitive field'); if (!yes || task.stop) return { ok: false, result: 'user_denied_form_submit' }; }
        const sub = await domBridge.dispatchEvent(session, { type: 'submit', targetId: obs.targets[id] });
        return { ok: !!sub.ok, result: sub.ok ? 'typed and submitted' : (sub.error || 'submit_failed'), state: sub };
      }
      return { ok: true, result: 'typed', state: out };
    }
    case 'select': {
      const el = obs.elements.find(e => e.id === id); if (!el) return { ok: false, result: 'element_not_found' };
      const optionIndex = Math.max(0, (el.options || []).findIndex(o => String(o).toLowerCase() === String(action.value).toLowerCase() || String(o).toLowerCase().includes(String(action.value).toLowerCase())));
      const out = await domBridge.dispatchEvent(session, { type: 'change', targetId: obs.targets[id], value: action.value, selectedIndex: optionIndex });
      if (out.result && out.result.limited) return { ok: false, result: 'engine_required_for_select' };
      return { ok: !!out.ok, result: out.ok ? 'selected ' + action.value : (out.error || 'select_failed'), state: out };
    }
    case 'scroll': {
      const current = Number(session.scrollY) || 0; const delta = 600;
      const y = action.direction === 'top' ? 0 : action.direction === 'bottom' ? 100000 : Math.max(0, current + (action.direction === 'up' ? -delta : delta));
      const out = await domBridge.dispatchEvent(session, { type: 'scroll', scrollY: y, scrollX: Number(session.scrollX) || 0 });
      session.scrollY = Number(out.result && out.result.scrollY != null ? out.result.scrollY : y);
      return { ok: !!out.ok, result: 'scrolled ' + action.direction, state: out };
    }
    case 'wait': await sleep(Math.min(3000, Math.max(200, action.ms || 1000))); return { ok: true, result: 'waited' };
    case 'read': task.readOffset = Math.max(0, Number(action.offset) || 0); return { ok: true, result: 'read page text at offset ' + task.readOffset };
    case 'back': case 'forward': {
      const next = task.urlIndex + (action.type === 'back' ? -1 : 1);
      if (next < 0 || next >= task.urlStack.length) return { ok: false, result: 'no_' + action.type + '_history' };
      task.urlIndex = next;
      const target = task.urlStack[task.urlIndex];
      const r = await domBridge.navigate(session, target);
      return { ok: !r.error && r.hasContent !== false, result: action.type + ' to ' + target, state: r };
    }
    default: return { ok: false, result: 'unsupported_action' };
  }
}
async function runTask(ai, task) {
  const recent = [];
  for (let i = 0; i < task.maxSteps; i++) {
    if (task.stop) { task.status = 'stopped'; task.message = task.lang === 'vi' ? 'Đã dừng tác vụ.' : 'Task stopped.'; push(task, 'status', { message: task.message }); return; }
    const obs = observeSession(task.session, task.readOffset || 0);
    push(task, 'status', { message: task.lang === 'vi' ? `Bước ${i+1}: backend đang phân tích trang.` : `Step ${i+1}: backend inspecting page.` });
    const plan = await planner.planStep(ai, { task: task.task, lang: task.lang, step: i+1, maxSteps: task.maxSteps, history: task.history.slice(-14), observation: obs });
    if (!plan || !plan.ok || !plan.action) { task.status = 'error'; task.error = plan && plan.error || 'AI planning failed'; push(task, 'error', { message: task.error }); return; }
    const a = plan.action;
    push(task, 'step', { n: i+1, thought: clip(plan.thought, 250), action: a, url: obs.url, title: obs.title });
    if (a.type === 'done') { task.status = 'done'; task.message = a.summary || (task.lang === 'vi' ? 'Hoàn tất.' : 'Done.'); push(task, 'done', { message: task.message, url: task.session.url, title: task.session.title }); return; }
    if (a.type === 'ask_user') {
      const q = String(a.question || '');
      if (/\b(password|email|phone|otp|mật khẩu|số điện thoại|điện thoại)\b/i.test(q)) {
        const msg = task.lang === 'vi'
          ? 'Điền email/mật khẩu trên khung trình duyệt (screenshot engine) hoặc bấm ↗ Open. Không gửi thông tin đăng nhập trong chat AI.'
          : 'Fill email/password in the browser viewport (engine screenshot) or press Open ↗. Do not send credentials in AI chat.';
        push(task, 'login_form', { message: msg, url: task.session.url });
        task.status = 'waiting_user';
        task.message = msg;
        return;
      }
      task.status = 'waiting_user'; task.message = q; push(task, 'ask_user', { message: task.message }); return;
    }
    if (a.type === 'fail') { task.status = 'failed'; task.message = a.reason || 'Task failed'; push(task, 'failed', { message: task.message }); return; }
    const key = JSON.stringify(a) + '|' + obs.url; recent.push(key); if (recent.length > 3) recent.shift();
    if (recent.length === 3 && recent.every(k => k === key)) { task.status = 'failed'; task.message = task.lang === 'vi' ? 'Đã dừng vì AI lặp lại cùng thao tác.' : 'Stopped because the agent repeated the same action.'; push(task, 'failed', { message: task.message }); return; }
    const priorUrl = task.session.url;
    const out = await execute(task, a, obs);
    const currentUrl = task.session.url;
    if (currentUrl && currentUrl !== priorUrl && !['back','forward'].includes(a.type)) {
      if (task.urlStack[task.urlStack.length - 1] !== currentUrl) { task.urlStack = task.urlStack.slice(0, task.urlIndex + 1); task.urlStack.push(currentUrl); if (task.urlStack.length > 50) task.urlStack.shift(); task.urlIndex = task.urlStack.length - 1; }
    }
    task.history.push({ n: i+1, action: clip(a.type + (a.url ? ' ' + a.url : a.label ? ' ' + a.label : ''), 300), result: clip(out.result, 300) });
    push(task, 'action_result', { n: i+1, ok: !!out.ok, result: clip(out.result, 300), url: task.session.url, title: task.session.title });
    if (!out.ok && /user_denied|blocked_secret|login_requires_engine|engine_required_for_(click|input|select)/.test(out.result)) { task.status = 'waiting_user'; task.message = /login_requires_engine|webkit_required_for_/.test(out.result) ? (task.lang === 'vi' ? 'Điền form đăng nhập trên khung trình duyệt (engine Chromium). Hoặc Mở ngoài ↗. Không gửi mật khẩu cho AI.' : 'Use the login form in the browser viewport (Playwright/Chromium engine). Or Open ↗. Never send passwords to AI.') : (task.lang === 'vi' ? 'Cần thao tác thủ công của bạn.' : 'Your manual action is needed.'); push(task, 'ask_user', { message: task.message }); return; }
    // Allow SPA hydration after action, then refresh session HTML from the live engine.
    await sleep(300);
    if (task.stop) continue;
  }
  task.status = 'limit'; task.message = task.lang === 'vi' ? `Đã đạt giới hạn ${task.maxSteps} bước.` : `Reached the ${task.maxSteps}-step limit.`; push(task, 'limit', { message: task.message });
}
function status(id, sessionId, after = 0) { const t = getTask(id, sessionId); return t ? publicTask(t, Number(after)||0) : null; }
function stop(id, sessionId) { const t = getTask(id, sessionId); if (!t) return null; t.stop = true; if (t.confirmationResolve) { t.confirmationResolve(false); t.confirmationResolve = null; } t.status = 'stopping'; push(t, 'status', { message: 'Stop requested' }); return publicTask(t, 0); }
function confirm(id, sessionId, confirmationId, approved) { const t = getTask(id, sessionId); if (!t || !t.confirmation || t.confirmation.id !== confirmationId || !t.confirmationResolve) return null; const resolve = t.confirmationResolve; t.confirmationResolve = null; t.confirmation = null; t.status = 'running'; push(t, 'confirmation_answer', { approved: !!approved }); resolve(!!approved); return publicTask(t, 0); }
module.exports = { start, status, stop, confirm, observeSession };
