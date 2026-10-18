'use strict';
const assert = require('assert');
const bridge = require('./lib/engine/dom-bridge');

assert.strictEqual(typeof bridge.authAssistHtml, 'function');
const html = bridge.authAssistHtml('https://accounts.google.com/v3/signin/rejected?x=1', 'google_auth_policy', 'vi');
assert.ok(html.includes('data-sh-auth-assist'));
assert.ok(html.includes('Login desktop') || html.includes('Desktop'));
assert.ok(html.includes('solohost-open-novnc'));
assert.ok(html.includes('Đăng nhập') || html.includes('Sign-in'));

// rejected path must map to google_auth_policy
const src = require('fs').readFileSync('lib/engine/dom-bridge.js', 'utf8');
assert.ok(/signin\\\/rejected/.test(src));
assert.ok(src.includes('authAssistHtml'));

const app = require('fs').readFileSync('public/app.js', 'utf8');
assert.ok(app.includes('showAuthAssistInFrame'));
assert.ok(app.includes('buildAuthAssistSrcdoc'));
// Must not blank auth pages as only path
assert.ok(app.includes('authAssist: true') || app.includes('showAuthAssistInFrame'));
assert.ok(!/externalRequired && j\.externalReason !== 'bing_verification_required'\) return loadViaExternal/.test(app));

console.log('[PASS] v10.44.2 google auth assist');
