'use strict';

/**
 * Server-owned browser agent (v10.26).
 * Live Chromium observation via observer.js; structured workMemory; SSRF-safe tools.
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const domBridge = require('./engine/dom-bridge');
const agentProgress = require('./agent-progress');
const planner = require('./browser-agent');
const agentTools = require('./agent-tools');
const appLog = require('./app-log');
const observer = require('./engine/observer');

const tasks = new Map();
const MAX_TASKS = 20;
const TASK_TTL_MS = 24 * 60 * 60 * 1000;
const TASK_DIR = path.join(process.env.SOLOHOST_DATA_DIR || path.join(__dirname, '..', 'data'), 'agent-tasks');
const AGENT_MAX_STEPS = Math.min(150, Math.max(10, Number(process.env.AGENT_MAX_STEPS) || 40));
const STUCK_N = 3;

const SECRET = /password|passcode|one[- ]?time|otp|cvv|cvc|credit.?card|mật khẩu|mat khau|mã xác minh/i;
const HIGH_RISK = /\b(buy|purchase|pay|payment|checkout|place.?order|delete|remove|unsubscribe|transfer|withdraw|wire)\b|thanh toán|đặt hàng|xóa tài khoản|chuyển khoản|rút tiền/i;
const MED_RISK = /\b(log ?out|sign ?out|publish|subscribe|donate)\b|đăng xuất|đăng bài|ủng hộ|đăng ký gói/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function clip(v, n = 500) {
  const s = String(v == null ? '' : v);
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function ensureTaskDir() {
  try { fs.mkdirSync(TASK_DIR, { recursive: true, mode: 0o700 }); } catch (_) {}
}

function persistTaskDisk(task) {
  try {
    ensureTaskDir();
    const safe = {
      id: task.id,
      sessionId: task.sessionId,
      task: task.task,
      lang: task.lang,
      status: task.status,
      message: task.message,
      workMemory: task.workMemory,
      plan: task.plan,
      maxSteps: task.maxSteps,
      maxMs: task.maxMs,
      history: (task.history || []).slice(-20),
      urlStack: task.urlStack,
      urlIndex: task.urlIndex,
      updatedAt: task.updatedAt,
      startedAt: task.startedAt
    };
    fs.writeFileSync(path.join(TASK_DIR, task.id + '.json'), JSON.stringify(safe), { mode: 0o600 });
  } catch (_) {}
}

function loadTaskDisk(id) {
  try {
    const p = path.join(TASK_DIR, String(id) + '.json');
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

function summarizeWorkMemory(wm) {
  if (!wm || typeof wm !== 'object') return '';
  const findings = (wm.findings || []).slice(-8).map((f, i) => {
    if (typeof f === 'string') return (i + 1) + '. ' + clip(f, 220);
    return (i + 1) + '. ' + clip(f.fact || f.text || JSON.stringify(f), 220) + (f.url ? ' [' + f.url + ']' : '');
  });
  const lines = [];
  if (wm.todo && wm.todo.length) lines.push('TODO: ' + wm.todo.slice(0, 8).join('; '));
  if (wm.visited && wm.visited.length) lines.push('VISITED: ' + wm.visited.slice(-10).join(' | '));
  if (wm.notes && wm.notes.length) lines.push('NOTES: ' + wm.notes.slice(-5).map((n) => clip(n, 120)).join(' | '));
  if (findings.length) lines.push('FINDINGS:\n' + findings.join('\n'));
  if (wm.lastUrl) lines.push('LAST_URL: ' + wm.lastUrl);
  return lines.join('\n').slice(0, 3500);
}

function actionRisk(action, label) {
  const blob = [action && action.type, label, action && action.text, action && action.value].join(' ');
  if (SECRET.test(blob)) return 'high';
  if (HIGH_RISK.test(blob)) return 'high';
  if (MED_RISK.test(blob)) return 'medium';
  if (action && action.risk) return String(action.risk);
  return 'low';
}

async function assertSafeUrl(url) {
  const { assertPublicHttpUrl } = require('./frame-proxy');
  await assertPublicHttpUrl(url);
}

function isLiveEngine(session) {
  return session && (session.backend === 'playwright' || session.backend === 'webkit') && session.pwSessionId;
}

/** Fallback HTML parse when live observe unavailable — does NOT swallow form children. */
function observeHtmlFallback(session, textOffset = 0) {
  const html = String(session.html || '');
  const body = (html.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i) || [null, html])[1];
  const decode = (s) => String(s || '').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"');
  const stripText = (s) => decode(String(s || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  const fullText = stripText(body);
  const offset = Math.min(Math.max(0, Number(textOffset) || 0), Math.max(0, fullText.length - 1));
  const text = fullText.slice(offset, offset + 3500);
  const elements = [];
  const targets = {};
  // Only void/self-or-simple tags — never match <form>...</form> as one unit
  // Void tags (input) + paired tags — never match <form>...</form>
  const re = /<(input)\b([^>]*)\/?>|<(a|button|textarea|select|summary)\b([^>]*)>([\s\S]*?)<\/\3\s*>/gi;
  let m;
  while ((m = re.exec(body)) && elements.length < 100) {
    const tag = (m[1] || m[3] || '').toLowerCase();
    const attrStr = m[2] || m[4] || '';
    const inner = m[5] || '';
    const at = {};
    attrStr.replace(/([\w:-]+)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g, (_, k, a, b, c) => {
      at[k.toLowerCase()] = decode(a ?? b ?? c ?? '');
      return '';
    });
    const targetId = at['data-sh-id'] || '';
    if (!targetId) continue;
    const type = String(at.type || (tag === 'input' ? 'text' : '')).toLowerCase();
    if (type === 'hidden') continue;
    let label = stripText(inner) || at['aria-label'] || at.title || at.placeholder || at.name || at.value || '';
    if (tag === 'input' && SECRET.test([type, at.name, at.id, at.placeholder].join(' '))) label += ' [secret field - never fill]';
    const id = elements.length + 1;
    const e = { id, tag, label: clip(label, 90) };
    if (tag === 'input') e.type = type;
    if (tag === 'a' && at.href) {
      try { e.href = new URL(at.href, session.url).href; } catch { e.href = at.href; }
    }
    elements.push(e);
    targets[id] = targetId;
  }
  return {
    readable: !!html,
    live: false,
    url: session.url || '',
    title: session.title || '',
    text,
    textOffset: offset,
    textTotal: fullText.length,
    elements,
    targets,
    scroll: { y: Number(session.scrollY) || 0, height: 0, viewport: 0 },
    pageState: [],
    audit: { textLength: text.length, controls: elements.length, media: 0 }
  };
}

async function observeSession(session, textOffset = 0) {
  if (isLiveEngine(session)) {
    try {
      const pw = require('./engine/playwright-engine');
      const live = await observer.observeLive(pw, session.pwSessionId, { textOffset });
      if (live && !live.error && live.elements) {
        // Refresh bridge snapshot lightly without full re-navigate
        try {
          const content = await pw.getContent(session.pwSessionId, { force: false });
          if (content) {
            session.html = content.html || session.html;
            session.title = content.title || session.title;
            session.url = content.url || session.url;
          }
        } catch (_) {}
        return live;
      }
    } catch (e) {
      appLog.log('warn', 'agent.observe_live_fail', { error: String(e.message || e).slice(0, 120) });
    }
  }
  return observeHtmlFallback(session, textOffset);
}

function push(task, type, data = {}) {
  const event = { id: ++task.eventSeq, type, at: new Date().toISOString(), ...data };
  task.events.push(event);
  if (task.events.length > 120) task.events.shift();
  task.updatedAt = Date.now();
  try {
    const safe = Object.assign({}, data);
    delete safe.password;
    delete safe.secret;
    delete safe.value;
    agentProgress.push({
      taskId: task.id,
      sessionId: task.sessionId,
      type,
      status: task.status,
      message: task.message || safe.message || '',
      url: (task.session && task.session.url) || safe.url || '',
      n: safe.n,
      action: safe.action && safe.action.type,
      plan: task.plan
    });
  } catch (_) {}
  if (type === 'step') appLog.log('info', 'agent.task.step', { taskId: task.id, n: data.n, action: data.action && data.action.type });
  else if (type === 'error' || type === 'failed') appLog.log('warn', 'agent.task.' + type, { taskId: task.id, message: clip(data.message || task.error || task.message, 180) });
  else if (type === 'done') appLog.log('info', 'agent.task.done', { taskId: task.id });
  persistTaskDisk(task);
  return event;
}

function publicTask(task, after = 0) {
  return {
    ok: true,
    taskId: task.id,
    status: task.status,
    message: task.message || '',
    error: task.error || '',
    confirmation: task.confirmation ? { id: task.confirmation.id, text: task.confirmation.text } : null,
    events: task.events.filter((e) => e.id > after),
    cursor: task.eventSeq,
    history: task.history.slice(-14),
    plan: task.plan || null,
    workMemory: task.workMemory ? { findings: (task.workMemory.findings || []).length, todo: task.workMemory.todo } : null,
    updatedAt: task.updatedAt
  };
}

function getTask(id, sessionId) {
  const t = tasks.get(String(id));
  return t && t.sessionId === sessionId ? t : null;
}

async function waitStable(session) {
  await sleep(400);
  if (isLiveEngine(session)) {
    try {
      const pw = require('./engine/playwright-engine');
      await pw.evaluate(session.pwSessionId, 'new Promise(r => setTimeout(r, 200))');
    } catch (_) {}
  }
}

async function executeAction(task, session, action, obs) {
  const targets = (obs && obs.targets) || {};
  switch (action.type) {
    case 'navigate': {
      let url = String(action.url || '').trim();
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
      await assertSafeUrl(url);
      const r = await domBridge.navigate(session, url);
      if (r && r.url) {
        task.urlStack = task.urlStack.slice(0, task.urlIndex + 1);
        task.urlStack.push(r.url);
        task.urlIndex = task.urlStack.length - 1;
        task.workMemory = task.workMemory || {};
        task.workMemory.visited = (task.workMemory.visited || []).concat([r.url]).slice(-30);
      }
      return { ok: !r.error && r.hasContent !== false, result: r.error || r.url || url, state: r };
    }
    case 'search': {
      const query = String(action.query || '').trim();
      if (!query) throw new Error('search needs "query"');
      let engine = String(action.engine || process.env.SOLOHOST_DEFAULT_SEARCH || 'google').toLowerCase();
      if (!['youtube', 'bing', 'google', 'ddg', 'brave'].includes(engine)) engine = 'google';
      let url;
      if (engine === 'youtube') url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
      else if (engine === 'bing') url = 'https://www.bing.com/search?q=' + encodeURIComponent(query);
      else if (engine === 'ddg') url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
      else if (engine === 'brave') url = 'https://search.brave.com/search?q=' + encodeURIComponent(query);
      else url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
      await assertSafeUrl(url);
      const r = await domBridge.navigate(session, url);
      return { ok: !r.error && r.hasContent !== false, result: engine + ': ' + query, state: r };
    }
    case 'click': {
      const id = Number(action.id);
      const targetId = targets[id];
      if (!targetId) return { ok: false, result: 'unknown_element_id' };
      const el = (obs.elements || []).find((e) => e.id === id);
      if (el && el.href && /\/(login|signin|oauth)/i.test(el.href) && !isLiveEngine(session)) {
        return { ok: false, result: 'login_requires_engine' };
      }
      const out = await domBridge.dispatchEvent(session, { type: 'click', targetId });
      return { ok: !!out.ok, result: out.result || 'clicked ' + id, state: out };
    }
    case 'type': {
      const id = Number(action.id);
      const targetId = targets[id];
      if (!targetId) return { ok: false, result: 'unknown_element_id' };
      const el = (obs.elements || []).find((e) => e.id === id);
      if (el && SECRET.test([el.type, el.label].join(' '))) return { ok: false, result: 'blocked_secret_field_use_ask_user' };
      const value = String(action.text != null ? action.text : action.value != null ? action.value : '');
      const out = await domBridge.dispatchEvent(session, { type: 'input', targetId, value });
      if (action.submit || action.press_enter) {
        await waitStable(session);
        const sub = await domBridge.dispatchEvent(session, { type: 'submit', targetId });
        return { ok: !!out.ok, result: 'typed+submit', state: sub };
      }
      return { ok: !!out.ok, result: 'typed', state: out };
    }
    case 'press_key':
    case 'press': {
      const id = Number(action.id);
      const targetId = id ? targets[id] : '';
      const key = String(action.key || 'Enter');
      if (isLiveEngine(session)) {
        const pw = require('./engine/playwright-engine');
        const out = await pw.dispatchEvent(session.pwSessionId, { type: 'press_key', targetId, key });
        return { ok: true, result: 'pressed ' + key, state: out };
      }
      if (targetId && (key === 'Enter' || key === 'Return')) {
        const out = await domBridge.dispatchEvent(session, { type: 'submit', targetId });
        return { ok: !!out.ok, result: 'enter', state: out };
      }
      return { ok: false, result: 'press_key_requires_engine' };
    }
    case 'select': {
      const id = Number(action.id);
      const targetId = targets[id];
      if (!targetId) return { ok: false, result: 'unknown_element_id' };
      const out = await domBridge.dispatchEvent(session, {
        type: 'input',
        targetId,
        value: action.value != null ? String(action.value) : '',
        selectedIndex: action.selectedIndex
      });
      return { ok: !!out.ok, result: 'selected', state: out };
    }
    case 'extract_page': {
      try {
        const pw = require('./engine/playwright-engine');
        const data = await agentTools.extractFromPlaywrightSession(pw, session.pwSessionId);
        if (data && !data.error) {
          const summary = [
            'title: ' + (data.title || ''),
            'headings: ' + (data.headings || []).slice(0, 12).join(' · '),
            'links: ' + (data.links || []).slice(0, 16).map((l) => l.text + ' → ' + l.href).join(' | '),
            'docs: ' + (data.docs || []).map((d) => d.kind + ' ' + d.href).join(' | '),
            'tables: ' + (data.tables || []).slice(0, 3).join('\n---\n'),
            'text: ' + (data.text || '').slice(0, 8000)
          ].join('\n');
          task.workMemory = task.workMemory || { findings: [] };
          task.workMemory.findings = (task.workMemory.findings || []).concat([{ fact: clip(summary, 1200), url: data.url || session.url, step: task.history.length }]).slice(-20);
          task.workMemory.lastUrl = data.url || session.url;
          return { ok: true, result: clip(summary, 6000) };
        }
        return { ok: false, result: (data && data.error) || 'extract_failed' };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'fetch_doc': {
      try {
        const docUrl = String(action.url || '').trim();
        if (!/^https?:/i.test(docUrl)) return { ok: false, result: 'fetch_doc needs http(s) url' };
        await assertSafeUrl(docUrl);
        const undici = global.fetch || (async (url, opt) => {
          const http = require('http');
          const https = require('https');
          const lib = String(url).startsWith('https') ? https : http;
          return new Promise((resolve, reject) => {
            const req = lib.get(url, { headers: (opt && opt.headers) || {}, timeout: 15000 }, (res) => {
              // block redirect to private hosts: re-check location
              if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
                const next = res.headers.location;
                assertSafeUrl(next).then(() => {
                  res.resume();
                  reject(new Error('redirect_recheck_required:' + next));
                }).catch((err) => {
                  res.resume();
                  reject(err);
                });
                return;
              }
              const chunks = [];
              res.on('data', (c) => chunks.push(c));
              res.on('end', () => {
                const buf = Buffer.concat(chunks);
                resolve({
                  ok: res.statusCode >= 200 && res.statusCode < 400,
                  status: res.statusCode,
                  headers: { get: (k) => res.headers[String(k).toLowerCase()] },
                  arrayBuffer: async () => buf
                });
              });
            });
            req.on('error', reject);
          });
        });
        const result = await agentTools.fetchDocumentText(docUrl, undici);
        if (result.ok) {
          task.workMemory = task.workMemory || { findings: [] };
          task.workMemory.findings = (task.workMemory.findings || []).concat([{ fact: clip(result.text, 800), url: docUrl, step: task.history.length }]).slice(-20);
          return { ok: true, result: clip((result.kind || 'doc') + ': ' + (result.text || ''), 6000) };
        }
        return { ok: false, result: result.error || 'fetch_doc_failed' };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'scroll': {
      const current = Number((obs.scroll && obs.scroll.y) || session.scrollY) || 0;
      const delta = 600;
      const y =
        action.direction === 'top'
          ? 0
          : action.direction === 'bottom'
            ? 100000
            : Math.max(0, current + (action.direction === 'up' ? -delta : delta));
      const out = await domBridge.dispatchEvent(session, { type: 'scroll', scrollY: y, scrollX: Number(session.scrollX) || 0 });
      session.scrollY = Number(out.result && out.result.scrollY != null ? out.result.scrollY : y);
      return { ok: !!out.ok, result: 'scrolled ' + action.direction, state: out };
    }
    case 'wait':
      await sleep(Math.min(5000, Math.max(200, action.ms || 1000)));
      return { ok: true, result: 'waited' };
    case 'read':
      task.readOffset = Math.max(0, Number(action.offset) || 0);
      return { ok: true, result: 'read page text at offset ' + task.readOffset };
    case 'note': {
      task.workMemory = task.workMemory || { notes: [] };
      task.workMemory.notes = (task.workMemory.notes || []).concat([String(action.text || action.note || '')]).slice(-20);
      return { ok: true, result: 'noted' };
    }
    case 'back':
    case 'forward': {
      const next = task.urlIndex + (action.type === 'back' ? -1 : 1);
      if (next < 0 || next >= task.urlStack.length) return { ok: false, result: 'no_' + action.type + '_history' };
      task.urlIndex = next;
      const target = task.urlStack[task.urlIndex];
      await assertSafeUrl(target);
      const r = await domBridge.navigate(session, target);
      return { ok: !r.error && r.hasContent !== false, result: action.type + ' to ' + target, state: r };
    }
    default:
      return { ok: false, result: 'unsupported_action' };
  }
}

async function runTask(ai, task) {
  const recentHashes = [];
  const deadline = (task.startedAt || Date.now()) + (task.maxMs || 3600000);
  for (let i = 0; i < task.maxSteps; i++) {
    if (task.stop) {
      task.status = 'stopped';
      task.message = task.lang === 'vi' ? 'Đã dừng tác vụ.' : 'Task stopped.';
      push(task, 'status', { message: task.message });
      return;
    }
    if (Date.now() > deadline) {
      task.status = 'limit';
      task.message =
        task.lang === 'vi'
          ? 'Hết thời gian nhiệm vụ (~' + Math.round((task.maxMs || 0) / 60000) + ' phút). Bấm Tiếp tục để resume.'
          : 'Task time limit reached (~' + Math.round((task.maxMs || 0) / 60000) + ' min). Tap Continue to resume.';
      push(task, 'status', { message: task.message });
      persistTaskDisk(task);
      return;
    }

    const session = task.session;
    let obs = await observeSession(session, task.readOffset || 0);
    const obsHash = observer.hashObservation(obs);

    let plan;
    try {
      plan = await planner.planNext({
        ai,
        task: task.task,
        observation: obs,
        history: task.history,
        step: i + 1,
        maxSteps: task.maxSteps,
        workMemory: task.workMemory,
        workMemoryText: summarizeWorkMemory(task.workMemory),
        plan: task.plan,
        stuckHint: recentHashes.filter((h) => h === obsHash).length >= 2
          ? 'Previous actions did not change the page. Try a different element, scroll, search engine, or ask_user.'
          : ''
      });
    } catch (e) {
      task.status = 'failed';
      task.error = clip(e.message || e, 200);
      task.message = task.error;
      push(task, 'failed', { message: task.message });
      return;
    }

    if (plan.plan) task.plan = plan.plan;
    if (plan.thought) task.history.push({ step: i + 1, thought: clip(plan.thought, 400) });

    // Multi-action: up to 4 safe actions
    const actions = Array.isArray(plan.actions) && plan.actions.length
      ? plan.actions.slice(0, 4)
      : plan.action
        ? [plan.action]
        : [];

    if (!actions.length) {
      if (plan.done) {
        task.status = 'done';
        task.message = plan.message || (task.lang === 'vi' ? 'Hoàn thành.' : 'Done.');
        push(task, 'done', { message: task.message });
        return;
      }
      if (plan.ask_user) {
        task.status = 'waiting_user';
        task.message = plan.message || plan.ask_user;
        push(task, 'ask_user', { message: task.message });
        return;
      }
      task.status = 'failed';
      task.message = 'No action planned';
      push(task, 'failed', { message: task.message });
      return;
    }

    for (const action of actions) {
      if (!action || !action.type) continue;
      if (action.type === 'done') {
        task.status = 'done';
        task.message = action.message || plan.message || 'Done.';
        push(task, 'done', { message: task.message });
        return;
      }
      if (action.type === 'ask_user' || action.type === 'fail') {
        task.status = action.type === 'fail' ? 'failed' : 'waiting_user';
        task.message = action.message || plan.message || action.type;
        push(task, action.type === 'fail' ? 'failed' : 'ask_user', { message: task.message });
        return;
      }

      const el = obs.elements && action.id != null ? obs.elements.find((e) => e.id === Number(action.id)) : null;
      const risk = actionRisk(action, el && el.label);
      if (risk === 'high' && !task.trustLowRisk) {
        task.status = 'waiting_confirmation';
        task.confirmation = {
          id: crypto.randomBytes(8).toString('hex'),
          text:
            (task.lang === 'vi' ? 'Xác nhận hành động rủi ro: ' : 'Confirm risky action: ') +
            action.type +
            (el ? ' — ' + clip(el.label, 80) : '')
        };
        task.pendingAction = action;
        task.message = task.confirmation.text;
        push(task, 'confirm', { message: task.message, risk });
        return;
      }

      push(task, 'step', { n: i + 1, action: { type: action.type, id: action.id } });
      let out;
      try {
        out = await executeAction(task, session, action, obs);
      } catch (e) {
        out = { ok: false, result: clip(e.message || e, 200) };
      }

      await waitStable(session);
      const obs2 = await observeSession(session, task.readOffset || 0);
      const hash2 = observer.hashObservation(obs2);
      const noEffect = hash2 === obsHash && action.type !== 'wait' && action.type !== 'note' && action.type !== 'read';
      task.history.push({
        step: i + 1,
        action: action.type,
        result: clip(out.result, 500),
        ok: !!out.ok,
        no_effect: noEffect,
        url: obs2.url
      });
      if (task.history.length > 40) task.history = task.history.slice(-30);

      recentHashes.push(obsHash + '|' + action.type);
      if (recentHashes.length > 12) recentHashes.shift();
      // Stuck: same observation hash + same action type N times
      const stuckKey = hash2 + '|' + action.type;
      const stuckCount = recentHashes.filter((h) => h.endsWith('|' + action.type) && h.startsWith(hash2)).length;
      // simpler: count consecutive identical state hashes after actions
      const lastStates = task.history.slice(-STUCK_N).map((h) => h.url + (h.no_effect ? ':ne' : ''));
      if (noEffect) {
        push(task, 'status', { message: 'no_effect', n: i + 1 });
      }

      obs = obs2;
      if (out.ok === false && /login_requires_engine|blocked_secret/.test(String(out.result))) {
        task.status = 'waiting_user';
        task.message =
          task.lang === 'vi'
            ? 'Cần thao tác thủ công (engine/noVNC hoặc Open ↗). Không gửi mật khẩu cho AI.'
            : 'Manual action needed (engine/noVNC or Open ↗). Never send passwords to AI.';
        push(task, 'ask_user', { message: task.message });
        return;
      }
      // Early stop multi-action if page changed significantly
      if (obs2.url !== (session.url || obs.url) && actions.indexOf(action) < actions.length - 1) {
        session.url = obs2.url;
        break;
      }
      session.url = obs2.url || session.url;
    }
  }
  task.status = 'limit';
  task.message =
    task.lang === 'vi'
      ? 'Hết số bước. Bấm Tiếp tục để resume (bộ nhớ nhiệm vụ được giữ).'
      : 'Step limit reached. Tap Continue to resume (task memory kept).';
  push(task, 'status', { message: task.message });
  persistTaskDisk(task);
}

async function start({ ai, session, task: taskText, lang, history, maxSteps, maxMs, workMemory, resumeTaskId }) {
  for (const [id, old] of tasks) if (Date.now() - old.updatedAt > TASK_TTL_MS) {
    tasks.delete(id);
    try { fs.unlinkSync(path.join(TASK_DIR, id + '.json')); } catch (_) {}
  }
  for (const active of tasks.values()) {
    if (active.sessionId === session.id && ['running', 'waiting_confirmation', 'stopping'].includes(active.status)) {
      active.stop = true;
      active.status = 'stopped';
      active.message = 'Superseded by new task';
    }
  }

  let restored = null;
  if (resumeTaskId) restored = loadTaskDisk(resumeTaskId);

  const taskTextClean = clip(taskText || (restored && restored.task) || '', 1500).trim();
  if (!taskTextClean) throw new Error('task_required');
  while (tasks.size >= MAX_TASKS) tasks.delete(tasks.keys().next().value);

  const steps = Math.min(AGENT_MAX_STEPS, Math.max(1, Number(maxSteps) || Number(restored && restored.maxSteps) || 40));
  const ms = Math.min(3 * 3600000, Math.max(60000, Number(maxMs) || Number(restored && restored.maxMs) || 3600000));

  const task = {
    id: (restored && restored.id) || crypto.randomBytes(16).toString('hex'),
    sessionId: session.id,
    session,
    task: taskTextClean,
    lang: lang === 'vi' ? 'vi' : 'en',
    history: Array.isArray(history) && history.length ? history.slice(-20) : (restored && restored.history) || [],
    maxSteps: steps,
    maxMs: ms,
    workMemory: workMemory && typeof workMemory === 'object' ? workMemory : (restored && restored.workMemory) || { findings: [], visited: [], notes: [], todo: [] },
    plan: (restored && restored.plan) || null,
    status: 'running',
    message: '',
    error: '',
    events: [],
    eventSeq: 0,
    updatedAt: Date.now(),
    startedAt: Date.now(),
    stop: false,
    confirmation: null,
    urlStack: session.url ? [session.url] : (restored && restored.urlStack) || [],
    urlIndex: 0,
    readOffset: 0
  };
  task.ai = ai;
  tasks.set(task.id, task);
  persistTaskDisk(task);
  push(task, 'status', { message: task.lang === 'vi' ? 'Bắt đầu nhiệm vụ…' : 'Starting task…' });
  setImmediate(() => {
    runTask(ai, task).catch((e) => {
      task.status = 'failed';
      task.error = clip(e.message || e, 200);
      task.message = task.error;
      push(task, 'failed', { message: task.message });
    });
  });
  return publicTask(task);
}

async function confirm(taskId, sessionId, confirmationId, accepted) {
  const task = getTask(taskId, sessionId);
  if (!task) return null;
  if (!task.confirmation || task.confirmation.id !== confirmationId) return publicTask(task);
  task.confirmation = null;
  if (!accepted) {
    task.status = 'stopped';
    task.message = task.lang === 'vi' ? 'Đã từ chối hành động.' : 'Action declined.';
    push(task, 'status', { message: task.message });
    return publicTask(task);
  }
  task.status = 'running';
  const action = task.pendingAction;
  task.pendingAction = null;
  setImmediate(async () => {
    try {
      if (action) {
        const obs = await observeSession(task.session, task.readOffset || 0);
        await executeAction(task, task.session, action, obs);
      }
      await runTask(task.ai, task);
    } catch (e) {
      task.status = 'failed';
      task.message = clip(e.message || e, 200);
      push(task, 'failed', { message: task.message });
    }
  });
  // Re-run needs ai — store on task
  return publicTask(task);
}

function stop(taskId, sessionId) {
  const task = getTask(taskId, sessionId);
  if (!task) return null;
  task.stop = true;
  task.status = 'stopping';
  return publicTask(task);
}

module.exports = {
  start,
  getTask,
  publicTask,
  stop,
  confirm,
  observeSession,
  observeHtmlFallback,
  summarizeWorkMemory,
  actionRisk,
  AGENT_MAX_STEPS
};
