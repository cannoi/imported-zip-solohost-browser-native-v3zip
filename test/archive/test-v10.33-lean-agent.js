'use strict';
const assert = require('assert');
const intent = require('./lib/agent-intent');
const runner = require('./lib/agent-runner');
const compare = require('./lib/agent-playbooks/compare_products');
const fs = require('fs');
const path = require('path');

// Intent: price question is TASK
const c1 = intent.classifyIntent('Giá iPhone 18 và nơi nào bán rẻ?');
assert.strictEqual(c1.kind, 'TASK', 'price question must be TASK got ' + c1.kind);
const c2 = intent.classifyIntent('Xin chào');
assert.strictEqual(c2.kind, 'CHAT');
const c3 = intent.classifyIntent('https://example.com');
assert.strictEqual(c3.kind, 'QUICK_LOOKUP');
const c4 = intent.classifyIntent('So sánh giá FPT và TGDD');
assert.strictEqual(c4.kind, 'TASK');
console.log('[PASS] intent_classification');

// Parallel runner: one fails, others succeed
async function testRunner() {
  const jobs = [
    runner.createJob('a', 'A', async () => ({ ok: 1 })),
    runner.createJob('b', 'B', async () => { throw new Error('boom'); }),
    runner.createJob('c', 'C', async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { ok: 3 };
    })
  ];
  const batch = await runner.runParallel(jobs, { concurrency: 2, timeoutMs: 5000 });
  assert.strictEqual(batch.summary.ok, 2);
  assert.strictEqual(batch.summary.failed, 1);
  assert.strictEqual(batch.jobs[1].status, 'failed');
  console.log('[PASS] parallel_runner_partial_failure');
}
testRunner().then(() => {
  // Source wiring
  const panel = fs.readFileSync(path.join(__dirname, 'public/ai-panel.js'), 'utf8');
  assert.ok(panel.includes('classifyUserIntent'));
  assert.ok(/function shouldRunAgent[\s\S]*kind === 'TASK'/.test(panel));
  console.log('[PASS] ai_panel_task_routing');

  const be = fs.readFileSync(path.join(__dirname, 'lib/backend-agent.js'), 'utf8');
  assert.ok(be.includes('runCompareProductsParallel'));
  assert.ok(be.includes('agentRunner.runParallel'));
  assert.ok(compare.matchCompareIntent('Giá iPhone 18 và nơi nào bán rẻ?'));
  console.log('[PASS] compare_parallel_wired');

  console.log('\nAll lean-agent checks PASS');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
