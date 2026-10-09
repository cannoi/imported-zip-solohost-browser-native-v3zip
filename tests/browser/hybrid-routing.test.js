'use strict';
const assert = require('assert');
const path = require('path');
const root = path.join(__dirname, '..', '..');
const { classifyUrlIntent } = require(path.join(root, 'lib/content-extractor.js'));
const gw = require(path.join(root, 'browser-gateway.js'));

assert.strictEqual(classifyUrlIntent('https://www.youtube.com/watch?v=dQw4w9WgXcQ').mode, 'EMBED');
assert.ok(classifyUrlIntent('https://www.youtube.com/watch?v=dQw4w9WgXcQ').embed_url.includes('embed/dQw4w9WgXcQ'));
assert.strictEqual(classifyUrlIntent('https://youtu.be/dQw4w9WgXcQ').mode, 'EMBED');
assert.strictEqual(classifyUrlIntent('https://www.tiktok.com/@user/video/1234567890').mode, 'EMBED');
assert.strictEqual(classifyUrlIntent('https://www.facebook.com/watch/?v=1').mode, 'EMBED');
assert.strictEqual(classifyUrlIntent('https://www.facebook.com/').mode, 'WEBVIEW');
assert.strictEqual(classifyUrlIntent('https://www.google.com/search?q=hello').mode, 'WEBVIEW');
assert.strictEqual(classifyUrlIntent('https://www.instagram.com/').mode, 'WEBVIEW');
assert.strictEqual(classifyUrlIntent('https://en.wikipedia.org/wiki/Browser').mode, 'READER');
assert.strictEqual(classifyUrlIntent('https://thanhnien.vn/some-article.html').mode, 'READER');

const embedSchema = gw.toParseSchema({
  mode: 'EMBED',
  url: 'https://www.youtube.com/watch?v=abc',
  embed_url: 'https://www.youtube.com/embed/abc',
  platform: 'youtube',
  videoId: 'abc',
  title: 'youtube abc',
  media: []
});
assert.strictEqual(embedSchema.mode, 'EMBED');
assert.strictEqual(embedSchema.data.embed_url, 'https://www.youtube.com/embed/abc');
assert.strictEqual(embedSchema.success, true);

const wv = gw.toParseSchema({
  mode: 'WEBVIEW',
  url: 'https://www.google.com/search?q=x',
  intent_reason: 'GOOGLE_SEARCH_OR_APP',
  media: []
});
assert.strictEqual(wv.mode, 'WEBVIEW');
assert.strictEqual(wv.data.webview_required, true);

const rd = gw.toParseSchema({
  mode: 'READER',
  url: 'https://example.com/a',
  title: 'A',
  clean_html: '<p>Hi</p>',
  raw_text: 'Hi',
  reading_minutes: 1,
  media: []
});
assert.strictEqual(rd.mode, 'READER');
assert.ok(rd.data.clean_html.includes('Hi'));
assert.ok(rd.content.clean_html.includes('Hi')); // back-compat

console.log('PASS hybrid-routing');
