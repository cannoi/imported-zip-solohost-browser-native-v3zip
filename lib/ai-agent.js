'use strict';

/**
 * V7.8 AI Browser assistant layer.
 * AI is optional: browser navigation/engine never depends on providers.
 * Prefer Personal AI Hub when reachable, then local Ollama, then cloud keys.
 */

const http = require('http');
const https = require('https');
const { URL } = require('url');

const SKILLS = ['search', 'summarize', 'explain', 'translate', 'navigate', 'extract', 'assist'];

function requestJson(urlString, { method = 'GET', headers = {}, body, timeout = 25000 } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try { url = new URL(urlString); }
    catch (err) { return reject(err); }
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers,
      timeout
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; if (raw.length > 800000) req.destroy(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: raw ? JSON.parse(raw) : {} }); }
        catch { resolve({ status: res.statusCode, json: {}, text: raw }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('ai timeout')); });
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

function providers() {
  const ollama = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
  const openaiBase = process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1';
  const hub = process.env.PERSONAL_AI_HUB_URL || process.env.SOLOHOST_AI_HUB_URL || '';
  const prefer = (process.env.AI_PROVIDER || '').toLowerCase();
  return {
    prefer,
    hub: { url: hub.replace(/\/$/, ''), model: process.env.HUB_MODEL || '' },
    ollama: { url: ollama, model: process.env.OLLAMA_MODEL || 'llama3.2' },
    openai: {
      url: openaiBase,
      key: process.env.OPENAI_API_KEY || '',
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini'
    },
    anthropic: {
      key: process.env.ANTHROPIC_API_KEY || '',
      model: process.env.ANTHROPIC_MODEL || 'claude-3-5-haiku-latest'
    }
  };
}

async function probeHub(p) {
  if (!p.hub.url) return { status: 'NOT_AVAILABLE' };
  const paths = ['/api/ai', '/api/health', '/health', '/api/status', '/'];
  for (const path of paths) {
    try {
      const r = await requestJson(p.hub.url + path, { timeout: 2500 });
      if (r.status && r.status < 500) {
        return { status: 'PASS', url: p.hub.url, path };
      }
    } catch { /* try next */ }
  }
  return { status: 'NOT_AVAILABLE', url: p.hub.url };
}

async function probe() {
  const p = providers();
  const out = {
    hub: 'NOT_AVAILABLE',
    local: 'NOT_AVAILABLE',
    openai: 'NOT_AVAILABLE',
    anthropic: 'NOT_AVAILABLE',
    active: 'none',
    skills: SKILLS,
    required: false
  };
  const hub = await probeHub(p);
  if (hub.status === 'PASS') {
    out.hub = 'PASS';
    out.active = 'hub';
    out.hubUrl = hub.url;
  }
  try {
    const r = await requestJson(p.ollama.url.replace(/\/$/, '') + '/api/tags', { timeout: 2500 });
    if (r.status && r.status < 500) {
      out.local = 'PASS';
      if (out.active === 'none') out.active = 'local';
    }
  } catch { /* offline ok */ }
  if (p.openai.key) {
    out.openai = 'PASS';
    if (out.active === 'none' || p.prefer === 'openai') out.active = 'openai';
  }
  if (p.anthropic.key) {
    out.anthropic = 'PASS';
    if (out.active === 'none' || p.prefer === 'anthropic') out.active = 'anthropic';
  }
  if ((p.prefer === 'local' || p.prefer === 'ollama') && out.local === 'PASS') out.active = 'local';
  if (p.prefer === 'hub' && out.hub === 'PASS') out.active = 'hub';
  if (p.prefer === 'openai' && out.openai === 'PASS') out.active = 'openai';
  if (p.prefer === 'anthropic' && out.anthropic === 'PASS') out.active = 'anthropic';
  return out;
}

function langHint(text, headerLang) {
  const t = String(text || '');
  if (/[àáạảãăắằặẳẵâấầậẩẫèéẹẻẽêếềệểễìíịỉĩòóọỏõôốồộổỗơớờợởỡùúụủũưứừựửữỳýỵỷỹđ]/i.test(t)) {
    return 'Reply in Vietnamese.';
  }
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(t)) return 'Reply in the same language as the user.';
  if (headerLang && headerLang.toLowerCase().startsWith('vi')) return 'Reply in Vietnamese.';
  return 'Reply in the same language as the user.';
}

function detectSkill(message, explicit) {
  if (explicit && SKILLS.includes(String(explicit).toLowerCase())) return String(explicit).toLowerCase();
  const t = String(message || '').toLowerCase();
  if (/^(go to|open|navigate|mở|truy cập)\b/i.test(message) || /\b(https?:\/\/|www\.)/i.test(message)) return 'navigate';
  if (/\b(summariz|tóm tắt|tom tat|summary)\b/i.test(t)) return 'summarize';
  if (/\b(explain|giải thích|giai thich|what is|là gì)\b/i.test(t)) return 'explain';
  if (/\b(translat|dịch|dich sang|translate)\b/i.test(t)) return 'translate';
  if (/\b(extract|trích|trich xuất|pull text|lấy nội dung)\b/i.test(t)) return 'extract';
  if (/\b(search|tìm|tim kiem|google|look up)\b/i.test(t)) return 'search';
  return 'assist';
}

