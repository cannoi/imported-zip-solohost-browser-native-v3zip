'use strict';
const assert = require('assert');
const { createExecuteAction } = require('../lib/agent-actions');
const fn = createExecuteAction({
  domBridge: { navigate: async (s, url) => ({ url, error: null, hasContent: true }) },
  assertSafeUrl: async () => {}
});
(async () => {
  const task = { urlStack: [], urlIndex: -1, sourcesStatus: {}, workMemory: {} };
  const r = await fn(task, {}, { type: 'navigate', url: 'https://example.com' }, {});
  assert.strictEqual(r.ok, true);
  const u = await fn(task, {}, { type: 'nope' }, {});
  assert.strictEqual(u.ok, false);
  console.log('[PASS] test/agent-actions');
})().catch((e) => { console.error(e); process.exit(1); });
