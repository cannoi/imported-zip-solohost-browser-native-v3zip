'use strict';
const { assertPublicHttpUrl } = require('./lib/frame-proxy');

async function main() {
  const urls = [
    'https://example.com/',
    'http://127.0.0.1/',
    'https://example.com:2375/'
  ];
  const rows = [];
  for (const u of urls) {
    const t0 = process.hrtime.bigint();
    let outcome = 'ok';
    try { await assertPublicHttpUrl(u); } catch (e) { outcome = e.code || 'err'; }
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rows.push({ url: u, outcome, ms: Math.round(ms * 100) / 100 });
  }
  console.log('SSRF check latency (this host):');
  console.table(rows);
  console.log('Page load / RAM / multi-tab: NOT MEASURED on SoloHost runtime in this environment.');
}

main();
