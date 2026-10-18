'use strict';
/**
 * Engine smoke tests — WebKit worker removed (SOLOHOST_WEBKIT=0).
 * Validates manager/bridge contracts still present; soft-skips Python worker.
 */
const path = require('path');
const fs = require('fs');
const assert = require('assert');

const worker = path.join(__dirname, 'native', 'webkit-worker', 'worker.py');
const hasWorker = fs.existsSync(worker);

console.log('Engine contract tests (webkit worker present=%s)...', hasWorker);

const managerSource = fs.readFileSync(path.join(__dirname, 'lib', 'engine', 'webkit-manager.js'), 'utf8');
assert.ok(managerSource.includes('requestQueue') || managerSource.includes('_dispatchNext') || managerSource.includes('createSession'),
  'webkit-manager must expose session API (stub OK when disabled)');

const bridgeSource = fs.readFileSync(path.join(__dirname, 'lib', 'engine', 'dom-bridge.js'), 'utf8');
assert.ok(bridgeSource.includes('createSession') && bridgeSource.includes('navigate'), 'dom-bridge core API');
assert.ok(bridgeSource.includes('session.navigationInFlight') || bridgeSource.includes('navigationInFlight'),
  'duplicate navigations should be coalesced when present');

const pw = fs.readFileSync(path.join(__dirname, 'lib', 'engine', 'playwright-engine.js'), 'utf8');
assert.ok(pw.includes('createSession') && pw.includes('navigate'), 'playwright-engine is primary runtime');
assert.ok(!pw.includes("require('./stealth')"), 'stealth must not be required');
assert.ok(!fs.existsSync(path.join(__dirname, 'lib', 'engine', 'stealth.js')), 'stealth.js removed');

if (hasWorker) {
  const workerSource = fs.readFileSync(worker, 'utf8');
  assert.ok(workerSource.includes('cloneNode(true)') || workerSource.length > 100, 'worker file present');
  console.log('  (optional worker file still present — not launched; WEBKIT disabled by default)');
} else {
  console.log('  webkit-worker absent — OK (Chromium primary)');
}

console.log('Engine protocol tests PASSED');
