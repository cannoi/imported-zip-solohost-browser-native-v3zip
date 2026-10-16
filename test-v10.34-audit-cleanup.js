'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
assert.ok(!fs.existsSync(path.join(root, 'lib/engine/stealth.js')), 'stealth.js deleted');
assert.ok(!fs.existsSync(path.join(root, 'native/webkit-worker/worker.py')), 'webkit worker deleted');

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.ok(!pkg.dependencies['sanitize-html'], 'sanitize-html dep removed (internal sanitizer kept)');
assert.ok(String(pkg.version).startsWith('10.'));

const be = fs.readFileSync(path.join(root, 'lib/backend-agent.js'), 'utf8');
assert.ok(!be.includes('supportsVisionHint'), 'unused supportsVisionHint import gone');
assert.ok(be.includes("require('./agent-sources/vn-retail')"), 'vn-retail loaded inside parallel path');
assert.ok(!/^const vnRetail = require/m.test(be), 'no top-level vnRetail binding');
assert.ok(be.includes('runCompareProductsParallel'), 'parallel compare kept');
assert.ok(be.includes('stuckKey'), 'stuck-loop detection kept');

const ev = fs.readFileSync(path.join(root, 'lib/agent-evidence.js'), 'utf8');
assert.ok(/kind !== 'serp'|kind != 'serp'/.test(ev), 'serp filtered from ledger prompt');

const eng = fs.readFileSync(path.join(root, 'lib/engine/playwright-engine.js'), 'utf8');
assert.ok(!eng.includes("require('./stealth')"));

const intent = require('./lib/agent-intent');
assert.strictEqual(intent.classifyIntent('Giá iPhone 18 và nơi nào bán rẻ?').kind, 'TASK');
assert.strictEqual(intent.classifyIntent('Xin chào').kind, 'CHAT');

console.log('[PASS] v10.34 audit cleanup checks');
