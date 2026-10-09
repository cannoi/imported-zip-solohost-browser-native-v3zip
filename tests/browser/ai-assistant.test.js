const assert = require('assert');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', '..');
const ai = require(path.join(root, 'lib/ai-agent.js'));
assert.ok(Array.isArray(ai.SKILLS));
assert.ok(ai.SKILLS.includes('summarize'));
assert.strictEqual(ai.detectSkill('tóm tắt trang này'), 'summarize');
assert.strictEqual(ai.detectSkill('open https://example.com'), 'navigate');
assert.strictEqual(ai.detectSkill('hello'), 'assist');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
// V7.9 replaced the old /api/ai/skills route with the Universal AI module mounted under /api/ai.
assert.ok(server.includes("p.startsWith('/api/ai')") && server.includes('mountAIRoutes'));
const adapter = require(path.join(root, 'lib/app-adapter.js'));
assert.ok(adapter.knowledge.includes('Chromium') && !adapter.knowledge.includes('WebKitGTK (solohost'));
(async () => {
  // AI stays optional: without a provider the offline guide answers in the user's language.
  assert.ok(/Gõ địa chỉ/.test(await adapter.localReply('mở trang web thế nào', {})));
  assert.ok(/Type a URL/.test(await adapter.localReply('how do I open a url', {})));
  const ctx = await adapter.getContext({ screen: 'home' });
  assert.strictEqual(ctx.engine, 'chromium');
  console.log('PASS ai-assistant adapter');
})();
