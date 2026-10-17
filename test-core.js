'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const tests = [
  'test-syntax.js',
  'test-security.js',
  'test-bridge.js',
  'test-engine.js',
  'test-agent-intent-core.js',
  'test-v10.33-lean-agent.js',
  'test-v10.35-tier-a.js',
  'test-v10.36-complete.js',
  'test-v10.37-unify.js',
  'test-v10.39-youtube-blank.js',
  'test-v10.40-mobile-first.js',
  'test-v10.41-youtube-pipeline.js',
  'test-youtube.js'
].filter((f) => fs.existsSync(path.join(__dirname, f)));
let failed = 0;
for (const t of tests) {
  console.log('\n===', t, '===');
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: 'inherit', cwd: __dirname });
  if (r.status !== 0) { failed++; console.error('FAIL', t); }
}
if (failed) { console.error(failed + ' failed'); process.exit(1); }
console.log('\nCore OK:', tests.length, 'tests');
