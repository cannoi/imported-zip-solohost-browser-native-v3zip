/**
 * Universal AI provider engine (v1.3.0).
 * - Discovers models instead of relying on stale hard-coded model IDs.
 * - Keeps provider-specific authentication server-side.
 * - Retries a generation once with a discovered model when a configured model is stale.
 * - v1.3.0: hardened Custom / Local (OpenAI-compatible) support:
 *     Base URL normalisation + /v1 probing, tolerant /models parsing, Ollama native fallback,
 *     non-chat model filtering, tolerant response extraction (parts arrays, <think> blocks,
 *     SSE bodies, Responses API, Ollama native), parameter auto-adaptation (temperature,
 *     system role, max_tokens), clear network/timeout/HTML diagnostics.
 */
'use strict';

const crypto = require('crypto');

const LIST_TIMEOUT_MS = 20000;
const CLOUD_CHAT_TIMEOUT_MS = 60000;
const LOCAL_CHAT_TIMEOUT_MS = 120000; // local models may need to load into memory first
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

const modelCache = new Map(); // auto-resolved model per provider/base/key
const baseCache = new Map();  // base URL candidate that worked

/* ------------------------------------------------------------------ helpers */

function protocolOf(provider, kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'gemini' || k === 'anthropic' || k === 'openai') return k;
  if (provider === 'gemini' || provider === 'anthropic') return provider;
  return 'openai';
}
function isSelfHosted(provider) { return provider === 'local' || provider === 'custom'; }

function envTimeout() {
  const n = Number(process.env.AI_TIMEOUT_MS);
  return Number.isFinite(n) && n >= 1000 ? n : 0;
}
function chatTimeout(provider) {
  return envTimeout() || (isSelfHosted(provider) ? LOCAL_CHAT_TIMEOUT_MS : CLOUD_CHAT_TIMEOUT_MS);
}

/** Trim, add a scheme when missing, drop trailing slashes. Query string is preserved (Gemini). */
function cleanBase(url) {
  let s = String(url || '').trim();
  if (!s) return '';
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) {
    const host = s.split(/[\/?#]/)[0].replace(/:\d+$/, '');
    const priv = /^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[::1\]|host\.docker\.internal)/i.test(host)
      || /\.(local|lan|internal)$/i.test(host) || !host.includes('.');
    s = (priv ? 'http://' : 'https://') + s;
  }
  return s.replace(/\/+$/, '');
}

/** Remove an endpoint the user pasted by mistake (e.g. ".../v1/chat/completions"). */
function normalizeBaseUrl(url, proto = 'openai') {
  let b = cleanBase(url);
  if (!b || b.includes('?')) return b;
  if (proto === 'anthropic') b = b.replace(/\/(messages|models)$/i, '');
  else if (proto === 'openai') b = b.replace(/\/(chat\/completions|completions|responses|models|embeddings)$/i, '');
  return b.replace(/\/+$/, '');
}

function redactUrl(u) {
  try { const x = new URL(u); return x.origin + x.pathname.replace(/\/+$/, ''); }
  catch { return String(u || '').split('?')[0]; }
}

/** Candidate base URLs. Only Custom/Local are probed (users often omit "/v1"). */
function baseCandidates(provider, base) {
  if (!isSelfHosted(provider) || !base) return [base];
  let u; try { u = new URL(base); } catch { return [base]; }
  const p = u.pathname.replace(/\/+$/, '');
  if (!p) return [base + '/v1', base];
  if (!/\/v\d+/i.test(p)) return [base, base + '/v1'];
  return [base];
}

function authFor(proto, apiKey) {
  let k = String(apiKey || '').trim().replace(/^Bearer\s+/i, '');
  if (!k || k === 'local') return {};
  if (proto === 'anthropic') return { 'x-api-key': k, 'anthropic-version': '2023-06-01' };
  return { 'Authorization': 'Bearer ' + k };
}

