'use strict';
/**
 * Evidence ledger for Browser Agent — stores fetched page/article/feed snippets
 * with stable [E#] ids so reports can cite sources without hallucinating.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_ROOT = process.env.SOLOHOST_DATA_DIR || path.join(__dirname, '..', 'data');
const LEDGER_ROOT = path.join(DATA_ROOT, 'agent-tasks');
const MAX_ENTRIES = 120;
const MAX_TEXT = 20000;
const MAX_SNIPPET = 600;

function ensureDir(d) {
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
}

function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function clip(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function taskDir(taskId) {
  ensureDir(LEDGER_ROOT);
  const d = path.join(LEDGER_ROOT, String(taskId || 'unknown'));
  ensureDir(d);
  return d;
}

function loadLedger(taskId) {
  const file = path.join(taskDir(taskId), 'ledger.json');
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(j.entries) ? j.entries : [];
  } catch {
    return [];
  }
}

function saveLedger(taskId, entries) {
  const file = path.join(taskDir(taskId), 'ledger.json');
  const trimmed = entries.slice(-MAX_ENTRIES);
  fs.writeFileSync(file, JSON.stringify({ entries: trimmed, updatedAt: new Date().toISOString() }, null, 0), { mode: 0o600 });
  return trimmed;
}

function addEvidence(taskId, item) {
  const entries = loadLedger(taskId);
  const id = 'E' + (entries.length + 1);
  const entry = {
    id,
    url: String(item.url || '').slice(0, 2000),
    title: clip(item.title, 300),
    source: item.source || domainOf(item.url),
    publishedAt: item.publishedAt || null,
    fetchedAt: new Date().toISOString(),
    section: item.section || null,
    snippet: clip(item.snippet || item.text, MAX_SNIPPET),
    kind: item.kind || 'page'
  };
  // Full text on disk
  try {
    const textPath = path.join(taskDir(taskId), id + '.txt');
    fs.writeFileSync(textPath, clip(item.text || item.snippet || '', MAX_TEXT), { mode: 0o600 });
    entry.textFile = id + '.txt';
  } catch (_) {}
  entries.push(entry);
  saveLedger(taskId, entries);
  return entry;
}

function getEvidence(taskId, id) {
  const entries = loadLedger(taskId);
  const e = entries.find((x) => x.id === String(id) || x.id === 'E' + String(id).replace(/^E/i, ''));
  if (!e) return null;
  let text = e.snippet;
  try {
    if (e.textFile) text = fs.readFileSync(path.join(taskDir(taskId), e.textFile), 'utf8');
  } catch (_) {}
  return Object.assign({}, e, { text: clip(text, MAX_TEXT) });
}

function recall(taskId, { query, id, url } = {}) {
  if (id) {
    const e = getEvidence(taskId, id);
    return e ? [summarizeEntry(e)] : [];
  }
  const entries = loadLedger(taskId);
  if (url) {
    const u = String(url).toLowerCase();
    return entries.filter((e) => String(e.url).toLowerCase().includes(u)).slice(0, 8).map(summarizeEntry);
  }
  const q = String(query || '').toLowerCase().trim();
  if (!q) return entries.slice(-10).map(summarizeEntry);
  const hits = [];
  for (const e of entries) {
    let text = e.snippet || '';
    try {
      if (e.textFile) text = fs.readFileSync(path.join(taskDir(taskId), e.textFile), 'utf8');
    } catch (_) {}
    if ((e.title + ' ' + text + ' ' + e.url).toLowerCase().includes(q)) {
      hits.push(summarizeEntry(Object.assign({}, e, { text })));
    }
    if (hits.length >= 10) break;
  }
  return hits;
}

function summarizeEntry(e) {
  return {
    id: e.id,
    url: e.url,
    title: e.title,
    source: e.source,
    publishedAt: e.publishedAt,
    snippet: clip(e.snippet || e.text, MAX_SNIPPET),
    kind: e.kind
  };
}

function ledgerPromptBlock(taskId) {
  const entries = loadLedger(taskId).slice(-30);
  if (!entries.length) return 'EVIDENCE: (empty)';
  return 'EVIDENCE (cite as [E#]):\n' + entries.map((e) =>
    `[${e.id}] ${e.source || ''} | ${e.publishedAt || '?'} | ${clip(e.title, 80)}\n  ${clip(e.snippet, 220)}\n  ${e.url}`
  ).join('\n');
}

function clearTaskEvidence(taskId) {
  const d = path.join(LEDGER_ROOT, String(taskId || ''));
  try {
    for (const f of fs.readdirSync(d)) fs.unlinkSync(path.join(d, f));
    fs.rmdirSync(d);
  } catch (_) {}
}

module.exports = {
  addEvidence, getEvidence, recall, loadLedger, ledgerPromptBlock, clearTaskEvidence, domainOf, clip
};
