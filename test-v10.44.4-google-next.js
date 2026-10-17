'use strict';
const assert = require('assert');
const fs = require('fs');
const eng = fs.readFileSync('lib/engine/playwright-engine.js', 'utf8');
const br = fs.readFileSync('lib/engine/dom-bridge.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');
assert.ok(eng.includes('googleSignInAction'));
assert.ok(eng.includes('identifierNext'));
assert.ok(eng.includes('isGoogleAccountsUrl'));
assert.ok(br.includes('bridge.google_event'));
assert.ok(br.includes('isGoogle'));
assert.ok(app.includes("bridgeEvent({ type: 'submit', targetId: id })"));
// No false-positive full external for all google accounts
assert.ok(!/if \(h === 'accounts\.google\.com'\) return true/.test(app));
console.log('[PASS] v10.44.4 google next path');
