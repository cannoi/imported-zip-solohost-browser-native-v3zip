'use strict';
const assert = require('assert');
const fs = require('fs');
assert.ok(!fs.existsSync('lib/ai-agent.js'), 'legacy ai-agent.js removed');
assert.ok(fs.existsSync('lib/ai-module/ai-service.js') || fs.existsSync('lib/ai-module'), 'ai-module present');
const intent = require('./lib/agent-intent');
const r = intent.classifyIntent('App này là app gì vậy');
assert.strictEqual(r.kind, 'CHAT');
console.log('[PASS] v10.23 upgrade contracts without ai-agent');