function cleanHeaders(h) {
  const out = {};
  if (!h || typeof h !== 'object') return out;
  for (const [k, v] of Object.entries(h)) {
    if (!/^[A-Za-z0-9-]+$/.test(k)) continue;
    if (/^(host|content-length|connection|transfer-encoding)$/i.test(k)) continue;
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

function timeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

function networkError(e, url, timeoutMs) {
  const safe = redactUrl(url);
  const code = e?.cause?.code || e?.code || '';
  let msg, c = 'NETWORK';
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') {
    c = 'TIMEOUT';
    msg = `Request to ${safe} timed out after ${Math.round((timeoutMs || 0) / 1000)}s. Local models can be slow to load; raise AI_TIMEOUT_MS if needed.`;
  } else if (code === 'ECONNREFUSED') {
    msg = `Connection refused at ${safe}. Is the server running and the port correct? (Inside Docker use host.docker.internal instead of localhost/127.0.0.1.)`;
  } else if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    msg = `Host not found for ${safe}. Check the Base URL spelling and DNS.`;
  } else if (/CERT|SSL|TLS|DEPTH_ZERO|SELF_SIGNED/i.test(String(code))) {
    msg = `TLS/certificate error reaching ${safe} (${code}). Use http:// for plain local servers or install a valid certificate.`;
  } else {
    msg = `Cannot reach ${safe}: ${code || e?.message || 'network error'}`;
  }
  const err = new Error(msg);
  err.code = c;
  return err;
}

function parseSse(text) {
  if (!/^\s*(data:|event:|:)/.test(text)) return null;
  let out = '', last = null;
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (!d || d === '[DONE]') continue;
    try {
      const j = JSON.parse(d); last = j;
      const c = j?.choices?.[0];
      out += (c?.delta?.content ?? c?.message?.content ?? c?.text ?? '');
    } catch { /* ignore keep-alive / partial lines */ }
  }
  if (last === null) return null;
  return { choices: [{ message: { content: out }, finish_reason: last?.choices?.[0]?.finish_reason }] };
}

async function requestJson(url, { method = 'GET', body, headers = {}, timeoutMs = LIST_TIMEOUT_MS } = {}) {
  let r, text;
  const attempt = async (target) => {
    r = await fetch(target, {
      method,
      headers: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: timeoutSignal(timeoutMs),
    });
    text = await r.text();
  };
  try {
    try { await attempt(url); }
    catch (e) {
      // Node resolves "localhost" to ::1 first on some setups while the server listens on IPv4 only.
      const code = e?.cause?.code || e?.code;
      let u = null; try { u = new URL(url); } catch {}
      if (code === 'ECONNREFUSED' && u && u.hostname === 'localhost') {
        u.hostname = '127.0.0.1';
        await attempt(u.toString());
      } else throw e;
    }
  } catch (e) { throw networkError(e, url, timeoutMs); }

  let json = {};
  if (text) {
    try { json = JSON.parse(text); }
    catch {
      if (r.ok) {
        const sse = parseSse(text);
        if (sse) return sse;
        const html = /^\s*<(!doctype|html|head|body)/i.test(text);
        const e = new Error(`Endpoint ${redactUrl(url)} returned a non-JSON response (${html ? 'an HTML page' : 'plain text'}): "${text.replace(/\s+/g, ' ').slice(0, 100)}". The Base URL probably does not point at the API root (it should look like http://host:port/v1).`);
        e.code = 'NOT_JSON';
        throw e;
      }
      json = {};
    }
  }
  if (!r.ok) {
    let message = json?.error?.message || json?.error || json?.message || json?.detail || text || `HTTP ${r.status}`;
    if (typeof message === 'object') message = JSON.stringify(message);
    if (/^\s*<(!doctype|html|head|body)/i.test(String(message))) message = 'HTML error page';
    const e = new Error(`HTTP ${r.status}: ${String(message).slice(0, 500)}`);
    e.status = r.status;
    e.providerBody = json;
    throw e;
  }
  return json;
}

function isModelNotFound(e) {
  const m = String(e?.message || '');
  return /model.*(not found|does not exist|not available|unknown|not supported)|not_found.*model|no such model|try pulling it first|invalid model/i.test(m);
}
function isEndpointMiss(e) {
  if (!e) return false;
  if (e.code === 'NOT_JSON') return true;
  return (e.status === 404 || e.status === 405) && !isModelNotFound(e);
}

