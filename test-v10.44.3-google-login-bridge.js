'use strict';
const assert = require('assert');
const fs = require('fs');
const bridge = require('./lib/engine/dom-bridge');
const src = fs.readFileSync('lib/engine/dom-bridge.js', 'utf8');
const app = fs.readFileSync('public/app.js', 'utf8');

// Runtime code must not match the phrase (comments OK)
const codeOnly = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
assert.ok(!/browser or app may not be secure/i.test(codeOnly), 'false-positive phrase still used in runtime');
assert.ok(/googleHardReject|signin\\\/rejected/.test(src));

const isExt = app.match(/function isExternalAuthPath[\s\S]*?\n  \}/)[0];
assert.ok(/signin\\\/rejected/.test(isExt));
assert.ok(!/if \(h === 'accounts\.google\.com'\) return true/.test(isExt));

assert.ok(typeof bridge.authAssistHtml === 'function');
assert.ok(bridge.authAssistHtml('https://accounts.google.com/v3/signin/rejected', 'google_auth_policy', 'en').includes('data-sh-auth-assist'));

console.log('[PASS] v10.44.3 google login bridge interactivity');
