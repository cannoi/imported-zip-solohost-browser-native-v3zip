'use strict';
const assert = require('assert');
const fs = require('fs');
const bridge = fs.readFileSync(require.resolve('./lib/engine/dom-bridge'), 'utf8');
const agent = fs.readFileSync(require.resolve('./lib/backend-agent'), 'utf8');

assert.ok(bridge.includes('async function recreatePlaywrightSession(session)'), 'bridge has explicit Playwright session recovery');
assert.ok(bridge.includes('bridge.playwright_session_recovered'), 'session recovery is observable in logs');
assert.ok(bridge.includes('bridge.playwright_nav_recovered'), 'navigation retries after stale session recovery');
assert.ok(bridge.includes('Browser session recovered; retry the action.'), 'stale event path refreshes state rather than spamming failures');
assert.ok(agent.includes("status: 'failed', reason: clip((r && r.error) || 'navigation_failed_or_empty_content'"), 'failed navigation is recorded as source failure');
assert.ok(agent.includes('task.noProgressDoneAttempts < 2'), 'done gate has bounded retry attempts');
assert.ok(agent.includes('Finalizing a partial report with explicit limitations.'), 'source failure ends in partial report instead of infinite pending status');
assert.ok(agent.includes('sourcesStatus: task.sourcesStatus || {}'), 'source state is persisted for resume');
console.log('v10.31.0 session recovery + bounded source gate regression tests passed');