/** Try each candidate base URL; remember the one that works. */
async function withBases(provider, base, fn) {
  const cands = baseCandidates(provider, base);
  const ck = provider + '|' + base;
  const cached = baseCache.get(ck);
  const order = cached && cands.includes(cached) ? [cached, ...cands.filter(x => x !== cached)] : cands;
  let firstErr = null;
  for (const b of order) {
    try { const out = await fn(b); baseCache.set(ck, b); return out; }
    catch (e) {
      if (!firstErr) firstErr = e;
      if (!isEndpointMiss(e)) throw e;
    }
  }
  if (order.length > 1 && firstErr) firstErr.message += ` (tried: ${order.map(redactUrl).join(', ')})`;
  throw firstErr;
}

/* ------------------------------------------------------------------- models */

function normalizeModel(model, provider) {
  // `auto` is intentionally resolved dynamically by listModels().
  if (model && model !== 'auto') return model;
  const legacy = {
    // Safe compatibility hints only; these are fallback candidates, not guarantees.
    openai: ['gpt-5.6-luna','gpt-5.6','gpt-4o-mini'],
    gemini: ['gemini-3.8-flash','gemini-3.7-flash','gemini-3.6-flash','gemini-2.5-flash'],
    deepseek: ['deepseek-flash','deepseek-v4-pro'],
    openrouter: ['openai/gpt-5.6-luna','openai/gpt-4o-mini'],
    groq: ['llama-3.3-70b-versatile'],
    mistral: ['mistral-small-latest'],
    xai: ['grok-3-mini'],
    anthropic: ['claude-sonnet-4-5','claude-3-5-haiku-latest'],
    local: [], custom: []
  };
  return (legacy[provider] || [])[0] || 'auto';
}

