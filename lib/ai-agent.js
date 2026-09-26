'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

function requestJson(urlString, { method = 'GET', headers = {}, body } = {}) {
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
      timeout: 25000
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
  const prefer = (process.env.AI_PROVIDER || '').toLowerCase();
  return {
    prefer,
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

async function probe() {
  const p = providers();
  const out = { local: 'NOT_AVAILABLE', openai: 'NOT_AVAILABLE', anthropic: 'NOT_AVAILABLE', active: 'none' };
  try {
    const r = await requestJson(p.ollama.url.replace(/\/$/, '') + '/api/tags');
    if (r.status && r.status < 500) {
      out.local = 'PASS';
      out.active = 'local';
    }
  } catch { /* local offline is fine */ }
  if (p.openai.key) {
    out.openai = 'PASS';
    if (out.active === 'none' || p.prefer === 'openai') out.active = 'openai';
  }
  if (p.anthropic.key) {
    out.anthropic = 'PASS';
    if (out.active === 'none' || p.prefer === 'anthropic') out.active = 'anthropic';
  }
  if (p.prefer === 'local' && out.local === 'PASS') out.active = 'local';
  if (p.prefer === 'ollama' && out.local === 'PASS') out.active = 'local';
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

async function complete({ provider, messages }) {
  const p = providers();
  const use = provider || (await probe()).active;
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
        max_tokens: 800,
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

async function chat({ message, page, acceptLanguage, navigate }) {
  const text = String(message || '').trim();
  if (!text) return { ok: false, error: 'empty' };
  const system = [
    'You are SoloHost Browser assistant.',
    'Be brief. No marketing.',
    langHint(text, acceptLanguage),
    page && page.url ? `Open page: ${page.url} ${page.title || ''}`.trim() : 'No page is open.',
    'If the user asks to open a website, reply with a single line: NAVIGATE <url>',
    'Do not claim you clicked inside the live page unless a tool result says so.'
  ].join('\n');
  const result = await complete({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: text }
    ]
  });
  let nav = null;
  const m = String(result.text || '').match(/^NAVIGATE\s+(\S+)/m);
  if (m && typeof navigate === 'function') {
    nav = m[1];
    try { await navigate(nav); } catch { /* engine may be starting */ }
  }
  return { ok: true, provider: result.provider, text: result.text, navigate: nav };
}

module.exports = { probe, chat, providers };