function skillSystem(skill, page, acceptLanguage, message) {
  const pageLine = page && page.url
    ? `Current page URL: ${page.url}. Title: ${page.title || '(unknown)'}.`
    : 'No page is open in the browser.';
  const extractHint = page && page.excerpt
    ? `Page text excerpt (may be partial):\n${String(page.excerpt).slice(0, 6000)}`
    : 'Full page body text is not available to the assistant; use URL/title and user words only.';
  const base = [
    'You are the SoloHost Browser assistant layer, not the browser engine.',
    'Be brief, practical, no marketing.',
    langHint(message, acceptLanguage),
    pageLine,
    extractHint
  ];
  switch (skill) {
    case 'search':
      base.push('Help the user search the web. If they need a results page, end with one line: NAVIGATE https://www.google.com/search?q=QUERY');
      break;
    case 'summarize':
      base.push('Summarize the current page or the topic the user named. If no page text exists, summarize from URL/title and say that body text was not extracted.');
      break;
    case 'explain':
      base.push('Explain the topic or current page in simple words.');
      break;
    case 'translate':
      base.push('Translate as requested. If target language is missing, use the user message language as the target.');
      break;
    case 'navigate':
      base.push('Resolve where the user wants to go. Prefer a single line: NAVIGATE <absolute-https-url>.');
      break;
    case 'extract':
      base.push('Extract key facts, links, or structured points from available page context. If body text is missing, say so and list what is known from URL/title.');
      break;
    default:
      base.push('Assist with browsing. If opening a site is needed, include NAVIGATE <url> on its own line.');
  }
  base.push('Never claim you clicked, typed, or saw pixels unless a tool result is provided.');
  return base.join('\n');
}

async function completeHub(p, messages) {
  const endpoints = ['/api/ai/chat', '/api/chat', '/v1/chat/completions'];
  for (const ep of endpoints) {
    try {
      const r = await requestJson(p.hub.url + ep, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: ep.includes('chat/completions')
          ? { model: p.hub.model || 'default', messages, temperature: 0.3 }
          : { message: messages[messages.length - 1]?.content, messages }
      });
      const text =
        (r.json && r.json.text) ||
        (r.json && r.json.message && (r.json.message.content || r.json.message)) ||
        (r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content) ||
        (typeof r.text === 'string' && r.text) ||
        '';
      if (text && r.status < 500) return { provider: 'hub', text: String(text) };
    } catch { /* try next endpoint shape */ }
  }
  throw new Error('hub empty');
}

async function complete({ provider, messages }) {
  const p = providers();
  const use = provider || (await probe()).active;
  if (use === 'hub') return completeHub(p, messages);
  if (use === 'local') {
    const r = await requestJson(p.ollama.url.replace(/\/$/, '') + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: { model: p.ollama.model, stream: false, messages }
    });
    const text = r.json && r.json.message && r.json.message.content;
    if (!text) throw new Error('local model empty');
    return { provider: 'local', text };
  }
  if (use === 'openai') {
    if (!p.openai.key) throw new Error('OPENAI_API_KEY missing');
    const r = await requestJson(p.openai.url.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + p.openai.key
      },
      body: { model: p.openai.model, messages, temperature: 0.3 }
    });
    const text = r.json && r.json.choices && r.json.choices[0] && r.json.choices[0].message && r.json.choices[0].message.content;
    if (!text) throw new Error('openai empty');
    return { provider: 'openai', text };
  }
  if (use === 'anthropic') {
    if (!p.anthropic.key) throw new Error('ANTHROPIC_API_KEY missing');
    const r = await requestJson('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': p.anthropic.key,
        'anthropic-version': '2023-06-01'
      },
      body: {
        model: p.anthropic.model,
        max_tokens: 900,
        messages: messages.filter((m) => m.role !== 'system'),
        system: (messages.find((m) => m.role === 'system') || {}).content
      }
    });
    const text = r.json && r.json.content && r.json.content[0] && r.json.content[0].text;
    if (!text) throw new Error('anthropic empty');
    return { provider: 'anthropic', text };
  }
  throw new Error('no AI provider available');
}

function parseNavigate(text) {
  const m = String(text || '').match(/(?:^|\n)\s*NAVIGATE\s+(\S+)/i);
  return m ? m[1] : null;
}

async function chat({ message, page, acceptLanguage, navigate, skill }) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: 'empty', required: false };
  const chosen = detectSkill(text, skill);
  const status = await probe();
  if (status.active === 'none') {
    return {
      ok: false,
      required: false,
      skill: chosen,
      error: 'AI unavailable',
      hint: 'Browser still works. Configure PERSONAL_AI_HUB_URL, Ollama, or API keys to enable Assist.'
    };
  }
  try {
    const result = await complete({
      provider: status.active,
      messages: [
        { role: 'system', content: skillSystem(chosen, page, acceptLanguage, text) },
        { role: 'user', content: text }
      ]
    });
    let nav = parseNavigate(result.text);
    if (chosen === 'search' && !nav && !/^https?:\/\//i.test(text)) {
      const q = text.replace(/^(search|tìm|tim)\s+/i, '').trim();
      if (q) nav = 'https://www.google.com/search?q=' + encodeURIComponent(q);
    }
    if (nav && typeof navigate === 'function') {
      try { await navigate(nav); } catch { /* engine optional */ }
    }
    return {
      ok: true,
      required: false,
      skill: chosen,
      provider: result.provider,
      text: result.text,
      navigate: nav
    };
  } catch (err) {
    return {
      ok: false,
      required: false,
      skill: chosen,
      error: String(err.message || err),
      state: 'FAILED'
    };
  }
}

module.exports = { probe, chat, providers, SKILLS, detectSkill };