function modelItems(j) {
  let arr = [];
  if (Array.isArray(j)) arr = j;
  else if (Array.isArray(j?.data)) arr = j.data;
  else if (Array.isArray(j?.models)) arr = j.models;
  else if (Array.isArray(j?.data?.models)) arr = j.data.models;
  else if (Array.isArray(j?.result)) arr = j.result;
  else if (Array.isArray(j?.items)) arr = j.items;
  const seen = new Set();
  return arr.map(x => {
    if (typeof x === 'string') x = { id: x };
    const id = String(x?.id || x?.model || x?.name || x?.slug || x?.model_name || '').replace(/^models\//, '');
    return {
      id,
      name: x?.name || x?.displayName || x?.display_name || id,
      ownedBy: x?.owned_by || x?.ownedBy || x?.publisher || '',
      methods: x?.supportedGenerationMethods || x?.supported_generation_methods || [],
      raw: undefined,
    };
  }).filter(x => x.id && !seen.has(x.id) && seen.add(x.id));
}

// Models that can never answer a chat prompt (embeddings, speech, image, rerank, ...).
const NON_TEXT_RE = new RegExp([
  'embed', 'rerank', 'whisper', 'moderation', 'dall-?e', 'imagen', 'stable-diffusion', 'sdxl', 'midjourney',
  'text-to-speech', 'transcrib', 'minilm', 'nomic-bert', 'llama-guard', 'shieldgemma',
  '(^|[-_/:.])(tts|clip|bge|gte|e5|ocr|flux|sora|realtime|audio|speech|asr|vae)($|[-_/:.])',
].join('|'), 'i');
function isTextModel(id) { return !NON_TEXT_RE.test(String(id || '')); }

async function listModels({ provider, baseUrl, apiKey, kind, extraHeaders }) {
  const proto = protocolOf(provider, kind);
  const base = normalizeBaseUrl(baseUrl, proto);
  if (!base) throw new Error('Base URL is required for this provider');
  const extra = cleanHeaders(extraHeaders);

  if (proto === 'gemini') {
    const sep = base.includes('?') ? '&' : '?';
    const j = await requestJson(`${base}/models${sep}key=${encodeURIComponent(apiKey || '')}`, { headers: extra });
    return modelItems(j).filter(m => !m.methods.length || m.methods.includes('generateContent'));
  }

  const headers = { ...extra, ...authFor(proto, apiKey) };

  if (proto === 'anthropic') {
    const j = await requestJson(`${base}/models`, { headers });
    return modelItems(j);
  }

  // OpenAI-compatible (OpenAI, DeepSeek, OpenRouter, Groq, Mistral, xAI, Custom, Local)
  if (!isSelfHosted(provider)) {
    const j = await requestJson(`${base}/models`, { headers });
    return modelItems(j);
  }

  let items = [], err = null;
  try {
    items = await withBases(provider, base, async b => modelItems(await requestJson(`${b}/models`, { headers })));
  } catch (e) {
    if (!isEndpointMiss(e)) throw e; // auth / network / timeout errors are meaningful
    err = e;
  }
  if (!items.length) {
    // Ollama native listing (works even when the /v1 compatibility layer is missing).
    try {
      const origin = new URL(base).origin;
      items = modelItems(await requestJson(`${origin}/api/tags`, { headers }));
    } catch { /* ignore, handled below */ }
  }
  // Many custom servers legitimately have no /models. Return [] so the caller can ask for a manual model name.
  void err;
  return items;
}

function chooseAutoModel(models, provider) {
  const all = models.map(x => x.id);
  const textOnly = all.filter(isTextModel);
  const ids = textOnly.length ? textOnly : all;
  const preferred = {
    gemini: [/^gemini-3\.8-flash$/, /^gemini-3\.7-flash$/, /^gemini-3\.6-flash$/, /^gemini-3\.5-flash$/, /^gemini-2\.5-flash$/],
    deepseek: [/^deepseek-flash$/, /^deepseek-v4-pro$/],
    anthropic: [/claude-sonnet-5-5/i, /claude-opus-5-5/i, /claude-fable-5-1/i, /claude-haiku-4-5/i, /claude-sonnet/i, /claude-haiku/i, /claude-opus/i],
    openai: [/^gpt-5\.6-luna$/, /^gpt-5\.6$/, /^gpt-4o-mini$/, /^gpt-/i],
    openrouter: [/gpt-5\.6-luna/i, /gpt-4o-mini/i, /claude.*haiku/i, /gemini.*flash/i],
    groq: [/llama.*70b/i, /llama.*versatile/i, /qwen/i],
    mistral: [/mistral-small/i, /mistral-medium/i, /mistral-large/i],
    xai: [/grok-.*mini/i, /grok/i],
  }[provider] || [];
  for (const re of preferred) { const hit = ids.find(id => re.test(id)); if (hit) return hit; }
  if (isSelfHosted(provider) && ids.length > 1) {
    const score = id => (/instruct|chat|-it\b|assistant/i.test(id) ? 3 : 0)
      + (/qwen|llama|mistral|mixtral|gemma|phi|deepseek|gpt-oss|glm|granite|command|hermes|yi-/i.test(id) ? 2 : 0)
      - (/vision|llava|\bvl\b/i.test(id) ? 1 : 0);
    let best = ids[0], bs = score(best);
    for (const id of ids) { const s = score(id); if (s > bs) { best = id; bs = s; } }
    return best;
  }
  return ids[0] || 'auto';
}

function noModelError(provider, base, reason) {
  const hosted = isSelfHosted(provider);
  const e = new Error('Provider returned no usable text model'
    + (reason ? ` (${reason})` : '') + '. '
    + (hosted
      ? `The server at ${redactUrl(base)} did not list any chat model via GET /models. Type the exact model name in Settings → Model (e.g. the name shown by "ollama list" or the model loaded in LM Studio), Save, then try again.`
      : 'Check that the API key has access to text models and that the Base URL is correct.'));
  e.code = 'NO_MODEL';
  return e;
}

async function resolveModel({ provider, baseUrl, apiKey, model, kind, extraHeaders }) {
  if (model && model !== 'auto') return { model, discovered: false, models: [] };
  const models = await listModels({ provider, baseUrl, apiKey, kind, extraHeaders });
  const selected = chooseAutoModel(models, provider);
  if (!selected || selected === 'auto') {
    throw noModelError(provider, normalizeBaseUrl(baseUrl, protocolOf(provider, kind)), models.length ? 'only non-text models were listed' : 'empty model list');
  }
  return { model: selected, discovered: true, models };
}

/* --------------------------------------------------------- text extraction */

function contentToText(c) {
  if (c == null) return '';
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) {
    return c.map(p => {
      if (typeof p === 'string') return p;
      if (!p || typeof p !== 'object') return '';
      if (p.type && !/text/i.test(p.type)) return '';
      const t = p.text?.value ?? p.text ?? p.content ?? '';
      return typeof t === 'string' ? t : '';
    }).join('');
  }
  if (typeof c === 'object') return typeof c.text === 'string' ? c.text : '';
  return '';
}

