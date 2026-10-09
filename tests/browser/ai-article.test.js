'use strict';
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const root = path.join(__dirname, '..', '..');
const { createAIService } = require(path.join(root, 'lib/ai-module/ai-service.js'));

const ai = createAIService({
  dataDir: path.join(root, 'data'),
  appName: 'SoloHost Browser',
  adapter: {
    knowledge: 'test',
    async localReply() { return 'offline guide'; },
    async getContext() { return { screen: 'reader' }; },
    actions: []
  }
});

assert.strictEqual(typeof ai.summarizeArticle, 'function');
assert.strictEqual(typeof ai.translateArticle, 'function');
assert.strictEqual(typeof ai.askQuestion, 'function');

(async () => {
  const empty = await ai.summarizeArticle('');
  assert.strictEqual(empty.ok, false);
  assert.ok(/article|text|page/i.test(empty.error || ''));

  // Without provider keys, chat falls back to localReply — still must not throw.
  const sum = await ai.summarizeArticle('Alpha is one. Beta is two. Gamma is three. Delta is four.');
  assert.ok(sum.ok === true || sum.ok === false);
  assert.ok(sum.skill === 'summarize');
  assert.ok(sum.reply || sum.error);

  const routes = fs.readFileSync(path.join(root, 'lib/ai-module/routes.js'), 'utf8');
  assert.ok(routes.includes('/api/ai/summarize'));
  assert.ok(routes.includes('/api/ai/translate'));
  assert.ok(routes.includes('/api/ai/ask'));

  const panel = fs.readFileSync(path.join(root, 'public/ai-panel.js'), 'utf8');
  assert.ok(panel.includes('runArticleSkill'));
  assert.ok(panel.includes('/api/ai/summarize'));
  console.log('PASS ai-article skills');
})().catch((e) => { console.error(e); process.exit(1); });
