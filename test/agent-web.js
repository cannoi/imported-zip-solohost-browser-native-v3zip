'use strict';
const assert = require('assert');
const web = require('../lib/agent-web');
assert.strictEqual(typeof web.safeFetch, 'function');
assert.strictEqual(typeof web.extractPagePayload, 'function');
assert.strictEqual(typeof web.parseFeed, 'function');
console.log('[PASS] test/agent-web');