/** Remove chain-of-thought blocks emitted inline by local reasoning models (DeepSeek-R1, Qwen3, ...). */
function stripReasoning(t) {
  let s = String(t || '');
  s = s.replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '');
  s = s.replace(/^[\s\S]*?<\/(think|thinking|reasoning)>/i, '');   // opening tag was injected by the chat template
  s = s.replace(/<(think|thinking|reasoning)>[\s\S]*$/i, '');      // truncated, never closed
  return s.trim();
}

function extractText(j, label = 'provider') {
  if (j?.error && !j?.choices) {
    const m = typeof j.error === 'string' ? j.error : (j.error.message || JSON.stringify(j.error));
    const e = new Error(`${label} returned an error body: ${String(m).slice(0, 300)}`);
    e.code = 'PROVIDER_ERROR_BODY';
    throw e;
  }
  const c0 = j?.choices?.[0];
  const outputArr = Array.isArray(j?.output)
    ? j.output.filter(o => o && (o.type === 'message' || o.content)).map(o => contentToText(o.content)).join('')
    : '';
  const cands = [
    c0?.message?.content, c0?.text, c0?.delta?.content,
    j?.message?.content,                       // Ollama native /api/chat
    j?.response,                               // Ollama native /api/generate
    j?.output_text, outputArr,                 // OpenAI Responses API
    typeof j?.output === 'string' ? j.output : '',
    j?.content,                                // Anthropic-like
    Array.isArray(j?.candidates) ? j.candidates[0]?.content?.parts?.map(p => p?.text || '').join('') : '',
    j?.text, j?.result, j?.answer, j?.reply,
  ];
  for (const c of cands) { const t = stripReasoning(contentToText(c)); if (t) return t; }

  const msg = c0?.message || j?.message || {};
  const fr = c0?.finish_reason || j?.done_reason || '';
  let m;
  if (msg.refusal) m = `${label} refused to answer: ${String(msg.refusal).slice(0, 200)}`;
  else if (msg.tool_calls?.length || msg.function_call) m = `${label} returned a tool call instead of text`;
  else if (msg.reasoning_content || msg.reasoning || msg.thinking || fr === 'length')
    m = `${label} returned no final text (finish_reason=${fr || 'n/a'}): the model used its output budget on reasoning. Use a non-reasoning model or raise the server's max tokens/context.`;
  else m = `${label} returned no text content${fr ? ` (finish_reason=${fr})` : ''}`;
  const e = new Error(m);
  e.code = 'EMPTY_RESPONSE';
  throw e;
}

/* -------------------------------------------------------------- generation */

function foldSystem(messages) {
  const sys = messages.filter(x => x.role === 'system').map(x => String(x.content || '')).join('\n\n');
  const rest = messages.filter(x => x.role !== 'system').map(x => ({ ...x }));
  if (!sys) return rest;
  const i = rest.findIndex(x => x.role === 'user');
  if (i >= 0) rest[i].content = `${sys}\n\n${String(rest[i].content || '')}`;
  else rest.unshift({ role: 'user', content: sys });
  return rest;
}

/** POST /chat/completions, adapting to servers that reject optional parameters. */
async function postChat(url, body, headers, timeoutMs) {
  const b = { ...body };
  let lastErr;
  for (let i = 0; i < 4; i++) {
    try { return await requestJson(url, { method: 'POST', headers, body: b, timeoutMs }); }
    catch (e) {
      lastErr = e;
      if (![400, 422, 500].includes(e.status)) throw e;
      const m = String(e.message);
      if ('temperature' in b && /temperature/i.test(m)) { delete b.temperature; continue; }
      if ('max_tokens' in b && /max_completion_tokens/i.test(m)) { b.max_completion_tokens = b.max_tokens; delete b.max_tokens; continue; }
      if ('max_tokens' in b && /max_tokens/i.test(m)) { delete b.max_tokens; continue; }
      if ('stream' in b && /stream/i.test(m)) { delete b.stream; continue; }
      if (b.messages.some(x => x.role === 'system') && /system|role|template|alternat/i.test(m)) { b.messages = foldSystem(b.messages); continue; }
      throw e;
    }
  }
  throw lastErr;
}

function supportsVisionHint(model) {
  const m = String(model || '').toLowerCase();
  return /gpt-4o|gpt-4\.1|gpt-4-turbo|gemini|claude-3|claude-4|vision|llava|pixtral|qwen2(\.|-)vl|qwen-vl/.test(m);
}

