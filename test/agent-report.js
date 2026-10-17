'use strict';
const assert = require('assert');
const { groundSummary, buildAgentReport } = require('../lib/agent-report');
const msg = groundSummary({ id: 't1', lang: 'en' }, 'Hello target="_blank" rel="noopener noreferrer"> world');
assert.ok(!/target="_blank"/.test(msg), 'html attrs stripped');
const short = groundSummary({ id: 't2', lang: 'en' }, 'Done.');
assert.ok(typeof short === 'string');
console.log('[PASS] test/agent-report');
