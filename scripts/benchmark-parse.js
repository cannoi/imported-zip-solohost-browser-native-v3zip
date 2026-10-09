#!/usr/bin/env node
'use strict';
/**
 * Measures the real extraction path: GET /api/browser/parse (cold = cached:false, warm = cached:true).
 *
 *   node scripts/benchmark-parse.js http://127.0.0.1:8080 https://vnexpress.net/... https://example.com/...
 *   node scripts/benchmark-parse.js http://127.0.0.1:8080 --file urls.txt --runs 3
 *
 * Reports per-URL cold time, warm (cache hit) time, the extraction tier used and content size, plus
 * p50/p95 over the cold runs and whether the 1.5 s target was met. Run it from the same machine /
 * network the container uses — page speed depends on the target site and your uplink, not just code.
 */
const fs = require('fs');
const args = process.argv.slice(2);
const base = (args[0] && /^https?:\/\//.test(args[0]) ? args.shift() : 'http://127.0.0.1:8080').replace(/\/$/, '');
let runs = 1;
const urls = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--runs') runs = Math.max(1, Number(args[++i]) || 1);
  else if (args[i] === '--file') urls.push(...fs.readFileSync(args[++i], 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => /^https?:\/\//.test(s)));
  else if (/^https?:\/\//.test(args[i])) urls.push(args[i]);
}
if (!urls.length) { console.error('usage: benchmark-parse.js [baseUrl] <url...> [--file urls.txt] [--runs N]'); process.exit(2); }
const TARGET_MS = 1500;
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)] : null; };

async function call(url, refresh) {
  const t0 = process.hrtime.bigint();
  const res = await fetch(`${base}/api/browser/parse?url=${encodeURIComponent(url)}${refresh ? '&refresh=1' : ''}`);
  const body = await res.json().catch(() => ({}));
  return { ms: Number(process.hrtime.bigint() - t0) / 1e6, status: res.status, body };
}

(async () => {
  const cold = [];
  const rows = [];
  for (const url of urls) {
    for (let r = 0; r < runs; r++) {
      const c = await call(url, true);          // refresh=1 → always a real scrape
      const w = await call(url, false);         // served from the LRU cache
      if (c.body.success) cold.push(c.ms);
      rows.push({
        url, run: r + 1, ok: !!c.body.success, status: c.status,
        coldMs: Math.round(c.ms), warmMs: Math.round(w.ms), warmCached: !!w.body.cached,
        tier: c.body.diagnostics && c.body.diagnostics.tier, method: c.body.diagnostics && c.body.diagnostics.extraction_method,
        slowPath: !!(c.body.diagnostics && c.body.diagnostics.timing && c.body.diagnostics.timing.slow_path),
        words: c.body.content && c.body.content.word_count, error: c.body.error || null
      });
    }
  }
  console.table(rows);
  const under = cold.filter(ms => ms <= TARGET_MS).length;
  console.log(JSON.stringify({ base, samples: cold.length, coldP50Ms: Math.round(pct(cold, .5) || 0), coldP95Ms: Math.round(pct(cold, .95) || 0), underTargetPct: cold.length ? Math.round(100 * under / cold.length) : 0, targetMs: TARGET_MS }, null, 2));
})().catch(e => { console.error(e); process.exit(1); });