/** Normalize multimodal user content for OpenAI-compatible APIs. */
function normalizeVisionMessages(messages) {
  return (messages || []).map((msg) => {
    if (!msg || typeof msg !== 'object') return msg;
    if (Array.isArray(msg.content)) return msg;
    if (msg.images && Array.isArray(msg.images) && msg.images.length) {
      const parts = [{ type: 'text', text: String(msg.content || '') }];
      for (const img of msg.images.slice(0, 2)) {
        const url = typeof img === 'string' ? img : (img.url || img.dataUrl || '');
        if (!url) continue;
        parts.push({ type: 'image_url', image_url: { url, detail: img.detail || 'low' } });
      }
      return { role: msg.role || 'user', content: parts };
    }
    return { role: msg.role, content: msg.content };
  });
}

async function sleepMs(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withBackoff(fn, { retries = 3, label = 'provider' } = {}) {
  let last;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      last = e;
      const st = e.status || 0;
      if (![429, 500, 502, 503, 504].includes(st) && e.code !== 'TIMEOUT') throw e;
      const wait = Math.min(12000, 400 * Math.pow(2, i) + Math.floor(Math.random() * 200));
      await sleepMs(wait);
    }
  }
  throw last;
}

async function chatOpenAICompat({ provider, baseUrl, apiKey, model, messages, maxTokens, extraHeaders, kind, tools, toolChoice }) {
  const base = normalizeBaseUrl(baseUrl, 'openai');
  if (!base) throw new Error('Base URL is required for this provider');
  const headers = { ...cleanHeaders(extraHeaders), ...authFor('openai', apiKey) };
  const timeoutMs = chatTimeout(provider);
  const msgs = normalizeVisionMessages(messages);
  const body = {
    model,
    messages: msgs,
    temperature: 0.2,
    stream: false,
    ...(maxTokens ? { max_tokens: maxTokens } : {})
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = toolChoice || 'auto';
  }
  const label = provider || 'provider';
  try {
    return await withBases(provider, base, async b => {
      const j = await withBackoff(() => postChat(`${b}/chat/completions`, body, headers, timeoutMs), { label });
      // Tool-calling response path
      if (tools && tools.length) {
        const c0 = j?.choices?.[0];
        const msg = c0?.message || {};
        if (msg.tool_calls && msg.tool_calls.length) {
          return {
            mode: 'tools',
            text: contentToText(msg.content) || '',
            tool_calls: msg.tool_calls.map((tc) => ({
              id: tc.id,
              name: tc.function?.name || tc.name,
              arguments: (() => { try { return JSON.parse(tc.function?.arguments || tc.arguments || '{}'); } catch { return { _raw: tc.function?.arguments }; } })()
            })),
            raw: j
          };
        }
      }
      return extractText(j, label);
    });
  } catch (e) {
    if (!(isSelfHosted(provider) && isEndpointMiss(e))) throw e;
    // Fallback 1: OpenAI Responses API. Fallback 2: Ollama native /api/chat.
    const sys = messages.filter(x => x.role === 'system').map(x => String(x.content || '')).join('\n\n');
    const input = messages.filter(x => x.role !== 'system').map(x => ({ role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '') }));
    for (const b of baseCandidates(provider, base)) {
      try {
        const j = await requestJson(`${b}/responses`, { method: 'POST', headers, timeoutMs, body: { model, input, ...(sys ? { instructions: sys } : {}), stream: false } });
        return extractText(j, label);
      } catch (e2) { if (!isEndpointMiss(e2)) throw e2; }
    }
    try {
      const origin = new URL(base).origin;
      const j = await requestJson(`${origin}/api/chat`, { method: 'POST', headers, timeoutMs, body: { model, messages, stream: false, options: { temperature: .2 } } });
      return extractText(j, label);
    } catch (e3) { if (!isEndpointMiss(e3)) throw e3; }
    e.message += ' (also tried /responses and Ollama /api/chat)';
    throw e;
  }
}

