#!/usr/bin/env node
'use strict';
// Repeatable API-side benchmark. It intentionally does not claim to measure page FPS or rendering.
const base = (process.argv[2] || 'http://127.0.0.1:8080').replace(/\/$/, '');
const count = Math.max(5, Math.min(300, Number(process.argv[3]) || 30));
async function timed(path) {
  const start = process.hrtime.bigint();
  const response = await fetch(base + path, { headers: { 'cache-control': 'no-cache' } });
  const text = await response.text();
  return { ms: Number(process.hrtime.bigint() - start) / 1e6, status: response.status, bytes: Buffer.byteLength(text) };
}
function percentile(values, p) { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] || 0; }
(async () => {
  const results = {};
  for (const path of ['/health', '/ready', '/api/browser/status', '/api/performance']) {
    const rows = [];
    for (let i = 0; i < count; i++) {
      try { rows.push(await timed(path)); } catch (e) { rows.push({ ms: null, error: String(e.message || e) }); }
    }
    const ms = rows.map(r => r.ms).filter(Number.isFinite);
    results[path] = { samples: rows.length, successfulHttpResponses: rows.filter(r => r.status >= 200 && r.status < 400).length, p50Ms: ms.length ? Math.round(percentile(ms, .50) * 100) / 100 : null, p95Ms: ms.length ? Math.round(percentile(ms, .95) * 100) / 100 : null, minMs: ms.length ? Math.round(Math.min(...ms) * 100) / 100 : null, maxMs: ms.length ? Math.round(Math.max(...ms) * 100) / 100 : null, meanResponseBytes: rows.length ? Math.round(rows.reduce((n, r) => n + (r.bytes || 0), 0) / rows.length) : 0 };
  }
  let finalSample = null;
  try { const r = await fetch(base + '/api/performance'); if (r.ok) finalSample = await r.json(); } catch {}
  process.stdout.write(JSON.stringify({ benchmark: 'SoloHost Browser V7.6 API/host telemetry', base, startedAt: new Date().toISOString(), sampleCount: count, results, finalSample, limitations: ['Does not measure browser page load/paint, FPS, input latency, decoded image memory, media rebuffering, or noVNC bytes per second.', 'For before/after comparison, run on the same SoloHost device, same URL set, same screen resolution, same number of tabs, and same idle/warm-up period.'] }, null, 2) + '\n');
})().catch(e => { console.error(e); process.exitCode = 1; });
