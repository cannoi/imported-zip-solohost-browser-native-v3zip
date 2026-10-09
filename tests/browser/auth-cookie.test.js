'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { classifyUrlIntent, checkAuthRequired } = require(path.join(root, 'lib/content-extractor.js'));
const gw = require(path.join(root, 'browser-gateway.js'));

assert.strictEqual(classifyUrlIntent('https://www.youtube.com/watch?v=abc').mode, 'EMBED');
assert.strictEqual(classifyUrlIntent('https://www.google.com/search?q=x').mode, 'WEBVIEW');
assert.strictEqual(classifyUrlIntent('https://en.wikipedia.org/wiki/X').mode, 'READER');

checkAuthRequired(null, 'https://example.com/login').then((r) => {
  assert.strictEqual(r.auth_required, true);
  assert.strictEqual(r.reason, 'AUTH_URL_PATH');
  const schema = gw.toParseSchema({
    mode: 'WEBVIEW',
    url: 'https://example.com/login',
    auth_required: true,
    intent_reason: 'AUTH_URL_PATH',
    media: []
  });
  assert.strictEqual(schema.auth_required, true);
  assert.strictEqual(schema.mode, 'WEBVIEW');
  assert.strictEqual(schema.data.webview_required, true);
  console.log('PASS auth-cookie');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