async function runWithModel({ provider, baseUrl, apiKey, model, messages, kind, extraHeaders, maxTokens, tools, toolChoice }) {
  const mid = model || normalizeModel('auto', provider);
  const proto = protocolOf(provider, kind);
  const extra = cleanHeaders(extraHeaders);
  const maxTok = maxTokens || (tools && tools.length ? 2000 : 1500);

  if (proto === 'gemini') {
    const base = normalizeBaseUrl(baseUrl, 'gemini');
    const contents = messages.filter(x => x.role !== 'system').map(x => {
      const parts = [];
      if (Array.isArray(x.content)) {
        for (const part of x.content) {
          if (typeof part === 'string') parts.push({ text: part });
          else if (part.type === 'text') parts.push({ text: part.text || '' });
          else if (part.type === 'image_url' && part.image_url) {
            const u = String(part.image_url.url || '');
            const m = u.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
            if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
          }
        }
      } else {
        parts.push({ text: String(x.content || '') });
        if (x.images) {
          for (const img of x.images.slice(0, 2)) {
            const u = typeof img === 'string' ? img : (img.url || '');
            const m = String(u).match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
            if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
          }
        }
      }
      if (!parts.length) parts.push({ text: '' });
      return { role: x.role === 'assistant' ? 'model' : 'user', parts };
    });
    const system = messages.find(x => x.role === 'system')?.content;
    const sep = base.includes('?') ? '&' : '?';
    const url = `${base}/models/${encodeURIComponent(mid)}:generateContent${sep}key=${encodeURIComponent(apiKey)}`;
    const body = {
      contents,
      ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { temperature: 0.2, maxOutputTokens: maxTok }
    };
    if (Array.isArray(tools) && tools.length) {
      body.tools = [{ functionDeclarations: tools.map((t) => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        parameters: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
      })).filter((f) => f.name) }];
    }
    const j = await withBackoff(() => requestJson(url, {
      method: 'POST', headers: extra, timeoutMs: chatTimeout(provider), body
    }));
    const parts = j?.candidates?.[0]?.content?.parts || [];
    const fnCalls = parts.filter((p) => p.functionCall).map((p) => ({
      id: 'gemini_' + (p.functionCall.name || 'fn'),
      name: p.functionCall.name,
      arguments: p.functionCall.args || {}
    }));
    if (fnCalls.length) {
      return { mode: 'tools', text: parts.map((p) => p.text || '').join(''), tool_calls: fnCalls, raw: j };
    }
    const text = parts.map((x) => x.text || '').join('') || '';
    if (!text) throw new Error('Gemini returned no text candidate');
    return text;
  }

  if (proto === 'anthropic') {
    const base = normalizeBaseUrl(baseUrl, 'anthropic');
    const system = messages.find(x => x.role === 'system')?.content || '';
    const msgs = messages.filter(x => x.role !== 'system').map(x => {
      if (Array.isArray(x.content) || (x.images && x.images.length)) {
        const content = [];
        const text = Array.isArray(x.content) ? '' : String(x.content || '');
        if (text) content.push({ type: 'text', text });
        if (Array.isArray(x.content)) {
          for (const part of x.content) {
            if (part.type === 'text') content.push({ type: 'text', text: part.text || '' });
            if (part.type === 'image_url') {
              const u = String(part.image_url?.url || '');
              const m = u.match(/^data:(image\/[a-zA-Z0-9+.-]+);base64,(.+)$/);
              if (m) content.push({ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } });
            }
          }
        }
        return { role: x.role === 'assistant' ? 'assistant' : 'user', content };
      }
      return { role: x.role === 'assistant' ? 'assistant' : 'user', content: String(x.content || '') };
    });
    const body = { model: mid, max_tokens: maxTok, system, messages: msgs };
    if (Array.isArray(tools) && tools.length) {
      body.tools = tools.map((t) => ({
        name: t.function?.name || t.name,
        description: t.function?.description || t.description || '',
        input_schema: t.function?.parameters || t.parameters || { type: 'object', properties: {} }
      })).filter((x) => x.name);
    }
    const j = await withBackoff(() => requestJson(`${base}/messages`, {
      method: 'POST', timeoutMs: chatTimeout(provider),
      headers: { ...extra, ...authFor('anthropic', apiKey) },
      body
    }));
    const blocks = j?.content || [];
    const toolUses = blocks.filter((b) => b.type === 'tool_use').map((b) => ({
      id: b.id, name: b.name, arguments: b.input || {}
    }));
    if (toolUses.length) {
      return { mode: 'tools', text: blocks.filter((b) => b.type === 'text').map((b) => b.text || '').join(''), tool_calls: toolUses, raw: j };
    }
    const text = blocks.map(x => x.text || '').join('') || '';
    if (!text) throw new Error('Anthropic returned no text content');
    return text;
  }

  return chatOpenAICompat({ provider, baseUrl, apiKey, model: mid, messages, maxTokens: maxTok, extraHeaders, kind, tools, toolChoice });
}

