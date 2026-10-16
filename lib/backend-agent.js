'use strict';
const netGuard = require('./net-guard');

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
const agentReport = require('./agent-report');
const agentEvidence = require('./agent-evidence');
const researchTools = require('./agent-research-tools');
const agentSearch = require('./agent-search');
const agentRunner = require('./agent-runner');
const agentIntent = require('./agent-intent');
const agentLinks = require('./agent-links');
const newsDigest = require('./agent-playbooks/news_digest');
const compareProducts = require('./agent-playbooks/compare_products');
const taskAnalyzer = require('./agent-task-analyzer');
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
      brief: task.brief || task.task,
      spec: task.spec || null,
      clarifications: task.clarifications || [],
      checklist: task.checklist || null,
      sourcesStatus: task.sourcesStatus || {},
      errors: task.errors || [],
      browserSessionId: task.browserSessionId || null,
      lang: task.lang,
      status: task.status,
      message: task.message,
      report: task.report || null,
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
    return (i + 1) + '. ' + clip(f.fact || f.text || JSON.stringify(f), 500) + (f.url ? ' [' + f.url + ']' : '') + (f.evidenceId ? ' [' + f.evidenceId + ']' : '');
  });
  const lines = [];
  if (wm.todo && wm.todo.length) lines.push('TODO: ' + wm.todo.slice(0, 8).join('; '));
  if (wm.visited && wm.visited.length) lines.push('VISITED: ' + wm.visited.slice(-10).join(' | '));
  if (wm.searchCandidates && wm.searchCandidates.length) lines.push('SEARCH CANDIDATES (not evidence until opened):\n' + wm.searchCandidates.slice(-8).map((x) => '[' + x.rank + '] ' + clip(x.title, 120) + ' — ' + x.url + (x.snippet ? ' — ' + clip(x.snippet, 180) : '')).join('\n'));
  // Task errors are diagnostics, never findings. They are surfaced only in scope/limitations.
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
  return netGuard.assertPublicHttpUrl(url);
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
    if ((tag === 'input' || tag === 'textarea') && !SECRET.test([type, at.name, at.id, at.placeholder].join(' '))) {
      e.value = clip(at.value || '', 60);
    }
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
        try {
          const content = await pw.getContent(session.pwSessionId, { force: false });
          if (content) {
            session.html = content.html || session.html;
            session.title = content.title || session.title;
            session.url = content.url || session.url;
          }
        } catch (_) {}
        // Set-of-Mark style viewport shot for vision models (optional, capped size)
        const vision = String(process.env.AGENT_VISION || 'auto').toLowerCase();
        const wantVision = vision === 'on' || (vision === 'auto' && live.elements && live.elements.length < 5 && !(live.text && live.text.length > 400));
        if (wantVision && typeof pw.captureThumbnail === 'function') {
          try {
            const shot = await pw.captureThumbnail(session.pwSessionId, { quality: 40 });
            if (shot && shot.length < 180000) live.screenshotDataUrl = shot;
          } catch (_) {}
        }
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
    sourcesStatus: task.sourcesStatus || {}, checklist: task.checklist || null, errors: (task.errors || []).slice(-12),
    report: task.report || null,
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
      const ok = !!(r && !r.error && r.hasContent !== false && r.backend !== 'proxy-error');
      const domain = agentEvidence.domainOf((r && r.url) || url);
      task.sourcesStatus = task.sourcesStatus || {};
      if (domain) task.sourcesStatus[domain] = ok
        ? { status: 'ok', reason: 'navigation_succeeded', at: new Date().toISOString() }
        : { status: 'failed', reason: clip((r && r.error) || 'navigation_failed_or_empty_content', 180), at: new Date().toISOString() };
      if (ok && r && r.url) {
        task.urlStack = task.urlStack.slice(0, task.urlIndex + 1);
        task.urlStack.push(r.url);
        task.urlIndex = task.urlStack.length - 1;
        task.workMemory = task.workMemory || {};
        task.workMemory.visited = (task.workMemory.visited || []).concat([r.url]).slice(-30);
      }
      return { ok, result: ok ? (r.url || url) : ((r && r.error) || 'navigation_failed_or_empty_content'), state: r };
    }
    case 'search': {
      const query = String(action.query || '').trim();
      if (!query) throw new Error('search needs "query"');
      let engine = String(action.engine || process.env.SOLOHOST_DEFAULT_SEARCH || 'bing').toLowerCase();
      if (!['youtube', 'bing', 'google', 'ddg', 'brave'].includes(engine)) engine = 'bing';
      let url;
      if (engine === 'youtube') url = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(query);
      else if (engine === 'bing') url = 'https://www.bing.com/search?q=' + encodeURIComponent(query);
      else if (engine === 'ddg') url = 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query);
      else if (engine === 'brave') url = 'https://search.brave.com/search?q=' + encodeURIComponent(query);
      else url = 'https://www.google.com/search?q=' + encodeURIComponent(query);
      if (engine !== 'youtube') {
        const preferred = engine === 'google' ? ['bing', 'ddg', 'brave'] : [engine, ...['bing','ddg','brave'].filter(x => x !== engine)];
        task.searchEngineBlockedMap = task.searchEngineBlockedMap || {};
        if (Array.isArray(task.searchEngineBlocked)) {
          for (const e of task.searchEngineBlocked) task.searchEngineBlockedMap[e] = Date.now() + 20 * 60 * 1000;
        }
        const found = await agentSearch.searchWeb(query, {
          engines: preferred, timeoutMs: 3200, limit: 10, blockedMap: task.searchEngineBlockedMap
        });
        task.searchEngineBlocked = Object.keys(task.searchEngineBlockedMap).filter((k) => task.searchEngineBlockedMap[k] > Date.now());
        appLog.log('info', 'agent.search', { outcome: found.outcome || (found.results && found.results.length ? 'ok' : 'empty'), engine: found.engine, ms: found.ms, blocked: found.blocked || [], n: (found.results || []).length });
        if (found.results && found.results.length) {
          task.workMemory = task.workMemory || { findings: [], visited: [], notes: [], todo: [] };
          const candidateChecks = await agentLinks.verifyLinks(found.results.slice(0, 4).map(x => x.url), { cache: task.linkVerifyCache || (task.linkVerifyCache = new Map()), timeoutMs: 3500, concurrency: 4 });
          const checkedByUrl = new Map(candidateChecks.map(x => [x.url, x]));
          task.workMemory.searchCandidates = found.results.map(x => Object.assign({}, x, { linkCheck: checkedByUrl.get(agentLinks.canonicalizeUrl(x.url)) || null }));
          task.searchEngineBlocked = [...new Set([...(task.searchEngineBlocked || []), ...(found.blocked || [])])];
          for (const item of task.workMemory.searchCandidates) agentEvidence.addEvidence(task.id, { kind: 'serp', url: item.url, title: item.title, snippet: (item.snippet || '') + (item.linkCheck ? ` [link check: ${item.linkCheck.ok ? 'ok' : item.linkCheck.reason || 'unverified'}]` : ''), text: item.snippet || '', source: item.site });
          const summary = task.workMemory.searchCandidates.map((x, i) => `${i + 1}. ${x.title} — ${x.url}${x.snippet ? ' — ' + x.snippet : ''}${x.linkCheck ? ' [link: ' + (x.linkCheck.ok ? 'reachable' : 'not verified') + ']' : ''}`).join('\n');
          return { ok: true, result: `Structured search via ${found.engine}; ${found.results.length} candidates. Search snippets are candidates only; open pages before making factual claims.\n${summary}`, state: { url, title: `Search: ${query}`, text: summary, searchResults: found.results, engine: found.engine, blocked: found.blocked || [] } };
        }
        task.errors = task.errors || [];
        task.errors.push({
          at: new Date().toISOString(),
          step: task.history.length + 1,
          message: 'Structured search ' + (found.outcome || 'empty') + ': ' + (found.error || 'no results'),
          enginesBlocked: found.blocked || []
        });
        if (found.outcome === 'blocked') {
          return {
            ok: false,
            outcome: 'blocked',
            result: 'search_blocked: all public engines challenged; open a retailer URL directly or ask user to verify in Live view — do NOT conclude product is unavailable',
            state: { blocked: found.blocked || [], outcome: 'blocked' }
          };
        }
        if (found.outcome === 'empty') {
          return {
            ok: false,
            outcome: 'empty',
            result: 'search_empty: engines reachable but no results for query; try direct retailer catalog',
            state: { outcome: 'empty' }
          };
        }
      }
      await assertSafeUrl(url);
      const r = await domBridge.navigate(session, url);
      if (r && r.url && /google\.com\/sorry|captcha|verify/i.test(r.url)) {
        task.errors = task.errors || []; task.errors.push({ at: new Date().toISOString(), message: 'Search engine blocked/verification page; switched to structured fallback where possible.' });
        return { ok: false, result: 'search_engine_blocked; do not retry this engine, use another public search engine or direct official source', state: r };
      }
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
          task.workMemory = task.workMemory || { findings: [], sources_status: {} };
          const ev = agentEvidence.addEvidence(task.id, {
            url: data.url || session.url,
            title: data.title || '',
            text: data.text || summary,
            snippet: (data.headings || []).slice(0, 6).join(' · '),
            kind: 'page'
          });
          task.workMemory.findings = (task.workMemory.findings || []).concat([{
            fact: clip(summary, 2500),
            url: data.url || session.url,
            evidenceId: ev.id,
            step: task.history.length
          }]).slice(-30);
          task.workMemory.lastUrl = data.url || session.url;
          const domain = agentEvidence.domainOf(data.url || session.url);
          if (domain) {
            task.workMemory.sources_status = task.workMemory.sources_status || {};
            task.workMemory.sources_status[domain] = { status: 'ok', reason: 'extract_page' };
          }
          return { ok: true, result: '[' + ev.id + '] ' + clip(summary, 6000) };
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

    
    case 'fetch_feed': {
      try {
        let feedUrl = String(action.url || session.url || '').trim();
        if (!feedUrl) return { ok: false, result: 'fetch_feed needs url' };
        await assertSafeUrl(feedUrl);
        let items = [];
        try {
          const res = await researchTools.safeFetch(feedUrl);
          items = researchTools.parseFeed(res.body, res.url);
          if (!items.length && /html/i.test(res.contentType || '')) {
            const alts = researchTools.discoverFeedLinks(res.body, res.url);
            for (const alt of alts.slice(0, 3)) {
              try {
                const r2 = await researchTools.safeFetch(alt);
                items = researchTools.parseFeed(r2.body, r2.url);
                if (items.length) { feedUrl = r2.url; break; }
              } catch (_) {}
            }
          }
        } catch (e) {
          return { ok: false, result: clip(e.message || e, 200) };
        }
        task.workMemory = task.workMemory || { findings: [], sources_status: {} };
        const lines = [];
        for (const it of items.slice(0, 20)) {
          const ev = agentEvidence.addEvidence(task.id, {
            url: it.url, title: it.title, publishedAt: it.publishedAt,
            snippet: it.summary, text: it.summary, kind: 'feed'
          });
          task.workMemory.findings = (task.workMemory.findings || []).concat([{
            fact: it.title + (it.publishedAt ? ' (' + it.publishedAt + ')' : ''),
            url: it.url, evidenceId: ev.id
          }]).slice(-40);
          lines.push('[' + ev.id + '] ' + it.title + ' | ' + (it.publishedAt || '?') + ' | ' + it.url);
        }
        const domain = agentEvidence.domainOf(feedUrl);
        if (domain) task.workMemory.sources_status[domain] = { status: 'ok', reason: 'feed', count: items.length };
        return { ok: true, result: lines.length ? lines.join('\n') : 'no_feed_items' };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'extract_articles': {
      try {
        const html = session.html || '';
        const pageUrl = session.url || '';
        const list = researchTools.extractArticlesFromHtml(html, pageUrl);
        task.workMemory = task.workMemory || { findings: [] };
        const lines = [];
        for (const it of list.slice(0, 20)) {
          const ev = agentEvidence.addEvidence(task.id, {
            url: it.url, title: it.title, publishedAt: it.time, snippet: it.title, kind: 'article'
          });
          lines.push('[' + ev.id + '] ' + it.title + ' → ' + it.url);
        }
        return { ok: true, result: lines.join('\n') || 'no_articles_found' };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'read_article': {
      try {
        const u = String(action.url || '').trim();
        if (!u) return { ok: false, result: 'read_article needs url' };
        await assertSafeUrl(u);
        const res = await researchTools.safeFetch(u);
        const meta = researchTools.extractArticleMeta(res.body, res.url);
        const ev = agentEvidence.addEvidence(task.id, {
          url: res.url, title: meta.title, publishedAt: meta.publishedAt,
          text: meta.text, snippet: meta.text.slice(0, 400), kind: 'article'
        });
        task.workMemory = task.workMemory || { findings: [], sources_status: {} };
        task.workMemory.findings = (task.workMemory.findings || []).concat([{
          fact: meta.title + (meta.publishedAt ? ' @' + meta.publishedAt : ''),
          url: res.url, evidenceId: ev.id
        }]).slice(-40);
        const domain = agentEvidence.domainOf(res.url);
        if (domain) task.workMemory.sources_status[domain] = { status: 'ok', reason: 'read_article' };
        return {
          ok: true,
          result: '[' + ev.id + '] ' + meta.title + '\n' + (meta.publishedAt || '') + '\n' + researchTools.clip(meta.text, 4000)
        };
      } catch (e) {
        return { ok: false, result: clip(e.message || e, 200) };
      }
    }
    case 'open_many': {
      const urls = Array.isArray(action.urls) ? action.urls.slice(0, 8) : [];
      const lines = [];
      const runOne = async (u) => {
        try {
          await assertSafeUrl(u);
          const res = await researchTools.safeFetch(u);
          const meta = researchTools.extractArticleMeta(res.body, res.url);
          const ev = agentEvidence.addEvidence(task.id, {
            url: res.url, title: meta.title, publishedAt: meta.publishedAt,
            text: meta.text, snippet: meta.text.slice(0, 400), kind: 'article'
          });
          lines.push('[' + ev.id + '] ' + meta.title + ' | ' + (meta.publishedAt || '?') + ' | ' + res.url);
        } catch (e) {
          lines.push('FAIL ' + u + ' ' + String(e.message || e).slice(0, 80));
        }
      };
      // sequential with small batches of 3
      for (let i = 0; i < urls.length; i += 3) {
        await Promise.all(urls.slice(i, i + 3).map(runOne));
      }
      return { ok: lines.some((l) => l.startsWith('[E')), result: lines.join('\n') };
    }
    case 'recall': {
      const hits = agentEvidence.recall(task.id, { query: action.query, id: action.id, url: action.url });
      if (!hits.length) return { ok: true, result: 'no_evidence_match' };
      return {
        ok: true,
        result: hits.map((h) => '[' + h.id + '] ' + h.title + ' | ' + (h.publishedAt || '?') + '\n' + h.snippet + '\n' + h.url).join('\n\n')
      };
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


async function ensureTaskBrowserSession(task) {
  if (task && task.session && task.browserSessionId) return task.session;
  const created = await domBridge.createSession({ tabKey: 'agent-' + task.id.slice(0, 48), clientKey: 'agent-profile', privateMode: false, persist: true, locale: task.lang === 'vi' ? 'vi-VN' : 'en-US', timezoneId: process.env.TZ || 'UTC' });
  const isolated = domBridge.authSession(created.sessionId, created.token);
  if (!isolated) throw new Error('agent_bridge_session_auth_failed');
  task.session = isolated; task.browserSessionId = isolated.id; task.urlStack = []; task.urlIndex = -1;
  try {
    const pe = require('./engine/playwright-engine');
    const pwId = isolated.pwSessionId || isolated.engineSessionId;
    if (pwId && pe.sessions) {
      /* sessions map may not export — use acquireLease via get if available */
    }
    if (typeof pe.acquireLease === 'function' && isolated.pwSessionId) {
      const s = pe.sessions && pe.sessions.get && pe.sessions.get(isolated.pwSessionId);
      // fallback: mark via navigate touch by getState
    }
  } catch (_) {}
  try {
    const pe = require('./engine/playwright-engine');
    if (isolated.pwSessionId) {
      // Soft-pin through engine API if exposed
      const st = pe.getSession && pe.getSession(isolated.pwSessionId);
      if (st) { st.agentPinned = true; pe.acquireLease && pe.acquireLease(st, 'agent'); }
    }
  } catch (_) {}
  return isolated;
}

async function releaseAgentSession(task) {
  const id = task && task.browserSessionId;
  if (!id) return;
  task.browserSessionId = null;
  try { await domBridge.destroySession(id); } catch (_) {}
  task.session = null;
  persistTaskDisk(task);
}


/** Fast parallel product-price path — no LLM micro-steps for retailer fetches. */
async function runCompareProductsParallel(task) {
  const retail = require('./agent-sources/vn-retail');
  const { safeFetch } = require('./agent-research-tools');
  const query = (String(task.task || '').match(/(?:iphone|samsung|pixel|macbook|ipad)[^,]{0,40}/i) || ['product'])[0].trim();
  const matched = retail.matchRetailersInText(task.task);
  const list = (matched.length ? matched : retail.defaultPhoneRetailers()).slice(0, 5);
  const jobs = list.map((r, i) => agentRunner.createJob(
    'retail-' + r.id,
    r.name,
    async () => {
      const url = r.searchUrl(query);
      await assertSafeUrl(url);
      const res = await safeFetch(url, { timeoutMs: 12000 });
      if (!res || !res.ok) {
        const err = new Error('fetch_failed_' + (res && res.status));
        err.blocked = res && res.status === 403;
        throw err;
      }
      const body = String(res.body || '');
      if (/captcha|verify you are human|unusual traffic/i.test(body.slice(0, 8000))) {
        const err = new Error('blocked_challenge');
        err.blocked = true;
        throw err;
      }
      const offers = retail.extractProductOffers(body, res.url || url);
      // Heuristic price from visible text if no JSON-LD
      let priceText = null;
      const pm = body.match(/(?:(?:đ|đ\s*|VND|₫)\s*)?([0-9]{1,3}(?:[.,][0-9]{3}){1,3})\s*(?:đ|₫|VND)?/i);
      if (pm) priceText = pm[1];
      return {
        retailer: r.name,
        host: r.host,
        url: res.url || url,
        offers: offers.slice(0, 5),
        priceHint: offers[0] && offers[0].price ? offers[0].price : priceText,
        title: offers[0] && offers[0].title ? offers[0].title : query,
        at: new Date().toISOString()
      };
    },
    { retailer: r.id }
  ));

  push(task, 'status', {
    message: task.lang === 'vi'
      ? 'Đang lấy giá song song từ ' + list.length + ' nhà bán…'
      : 'Fetching prices in parallel from ' + list.length + ' retailers…'
  });

  const batch = await agentRunner.runParallel(jobs, {
    concurrency: 3,
    timeoutMs: 20000,
    onProgress: (job) => {
      appLog.log('info', 'agent.subtask', {
        task: task.id, id: job.id, status: job.status, ms: job.ms, label: job.label
      });
    }
  });

  task.workMemory = task.workMemory || { findings: [], sources_status: {} };
  const rows = [];
  for (const job of batch.jobs) {
    const host = (job.meta && job.meta.retailer) || job.id;
    if (job.status === 'succeeded' && job.result) {
      task.workMemory.sources_status[job.result.host] = { status: 'ok', reason: 'parallel_fetch' };
      task.sourcesStatus = task.sourcesStatus || {};
      task.sourcesStatus[job.result.host] = { status: 'ok', reason: 'parallel_fetch' };
      task.workMemory.findings = (task.workMemory.findings || []).concat([{
        fact: (job.result.title || '') + ' @ ' + (job.result.priceHint || 'n/a') + ' — ' + job.result.retailer,
        url: job.result.url,
        step: task.history.length
      }]).slice(-40);
      try {
        agentEvidence.addEvidence(task.id, {
          type: 'price_observation',
          url: job.result.url,
          claim: job.result.priceHint || null,
          title: job.result.title,
          retailer: job.result.retailer
        });
      } catch (_) {}
      rows.push(job.result);
    } else {
      const st = {
        status: /block/i.test(job.error || '') ? 'blocked' : 'failed',
        reason: job.error || job.status
      };
      task.workMemory.sources_status[host] = st;
      task.sourcesStatus = task.sourcesStatus || {};
      task.sourcesStatus[host] = st;
    }
  }

  const okRows = rows.filter((r) => r.priceHint);
  let report;
  if (task.lang === 'vi') {
    report = '## So sánh giá (song song)\n\nTruy vấn: **' + query + '**\n\n';
    report += '| Nhà bán | Giá quan sát | Link | Trạng thái |\n|---|---|---|---|\n';
    for (const job of batch.jobs) {
      if (job.status === 'succeeded' && job.result) {
        report += '| ' + job.result.retailer + ' | ' + (job.result.priceHint || '—') + ' | ' + job.result.url + ' | ✓ |\n';
      } else {
        report += '| ' + job.label + ' | — | — | ' + (job.status === 'timed_out' ? 'timeout' : (job.error || job.status)) + ' |\n';
      }
    }
    report += '\n### Phạm vi & hạn chế\n';
    if (!okRows.length) {
      report += '- Chưa lấy được giá xác minh (nguồn chặn/timeout). **Không kết luận chỗ rẻ nhất.**\n';
      report += '- Thử Open ↗ từng cửa hàng hoặc xác minh thủ công, rồi bấm Tiếp tục.\n';
    } else {
      report += '- Chỉ so sánh các dòng có giá quan sát được; giá có thể là niêm yết, chưa gồm KM.\n';
      report += '- Thời điểm lấy: ' + new Date().toISOString() + '\n';
    }
  } else {
    report = '## Price comparison (parallel)\n\nQuery: **' + query + '**\n\n';
    report += '| Retailer | Observed price | Link | Status |\n|---|---|---|---|\n';
    for (const job of batch.jobs) {
      if (job.status === 'succeeded' && job.result) {
        report += '| ' + job.result.retailer + ' | ' + (job.result.priceHint || '—') + ' | ' + job.result.url + ' | ok |\n';
      } else {
        report += '| ' + job.label + ' | — | — | ' + (job.error || job.status) + ' |\n';
      }
    }
    report += '\n### Scope & limits\n';
    if (!okRows.length) {
      report += '- No verified prices (blocked/timeout). **Do not claim a cheapest store.**\n';
    } else {
      report += '- Only rows with observed prices are comparable; promo conditions may differ.\n';
    }
  }

  task.status = okRows.length ? (batch.failed.length ? 'partial' : 'done') : 'partial';
  task.message = report;
  task.history.push({
    thought: 'parallel_retail_fetch',
    action: { type: 'parallel_fetch', query },
    result: 'ok=' + batch.summary.ok + ' failed=' + batch.summary.failed,
    ok: okRows.length > 0,
    url: null
  });
  push(task, 'done', { message: report, status: task.status, summary: batch.summary });
  persistTaskDisk(task);
  return task;
}


async function runTask(ai, task) {
  try {
    if (!task.checklist && compareProducts && compareProducts.matchCompareIntent(task.task)) {
      task.checklist = compareProducts.buildChecklist(task.task, task.lang);
      task.playbook = 'compare_products';
      // Prefer deterministic parallel retail fetches over LLM micro-navigation
      try {
        await runCompareProductsParallel(task);
        return;
      } catch (e) {
        appLog.log('warn', 'agent.compare_parallel_fail', { error: String(e.message || e).slice(0, 200) });
        // fall through to LLM loop
      }
      task.workMemory = task.workMemory || { findings: [], todo: [], sources_status: {} };
      task.workMemory.todo = (task.checklist.sources || []).map((s) => 'cover retailer ' + s);
    }
  } catch (_) {}

  const recentHashes = [];
  const deadline = (task.startedAt || Date.now()) + (task.maxMs || 3600000);
  for (let i = 0; i < task.maxSteps; i++) {
    if (task.stop) {
      task.status = 'stopped';
      task.message = task.lang === 'vi' ? 'Đã dừng tác vụ.' : 'Task stopped.';
      push(task, 'status', { message: task.message });
      await releaseAgentSession(task);
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
        task: task.brief || task.task,
        spec: task.spec,
        clarifications: task.clarifications || [],
        observation: obs,
        history: task.history,
        step: i + 1,
        maxSteps: task.maxSteps,
        workMemory: task.workMemory,
        workMemoryText: summarizeWorkMemory(task.workMemory) + '\n' + agentEvidence.ledgerPromptBlock(task.id),
        nowIso: new Date().toISOString(),
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
      await releaseAgentSession(task);
      return;
    }

    if (plan.plan) task.plan = plan.plan;
    if (plan.thought) task.history.push({ step: i + 1, thought: clip(plan.thought, 400) });

    // Multi-action: up to 4 safe actions; terminal actions (done/ask/fail) must stand alone
    let actions = Array.isArray(plan.actions) && plan.actions.length
      ? plan.actions.slice(0, 4)
      : plan.action
        ? [plan.action]
        : [];
    actions = actions.map((a) => { if (!a || !['error','exception','unknown'].includes(String(a.type || '').toLowerCase())) return a; task.errors = task.errors || []; task.errors.push({ at: new Date().toISOString(), step: i + 1, message: clip(a.message || a.reason || ('Planner returned ' + a.type), 180) }); return { type: 'wait', ms: 700, _recoveredFrom: a.type }; });
    const terminal = actions.filter((a) => a && ['done', 'ask_user', 'fail'].includes(a.type));
    const nonTerm = actions.filter((a) => a && !['done', 'ask_user', 'fail'].includes(a.type));
    if (terminal.length && nonTerm.length) {
      // Prefer doing real work first; defer done to next loop after observation
      actions = nonTerm;
    } else if (terminal.length) {
      actions = [terminal[0]];
    }

    if (!actions.length) {
      if (plan.done) {
        task.status = 'done';
        const fin = agentReport.finalizeDoneMessage(task, plan.message || plan.summary || '');
        task.message = fin.message;
        task.report = fin.report;
        push(task, 'done', { message: task.message, report: task.report });
        await releaseAgentSession(task);
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
      task.errors = task.errors || []; task.errors.push({ at: new Date().toISOString(), step: i + 1, message: task.message });
      push(task, 'failed', { message: task.message });
      await releaseAgentSession(task);
      return;
    }

    for (const action of actions) {
      if (!action || !action.type) continue;
      if (action.type === 'done') {
        const rawSummary = action.summary || action.message || plan.message || plan.thought || '';
        const checklist = task.checklist || null;
        const visitedDomains = new Set((task.workMemory && task.workMemory.visited || []).map((u) => {
          try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; }
        }).filter(Boolean));
        const ledgerCount = agentEvidence.loadLedger(task.id).length;
        const stepsLeft = (task.maxSteps || 40) - (i + 1);
        if (checklist && Array.isArray(checklist.sources) && checklist.sources.length && stepsLeft > 0) {
          const sourceStatus = task.sourcesStatus || {};
          const missing = checklist.sources.filter((s) => {
            const d = String(s).toLowerCase().replace(/^www\./, '');
            const visited = [...visitedDomains].some((v) => v === d || v.endsWith('.' + d) || d.endsWith('.' + v));
            const statusKey = Object.keys(sourceStatus).find(h => h === d || h.endsWith('.' + d) || d.endsWith('.' + h));
            const status = statusKey && sourceStatus[statusKey];
            return !visited && !(status && ['failed','blocked'].includes(status.status) && String(status.reason || '').trim());
          });
          if (missing.length) {
            task.workMemory = task.workMemory || {};
            task.workMemory.todo = (task.workMemory.todo || []).concat(missing.map((m) => 'cover source ' + m)).slice(-20);
            task.noProgressDoneAttempts = (task.noProgressDoneAttempts || 0) + 1;
            if (task.noProgressDoneAttempts < 2 && stepsLeft > 1) {
              task.message = task.lang === 'vi'
                ? 'Còn thiếu nguồn bắt buộc: ' + missing.slice(0, 5).join(', ') + '. Đang thử lại bằng công cụ đọc nguồn.'
                : 'Required sources still missing: ' + missing.slice(0, 5).join(', ') + '. Retrying with source-reading tools.';
              push(task, 'status', { message: task.message, missingSources: missing.slice(0, 10), retry: task.noProgressDoneAttempts });
              continue;
            }
            // Never loop forever on unavailable sources: mark them blocked with a reason and finalize a partial report.
            task.sourcesStatus = task.sourcesStatus || {};
            for (const source of missing) {
              const d = String(source).toLowerCase().replace(/^www\./, '');
              const k = Object.keys(task.sourcesStatus).find(h => h === d || h.endsWith('.' + d) || d.endsWith('.' + h));
              if (!k || !['failed','blocked'].includes(task.sourcesStatus[k].status)) {
                task.sourcesStatus[d] = { status: 'blocked', reason: 'Source was not successfully reached within the task step budget.', at: new Date().toISOString() };
              }
            }
            push(task, 'status', { message: task.lang === 'vi'
              ? 'Một số nguồn chưa truy cập được sau khi thử lại. Đang hoàn tất báo cáo một phần và ghi rõ hạn chế.'
              : 'Some sources remained unavailable after retry. Finalizing a partial report with explicit limitations.', missingSources: missing.slice(0, 10) });
          }
        }
        task.status = 'done';
        const fin = agentReport.finalizeDoneMessage(task, rawSummary);
        task.message = fin.message;
        task.report = fin.report;
        task.lastDoneSummary = rawSummary;
        push(task, 'done', { message: task.message, report: task.report });
        await releaseAgentSession(task);
        return;
      }
      if (action.type === 'ask_user' || action.type === 'fail') {
        task.status = action.type === 'fail' ? 'failed' : 'waiting_user';
        task.message = terminalMessage(action, plan);
        if (action.type === 'fail') { task.errors = task.errors || []; task.errors.push({ at: new Date().toISOString(), step: i + 1, message: task.message }); }
        push(task, action.type === 'fail' ? 'failed' : 'ask_user', { message: task.message, question: action.question || action.message || '', options: Array.isArray(action.options) ? action.options : [], kind: action.kind || 'clarify' });
        if (action.type === 'fail') await releaseAgentSession(task);
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
      const preUrl = session.url || (obs && obs.url) || '';
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
        thought: plan.thought ? clip(plan.thought, 400) : undefined,
        action: {
          type: action.type,
          id: action.id,
          url: action.url,
          query: action.query,
          text: action.text ? String(action.text).slice(0, 80) : undefined,
          key: action.key,
          engine: action.engine
        },
        result: clip(out.result, 1200),
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
      // Early stop multi-action if URL changed by this action (compare pre/post)
      const urlBefore = preUrl || session.url || obs.url;
      if (obs2.url && urlBefore && obs2.url !== urlBefore && actions.indexOf(action) < actions.length - 1) {
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

function terminalMessage(action, plan) {
  const a = action || {}; const p = plan || {};
  return String(a.question || a.message || a.text || a.reason || p.question || p.message || p.text || (a.type === 'fail' ? 'Agent could not complete the task.' : 'Please clarify the next step.')).trim();
}

async function start({ ai, session, task: taskText, lang, history, maxSteps, maxMs, workMemory, resumeTaskId }) {
  for (const [id, old] of tasks) if (Date.now() - old.updatedAt > TASK_TTL_MS) {
    tasks.delete(id);
    try { fs.unlinkSync(path.join(TASK_DIR, id + '.json')); } catch (_) {}
  }
  // A client cannot inject history or work memory into another task. Resume only a task
  // already owned by this authenticated browser session (memory/disk state is server-owned).
  let restored = null;
  if (resumeTaskId) {
    const activeResume = tasks.get(String(resumeTaskId));
    if (activeResume && activeResume.sessionId === session.id) restored = activeResume;
    else {
      const diskResume = loadTaskDisk(resumeTaskId);
      if (diskResume && diskResume.sessionId === session.id) restored = diskResume;
      else throw new Error('resume_task_not_found_for_session');
    }
  }

  const taskTextClean = String(taskText || (restored && (restored.brief || restored.task)) || '').slice(0, 20000).trim();
  if (!taskTextClean) throw new Error('task_required');
  while (tasks.size >= MAX_TASKS) tasks.delete(tasks.keys().next().value);

  const steps = Math.min(AGENT_MAX_STEPS, Math.max(1, Number(maxSteps) || Number(restored && restored.maxSteps) || 40));
  const ms = Math.min(3 * 3600000, Math.max(60000, Number(maxMs) || Number(restored && restored.maxMs) || 3600000));

  const task = {
    id: (restored && restored.id) || crypto.randomBytes(16).toString('hex'),
    sessionId: session.id,
    session,
    task: taskTextClean,
    brief: taskTextClean,
    spec: (restored && restored.spec) || taskAnalyzer.analyzeTask(taskTextClean, lang),
    clarifications: (restored && restored.clarifications) || [],
    checklist: (restored && restored.checklist) || null,
    sourcesStatus: (restored && restored.sourcesStatus) || {},
    lang: lang === 'vi' ? 'vi' : 'en',
    history: (restored && Array.isArray(restored.history) ? restored.history : []),
    maxSteps: steps,
    maxMs: ms,
    workMemory: (restored && restored.workMemory && typeof restored.workMemory === 'object') ? restored.workMemory : { findings: [], visited: [], notes: [], todo: [], searchCandidates: [] },
    errors: (restored && Array.isArray(restored.errors)) ? restored.errors : [],
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
  // Every task receives its own ephemeral/private bridge session and clean tab. The
  // authenticated caller session remains the ownership key for task polling/answers.
  try {
    await ensureTaskBrowserSession(task);
  } catch (e) {
    task.errors = task.errors || [];
    task.errors.push({ at: new Date().toISOString(), message: 'Could not create isolated browser session: ' + clip(e.message || e, 180) });
    throw new Error('agent_browser_session_create_failed: ' + clip(e.message || e, 120));
  }
  if (!task.checklist) {
    if (task.spec && task.spec.kind === 'news') task.checklist = newsDigest.buildChecklist(task.brief, task.lang);
    else task.checklist = taskAnalyzer.buildChecklist(task.spec || {});
  }
  if (!task.plan) {
    const defaults = { news: ['Collect feeds and recent items', 'Read and verify selected articles', 'Synthesize findings with source links'], research: ['Discover credible sources', 'Read and cross-check key claims', 'Write a cited synthesis'], study: ['Gather learning material', 'Explain key concepts and examples', 'Create review questions'], compare: ['Identify comparable options', 'Collect current specifications and prices', 'Compare trade-offs with sources'], work_doc: ['Inspect the supplied project or context', 'Collect evidence and identify gaps', 'Prepare findings and limitations'], lookup: ['Open and extract the requested material', 'Verify key details', 'Summarize with references'], other: ['Clarify the goal and constraints', 'Gather relevant evidence', 'Complete the requested output'] };
    const titles = ((task.spec && task.spec.steps) || []).length ? task.spec.steps : (defaults[task.spec && task.spec.kind] || defaults.other);
    task.plan = { title: task.spec && task.spec.goal ? clip(task.spec.goal, 160) : (task.lang === 'vi' ? 'Kế hoạch nhiệm vụ' : 'Task plan'), steps: titles.map((title, i) => ({ id: 'step-' + (i + 1), title, status: 'pending', evidence_count: 0 })).slice(0, 12), sources: (task.spec && task.spec.sources) || [], status: 'ready' };
  }
  task.ai = ai;
  tasks.set(task.id, task);
  persistTaskDisk(task);
  push(task, 'status', { message: task.lang === 'vi' ? 'Bắt đầu nhiệm vụ…' : 'Starting task…' });
  setImmediate(() => {
    runTask(ai, task).catch((e) => {
      task.status = 'failed';
      task.error = clip(e.message || e, 200);
      task.message = task.error;
      task.errors = task.errors || []; task.errors.push({ at: new Date().toISOString(), message: task.error });
      push(task, 'failed', { message: task.message });
      releaseAgentSession(task).catch(() => {});
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
    releaseAgentSession(task).catch(() => {});
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

async function continueTask(taskId, sessionId) {
  const task = getTask(taskId, sessionId);
  if (!task) return null;
  if (['running','waiting_confirmation','waiting_user'].includes(task.status)) return publicTask(task);
  if (!['limit','stopped'].includes(task.status)) return null;
  try { await ensureTaskBrowserSession(task); }
  catch (e) { task.status = 'failed'; task.message = clip(e.message || e, 200); task.errors = (task.errors || []).concat([{ at:new Date().toISOString(), message:task.message }]); push(task,'failed',{message:task.message}); return publicTask(task); }
  task.status = 'running'; task.stop = false; task.startedAt = Date.now(); task.updatedAt = Date.now();
  push(task, 'status', { message: task.lang === 'vi' ? 'Tiếp tục đúng nhiệm vụ cũ; giữ nguyên sổ bằng chứng…' : 'Resuming the same task and preserving its evidence ledger…' });
  setImmediate(() => runTask(task.ai, task).catch(async e => { task.status='failed'; task.message=clip(e.message||e,200); task.errors=(task.errors||[]).concat([{at:new Date().toISOString(),message:task.message}]); push(task,'failed',{message:task.message}); await releaseAgentSession(task); }));
  return publicTask(task);
}

async function answer(taskId, sessionId, text) {
  const task = getTask(taskId, sessionId);
  if (!task) return null;
  const value = String(text || '').trim().slice(0, 10000);
  if (!value) return publicTask(task);
  task.clarifications = task.clarifications || [];
  task.clarifications.push({ text: value, at: new Date().toISOString() });
  task.status = 'running'; task.message = '';
  push(task, 'status', { message: task.lang === 'vi' ? 'Đã nhận câu trả lời. Tiếp tục nhiệm vụ cũ…' : 'Answer received. Resuming the existing task…' });
  setImmediate(() => runTask(task.ai, task).catch(e => { task.status = 'failed'; task.message = clip(e.message || e, 200); push(task, 'failed', { message: task.message }); }));
  return publicTask(task);
}

function stop(taskId, sessionId) {
  const task = getTask(taskId, sessionId);
  if (!task) return { ok: false, error: 'task_not_found' };
  task.stop = true;
  task.status = 'stopping';
  return publicTask(task);
}

/** API: GET task progress (events after cursor). */
function status(taskId, sessionId, after) {
  const task = getTask(taskId, sessionId);
  if (!task) {
    // Try disk resume metadata for Continue UX
    try {
      const disk = loadTaskDisk(taskId);
      if (disk && disk.sessionId === sessionId) {
        return {
          ok: true,
          taskId: disk.id,
          status: disk.status || 'limit',
          message: disk.message || '',
          events: [],
          cursor: 0,
          history: disk.history || [],
          plan: disk.plan || null,
          workMemory: disk.workMemory || null,
          fromDisk: true,
          updatedAt: disk.updatedAt
        };
      }
    } catch (_) {}
    return { ok: false, error: 'task_not_found' };
  }
  return publicTask(task, Number(after) || 0);
}

module.exports = {
  start,
  status,
  getTask,
  publicTask,
  stop,
  confirm,
  answer,
  continueTask,
  observeSession,
  observeHtmlFallback,
  summarizeWorkMemory,
  actionRisk,
  AGENT_MAX_STEPS
};
