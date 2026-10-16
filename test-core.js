'use strict';
/**
 * Core suite (~12 domains). Prefer this over the long historical chain.
 */
const { spawnSync } = require('child_process');
const path = require('path');

const tests = [
  'test-security.js',
  'test-perf-ssrf.js',
  'test-bridge.js',
  'test-youtube.js',
  'test-agent-intent-core.js',
  'test-v10.33-lean-agent.js',
  'test-v10.35-tier-a.js',
  'test-v10.36-complete.js',
  'test-engine.js',
  'test-syntax.js'
].filter((f) => {
  try { require('fs').accessSync(path.join(__dirname, f)); return true; } catch { return false; }
});

let failed = 0;
for (const t of tests) {
  console.log('\n===', t, '===');
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit' });
  if (r.status !== 0) {
    failed += 1;
    console.error('FAIL', t);
  }
}
if (failed) {
  console.error('\n' + failed + ' core test(s) failed');
  process.exit(1);
}
console.log('\nAll core tests passed (' + tests.length + ')');