function cacheKey({ provider, baseUrl, apiKey }) {
  return provider + '|' + cleanBase(baseUrl) + '|' + crypto.createHash('sha1').update(String(apiKey || '')).digest('hex').slice(0, 12);
}

/**
 * Resolve the model (dynamic when "auto") and generate.
 * Optional `meta` object receives { model } = the model actually used.
 */
async function runProvider(args) {
  const { provider, baseUrl, apiKey, model, kind, extraHeaders, messages, meta, tools, toolChoice, maxTokens } = args;
  const auto = !model || model === 'auto';
  const key = cacheKey(args);
  let chosen = null;
  if (auto) {
    const c = modelCache.get(key);
    if (c && Date.now() - c.ts < MODEL_CACHE_TTL_MS) chosen = c.model;
  }
  if (!chosen) {
    chosen = (await resolveModel({ provider, baseUrl, apiKey, model, kind, extraHeaders })).model;
    if (auto) modelCache.set(key, { model: chosen, ts: Date.now() });
  }
  const run = m => runWithModel({ provider, baseUrl, apiKey, model: m, messages, kind, extraHeaders, tools, toolChoice, maxTokens });
  try {
    const text = await run(chosen);
    if (meta) meta.model = chosen;
    return text;
  } catch (e) {
    if (auto) {
      modelCache.delete(key);
      if (e.status === 404 && isModelNotFound(e)) {
        const fresh = (await resolveModel({ provider, baseUrl, apiKey, model: 'auto', kind, extraHeaders })).model;
        if (fresh && fresh !== chosen) {
          const text = await run(fresh);
          modelCache.set(key, { model: fresh, ts: Date.now() });
          if (meta) meta.model = fresh;
          return text;
        }
      }
    }
    throw e;
  }
}

async function testProvider({ provider, baseUrl, apiKey, model = 'auto', kind, extraHeaders }) {
  const started = Date.now();
  const models = await listModels({ provider, baseUrl, apiKey, kind, extraHeaders });
  const explicit = !!model && model !== 'auto';
  const selected = explicit ? model : chooseAutoModel(models, provider);
  const base = normalizeBaseUrl(baseUrl, protocolOf(provider, kind));
  if (!explicit && (!selected || selected === 'auto')) throw noModelError(provider, base, models.length ? 'only non-text models were listed' : 'empty model list');

  const out = { ok: true, provider, model: selected, modelCount: models.length, models: models.slice(0, 100) };
  if (isSelfHosted(provider)) {
    // Listing proves nothing about generation on custom/local servers: run a tiny real generation.
    const g0 = Date.now();
    try {
      const text = await runWithModel({ provider, baseUrl, apiKey, model: selected, kind, extraHeaders, maxTokens: 16,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }] });
      out.generation = { ok: true, latencyMs: Date.now() - g0, sample: String(text).slice(0, 60) };
    } catch (e) {
      if (e.code === 'EMPTY_RESPONSE') {
        out.generation = { ok: true, empty: true, latencyMs: Date.now() - g0 };
        out.warning = `Server reachable and model "${selected}" accepted the request, but the probe returned no text: ${e.message}`;
      } else {
        const w = new Error(`Connection OK${models.length ? ` (${models.length} models)` : ''} but a test generation with model "${selected}" failed: ${e.message}`);
        w.status = e.status; w.code = e.code || 'GENERATION_FAILED';
        throw w;
      }
    }
  }
  out.latencyMs = Date.now() - started;
  return out;
}

function clearCaches() { modelCache.clear(); baseCache.clear(); }

module.exports = {
  runProvider, runWithModel, normalizeModel, listModels, chooseAutoModel, resolveModel, testProvider,
  extractText, normalizeBaseUrl, isTextModel, clearCaches,
  normalizeVisionMessages, supportsVisionHint, withBackoff,
};
