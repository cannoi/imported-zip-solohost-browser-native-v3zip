'use strict';
// Per-browser-profile memory. Credentials, tokens, payment data and raw cookies are never accepted.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const DATA = process.env.SOLOHOST_DATA_DIR || path.join(__dirname, '..', 'data');
const FILE = path.join(DATA, 'ai-memory.json');
const PROFILE_RE = /^[a-f0-9]{32}$/i;
function read() { try { const x = JSON.parse(fs.readFileSync(FILE, 'utf8')); return x && typeof x === 'object' ? x : {}; } catch (_) { return {}; } }
function write(db) { try { fs.mkdirSync(DATA, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(db, null, 2)); fs.renameSync(tmp, FILE); return true; } catch (_) { return false; } }
function cleanText(v, max = 1200) { return String(v || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max); }
function safeContent(v) { const s = cleanText(v, 1600); if (!s) return ''; if (/(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|password|passwd|secret|authorization|cookie|credit.?card|cvv)\s*[:=]/i.test(s) || /\b(?:sk-[A-Za-z0-9_-]{16,}|AIza[\w-]{25,})\b/.test(s)) return ''; return s; }
function profileKey(id) { const raw = String(id || ''); return PROFILE_RE.test(raw) ? raw.toLowerCase() : ''; }
function get(profileId) { const key = profileKey(profileId); if (!key) return null; const db = read(); const p = db[key] || { memories: [], skills: [], history: [], updatedAt: new Date().toISOString() }; return { profileId: key, memories: p.memories || [], skills: p.skills || [], history: p.history || [], updatedAt: p.updatedAt }; }
function update(profileId, body = {}) {
  const key = profileKey(profileId); if (!key) return { ok: false, error: 'invalid_profile' };
  const db = read(); const p = db[key] || { memories: [], skills: [], history: [] };
  const type = String(body.type || '');
  if (type === 'turn') {
    const user = safeContent(body.user); const assistant = safeContent(body.assistant);
    // Keep transcript bounded and avoid persisting credential-like strings from either side.
    if (user) p.history.push({ role: 'user', content: user, at: Date.now() });
    if (assistant) p.history.push({ role: 'assistant', content: assistant, at: Date.now() });
    p.history = p.history.slice(-40);
  } else if (type === 'memory') {
    const content = safeContent(body.content); if (!content) return { ok: false, error: 'empty_or_sensitive_memory' };
    const item = { id: crypto.randomBytes(8).toString('hex'), content, createdAt: new Date().toISOString() };
    const i = p.memories.findIndex(x => String(x.content).toLowerCase() === content.toLowerCase()); if (i >= 0) p.memories.splice(i, 1); p.memories.unshift(item); p.memories = p.memories.slice(0, 40);
  } else if (type === 'skill') {
    const name = cleanText(body.name, 100); const content = safeContent(body.content);
    if (!name || !content) return { ok: false, error: 'empty_or_sensitive_skill' };
    const item = { id: crypto.randomBytes(8).toString('hex'), name, content, updatedAt: new Date().toISOString() };
    const i = p.skills.findIndex(x => String(x.name).toLowerCase() === name.toLowerCase()); if (i >= 0) p.skills.splice(i, 1); p.skills.unshift(item); p.skills = p.skills.slice(0, 30);
  } else if (type === 'clear_history') p.history = [];
  else if (type === 'clear') { delete db[key]; write(db); return { ok: true, cleared: true }; }
  else return { ok: false, error: 'invalid_type' };
  p.updatedAt = new Date().toISOString(); db[key] = p; const ok = write(db); return { ok, memory: get(key) };
}
module.exports = { get, update, safeContent };
